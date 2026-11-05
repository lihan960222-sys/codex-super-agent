import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const module=await import('./store.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e});
const coreModule=await import('./core.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e});
function fixture(){assert.equal(typeof module.Store,'function','durable Store must exist');assert.equal(typeof coreModule.Core,'function','Core must exist');const file=join(mkdtempSync(join(tmpdir(),'superagent-core-')),'state.sqlite');const store=new module.Store(file);return {file,store,core:new coreModule.Core(store)}}
const incoming=id=>({id,source:'telegram',text:'Analyze isolated fixture',at:'2026-11-04T00:00:00Z',chatId:'owner',messageId:id});
const decision={title:'fixture',responsibility:'laser',scope:'analyze',resources:['desktop'],origin:'explicit'};
test('persisted intake survives restart and duplicate reception never loses unsubmitted text',()=>{
  const {file,store,core}=fixture();assert.equal(core.receive(incoming('1')),true);assert.equal(core.receive(incoming('1')),false);store.close();
  const reopened=new module.Store(file);assert.equal(reopened.get('event','1').text,'Analyze isolated fixture');assert.equal(reopened.get('event','1').status,'received');reopened.close();
});
test('accepting the same event twice creates one task and one durable launch',()=>{
  const {store,core}=fixture();core.receive(incoming('1'));const a=core.createTask('1',decision);const b=core.createTask('1',decision);
  assert.equal(a.id,b.id);assert.equal(store.list('task').length,1);assert.equal(store.effects().filter(x=>x.kind==='launch').length,1);store.close();
});
test('transaction rollback removes records and external effects together',()=>{
  const {store}=fixture();assert.throws(()=>store.atomic(()=>{store.put('task','a',{id:'a'});store.enqueue('launch','a',{taskId:'a'});throw Error('crash')}));assert.equal(store.get('task','a'),null);assert.equal(store.effects().length,0);store.close();
});
test('settling an older effect attempt cannot delete a replacement payload',()=>{
  const {store}=fixture();store.enqueue('delivery','a',{text:'first'});const old=store.claimEffect('delivery','a');store.enqueue('delivery','a',{text:'second'});
  assert.equal(store.settleEffect(old),false);assert.equal(store.effects()[0].payload.text,'second');store.close();
});
test('manual stop persists and late reports or ordinary followups cannot resurrect work',()=>{
  const {file,store,core}=fixture();core.receive(incoming('1'));const task=core.createTask('1',decision);core.stop(task.id);core.receive(incoming('2'));assert.throws(()=>core.attach('2',task.id),/stopped/);
  assert.equal(core.report(task.id,task.generation,{state:'ready',summary:'late'}),false);store.close();
  const reopened=new module.Store(file);assert.equal(reopened.get('task',task.id).status,'stopped');reopened.close();
});
test('global pause fences queued starts and explicit resume preserves single-task stops',()=>{
  const {store,core}=fixture();core.receive(incoming('1'));const a=core.createTask('1',decision);core.receive(incoming('2'));const b=core.createTask('2',decision);core.stop(a.id);core.stop(null);
  assert.equal(core.snapshot().paused,true);assert.equal(core.canLaunch(b.id),false);core.resume(null);assert.equal(core.canLaunch(b.id),true);assert.equal(core.canLaunch(a.id),false);store.close();
});
test('outdated assignment report cannot overwrite a newer run and duplicate input is delivered once',()=>{
  const {store,core}=fixture();core.receive(incoming('1'));const task=core.createTask('1',decision);core.receive(incoming('2'));core.attach('2',task.id);core.attach('2',task.id);
  assert.equal(store.list('input').filter(x=>x.eventId==='2').length,1);assert.equal(core.report(task.id,task.generation-1,{state:'failed'}),false);assert.equal(store.get('task',task.id).status,'queued');store.close();
});
