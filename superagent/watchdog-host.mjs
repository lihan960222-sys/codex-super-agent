import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {claimLock} from './system.mjs';
import {Client,Native} from './native.mjs';import {Watchdog} from './watchdog.mjs';import {atomicText} from './files.mjs';
const run=promisify(execFile);
export async function requestLocal(base,token,endpoint,body){const url=new URL(base);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||!['/snapshot','/act'].includes(endpoint))throw Error('Only local control endpoints are permitted');return new Promise((resolve,reject)=>{const payload=body?JSON.stringify(body):null;const req=http.request({hostname:'127.0.0.1',port:url.port,path:endpoint,method:payload?'POST':'GET',headers:{authorization:'Bearer '+token,...payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}},timeout:10000},res=>{let text='',length=0;res.on('data',c=>{length+=c.length;if(length>1_000_000){req.destroy(Error('Control response too large'));return;}text+=c;});res.on('end',()=>{try{const value=JSON.parse(text);if(res.statusCode!==200)throw Error(value.error||'Control action rejected ('+res.statusCode+')');resolve(value);}catch(e){reject(e);}});});req.on('timeout',()=>req.destroy(Error('Local coordinator timed out')));req.on('error',reject);if(payload)req.write(payload);req.end();});}
export async function terminateStale(health,expected){
 if(!Number.isInteger(health.processId)||health.processId===process.pid||health.entry!==expected.entry||path.resolve(health.configFile||'')!==path.resolve(expected.configFile))return {stopped:false,reason:'identity-mismatch'};
 const script=`$ErrorActionPreference='Stop'
$targetProcessId=[int]$env:SA_TARGET_PID
$target=Get-CimInstance Win32_Process -Filter ('ProcessId='+$targetProcessId)
if(-not $target){'{"stopped":false,"reason":"already-exited"}';exit 0}
if([IO.Path]::GetFullPath($target.ExecutablePath) -ine [IO.Path]::GetFullPath($env:SA_NODE)){throw 'Executable mismatch'}
foreach($required in @($env:SA_ENTRY,$env:SA_CONFIG)){if($target.CommandLine -notmatch ('(^|[\\s"])+(["]?)'+[regex]::Escape($required)+'(["]?)([\\s]|$)')){throw 'Command line mismatch'}}
$created=[DateTimeOffset]$target.CreationDate
if([Math]::Abs($created.ToUnixTimeMilliseconds()-[double]$env:SA_STARTED) -gt 5000){throw 'Process creation time mismatch'}
Stop-Process -Id $targetProcessId -Force
'{"stopped":true}'`;
 const {stdout}=await run(expected.powershell||'powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,env:{...process.env,SA_TARGET_PID:String(health.processId),SA_ENTRY:expected.entry,SA_CONFIG:expected.configFile,SA_NODE:expected.node,SA_STARTED:String(health.startedAt)}});return JSON.parse(stdout.trim());
}
export async function watchMain(configFile){const config=JSON.parse(fs.readFileSync(configFile,'utf8')),folder=path.dirname(configFile),stateDir=path.join(folder,'superagent-state'),stateFile=path.join(stateDir,'watchdog-state.json');fs.mkdirSync(stateDir,{recursive:true});const release=claimLock(path.join(stateDir,'watchdog'));process.once('exit',release);let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{},client,native,failures=0;
 const getNative=async()=>{if(native)return native;client=new Client(config);await client.connect();const account=await client.request('account/read');if(account.account?.email?.toLowerCase()!==config.expectedEmail.toLowerCase())throw Error('Watchdog account mismatch');native=new Native(client);native.on('disconnected',()=>{native=null;});return native;};
 const lazy={verifyCoordinator:async(...args)=>(await getNative()).verifyCoordinator(...args),interrupt:async(...args)=>(await getNative()).interrupt(...args),start:async(...args)=>(await getNative()).start(...args),turn:async(...args)=>(await getNative()).turn(...args),unbind:id=>native?.unbind(id)};
 for(;;){let settings,health;try{
   settings=JSON.parse(fs.readFileSync(path.join(folder,'superagent-settings.json'),'utf8'));health=JSON.parse(fs.readFileSync(path.join(folder,'superagent-health.json'),'utf8'));const token=fs.readFileSync(path.join(stateDir,'control.token'),'utf8');
   if(Date.now()-Date.parse(health.at)>120000)throw Error('Coordinator heartbeat is stale');
   const watchdog=new Watchdog({native:lazy,request:(endpoint,body)=>requestLocal(health.controlUrl,token,endpoint,body),settings,state,cwd:stateDir,save:next=>{state=next;atomicText(stateFile,JSON.stringify(state));}});await watchdog.check();failures=0;atomicText(path.join(folder,'watchdog-status.json'),JSON.stringify({running:true,processId:process.pid,at:new Date().toISOString()}));
  }catch(e){failures++;atomicText(path.join(folder,'watchdog-status.json'),JSON.stringify({running:true,processId:process.pid,at:new Date().toISOString(),error:String(e.message).slice(0,1000),failures}));
   if(failures>=3&&health&&Date.now()-Date.parse(health.at)>120000){try{const recovery=await terminateStale(health,{entry:fileURLToPath(new URL('./bridge.mjs',import.meta.url)),configFile,node:config.node,powershell:config.powershell});atomicText(path.join(stateDir,'watchdog-recovery.json'),JSON.stringify({at:Date.now(),...recovery}));}catch(recoveryError){atomicText(path.join(stateDir,'watchdog-recovery.json'),JSON.stringify({at:Date.now(),stopped:false,error:recoveryError.message}));}}
  }
  await new Promise(r=>setTimeout(r,Math.min(settings?.watchdogLimits?.pollMs||60000,60000)));
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))watchMain(path.resolve(process.argv[2])).catch(e=>{console.error(e.message);process.exitCode=1;});
