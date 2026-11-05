import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from './store.mjs';
import {Core} from './core.mjs';
const {Routing}=await import('./routing.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e});
function fixture(){assert.equal(typeof Routing,'function','Routing must exist');const file=join(mkdtempSync(join(tmpdir(),'superagent-routing-')),'state.sqlite');const store=new Store(file),core=new Core(store),routing=new Routing(core);return {file,store,core,routing};}
const event=(id,extra={})=>({id,chatId:'owner',messageId:id,source:'telegram',text:'继续处理',...extra});
function task(f,id='1'){f.core.receive(event(id));return f.core.createTask(id,{title:id,responsibility:'焊接'});}

test('reply binding survives restart, bypasses assessment and never binds the entire private chat',()=>{
 const f=fixture(),t=task(f);f.routing.bind('owner','bot-ack',t.id);f.store.close();
 const s=new Store(f.file),r=new Routing(new Core(s));assert.equal(r.accept(event('2',{replyTo:'bot-ack'})).kind,'direct');assert.equal(s.list('input').filter(x=>x.eventId==='2')[0].taskId,t.id);
 assert.equal(r.accept(event('3',{text:'另一个网站项目'})).kind,'candidate');assert.equal(s.list('evaluation').length,0);s.close();
});
test('duplicate reception after assignment does not resubmit input or create a second candidate',()=>{
 const f=fixture(),t=task(f);f.routing.bind('owner','a',t.id);f.routing.accept(event('2',{replyTo:'a'}));const count=f.store.effects().length;
 assert.equal(f.routing.accept(event('2',{replyTo:'a'})).kind,'duplicate');assert.equal(f.store.effects().length,count);f.store.close();
});
test('ambiguous binding and stopped target are candidates, never direct or resurrected',()=>{
 const f=fixture(),a=task(f),b=task(f,'2');f.routing.bind('owner','shared',a.id);f.routing.bind('owner','shared',b.id);
 assert.equal(f.routing.accept(event('3',{replyTo:'shared'})).kind,'candidate');f.routing.bind('owner','a',a.id);f.core.stop(a.id);
 assert.equal(f.routing.accept(event('4',{replyTo:'a'})).kind,'candidate');assert.equal(f.core.task(a.id).status,'stopped');f.store.close();
});
test('handback excludes original task, ignores stale worker and is idempotent',()=>{
 const f=fixture(),t=task(f);f.routing.bind('owner','a',t.id);f.routing.accept(event('2',{replyTo:'a'}));
 assert.equal(f.routing.handback('2',t.id,t.generation-1,'other project'),false);
 assert.equal(f.routing.handback('2',t.id,t.generation,'other project'),true);assert.equal(f.routing.handback('2',t.id,t.generation,'other project'),false);
 const b=f.routing.begin();assert.throws(()=>f.routing.decide(b.id,[{eventId:'2',kind:'attach',taskId:t.id}]),/returned/);assert.equal(f.store.get('event','2').status,'routing');f.store.close();
});
test('new intake during assessment goes to next batch and old policy or stop epoch rejects decisions',()=>{
 const f=fixture();f.routing.accept(event('1'));const b=f.routing.begin();f.routing.accept(event('2'));assert.equal(f.routing.begin().id,b.id);
 f.core.stop(null);assert.throws(()=>f.routing.decide(b.id,[{eventId:'1',kind:'create',title:'one',responsibility:'laser'}]),/Stale/);
 assert.equal(f.store.list('task').length,0);f.core.resume(null);f.routing.expire(b.id);assert.equal(f.routing.begin().events.length,2);f.store.close();
});
test('decision batch is all-or-nothing and replay is idempotent',()=>{
 const f=fixture();f.routing.accept(event('1'));f.routing.accept(event('2'));const b=f.routing.begin();
 assert.throws(()=>f.routing.decide(b.id,[{eventId:'1',kind:'create',title:'one',responsibility:'laser'},{eventId:'2',kind:'attach',taskId:'missing'}]));assert.equal(f.store.list('task').length,0);
 const actions=[{eventId:'1',kind:'create',title:'one',responsibility:'laser'},{eventId:'2',kind:'clarify',question:'你指哪一个项目？'}];
 f.routing.decide(b.id,actions);f.routing.decide(b.id,actions);assert.equal(f.store.list('task').length,1);assert.equal(f.store.list('question').length,1);assert.equal(f.routing.begin(),null);f.store.close();
});
test('task status uses short handoff and reply stop targets just that task',()=>{
 const f=fixture(),a=task(f),b=task(f,'2');f.routing.bind('owner','a',a.id);
 f.routing.accept(event('3',{replyTo:'a',text:'停止'}));assert.equal(f.core.task(a.id).status,'stopped');assert.equal(f.core.task(b.id).status,'queued');
 const card=f.routing.cards()[0];assert.ok('summary'in card);assert.ok(!('history'in card));f.store.close();
});

test('answer to a clarification carries original request into the task and resolves the question',()=>{const f=fixture();f.routing.accept(event('1',{text:'处理其中一个项目'}));let b=f.routing.begin();f.routing.decide(b.id,[{eventId:'1',kind:'clarify',question:'哪一个？'}]);f.store.put('question-binding',JSON.stringify(['owner','q-message']),{questionId:'1'});f.routing.accept(event('2',{text:'焊接项目',replyTo:'q-message'}));b=f.routing.begin();const [r]=f.routing.decide(b.id,[{eventId:'2',kind:'create',title:'weld',responsibility:'laser',questionId:'1'}]);assert.equal(f.store.list('input').filter(i=>i.taskId===r.taskId).length,2);assert.equal(f.store.get('question','1').status,'resolved');f.store.close();});
test('responsibility renaming and merging preserve existing task sessions and stable IDs',()=>{const f=fixture(),a=task(f);f.routing.accept(event('2',{text:'以后都叫激光工艺'}));const b=f.routing.begin();f.routing.decide(b.id,[{eventId:'2',kind:'responsibility',responsibilityId:a.responsibilityId,name:'激光工艺'}]);assert.equal(f.store.get('responsibility',a.responsibilityId).name,'激光工艺');assert.equal(f.core.task(a.id).id,a.id);f.store.close();});
test('natural settings change becomes a validated durable effect; pure file tasks can reserve isolated resources',()=>{const f=fixture();f.routing.accept(event('1',{text:'把router模型设为 fast low'}));let b=f.routing.begin();f.routing.decide(b.id,[{eventId:'1',kind:'settings',patch:{router:{model:'fast',effort:'low'}}}]);assert.equal(f.store.effects().find(e=>e.kind==='settings').payload.patch.router.model,'fast');f.routing.accept(event('2',{text:'写一份独立报告，不操作桌面'}));b=f.routing.begin();const [r]=f.routing.decide(b.id,[{eventId:'2',kind:'create',title:'report',responsibility:'writing',resources:['isolated']}]);assert.equal(f.core.task(r.taskId).resources[0],'isolated:'+r.taskId);f.store.close();});
test('observer event cannot attach to original work; accepted speculation retains copy source and budget key',()=>{const f=fixture(),t=task(f);f.core.receive({id:'obs',source:'observer',origin:'proactive',parentTaskId:t.id,problemKey:'problem',authorizedRule:'inspect-changed-task-copy',text:'inspect changed project'});f.store.put('event','obs',{...f.store.get('event','obs'),status:'candidate'});const b=f.routing.begin();assert.throws(()=>f.routing.decide(b.id,[{eventId:'obs',kind:'attach',taskId:t.id}]),/proactive/i);const [r]=f.routing.decide(b.id,[{eventId:'obs',kind:'create',title:'experiment',responsibility:'laser'}]);assert.equal(f.core.task(r.taskId).parentTaskId,t.id);assert.equal(f.core.task(r.taskId).problemKey,'problem');f.store.close();});
test('paused execution still accepts natural-language resume through Router',()=>{const f=fixture();task(f);f.core.stop(null);f.routing.accept(event('resume',{text:'恢复全部任务'}));const b=f.routing.begin();assert.ok(b);f.routing.decide(b.id,[{eventId:'resume',kind:'resume',taskId:null}]);assert.equal(f.core.snapshot().paused,false);f.store.close();});
test('accepted owner task is acknowledged and coordination answer is delivered without creating work',()=>{const f=fixture();f.routing.accept(event('1'));let b=f.routing.begin();f.routing.decide(b.id,[{eventId:'1',kind:'create',title:'焊接研究',responsibility:'laser'}]);assert.ok(f.store.effects().some(e=>e.kind==='reply'&&e.payload.text.includes('焊接研究')));f.routing.accept(event('2',{text:'你负责分配任务吗'}));b=f.routing.begin();f.routing.decide(b.id,[{eventId:'2',kind:'answer',text:'是的，直接告诉我任务即可。'}]);assert.equal(f.store.list('task').length,1);assert.ok(f.store.effects().some(e=>e.payload.text==='是的，直接告诉我任务即可。'));f.store.close();});
