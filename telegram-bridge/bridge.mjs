import {readFileSync,existsSync,appendFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalClient} from './client.mjs';
import {Controller,writeJson} from './controller.mjs';
import {callTelegram} from './telegram.mjs';
import {Media} from './media.mjs';
import {ProjectFolders} from './projects.mjs';

export const redact=(message,token)=>String(message).split(token||'\0').join('[redacted]').replace(/bot\d+:[A-Za-z0-9_-]+/g,'bot[redacted]');

export function decryptToken(config) {
  const env={...process.env,CODEX_TELEGRAM_TOKEN_FILE:config.tokenFile};
  for(const key of Object.keys(env))if(key.toUpperCase()==='PSMODULEPATH')delete env[key];
  const decrypt=spawnSync(config.powershell,['-NoProfile','-NonInteractive','-Command',"$s=Get-Content -LiteralPath $env:CODEX_TELEGRAM_TOKEN_FILE -Raw | ConvertTo-SecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }"],{env,windowsHide:true,encoding:'utf8',timeout:10000});
  if(decrypt.status!==0)throw Error('The locally encrypted bot credential could not be opened by this Windows user.');
  return decrypt.stdout.trim();
}

async function main() {
  const configFile=resolve(process.argv[2]||'config.json');
  const folder=dirname(configFile);
  const config=JSON.parse(readFileSync(configFile,'utf8'));
  let token=process.env.TELEGRAM_BOT_TOKEN;
  if(!token&&config.tokenFile&&existsSync(config.tokenFile)) {
    token=decryptToken(config);
  }
  if(!token){console.log('Waiting for local Telegram bot credential setup. No Telegram connection was opened.');return;}
  delete process.env.TELEGRAM_BOT_TOKEN;
  let rpc;
  const statusFile=resolve(folder,'bridge-status.json');
  const status=(value)=>writeJson(statusFile,{updatedAt:new Date().toISOString(),...value});
  const log=(message)=>{const line=new Date().toISOString()+' '+redact(message,token);console.log(line);appendFileSync(resolve(folder,'bridge.log'),line+'\n');};
  const fail=(error)=>{const message=redact(error?.message||error,token);log(message);status({running:false,error:message});rpc?.close();process.exit(1);};
  process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
  const telegram=(method,params={})=>callTelegram(token,method,params);
  try {
  const me=await telegram('getMe');
  const hook=await telegram('getWebhookInfo');
  if(hook.url)throw Error('This bot already has a webhook. Use a dedicated new bot; the existing webhook was left unchanged.');
  config.botUsername=me.username;writeJson(configFile,config);
  rpc=new LocalClient({...config,diagnosticFile:resolve(folder,'daemon-start-diagnostic.json')});rpc.on('failure',fail);
  let controller;
  const prompts=new Map(),presenting=new Set();
  let deliveryError='',lastPoll=null,maintaining=false;
  const health=()=>status({running:true,processId:process.pid,accountVerified:!!controller,botUsername:me.username,paired:!!config.ownerId,lastSuccessfulPoll:lastPoll,pendingReplies:controller?.state.outbox.length||0,pendingPrompts:prompts.size,awaitingOwnerApproval:controller?.approvals.size||0,deliveryError:deliveryError||null});
  const recoverable=error=>{if(!error.transient)fail(error);const message=redact(error.message,token);if(deliveryError!==message)log(message);deliveryError=message;health();};
  const present=async request=>{
    if(!prompts.has(request.id)||presenting.has(request.id))return;
    presenting.add(request.id);
    try{await controller.onRequest(request);prompts.delete(request.id)}finally{presenting.delete(request.id)}
  };
  // Notification delivery is ordered; approvals and owner messages remain independently responsive.
  let notifications=Promise.resolve();
  rpc.on('notification',m=>{controller?.observe(m);if(m.method==='serverRequest/resolved')prompts.delete(m.params.requestId);notifications=notifications.then(()=>controller?.onNotification(m)).catch(recoverable)});
  rpc.on('request',m=>{if(controller){prompts.set(m.id,m);present(m).catch(recoverable)}else rpc.reject(m.id,'Client is initializing; no permission granted.')});
  await rpc.connect();
  const account=await rpc.request('account/read');
  if(account.account?.email?.toLowerCase()!==config.expectedEmail.toLowerCase())throw Error('Codex account differs from the locally authorized account.');
  const media=new Media({config,folder,token,telegram});
  const projects=new ProjectFolders({config,rpc});
  controller=new Controller({config,stateFile:resolve(folder,'state.json'),rpc,telegram,media,projects,saveConfig:c=>writeJson(configFile,c)});
  try{await controller.resume()}catch(e){recoverable(e)}
  if(controller.state.preparingInput){controller.state.preparingInput=false;controller.queueDelivery('input-restart:'+controller.state.lastUpdate,'上次操作被重启打断。已恢复保存的会话，没有自动重复任务；请用 /status 核实后再继续。');controller.save();}
  health();
  setInterval(async()=>{
    if(maintaining)return;maintaining=true;
    try{await controller.flushOutbox();for(const request of prompts.values())await present(request);deliveryError='';health()}catch(e){recoverable(e)}finally{maintaining=false}
  },5000);
  log('Telegram client connected to verified local Windows Codex.');
  let lastError='';
  while(true) {
    let updates;
    try{updates=await telegram('getUpdates',{offset:controller.state.lastUpdate+1,timeout:25,allowed_updates:['message','callback_query']});lastError='';lastPoll=new Date().toISOString();}
    catch(e){if(!e.transient)fail(e);if(lastError!==e.message){log(e.message);lastError=e.message;}health();await new Promise(r=>setTimeout(r,5000));continue;}
    for(const update of updates)try{await controller.handle(update)}catch(e){recoverable(e)}
    health();
  }
  } catch(error) { fail(error); }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{
  const error=redact(e.message,process.env.TELEGRAM_BOT_TOKEN);
  try{writeJson(resolve(dirname(resolve(process.argv[2]||'config.json')),'bridge-status.json'),{updatedAt:new Date().toISOString(),running:false,error})}catch{}
  console.error(error);process.exitCode=1;
});
