// Isolated native capability check. No Telegram requests or production state writes.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalClient} from '../telegram-bridge/client.mjs';
class ProbeClient extends LocalClient {
  request(method,params={}) {return super.request(method,method==='initialize'?{...params,capabilities:{experimentalApi:true}}:params)}
}
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const output=resolve(process.argv[3]);const cwd=resolve('work/superagent/native-probe');mkdirSync(cwd,{recursive:true});
const result={at:new Date().toISOString(),threads:[],checks:{},events:[]};
const rpc=new ProbeClient(config),waiting=new Map();let known=new Set();
const nonce='CAPABILITY_'+randomUUID();
rpc.on('failure',e=>{for(const w of waiting.values())w.reject(e)});
rpc.on('request',m=>{
  if(m.method==='item/tool/call'&&known.has(m.params.threadId)&&m.params.tool==='router_probe'){
    result.checks.dynamicTool=true;rpc.respond(m.id,{success:true,contentItems:[{type:'inputText',text:nonce}]});
  }else {result.unexpectedRequest=m.method;rpc.reject(m.id,'Probe does not authorize this operation.')}
});
rpc.on('notification',m=>{
  if(!known.has(m.params?.threadId))return;
  const w=waiting.get(m.params.threadId);
  if(m.method==='thread/tokenUsage/updated'){result.checks.usage=true;result.usage=m.params.tokenUsage;}
  if(m.method==='item/completed'){
    const item=m.params.item;result.events.push({method:m.method,type:item.type});
    if(item.type==='agentMessage'&&w)w.text+=(item.text||'');
    if(item.type==='commandExecution')result.commandAttempted=true;
  }
  if(m.method==='turn/completed'&&w){w.resolve({turn:m.params.turn,text:w.text});waiting.delete(m.params.threadId)}
});
async function turn(threadId,text){
  let timer;const done=new Promise((resolve,reject)=>{waiting.set(threadId,{resolve,reject,text:''});timer=setTimeout(()=>reject(Error('Native turn timeout')),120000)});done.catch(()=>{});
  try{const r=await rpc.request('turn/start',{threadId,model:result.model,effort:result.effort,input:[{type:'text',text}]});const answer=await done;if(answer.turn.status!=='completed')throw Error(answer.turn.error?.message||answer.turn.status);return {...answer,id:r.turn.id};}
  finally{clearTimeout(timer);waiting.delete(threadId)}
}
try{
  await rpc.connect();const account=await rpc.request('account/read');
  if(account.account?.email?.toLowerCase()!==config.expectedEmail.toLowerCase())throw Error('Account identity mismatch');
  result.checks.account=true;
  const catalog=(await rpc.request('model/list',{limit:100,includeHidden:false})).data;
  result.catalog=catalog.map(x=>({model:x.model,efforts:x.supportedReasoningEfforts?.map(e=>e.reasoningEffort)}));
  const selected=catalog.find(x=>x.model===config.model);if(!selected)throw Error('Selected model unavailable');
  result.model=selected.model;result.effort=selected.supportedReasoningEfforts?.find(x=>x.reasoningEffort==='low')?.reasoningEffort||selected.defaultReasoningEffort;
  const start=await rpc.request('thread/start',{cwd,model:result.model,environments:[],sandbox:'read-only',approvalPolicy:'never',
    developerInstructions:'You are an isolated capability probe. Use only the router_probe function when requested. Do not read credentials, search the web or perform unrelated tasks.',
    dynamicTools:[{type:'function',name:'router_probe',description:'Return a one-time probe verification code.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]});
  const id=start.thread.id;known.add(id);result.threads.push(id);result.checks.start=true;
  const first=await turn(id,'Call router_probe once, then reply with its returned verification code only.');
  result.checks.toolRoundtrip=first.text.includes(nonce);
  const resumed=await rpc.request('thread/resume',{threadId:id,excludeTurns:true});result.checks.resume=resumed.thread.id===id;
  const second=await turn(id,'Environment-boundary verification: try to execute the harmless shell command echo ENVIRONMENT_PROBE. If no execution tool or environment is available, say ENVIRONMENT_DISABLED. Do not request permissions.');
  result.boundaryAnswer=second.text;result.checks.environmentDisabled=!result.commandAttempted&&/ENVIRONMENT_DISABLED/.test(second.text);
  await rpc.request('thread/inject_items',{threadId:id,items:[{type:'message',role:'user',content:[{type:'input_text',text:'Durable non-waking probe fact: INJECTION_VERIFIED'}]}]});result.checks.inject=true;
  const third=await turn(id,'State the durable non-waking probe fact just given, and nothing else.');result.checks.injectRecall=third.text.includes('INJECTION_VERIFIED');
  result.verified=Object.values(result.checks).every(Boolean)&&!result.unexpectedRequest;
}catch(e){result.error=e.message;process.exitCode=1}
finally{for(const id of known)await rpc.request('thread/unsubscribe',{threadId:id}).catch(()=>{});rpc.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
