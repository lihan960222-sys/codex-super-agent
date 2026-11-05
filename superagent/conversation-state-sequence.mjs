import {fileURLToPath} from 'node:url';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {Store} from './store.mjs';import {Core} from './core.mjs';import {Scheduler} from './scheduler.mjs';
import {assertTestRoot} from './conversation-fixtures.mjs';
export function stateSequence(root,seed=0x5eedbeef,steps=200){
 assertTestRoot(root,path.resolve('local/conversation-validation'));
 fs.mkdirSync(root,{recursive:true});const file=path.join(root,'state.sqlite');let store=new Store(file),core=new Core(store),paused=false,random=seed>>>0,n=0;const world=new Map(),log=[];
 const pick=limit=>{random^=random<<13;random^=random>>>17;random^=random<<5;return (random>>>0)%limit;};
 const add=()=>{const event={id:'event-'+(++n),source:'telegram',text:'Synthetic state transition '+n};core.receive(event);const t=core.createTask(event.id,{title:'Synthetic '+n,responsibility:'Synthetic',resources:['isolated']});world.set(t.id,{status:'queued',manualStop:false});return t.id;};
 for(let i=0;i<6;i++)add();
 try{for(let step=0;step<steps;step++){
   const ids=[...world.keys()],id=ids[pick(ids.length)],prior=structuredClone(core.snapshot()),operation=pick(11),m=world.get(id);let rejected=false;
   if(operation===0){if(ids.length<20)add();}
   if(operation===1){try{core.applyControl({mode:'selected',stopTaskIds:[id]});assert.ok(!['completed','failed'].includes(m.status));m.status='stopped';m.manualStop=true;}catch(e){assert.ok(['completed','failed'].includes(m.status));rejected=true;}}
   if(operation===2){core.applyControl({mode:'pause_all'});paused=true;for(const v of world.values())if(!v.manualStop&&['queued','running','waiting','uncertain','preparing','blocked'].includes(v.status))v.status='paused';}
   if(operation===3){core.applyControl({mode:'resume_all'});paused=false;for(const v of world.values())if(!v.manualStop&&['paused','queued'].includes(v.status))v.status='queued';}
   if(operation===4){try{core.applyControl({mode:'selected',startTaskIds:[id]});assert.ok(!['completed','failed'].includes(m.status));if(paused){for(const [other,v]of world)if(other!==id&&v.status==='queued')v.status='paused';paused=false;}if(!['running','preparing','uncertain'].includes(m.status)){m.status='queued';m.manualStop=false;}}catch(e){assert.ok(['completed','failed'].includes(m.status));rejected=true;}}
   if(operation===5){const t=core.task(id);core.report(id,t.generation-1,{state:'ready',summary:'Stale completion'});assert.deepEqual(core.snapshot(),prior);}
   if(operation===6){store.close();store=new Store(file);core=new Core(store);assert.deepEqual(core.snapshot(),prior);}
   if(operation===7){const e={id:'follow-'+step,text:'Synthetic authorized followup',source:'telegram'};core.receive(e);try{core.attach(e.id,id);assert.equal(m.manualStop,false);if(['completed','failed','waiting','blocked'].includes(m.status))m.status='queued';}catch(e){assert.equal(m.manualStop,true);rejected=true;}}
   if(operation===8){const scheduler=new Scheduler(core,{capacity:()=>2}),leases=[];for(const tid of ids){const l=scheduler.acquire(tid);if(l)leases.push(l);}assert.ok(store.list('lease').length<=2);for(const l of leases)scheduler.release(l.taskId,l.generation);}
   if(operation===9){try{core.pause(id);assert.ok(!['completed','failed'].includes(m.status));if(!m.manualStop)m.status='paused';}catch(e){assert.ok(['completed','failed'].includes(m.status));rejected=true;}}
   if(operation===10){const accepted=core.report(id,core.task(id).generation,{state:'ready',summary:'Synthetic completion'});assert.equal(accepted,!m.manualStop&&m.status!=='paused');if(accepted)m.status='completed';}
   assert.equal(core.snapshot().paused,paused,'global pause at step '+step);for(const [tid,want]of world){const actual=core.task(tid);assert.equal(actual.status,want.status,'status step '+step+' task '+tid);assert.equal(actual.manualStop,want.manualStop,'manual stop step '+step);}
   if(![0,2,3,4].includes(operation))for(const t of prior.tasks)if(t.id!==id)assert.deepEqual(core.task(t.id),t,'non-target mutation step '+step);
   for(const input of store.list('input'))assert.ok(world.has(input.taskId),'input still belongs to its task');
   if(rejected&&operation!==7)assert.deepEqual(core.snapshot(),prior);
   log.push({step,operation,id,status:'pass'});
  }return {id:'STATE-'+steps,status:'pass',level:'F',transport:'deterministic',seed,steps:log};
 }catch(e){return {id:'STATE-'+steps,status:'fail',level:'F',transport:'deterministic',seed,steps:log,error:e.stack};}finally{store.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=stateSequence(path.resolve(process.argv[2]));fs.writeFileSync(path.join(process.argv[2],'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,steps:result.steps.length,seed:result.seed,error:result.error}));}
