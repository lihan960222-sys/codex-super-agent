import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {randomBytes} from 'node:crypto';
import {createSystem,claimLock} from './system.mjs';import {ControlServer} from './control.mjs';import {atomicText} from './files.mjs';import {decryptToken,redact} from '../telegram-bridge/bridge.mjs';import {callTelegram} from '../telegram-bridge/telegram.mjs';

export async function main(configFile){
 const config=JSON.parse(fs.readFileSync(configFile,'utf8')),folder=path.dirname(configFile),stateDir=path.join(folder,'superagent-state');if(!config.ownerId||!config.chatId||!config.expectedEmail)throw Error('Existing private owner binding is required');
 const release=claimLock(stateDir);let system,control,interval,maintenance;const startedAt=Date.now();let lastPoll=null,stopping=false;
 const token=decryptToken(config);const clean=value=>redact(value,token).replace(/Bearer\s+\S+/gi,'Bearer [redacted]');const telegram=(method,params)=>callTelegram(token,method,params);
 const errors=new Map();const log=(error,key='runtime')=>{const text=clean(error?.message||error),previous=errors.get(key);if(!previous||previous.text!==text||Date.now()-previous.at>60000){fs.appendFileSync(path.join(folder,'superagent.log'),new Date().toISOString()+' '+key+' '+text+'\n');errors.set(key,{text,at:Date.now()});}
  if(system&&(key.startsWith('command:')||key.startsWith('native-answer:'))){const id=key.slice(key.indexOf(':')+1),event=system.store.get('event',id);if(event){system.store.put('event',id,{...event,status:'blocked',error:text});system.store.enqueue('reply','error:'+id,{eventId:id,text:'未完成：'+text});}}
 };
 const health=extra=>{const state={...system?.runtime.health(),running:!stopping,processId:process.pid,startedAt,entry:fileURLToPath(import.meta.url),configFile,controlUrl:control?.url,lastSuccessfulPoll:lastPoll,accountVerified:!!system,paired:true,...extra};atomicText(path.join(folder,'superagent-health.json'),JSON.stringify(state));atomicText(path.join(folder,'bridge-status.json'),JSON.stringify(state));};
 const shutdown=async(code,error)=>{if(stopping)return;stopping=true;clearInterval(interval);clearInterval(maintenance);if(error)log(error);try{health({running:false,error:error?clean(error.message):null})}catch{};system?.native.close();system?.rpc.close();try{await control?.close()}catch{};try{await system?.close()}catch{};release();process.exitCode=code;};
 try{
  const me=await telegram('getMe'),hook=await telegram('getWebhookInfo');if(hook.url)throw Error('Existing webhook prevents a second Telegram consumer');
  system=await createSystem({folder,config,token,telegram,onError:log});system.native.on('disconnected',e=>{log(e,'native-disconnected');setTimeout(()=>void shutdown(1,e),100);});
  const controlTokenFile=path.join(stateDir,'control.token');if(!fs.existsSync(controlTokenFile))fs.writeFileSync(controlTokenFile,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});const controlToken=fs.readFileSync(controlTokenFile,'utf8');
  control=new ControlServer({runtime:system.runtime,token:controlToken,maxRepairs:system.settings.current.watchdogLimits.maxRepairs});await control.listen();
  await telegram('setMyCommands',{commands:[{command:'settings',description:'设置'},{command:'model',description:'模型'},{command:'permissions',description:'权限'},{command:'status',description:'状态'},{command:'stop',description:'停止'},{command:'help',description:'帮助'}]});
  interval=setInterval(()=>{if(stopping)return;try{system.runtime.pump();health({botUsername:me.username})}catch(e){log(e);}},1000);
  maintenance=setInterval(()=>{if(stopping)return;system.runtime.track('observe',()=>system.observer.scan());try{system.settings.load();system.knowledge.reconcile()}catch(e){log(e,'settings-file');}},60000);
  process.once('SIGINT',()=>void shutdown(0));process.once('SIGTERM',()=>void shutdown(0));process.on('uncaughtException',e=>void shutdown(1,e));process.on('unhandledRejection',e=>void shutdown(1,e));health({botUsername:me.username});
  while(!stopping){let updates;try{updates=await telegram('getUpdates',{offset:(system.store.get('meta','telegram')?.lastUpdate??-1)+1,timeout:25,allowed_updates:['message','callback_query']});lastPoll=new Date().toISOString();}catch(e){if(stopping)break;log(e,'telegram-poll');if(!e.transient)throw e;await new Promise(r=>setTimeout(r,5000));continue;}if(stopping)break;for(const update of updates)system.runtime.receive(update);system.runtime.pump();}
 }catch(e){await shutdown(1,e);throw Error(clean(e.message));}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(path.resolve(process.argv[2]||'config.json')).catch(e=>{console.error(e.message);process.exitCode=1;});
