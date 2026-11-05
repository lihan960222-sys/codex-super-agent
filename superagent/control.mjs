import http from 'node:http';import {timingSafeEqual} from 'node:crypto';import {Guard} from './supervision.mjs';
export class ControlServer {
 constructor({runtime,token,maxRepairs=2}){this.runtime=runtime;this.token=token;this.guard=new Guard({maxRepairs});this.server=http.createServer((req,res)=>void this.handle(req,res));this.server.requestTimeout=10000;this.server.headersTimeout=10000;}
 async listen(){await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',resolve);});this.url='http://127.0.0.1:'+this.server.address().port;return this.url;}
 async close(){await new Promise(r=>{this.server.closeAllConnections();this.server.close(r)});}
 async handle(req,res){const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};const got=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+this.token);if(got.length!==expected.length||!timingSafeEqual(got,expected))return reply(401,{error:'Unauthorized'});
  try{if(req.url==='/snapshot'&&req.method==='GET')return reply(200,this.runtime.health());if(req.url!=='/act'||req.method!=='POST')return reply(404,{error:'Unknown operation'});let bytes=0,body='';for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return reply(413,{error:'Request too large'});body+=chunk;}const action=JSON.parse(body);const applied=this.act(action);reply(applied?200:409,{accepted:applied});}catch(e){reply(400,{error:e.message});}
 }
 act(action){const {store,core}=this.runtime;return store.atomic(()=>{
  if(typeof action.repairId!=='string'||!action.repairId||action.repairId.length>100)throw Error('Invalid repair identifier');if(store.get('repair',action.repairId))return true;
  const attempts=store.get('meta','repair-attempts')||{};if(!this.guard.authorize(core.snapshot(),action,attempts)){const t=store.get('task',action.taskId);if(t&&!t.manualStop&&!core.snapshot().paused&&attempts[t.id]>=this.guard.maxRepairs)store.enqueue('reply','repair-limit:'+t.id,{taskId:t.id,text:'任务自动恢复已达到上限，需要检查当前停点。进度和原会话已保留。'});return false;}const task=core.task(action.taskId);
  if(action.action==='reconcile')store.enqueue('reconcile',task.id,{taskId:task.id});
  else if(action.action==='request_status'){const event={id:'watchdog:'+action.repairId,source:'watchdog',text:'Status check only: use worker_report to state current progress, concrete blocker or expected external wait. Continue only the existing authorized task. Evidence: '+String(action.reason).slice(0,1000)};core.receive(event);core.addInput(event,task.id);store.enqueue('delivery',event.id,{taskId:task.id,inputId:event.id+':'+task.id});}
  else if(action.action==='interrupt_replan'){store.put('task',task.id,{...task,repair:{id:action.repairId,generation:task.generation,reason:String(action.reason).slice(0,1000)}});core.queueInterrupt(task);store.enqueue('reconcile',task.id,{taskId:task.id});}
  store.put('meta','repair-attempts',attempts);store.put('repair',action.repairId,{...action,at:Date.now()});return true;
 });}
}
