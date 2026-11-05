import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const module = await import('./controller.mjs').catch(()=>({}));
const {Controller} = module;

function fixture(t,extra={}) {
  assert.equal(typeof Controller,'function','Telegram controller has not been implemented');
  const dir=mkdtempSync(join(tmpdir(),'codex-telegram-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const calls=[],messages=[],responses=[];
  const config={ownerId:'123',chatId:'123',workspace:dir,model:'gpt-6.1-sol',...extra};
  const rpc={request:async(method,params)=>{calls.push({method,params});if(method==='model/list')return {data:[{model:config.model,inputModalities:['text','image']}]};if(method==='thread/start')return {thread:{id:'thread-a'}};if(method==='turn/start')return {turn:{id:'turn-a'}};if(method==='thread/read')return {thread:{status:{type:'idle'}}};return {};},respond:(id,result)=>responses.push({id,result}),reject:()=>{}};
  const telegram=async(method,params)=>{messages.push({method,params});return {message_id:messages.length};};
  const stateFile=join(dir,'state.json');
  const c=new Controller({config,stateFile,rpc,telegram,saveConfig:()=>{}});
  return {c,config,calls,messages,responses,stateFile,rpc,telegram};
}
const update=(id,text,user=123,type='private')=>({update_id:id,message:{message_id:id,from:{id:user},chat:{id:user,type},text}});
const preference=(id,data,user=123)=>({update_id:id,callback_query:{id:String(id),from:{id:user},message:{message_id:1,chat:{id:user,type:'private'}},data}});

test('project switching restores each folder and its own thread and survives restart',async t=>{
  const {ProjectFolders}=await import('./projects.mjs').catch(()=>({}));assert.equal(typeof ProjectFolders,'function');
  const f=fixture(t);const a=realpathSync.native(f.config.workspace),b=join(a,'项目B');mkdirSync(b);f.config.workspace=a;
  f.c.state.threadId='thread-a';f.c.save();
  const sessions=new Map([['thread-a',a]]);
  f.rpc.request=async(method,params)=>{f.calls.push({method,params});if(method==='thread/start'){sessions.set('thread-b',params.cwd);return {thread:{id:'thread-b',cwd:params.cwd},model:params.model,approvalsReviewer:params.approvalsReviewer}}if(method==='turn/start')return {turn:{id:'turn-b'}};if(method==='thread/read'||method==='thread/resume')return {thread:{id:params.threadId,cwd:sessions.get(params.threadId),status:{type:'idle'}}};if(method==='thread/turns/list')return {data:[]};return {}};
  const projects=new ProjectFolders({config:f.config,rpc:f.rpc});projects.resolve=async text=>({path:text.includes('项目B')?b:a,hasTask:false});f.c.projects=projects;
  await f.c.handle(update(1,'切换到项目B'));await f.c.preparing;
  assert.equal(f.config.workspace,b);assert.equal(f.c.state.threadId,null);assert.equal(f.calls.filter(x=>x.method==='thread/start').length,0);
  await f.c.submit('Start B');assert.equal(f.c.state.threadId,'thread-b');
  await f.c.onNotification({method:'turn/completed',params:{threadId:'thread-b',turn:{id:'turn-b',status:'completed'}}});
  assert.equal((await projects.association(a)).threadId,'thread-a');assert.equal((await projects.association(b)).threadId,'thread-b');
  await f.c.handle(update(2,'切回项目A'));await f.c.preparing;
  assert.equal(f.config.workspace,a);assert.equal(f.c.state.threadId,'thread-a');assert.equal(f.calls.filter(x=>x.method==='thread/start').length,1);
  await f.c.onNotification({method:'turn/completed',params:{threadId:'thread-b',turn:{id:'old-turn',status:'completed'}}});assert.equal(f.c.state.threadId,'thread-a');
  const staleConfig={...f.config,workspace:b};new Controller({config:staleConfig,stateFile:f.stateFile,rpc:f.rpc,telegram:f.telegram,projects,saveConfig:()=>{}});assert.equal(staleConfig.workspace,a);
});

test('switch requests cannot change projects during work or come from an outsider',async t=>{
  const f=fixture(t);let lookups=0;f.c.projects={resolve:async()=>{lookups++;return {path:'other'}}};
  await f.c.handle(update(1,'切换到项目B',999));assert.equal(lookups,0);
  f.c.state.busy=true;
  await f.c.handle(update(2,'切换到项目B'));assert.equal(lookups,0);assert.equal(f.c.state.threadId,null);
});

test('project lookup is cancellable and does not block settings or allow new-thread changes',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';let finish;
  f.c.projects={resolve:()=>new Promise(resolve=>finish=resolve)};
  await f.c.handle(update(1,'切回项目B'));assert.equal(typeof finish,'function');
  await f.c.handle(update(2,'/settings'));assert.ok(f.messages.some(x=>x.params.text?.includes('模型：')));
  await f.c.handle(update(3,'/new'));assert.equal(f.c.state.threadId,'thread-a');
  await f.c.handle(update(4,'/stop'));finish({path:'other',hasTask:false});await f.c.preparing;
  assert.equal(f.c.state.threadId,'thread-a');assert.equal(f.calls.filter(x=>x.method==='thread/start').length,0);
});

test('a native conversation from another folder cannot be recorded as the current project',async t=>{
  const {ProjectFolders}=await import('./projects.mjs');const f=fixture(t);const b=join(f.config.workspace,'other');mkdirSync(b);
  f.c.state.threadId='thread-a';f.c.projects=new ProjectFolders({config:f.config,rpc:f.rpc});
  f.rpc.request=async()=>({thread:{id:'thread-a',cwd:b,status:{type:'idle'}}});
  await assert.rejects(f.c.rememberProject(),/其他工作目录/);
});

test('settings buttons and model menus use short labels without instructional names',async t=>{
  const f=fixture(t);await f.c.handle(update(1,'/settings'));
  assert.deepEqual(f.messages.at(-1).params.reply_markup.inline_keyboard.flat().map(x=>x.text),['自动','手动','模型']);
});

test('late status reads cannot overwrite a different project or a later visit to the same project',async t=>{
  for(const stage of ['read','turns']){
    const f=fixture(t);f.c.state.threadId='thread-a';let finish;
    f.rpc.request=async method=>{if(method==='thread/read'&&stage==='turns')return {thread:{status:{type:'active'}}};return new Promise(resolve=>finish=resolve)};
    const pending=f.c.sync();await new Promise(resolve=>setImmediate(resolve));
    if(stage==='read'){Object.assign(f.c.state,{threadId:'thread-b',projectGeneration:1,busy:true,turnId:'new-turn'});finish({thread:{status:{type:'idle'}}});}
    else{Object.assign(f.c.state,{threadId:'thread-a',projectGeneration:2,busy:false,turnId:null});finish({data:[{id:'old-turn'}]});}
    await pending;assert.equal(f.c.state.busy,stage==='read');assert.equal(f.c.state.turnId,stage==='read'?'new-turn':null);
  }
});

test('model buttons have no image suffix',async t=>{
  const f=fixture(t);await f.c.handle(update(1,'/model'));
  const menu=f.messages.at(-1).params;
  assert.ok(menu.reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='pref:model:gpt-6.1-sol'));
  assert.ok(menu.reply_markup.inline_keyboard.flat().every(x=>!x.text.includes('图片')));
});

test('choosing model then effort persists the pair and applies it to the same conversation after restart',async t=>{
  const f=fixture(t,{model:'model-a',reasoningEffort:'low'});f.c.state.threadId='thread-a';f.c.save();
  const configFile=join(f.config.workspace,'config.json');writeFileSync(configFile,JSON.stringify(f.config));f.c.saveConfig=c=>writeFileSync(configFile,JSON.stringify(c));
  const request=f.rpc.request;
  f.rpc.request=async(method,params)=>method==='model/list'?{data:[{model:'model-b',displayName:'B',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'ultra',description:'Deepest'}]}]}:request(method,params);
  await f.c.handle(preference(1,'pref:model:model-b'));
  assert.equal(f.config.model,'model-a');assert.equal(f.config.reasoningEffort,'low');
  const buttons=f.messages.at(-1).params.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some(x=>x.callback_data==='pref:effort:model-b:medium'));
  assert.ok(buttons.some(x=>x.callback_data==='pref:effort:model-b:ultra'));
  assert.ok(!buttons.some(x=>x.callback_data==='pref:effort:model-b:low'));
  await f.c.handle(preference(2,'pref:model-menu'));assert.equal(f.config.model,'model-a');
  await f.c.handle(preference(3,'pref:effort:model-b:ultra'));
  const persisted=JSON.parse(readFileSync(configFile));assert.equal(persisted.model,'model-b');assert.equal(persisted.reasoningEffort,'ultra');
  assert.equal(f.c.state.threadId,'thread-a');assert.equal(f.calls.filter(x=>x.method==='turn/start').length,0);
  const restarted=new Controller({config:persisted,stateFile:f.stateFile,rpc:f.rpc,telegram:f.telegram,saveConfig:()=>{}});
  await restarted.handle(update(4,'Reply OK'));
  const turn=f.calls.find(x=>x.method==='turn/start');assert.equal(turn.params.model,'model-b');assert.equal(turn.params.effort,'ultra');
  const resume=f.calls.find(x=>x.method==='thread/resume');assert.equal(resume.params.threadId,'thread-a');assert.equal(Object.hasOwn(resume.params,'effort'),false);
  assert.equal(restarted.state.lastSubmittedSettings.effort,'ultra');
});

test('effort callbacks reject outsiders and unsupported model-effort pairs',async t=>{
  const f=fixture(t,{model:'model-a',reasoningEffort:'medium'});
  f.rpc.request=async()=>({data:[{model:'model-a',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'}]}]});
  await f.c.handle(preference(1,'pref:effort:model-a:medium',999));assert.equal(f.messages.length,0);
  await f.c.handle(preference(2,'pref:effort:model-a:ultra'));assert.equal(f.config.reasoningEffort,'medium');
  assert.ok(f.messages.some(x=>/不支持|不可用/.test(x.params.text||'')));
  await f.c.handle(preference(3,'pref:effort:removed-model:medium'));assert.equal(f.config.model,'model-a');
});

test('invalid manually configured effort cannot silently start a task',async t=>{
  const f=fixture(t,{reasoningEffort:'not-supported'});
  await f.c.handle(update(1,'Do work'));
  assert.equal(f.calls.filter(x=>x.method==='turn/start'||x.method==='thread/start').length,0);
  assert.ok(f.messages.some(x=>/思考强度/.test(x.params.text||'')));
});

test('owner can choose native automatic review and the choice survives recovery without blanket approval',async t=>{
  const f=fixture(t);
  await f.c.handle(update(1,'/permissions auto'));
  assert.equal(f.config.approvalsReviewer,'auto_review');
  assert.equal(f.responses.length,0);
  f.rpc.request=async(method,params)=>{f.calls.push({method,params});if(method==='thread/start'||method==='thread/resume')return {thread:{id:'thread-a'},model:f.config.model,approvalsReviewer:params.approvalsReviewer};if(method==='thread/read')return {thread:{status:{type:'idle'}}};if(method==='turn/start')return {turn:{id:'turn-a'}};return {}};
  await f.c.handle(update(2,'Reply OK'));
  assert.equal(f.calls.find(x=>x.method==='turn/start').params.approvalsReviewer,'auto_review');
  const c=new Controller({config:f.config,stateFile:f.stateFile,rpc:f.rpc,telegram:f.telegram,saveConfig:()=>{}});
  await c.resume();
  assert.equal(f.calls.filter(x=>x.method==='thread/resume').at(-1).params.approvalsReviewer,'auto_review');
});

test('settings are owner-only, invalid modes are rejected, and current approval requests remain explicit',async t=>{
  const f=fixture(t);
  await f.c.handle(update(1,'/permissions auto',999));assert.equal(f.config.approvalsReviewer,undefined);
  await f.c.handle(update(2,'/permissions yolo'));assert.equal(f.config.approvalsReviewer,undefined);
  await f.c.handle(update(3,'/permissions auto'));assert.equal(f.config.approvalsReviewer,'auto_review');
  await f.c.handle(update(4,'/permissions manual'));assert.equal(f.config.approvalsReviewer,'user');
  assert.equal(f.responses.length,0);assert.equal(f.calls.filter(x=>x.method==='turn/start').length,0);
});

test('model selection uses a live paginated catalog and is applied without changing the conversation',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';f.c.save();
  f.rpc.request=async(method,params)=>{f.calls.push({method,params});if(method==='model/list')return params.cursor?{data:[{model:'model-b',displayName:'B',inputModalities:['text'],supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}:{data:[{model:'model-a',displayName:'A',inputModalities:['text','image']}],nextCursor:'next'};if(method==='thread/resume')return {thread:{id:'thread-a'},model:params.model,approvalsReviewer:params.approvalsReviewer};if(method==='turn/start')return {turn:{id:'turn-a'}};return {}};
  await f.c.handle(update(1,'/model model-b'));assert.equal(f.c.state.threadId,'thread-a');
  await f.c.handle(update(2,'/model model-b low'));assert.equal(f.config.model,'model-b');
  await f.c.handle(update(3,'/model fabricated'));assert.equal(f.config.model,'model-b');
  await f.c.handle(update(4,'/permissions auto'));await f.c.handle(update(5,'Reply OK'));
  assert.equal(f.calls.find(x=>x.method==='turn/start').params.model,'model-b');
  assert.ok(f.calls.some(x=>x.method==='model/list'&&x.params.cursor==='next'));
});

test('a native refusal to enable automatic review cannot be displayed as successful or submit work',async t=>{
  const f=fixture(t,{approvalsReviewer:'auto_review'});
  f.rpc.request=async(method,params)=>{f.calls.push({method,params});return {thread:{id:'thread-a'},model:f.config.model,approvalsReviewer:'user'}};
  await f.c.handle(update(1,'Create a file'));
  assert.equal(f.calls.filter(x=>x.method==='turn/start').length,0);
  assert.ok(f.messages.some(x=>/未确认|未生效/.test(x.params.text)));
});

test('a loaded thread returning its prior model on resume still receives the new turn override',async t=>{
  const f=fixture(t,{model:'model-b',approvalsReviewer:'auto_review'});f.c.state.threadId='thread-a';f.c.save();
  f.rpc.request=async(method,params)=>{f.calls.push({method,params});if(method==='thread/resume')return {thread:{id:'thread-a'},model:'model-a',approvalsReviewer:'user'};if(method==='turn/start')return {turn:{id:'turn-a'}};return {}};
  await f.c.handle(update(1,'Reply OK'));
  assert.equal(f.calls.find(x=>x.method==='turn/start')?.params.model,'model-b');
  await f.c.onNotification({method:'thread/settings/updated',params:{threadId:'thread-a',threadSettings:{model:'model-b',approvalsReviewer:'auto_review'}}});
  assert.deepEqual(f.c.state.effectiveSettings,{model:'model-b',approvalsReviewer:'auto_review'});
});

test('owner media preparation stays responsive and submits typed input into the same conversation',async t=>{
  const f=fixture(t);let finish;
  f.c.media={prepare:()=>new Promise(resolve=>finish=resolve)};
  await f.c.handle({update_id:1,message:{from:{id:123},chat:{id:123,type:'private'},photo:[{file_id:'photo-a'}],caption:'Describe this'}});
  assert.equal(typeof finish,'function');assert.equal(f.calls.filter(x=>x.method==='turn/start').length,0);
  await f.c.handle(update(2,'/settings'));assert.ok(f.messages.some(x=>x.params.text?.includes('模型：')));
  finish({text:'Describe this',input:[{type:'localImage',path:'C:\\safe\\image.png'}]});
  await f.c.preparing;
  const turn=f.calls.find(x=>x.method==='turn/start');assert.ok(turn.params.input.some(x=>x.type==='localImage'));assert.equal(f.c.state.busy,true);
});

test('unauthorized attachments are ignored and media delivery retries do not rerun work',async t=>{
  const f=fixture(t);let downloads=0,sends=0;
  f.c.media={prepare:async()=>{downloads++;return {}},deliver:async()=>{if(++sends===1)throw Object.assign(Error('temporary upload failure'),{transient:true})}};
  await f.c.handle({update_id:1,message:{from:{id:999},chat:{id:999,type:'private'},voice:{file_id:'secret'}}});assert.equal(downloads,0);
  f.c.queueDelivery('file-a',{kind:'document',path:'C:\\private\\snapshot.pdf'});
  await assert.rejects(f.c.flushOutbox());assert.equal(f.c.state.outbox.length,1);
  await f.c.flushOutbox();assert.equal(f.c.state.outbox.length,0);assert.equal(f.calls.filter(x=>x.method==='turn/start').length,0);
});

test('stop cancels media preparation before it can submit a task',async t=>{
  const f=fixture(t);let finish;
  f.c.media={prepare:()=>new Promise(resolve=>finish=resolve)};
  await f.c.handle({update_id:1,message:{from:{id:123},chat:{id:123,type:'private'},voice:{file_id:'voice'}}});
  await f.c.handle(update(2,'/stop'));
  finish({text:'Create a file',input:[]});await f.c.preparing;
  assert.equal(f.calls.filter(x=>x.method==='turn/start').length,0);
});

test('a permanently invalid attachment is quarantined without blocking later replies or owner controls',async t=>{
  const f=fixture(t);f.c.media={deliver:async()=>{throw Object.assign(Error('Artifact no longer valid'),{artifactFailure:true})}};
  f.c.queueDelivery('bad-file',{kind:'document',path:'gone.pdf'});f.c.queueDelivery('later-text','Still online');
  await f.c.flushOutbox();
  assert.equal(f.c.state.outbox.length,0);assert.equal(f.c.state.failedAttachments.length,1);
  assert.ok(f.messages.some(x=>x.params.text==='Still online'));
});

test('an older completion cannot clear a newer turn or use its output scope',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';f.c.state.busy=true;f.c.state.turnId='new-turn';
  f.c.state.turnRoots={'old-turn':'old-root','new-turn':'new-root'};f.c.state.artifactRoot='new-root';
  f.c.approvals.set('new-approval',{request:{params:{turnId:'new-turn'}}});
  const roots=[];f.c.media={reply:async(text,root)=>{roots.push(root);return {text,attachments:[]}}};
  await f.c.onNotification({method:'item/completed',params:{threadId:'thread-a',turnId:'old-turn',item:{id:'old-message',type:'agentMessage',text:'old reply'}}});
  await f.c.onNotification({method:'turn/completed',params:{threadId:'thread-a',turn:{id:'old-turn',status:'completed'}}});
  assert.equal(f.c.state.busy,true);assert.equal(f.c.state.turnId,'new-turn');assert.equal(f.c.approvals.size,1);
  assert.equal(roots[0],'old-root');
});

test('a delayed known turn-start cannot replace a newer turn or claim its pending artifact root',t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';f.c.state.busy=true;f.c.state.turnId='new-turn';
  f.c.state.turnRoots={'old-turn':'old-root','new-turn':'new-root'};f.c.state.pendingTask={root:'new-root'};
  f.c.observe({method:'turn/started',params:{threadId:'thread-a',turn:{id:'old-turn'}}});
  assert.equal(f.c.state.turnId,'new-turn');assert.equal(f.c.state.turnRoots['old-turn'],'old-root');
});

test('unbound outsiders and groups cannot start tasks or bind without the one-time code',async t=>{
  const f=fixture(t);
  await f.c.handle(update(1,'create a file',999));
  await f.c.handle(update(2,'create a file',123,'group'));
  assert.equal(f.calls.length,0);assert.equal(f.messages.length,0);
});
test('authorized task is durable before submission and retains human approval policy',async t=>{
  const f=fixture(t);
  f.rpc.request=async(method,params)=>{f.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread-a'}};if(method==='turn/start'){assert.equal(JSON.parse(readFileSync(f.stateFile)).busy,true);return {turn:{id:'turn-a'}}}return {}};
  await f.c.handle(update(10,'Create hello.txt'));
  const start=f.calls.find(x=>x.method==='thread/start');
  assert.equal(start.params.approvalPolicy,'on-request');assert.equal(start.params.approvalsReviewer,'user');assert.equal(start.params.sandbox,'workspace-write');
  assert.equal(f.calls.find(x=>x.method==='turn/start').params.input[0].text,'Create hello.txt');
  await f.c.handle(update(10,'Create hello.txt'));
  assert.equal(f.calls.filter(x=>x.method==='turn/start').length,1);
});
test('restart does not replay a task whose submission outcome was lost',async t=>{
  const f=fixture(t);f.rpc.request=async(method)=>{if(method==='thread/start')return {thread:{id:'thread-a'}};throw Error('connection lost')};
  await f.c.handle(update(5,'create x'));
  const c=new Controller({config:f.config,stateFile:f.stateFile,rpc:f.rpc,telegram:f.telegram,saveConfig:()=>{}});
  assert.equal(c.state.busy,true);assert.equal(c.state.lastUpdate,5);
  await c.handle(update(5,'create x'));assert.equal(c.state.busy,true);
});
test('approvals stay pending until the owner approves exactly once',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';
  await f.c.onRequest({id:55,method:'item/commandExecution/requestApproval',params:{threadId:'thread-a',turnId:'turn-a',command:'write file',cwd:f.config.workspace}});
  assert.equal(f.responses.length,0);
  const prompt=f.messages.at(-1);const data=prompt.params.reply_markup.inline_keyboard[0][0].callback_data;
  const callback=(uid,id)=>({update_id:id,callback_query:{id:String(id),from:{id:uid},message:{message_id:f.messages.indexOf(prompt)+1,chat:{id:123,type:'private'}},data}});
  await f.c.handle(callback(999,2));assert.equal(f.responses.length,0);
  await f.c.handle(callback(123,3));assert.deepEqual(f.responses,[{id:55,result:{decision:'accept'}}]);
  await f.c.handle(callback(123,4));assert.equal(f.responses.length,1);
});
test('approval for another conversation cannot be applied to the active thread',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';
  await f.c.onRequest({id:2,method:'item/fileChange/requestApproval',params:{threadId:'other',turnId:'x'}});
  assert.deepEqual(f.responses,[{id:2,result:{decision:'decline'}}]);
  assert.equal(f.messages.length,0);
});
test('only an unexpired matching pairing code binds a private user; it cannot be reused',async t=>{
  const f=fixture(t,{ownerId:null,chatId:null,pairHash:createHash('sha256').update('abcdef').digest('hex'),pairExpires:Date.now()+60000});
  await f.c.handle(update(1,'/pair wrong',222));assert.equal(f.config.ownerId,null);
  await f.c.handle(update(2,'/pair abcdef',222));assert.equal(f.config.ownerId,'222');assert.equal(f.config.pairHash,null);
  await f.c.handle(update(3,'/pair abcdef',999));assert.equal(f.config.ownerId,'222');
  const expired=fixture(t,{ownerId:null,chatId:null,pairHash:createHash('sha256').update('abcdef').digest('hex'),pairExpires:Date.now()-1});
  await expired.c.handle(update(1,'/pair abcdef',222));assert.equal(expired.config.ownerId,null);
});
test('Telegram start deep link binds the same one-time code without allowing group binding',async t=>{
  const f=fixture(t,{ownerId:null,chatId:null,pairHash:createHash('sha256').update('xyz123').digest('hex'),pairExpires:Date.now()+60000});
  await f.c.handle(update(1,'/start bind_xyz123',321,'group'));assert.equal(f.config.ownerId,null);
  await f.c.handle(update(2,'/start bind_xyz123',321));assert.equal(f.config.ownerId,'321');
});
test('reconnect explicitly restores the original workspace-write sandbox and human reviewer',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';
  await f.c.resume();
  const r=f.calls.find(x=>x.method==='thread/resume');
  assert.equal(r.params.sandbox,'workspace-write');assert.equal(r.params.approvalsReviewer,'user');
});
test('file approval shows the actual paths and patch and fails closed without those details',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';
  await f.c.onNotification({method:'item/started',params:{threadId:'thread-a',item:{id:'patch-a',type:'fileChange',changes:[{path:'C:\\test\\hello.txt',diff:'+hello',kind:{type:'add'}}]}}});
  await f.c.onRequest({id:8,method:'item/fileChange/requestApproval',params:{threadId:'thread-a',turnId:'turn-a',itemId:'patch-a'}});
  assert.ok(f.messages.some(x=>x.params.text?.includes('C:\\test\\hello.txt')&&x.params.text?.includes('+hello')));
  const missing=fixture(t);missing.c.state.threadId='thread-a';
  await missing.c.onRequest({id:9,method:'item/fileChange/requestApproval',params:{threadId:'thread-a',turnId:'turn-a',itemId:'missing'}});
  assert.deepEqual(missing.responses,[{id:9,result:{decision:'decline'}}]);
});
test('network approval identifies the requested host even when there is no command',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';
  await f.c.onRequest({id:10,method:'item/commandExecution/requestApproval',params:{threadId:'thread-a',turnId:'turn-a',networkApprovalContext:{host:'example.com',protocol:'https',port:443}}});
  assert.ok(f.messages.some(x=>x.params.text?.includes('example.com')&&x.params.text?.includes('https')));
});
test('completed results missed during disconnect are delivered once on resume without starting another task',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';f.c.state.busy=true;f.c.save();
  f.rpc.request=async(method,params)=>{f.calls.push({method,params});if(method==='thread/read')return {thread:{status:{type:'idle'}}};if(method==='thread/turns/list')return {data:[{id:'turn-a',status:'completed',items:[{id:'answer-a',type:'agentMessage',text:'FILE_CREATED_OK'}]}]};return {}};
  await f.c.resume();assert.ok(f.messages.some(x=>x.params.text==='FILE_CREATED_OK'));
  const count=f.messages.length;await f.c.resume();assert.equal(f.messages.length,count);
  assert.equal(f.calls.filter(x=>x.method==='turn/start').length,0);
});
test('failed final-message delivery stays on disk and is retried without replaying work',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';
  f.c.telegram=async()=>{throw Error('temporary Telegram outage')};
  await assert.rejects(f.c.onNotification({method:'item/completed',params:{threadId:'thread-a',turnId:'turn-a',item:{id:'answer-a',type:'agentMessage',text:'RESULT_TO_RETRY'}}}));
  const restarted=new Controller({config:f.config,stateFile:f.stateFile,rpc:f.rpc,telegram:f.telegram,saveConfig:()=>{}});
  await restarted.flushOutbox();assert.ok(f.messages.some(x=>x.params.text==='RESULT_TO_RETRY'));assert.equal(f.calls.length,0);
});
test('a pending reply cannot prevent restoring the Codex subscription and current task state',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';f.c.state.busy=true;f.c.state.outbox=[{id:'old',text:'PENDING'}];
  f.c.telegram=async()=>{throw Object.assign(Error('outage'),{transient:true})};
  await assert.rejects(f.c.resume());
  assert.ok(f.calls.some(x=>x.method==='thread/resume'));assert.equal(f.c.state.busy,false);
});
test('recovery persists all missing reply items before attempting the first network send',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';
  f.rpc.request=async(method)=>method==='thread/read'?{thread:{status:{type:'idle'}}}:method==='thread/turns/list'?{data:[{id:'turn-a',status:'completed',items:[{id:'a',type:'agentMessage',text:'FIRST'},{id:'b',type:'agentMessage',text:'SECOND'}]}]}:{};
  f.c.telegram=async()=>{throw Object.assign(Error('outage'),{transient:true})};
  await assert.rejects(f.c.resume());
  assert.deepEqual(f.c.state.outbox.map(x=>x.id),['turn-a:a','turn-a:b','turn-a:end']);
});
test('a resumed active turn recovers missed complete messages when that turn ends',async t=>{
  const f=fixture(t);f.c.state.threadId='thread-a';
  f.rpc.request=async(method)=>method==='thread/read'?{thread:{status:{type:'active'}}}:method==='thread/turns/list'?{data:[{id:'turn-a',status:'inProgress',items:[{id:'partial',type:'agentMessage',text:'PARTIAL_TEXT'}]}]}:method==='thread/items/list'?{data:[{turnId:'turn-a',completedAtMs:1,item:{id:'missed',type:'agentMessage',text:'RECOVERED_COMPLETE_REPLY'}}],nextCursor:null}:{};
  await f.c.resume();assert.equal(f.messages.length,0);
  await f.c.onNotification({method:'turn/completed',params:{threadId:'thread-a',turn:{id:'turn-a',status:'completed'}}});
  assert.ok(f.messages.some(x=>x.params.text==='RECOVERED_COMPLETE_REPLY'));assert.equal(f.c.state.busy,false);
});
