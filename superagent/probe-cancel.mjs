// Uses the real native model with an isolated ledger and fake Telegram transport.
// No worker launches, real Telegram sends or production task mutations.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {Store} from './store.mjs';import {Core} from './core.mjs';import {Routing} from './routing.mjs';import {Settings} from './settings.mjs';import {Client,Native} from './native.mjs';import {Router} from './router.mjs';import {Delivery} from './delivery.mjs';import {Controls} from './controls.mjs';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),actual=JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[2]),'superagent-settings.json'),'utf8'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cancel-native-')),store=new Store(path.join(root,'state.sqlite')),core=new Core(store),routing=new Routing(core),settings=new Settings(path.join(root,'settings.json'),config),rpc=new Client(config),native=new Native(rpc),result={model:actual.router,cases:[],toolFailures:[]};settings.current.router=actual.router;
native.on('toolFailure',e=>result.toolFailures.push(e.error));
const event=(id,text)=>({id,text,source:'telegram',chatId:'isolated',messageId:id});
const add=(id,title,status)=>{core.receive(event(id,title));const t=core.createTask(id,{title,responsibility:'fixture',resources:['isolated']});store.put('task',t.id,{...t,status});return core.task(t.id);};
try{await rpc.connect();const router=new Router({store,core,routing,native,settings,cwd:root}),sent=[];
 const delivery=new Delivery({store,routing,chatId:'isolated',compose:(k,p)=>router.compose(k,p),stamp:p=>router.stamp(p),telegram:async(m,p)=>{sent.push(p.text);return {message_id:sent.length}}}),controls=new Controls({store,core,settings,delivery,native});
 const target=add('a','检查 bot 代码是否刚更新','paused'),other=add('b','AgentWorkspace','stopped');for(let i=0;i<7;i++)add('done'+i,'已完成资料检索 '+i,'completed');
 const drain=async()=>{for(const e of store.effects().filter(e=>e.kind==='reply')){await delivery.enqueue(e.key,e.payload);store.cancelEffect(e.kind,e.key)}await delivery.flush();};
 const status=async id=>{core.receive(event(id,'/status'));store.put('event',id,{...event(id,'/status'),status:'control'});await controls.command(event(id,'/status'));await delivery.flush();assert.ok(store.list('delivered').at(-1).taskIds.includes(target.id),'status must include paused task');};
 for(const [i,text] of ['停止这个队列任务','等待执行的这个任务不需要了'].entries()){
  store.put('task',target.id,{...core.task(target.id),status:'paused',manualStop:false});await status('status'+i);
  store.put('meta','router',{...store.get('meta','router'),decisions:999});routing.accept(event('cancel'+i,text));await router.tick();
  const q=store.list('question','pending').at(-1);if(q){assert.ok(q.options?.length,'control clarification must have options');await drain();routing.accept(event('confirm'+i,'不就这一个么，就是检查 bot 代码是否刚更新，停止并保留记录'));await router.tick();}
  assert.equal(core.task(target.id).status,'stopped');assert.equal(core.task(other.id).status,'stopped');assert.ok(store.list('task').filter(t=>t.id!==target.id&&t.id!==other.id).every(t=>t.status==='completed'));await drain();assert.ok(sent.at(-1).includes(target.title),'receipt must name target');result.cases.push({input:text,reply:sent.at(-1),pass:true});console.log(JSON.stringify(result.cases.at(-1)));
 }
 // Fresh structured clarification + bare confirmation across native thread rotation.
 store.put('task',target.id,{...core.task(target.id),status:'paused',manualStop:false});routing.accept(event('question','停止这个队列任务'));const batch=routing.begin();routing.decide(batch.id,[{eventId:'question',kind:'clarify',question:'停止“检查 bot 代码是否刚更新”并保留记录吗？',options:[{label:'停止该任务',plan:{mode:'selected',stopTaskIds:[target.id]}}]}]);await drain();store.put('meta','router',{...store.get('meta','router'),decisions:999});routing.accept(event('bare','不就这一个么'));await router.tick();assert.equal(core.task(target.id).status,'stopped');assert.equal(store.get('question','question').status,'resolved');await drain();result.cases.push({input:'不就这一个么',reply:sent.at(-1),pass:true});result.verified=true;
}catch(e){result.error=e.stack;result.questions=store.list('question');result.replies=store.list('delivered');process.exitCode=1;}finally{native.close();rpc.close();store.close();fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2));console.log(JSON.stringify({verified:result.verified,error:result.error,cases:result.cases.length}));}
