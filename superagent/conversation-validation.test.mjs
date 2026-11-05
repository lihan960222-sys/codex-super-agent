import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {assertTestRoot, evaluateEvidence, redact, summarize, ValidationRPC} from './conversation-fixtures.mjs';

test('validation refuses production paths and misleading sibling prefixes',()=>{
  const base=path.resolve('local/conversation-validation');
  assert.throws(()=>assertTestRoot('C:/Users/Administrator/Documents/CodexAgent/telegram',base),/isolated/);
  assert.throws(()=>assertTestRoot(base+'-outside',base),/isolated/);
  assert.doesNotThrow(()=>assertTestRoot(path.join(base,'run-1'),base));
});
test('evidence oracle catches changes to the wrong task',()=>{
  const result=evaluateEvidence({transport:'simulated-telegram',level:'N',before:{A:{status:'paused'},B:{status:'running'}},after:{A:{status:'paused'},B:{status:'stopped'}},expected:{states:{A:['stopped']},unchanged:['B']},sent:[],artifacts:[]});
  assert.equal(result.pass,false);assert.ok(result.assertions.some(a=>a.name==='unchanged:B'&&!a.pass));
});
test('queued task cannot pass when notification claims it started',()=>{
  const result=evaluateEvidence({transport:'simulated-telegram',level:'N',before:{},after:{A:{status:'queued',title:'铝板'}},expected:{states:{A:['queued']}},sent:[{text:'铝板已经开始执行'}],artifacts:[]});
  assert.equal(result.pass,false);
});
test('completion requires actual output and native evidence at E level',()=>{
  assert.equal(evaluateEvidence({transport:'simulated-telegram',level:'E',before:{},after:{A:{status:'completed'}},expected:{fileContains:'SYNTHETIC-42'},sent:[],artifacts:[]}).pass,false);
});
test('continuation cannot pass when a new session edits the original file',()=>{
  const result=evaluateEvidence({transport:'simulated-telegram',level:'E',before:{A:{id:'original-A',threadId:'old-thread'}},after:{A:{id:'original-A',threadId:'old-thread'},newTask:{threadId:'new-thread'}},expected:{continueTask:'A',followupAt:100},sent:[],artifacts:[],calls:[{method:'turn/start',role:'worker',native:true,threadId:'new-thread',at:200}]});
  assert.equal(result.pass,false,'retaining the unused original thread is insufficient');
});
test('resumed Worker requests remain Worker evidence after coordinator restart',async()=>{
  const rpc=new ValidationRPC({},{realWorkers:true});rpc.client.request=async(method,p)=>method==='thread/resume'?{thread:{id:p.threadId}}:{turn:{id:'turn'}};
  await rpc.request('thread/resume',{threadId:'old-worker',developerInstructions:'Execute the existing isolated task.',model:'gpt-6.1-sol'});
  await rpc.request('turn/start',{threadId:'old-worker',model:'gpt-6.1-sol',effort:'medium',input:[{type:'text',text:'continue'}]});
  assert.equal(rpc.calls.at(-1).role,'worker');rpc.close();
});
test('unlabelled native or simulated evidence is rejected',()=>{
  assert.throws(()=>evaluateEvidence({before:{},after:{},expected:{},sent:[],artifacts:[]}),/level|transport/);
});
test('reports redact credential canaries recursively and aggregates are derived',()=>{
  const value=redact({token:'CANARY_SECRET_81',error:'Bearer CANARY_SECRET_81',email:'fixture@example.invalid'},['CANARY_SECRET_81']);
  assert.ok(!JSON.stringify(value).includes('CANARY_SECRET_81'));
  assert.deepEqual(summarize([{status:'pass'},{status:'fail'},{status:'blocked'}]),{total:3,pass:1,fail:1,blocked:1});
});
