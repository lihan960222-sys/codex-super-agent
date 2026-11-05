import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
const {ProjectFolders,switchRequest}=await import('./projects.mjs').catch(()=>({}));

async function folders(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-projects-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const a=path.join(root,'项目A'),b=path.join(root,'项目B');await fs.mkdir(a);await fs.mkdir(b);return {root,a:await fs.realpath(a),b:await fs.realpath(b)}}

test('explicit natural-language switching is recognized without intercepting ordinary questions',()=>{
  assert.equal(typeof switchRequest,'function');
  for(const text of ['切换到夹具设计项目','请帮我切回上次那个项目，继续修改','回到 项目A','/project C:\\Projects\\A','switch to project A'])assert.ok(switchRequest(text),text);
  for(const text of ['如何切换到项目A？','你能介绍一下切换项目吗','请修改切换按钮','/model','创建零件'])assert.equal(switchRequest(text),false,text);
});

test('custom search roots extend the normal local directory hints',()=>{
  assert.equal(typeof ProjectFolders,'function');const custom=path.join(os.tmpdir(),'custom-project-root');
  const p=new ProjectFolders({config:{workspace:path.join(os.tmpdir(),'workspace'),projectSearchRoots:[custom]},rpc:{}});
  assert.equal(typeof p.searchRoots,'function');const roots=p.searchRoots();
  assert.ok(roots.includes(custom));assert.ok(roots.includes(path.join(os.homedir(),'Documents')));assert.ok(roots.includes(path.join(os.homedir(),'Desktop')));
});

test('folder associations round-trip and reject corrupt or linked metadata',async t=>{
  const {root,a,b}=await folders(t);assert.equal(typeof ProjectFolders,'function');
  const p=new ProjectFolders({config:{workspace:a,home:path.join(root,'private-home')},rpc:{}});
  await p.link(a,'thread-a');assert.equal((await p.association(a)).threadId,'thread-a');
  assert.equal((await p.association(b)),null);
  await fs.writeFile(path.join(b,'.telegram-codex-project.json'),'not json');await assert.rejects(p.association(b));
  await fs.unlink(path.join(b,'.telegram-codex-project.json'));
  await fs.link(path.join(a,'.telegram-codex-project.json'),path.join(b,'.telegram-codex-project.json'));
  await assert.rejects(p.association(b),/链接|关联/);
});

test('an explicit absolute folder path bypasses model inference',async t=>{
  const {a,b,root}=await folders(t);assert.equal(typeof ProjectFolders,'function');
  const p=new ProjectFolders({config:{workspace:a,home:path.join(root,'private-home')},rpc:{request:async()=>{throw Error('No inference expected')}}});
  const r=await p.resolve('切换到 "'+b+'"',[]);assert.equal(r.path,b);assert.equal(r.hasTask,false);
  await assert.rejects(p.resolve('切换到 "'+path.join(root,'missing')+'"',[]),/不存在|文件夹/);
});

test('descriptive lookup reuses a read-only ephemeral native thread and validates the returned folder',async t=>{
  const {a,b,root}=await folders(t);assert.equal(typeof ProjectFolders,'function');
  const rpc=new EventEmitter(),calls=[];
  rpc.request=async(method,params)=>{calls.push({method,params});if(method==='thread/start')return {thread:{id:'locator',cwd:a}};if(method==='model/list')return {data:[]};if(method==='turn/start'){setImmediate(()=>{rpc.emit('notification',{method:'item/completed',params:{threadId:'locator',item:{type:'agentMessage',text:JSON.stringify({status:'found',path:b,candidates:[],hasTask:false})}}});rpc.emit('notification',{method:'turn/completed',params:{threadId:'locator',turn:{id:'lookup',status:'completed'}}});});return {turn:{id:'lookup'}}}return {}};
  const p=new ProjectFolders({config:{workspace:a,home:path.join(root,'private-home'),model:'test-model',projectSearchRoots:[root]},rpc});
  const r=await p.resolve('切回上次的项目B',[]);assert.equal(r.path,b);
  const start=calls.find(x=>x.method==='thread/start');assert.equal(start.params.sandbox,'read-only');assert.equal(start.params.ephemeral,true);
  assert.ok(calls.find(x=>x.method==='turn/start').params.outputSchema);
  const supplied=JSON.parse(calls.find(x=>x.method==='turn/start').params.input[0].text).directoryCandidates;
  assert.ok(Array.isArray(supplied));assert.ok(supplied.includes(b));
  assert.equal(rpc.listenerCount('notification'),0);
});
