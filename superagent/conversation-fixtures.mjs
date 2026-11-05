// Validation utilities only. No production decision or recovery logic is duplicated here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Client} from './native.mjs';
import {createSystem} from './system.mjs';
export const baseline={router:{model:'gpt-6-luna',effort:'medium'},worker:{model:'gpt-6.1-sol',effort:'medium'}};
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function assertTestRoot(root,base){const rel=path.relative(path.resolve(base),path.resolve(root));if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('An isolated child of the validation root is required');return path.resolve(root);}
export function redact(value,secrets=[]){
  if(typeof value==='string'){let s=value;for(const secret of secrets.filter(Boolean))s=s.split(secret).join('[redacted]');return s.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email]').replace(/bot\d+:[A-Za-z0-9_-]+/g,'bot[redacted]');}
  if(Array.isArray(value))return value.map(v=>redact(v,secrets));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/token$|secret|authorization|password/i.test(k)?'[redacted]':redact(v,secrets)]));return value;
}
export function summarize(results){return results.reduce((a,r)=>{a.total++;if(r.status in a)a[r.status]++;return a;},{total:0,pass:0,fail:0,blocked:0});}
export function artifactSnapshot(root){const result=[];if(!fs.existsSync(root))return result;const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())walk(p);else if(entry.isFile()){const bytes=fs.readFileSync(p);result.push({path:path.relative(root,p),sha256:sha(bytes),size:bytes.length,text:/\.(md|txt|json|csv)$/i.test(p)?bytes.toString('utf8'):null});}}};walk(root);return result;}
export function evaluateEvidence({transport,level,before,after,expected={},sent=[],artifacts=[],calls=[]}){
  if(!['N','E','F','F+N'].includes(level)||!['simulated-telegram','deterministic'].includes(transport))throw Error('Explicit level and transport are required');
  const assertions=[],check=(name,pass,actual)=>assertions.push({name,pass:!!pass,actual});
  for(const [key,states]of Object.entries(expected.states||{}))check('state:'+key,states.includes(after[key]?.status),after[key]?.status??null);
  for(const key of expected.manualStop||[])check('manualStop:'+key,after[key]?.manualStop===true,after[key]?.manualStop);
  for(const key of expected.notManualStop||[])check('notManualStop:'+key,!after[key]?.manualStop,after[key]?.manualStop);
  for(const key of expected.unchanged||[])check('unchanged:'+key,JSON.stringify(after[key])===JSON.stringify(before[key]),after[key]);
  if(expected.taskCount!==undefined)check('taskCount',Object.keys(after).length===expected.taskCount,Object.keys(after).length);
  if(expected.minNew!==undefined)check('newTasks',Object.keys(after).length-Object.keys(before).length>=expected.minNew,Object.keys(after).length-Object.keys(before).length);
  if(expected.fileContains)check('fileContent',artifacts.some(a=>a.text?.includes(expected.fileContains)),artifacts.map(a=>a.path));
  if(expected.continueTask){const key=expected.continueTask,t=before[key];check('continuation-no-new-task',Object.keys(after).length===Object.keys(before).length,Object.keys(after).length);check('continuation-same-thread',!!t?.threadId&&after[key]?.threadId===t.threadId,after[key]?.threadId);check('continuation-actual-turn',calls.some(c=>c.native===true&&c.method==='turn/start'&&c.threadId===t?.threadId&&c.at>=(expected.followupAt||0)),calls.filter(c=>c.method==='turn/start'&&c.at>=(expected.followupAt||0)).map(c=>c.threadId));if(expected.fileContains)check('continuation-target-file',artifacts.some(a=>a.path.split(/[\\/]/).some(p=>p.startsWith(t.id+'_'))&&a.text?.includes(expected.fileContains)),t.id);}
  if(level==='E'&&expected.requireActualWorker!==false)check('actualWorkerTurn',calls.some(c=>c.role==='worker'&&c.method==='turn/start'&&c.native===true),calls.filter(c=>c.role==='worker'&&c.method==='turn/start').length);
  const text=sent.map(s=>s.text||'').join('\n');
  for(const t of Object.values(after))if(['queued','paused','stopped','preparing'].includes(t.status)&&t.title&&text.includes(t.title))check('truthfulStart:'+t.title,!new RegExp(t.title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'.{0,16}(已经开始执行|已开始工作|正在执行)').test(text),t.status);
  if(expected.textIncludes)for(const x of expected.textIncludes)check('replyContains:'+x,text.includes(x),text);
  if(expected.textExcludes)for(const x of expected.textExcludes)check('replyExcludes:'+x,!text.includes(x),text);
  return {pass:assertions.every(a=>a.pass),assertions};
}

// Only Worker I/O is substituted in N cases. Router tools and decisions always come from the real model.
export class ValidationRPC extends EventEmitter {
  constructor(config,{realWorkers=false,record=()=>{},workers=new Map()}={}){super();Object.assign(this,{config,realWorkers,record,workers});this.client=new Client(config);this.threads=new Map();this.requests=new Map();this.serial=0;this.calls=[];
    for(const kind of ['notification','request','failure'])this.client.on(kind,m=>{this.record({kind,...m});this.emit(kind,m);});
  }
  async connect(){return this.client.connect();}
  async request(method,p={}){
    const start=method==='thread/start',declaredWorker=!!p.developerInstructions,router=start?p.dynamicTools?.some(t=>t.name==='router_decide'):!declaredWorker&&this.threads.get(p.threadId)?.role==='router';
    const role=router?'router':p.threadId||start?'worker':'service';let mode;try{mode=JSON.parse(p.input?.[0]?.text||'{}').mode==='presentation'?'presentation':'routing';}catch{mode='routing';}
    const fake=role==='worker'&&!this.realWorkers;
    const call={method,role,...method==='turn/start'?{mode:role==='router'?mode:'execution'}:{},native:!fake,at:Date.now(),threadId:p.threadId,model:p.model,effort:p.effort};this.calls.push(call);this.record({kind:'request',call,params:p});
    let r;
    if(start&&fake){const id='synthetic-worker-'+(++this.serial);this.workers.set(id,{params:p,turns:[]});r={...p,thread:{id}};}
    else if(fake&&this.workers.has(p.threadId)){
      const w=this.workers.get(p.threadId);
      if(method==='thread/resume')r={...w.params,...p,thread:{id:p.threadId}};
      else if(method==='thread/settings/update'){w.params={...w.params,...p};r={};}
      else if(method==='turn/start'){const turn={id:'synthetic-turn-'+(++this.serial),status:'inProgress',items:[{id:'u'+this.serial,type:'userMessage',clientId:p.clientUserMessageId,content:p.input}]};w.turns.push(turn);r={turn};}
      else if(method==='turn/steer'){w.turns.at(-1)?.items.push({id:'s'+(++this.serial),type:'userMessage',clientId:p.clientUserMessageId,content:p.input});r={turnId:p.expectedTurnId};}
      else if(method==='turn/interrupt'){const t=w.turns.find(t=>t.id===p.turnId);if(t)t.status='interrupted';r={};if(t)setImmediate(()=>this.emit('notification',{method:'turn/completed',params:{threadId:p.threadId,turn:{...t}}}));}
      else if(method==='thread/turns/list')r={data:[...w.turns].reverse(),nextCursor:null};
      else if(method==='mcpServerStatus/list')r={data:[]};
      else if(method==='thread/unsubscribe')r={};
      else throw Error('Unimplemented synthetic Worker boundary: '+method);
    }else r=await this.client.request(method,p);
    if(start)this.threads.set(r.thread.id,{role:router?'router':'worker',model:p.model});
    if(method==='thread/resume')this.threads.set(p.threadId,{role:declaredWorker||this.workers.has(p.threadId)?'worker':this.threads.get(p.threadId)?.role||'router',model:p.model});
    this.record({kind:'response',method,role,result:r});return r;
  }
  respond(id,result){if(this.requests.has(id)){this.requests.get(id)(result);this.requests.delete(id);}else this.client.respond(id,result);}
  reject(id,message){if(this.requests.has(id)){this.requests.get(id)({error:message});this.requests.delete(id);}else this.client.reject(id,message);}
  async tool(threadId,turnId,tool,args){return new Promise(resolve=>{const id='synthetic-request-'+(++this.serial);this.requests.set(id,resolve);this.emit('request',{id,method:'item/tool/call',params:{threadId,turnId,tool,arguments:args}});});}
  complete(threadId,turnId,status='completed'){const t=this.workers.get(threadId)?.turns.find(t=>t.id===turnId);if(t)t.status=status;this.emit('notification',{method:'turn/completed',params:{threadId,turn:{id:turnId,status,items:t?.items||[]}}});}
  close(){this.client.close();}
}
export function taskSnapshot(system,aliases){const result={};for(const t of system.store.list('task')){const key=Object.entries(aliases).find(([,id])=>id===t.id)?.[0]||t.id;result[key]={id:t.id,title:t.title,status:t.status,manualStop:t.manualStop,generation:t.generation,threadId:t.threadId,resources:t.resources,responsibilityId:t.responsibilityId,outputFiles:t.output?artifactSnapshot(t.output).map(a=>({path:a.path,sha256:a.sha256})):[]};}return result;}
let transportSerial=100000;
export async function openFixture({root,config,realWorkers,record,workers}){
  assertTestRoot(root,path.resolve('local/conversation-validation'));fs.mkdirSync(path.join(root,'outputs'),{recursive:true});
  const localConfig={...config,ownerId:'1',chatId:'1',workspace:root,model:baseline.worker.model,reasoningEffort:baseline.worker.effort};
  const rpc=new ValidationRPC(localConfig,{realWorkers,record,workers}),sent=[],errors=[],uploads=[];
  const system=await createSystem({folder:root,config:localConfig,token:'0:test',rpc,outputRoot:path.join(root,'outputs'),telegram:async(method,p)=>{
    if(method==='getFile')return {file_path:p.file_id};const entry={method,...p,message_id:++transportSerial,at:Date.now()};sent.push(entry);record({kind:'telegram-send',...entry});return {message_id:entry.message_id};
  },onError:(e,key)=>{errors.push({message:e.message,key,at:Date.now()});record({kind:'runtime-error',message:e.message,key});}});
  if(system.settings.current.router.model!==baseline.router.model||system.settings.current.router.effort!==baseline.router.effort||system.settings.current.worker.model!==baseline.worker.model||system.settings.current.worker.effort!==baseline.worker.effort)system.settings.save({...baseline,maxWorkers:2},system.settings.current.revision);
  system.native.on('toolFailure',e=>record({kind:'tool-failure',...e}));
  for(const t of system.store.list('task'))if(t.threadId)rpc.threads.set(t.threadId,{role:'worker',model:t.executionSettings?.model});
  // Captures the real validated upload bytes at the Telegram boundary; never sends to Telegram.
  const original=system.mediaFor;system.mediaFor=(id)=>{const m=original(id);m.uploader=async(method,chatId,bytes,name,caption)=>{const upload={method,name,sha256:sha(bytes),size:bytes.length,text:/\.(md|txt)$/i.test(name)?bytes.toString('utf8'):null};uploads.push(upload);record({kind:'upload',...upload});return {message_id:20000+uploads.length};};return m;};
  system.delivery.mediaFor=system.mediaFor;
  return {system,rpc,sent,errors,uploads,config:localConfig};
}
