import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
const {Native}=await import('./native.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e});
function fixture(){assert.equal(typeof Native,'function','Native must exist');const rpc=new EventEmitter();rpc.sent=[];rpc.respond=(id,r)=>rpc.sent.push({id,result:r});rpc.reject=(id,error)=>rpc.sent.push({id,error});rpc.request=async()=>({});return {rpc,native:new Native(rpc)};}
const completed=(rpc,threadId,id,text)=>{rpc.emit('notification',{method:'item/completed',params:{threadId,turnId:id,item:{type:'agentMessage',id:id+'-item',text}}});rpc.emit('notification',{method:'turn/completed',params:{threadId,turn:{id,status:'completed'}}});};
test('simultaneous turns stay isolated including completion before start acknowledgement',async()=>{
 const {rpc,native}=fixture();native.bind('a',{});native.bind('b',{});rpc.request=async(m,p)=>{completed(rpc,p.threadId,'turn-'+p.threadId,p.threadId+' result');return {turn:{id:'turn-'+p.threadId}};};
 const [a,b]=await Promise.all([native.turn('a','A'),native.turn('b','B')]);assert.equal(a.text,'a result');assert.equal(b.text,'b result');native.close();
});
test('stale completion cannot finish a new turn',async()=>{
 const {rpc,native}=fixture();native.bind('a',{});rpc.request=async()=>{completed(rpc,'a','old','wrong');setImmediate(()=>completed(rpc,'a','new','right'));return {turn:{id:'new'}};};assert.equal((await native.turn('a','x')).text,'right');native.close();
});
test('unknown thread is rejected and tools only reach their bound role',async()=>{
 const {rpc,native}=fixture();let calls=0;native.bind('a',{tool:async(name,args)=>{assert.equal(name,'read');calls++;return args;}});
 rpc.emit('request',{id:1,method:'item/tool/call',params:{threadId:'alien',tool:'read',arguments:{}}});rpc.emit('request',{id:2,method:'item/tool/call',params:{threadId:'a',tool:'read',arguments:{value:5}}});await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.ok(rpc.sent.find(x=>x.id===1).error);assert.equal(rpc.sent.find(x=>x.id===2).result.success,true);native.close();
});
test('transport failure rejects active waiter without retrying submission',async()=>{
 const {rpc,native}=fixture();native.bind('a',{});let starts=0;rpc.request=async()=>{starts++;setImmediate(()=>rpc.emit('failure',Error('disconnected')));return {turn:{id:'a1'}};};await assert.rejects(native.turn('a','x'),/disconnected/);assert.equal(starts,1);native.close();
});
test('coordinator capability check refuses any external MCP tool before a model turn',async()=>{const {rpc,native}=fixture();assert.equal(typeof native.verifyCoordinator,'function');rpc.request=async()=>({data:[{name:'unexpected',tools:{write:{}}}]});await assert.rejects(native.verifyCoordinator('r'),/external/);rpc.request=async()=>({data:[]});await native.verifyCoordinator('r');native.close();});
