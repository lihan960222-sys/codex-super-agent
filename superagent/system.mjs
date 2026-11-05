import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {Store} from './store.mjs';import {Core} from './core.mjs';import {Routing} from './routing.mjs';import {Settings} from './settings.mjs';import {TaskFiles,atomicText} from './files.mjs';import {Knowledge} from './knowledge.mjs';import {Client,Native} from './native.mjs';import {Router} from './router.mjs';import {Scheduler} from './scheduler.mjs';import {Executor} from './executor.mjs';import {Delivery} from './delivery.mjs';import {Controls} from './controls.mjs';import {Approvals} from './approvals.mjs';import {Observer} from './supervision.mjs';import {Runtime} from './runtime.mjs';import {importLegacy} from './migration.mjs';import {Media} from '../telegram-bridge/media.mjs';
export function claimLock(folder){fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,'coordinator.lock'),nonce=randomUUID();
 if(fs.existsSync(file)){const old=JSON.parse(fs.readFileSync(file,'utf8'));let alive=true;try{process.kill(old.pid,0)}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}if(alive)throw Error('A coordinator is already running');fs.unlinkSync(file);}
 fs.writeFileSync(file,JSON.stringify({pid:process.pid,nonce,at:Date.now()}),{flag:'wx'});return ()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).nonce===nonce)fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}};
}
export async function createSystem({folder,config,token,telegram,rpc=new Client(config),outputRoot,onError=()=>{}}){
 const stateDir=path.join(folder,'superagent-state');fs.mkdirSync(stateDir,{recursive:true});const store=new Store(path.join(stateDir,'state.sqlite')),core=new Core(store),settings=new Settings(path.join(folder,'superagent-settings.json'),config);
 if(outputRoot){settings.current.outputRoot=outputRoot;atomicText(settings.file,JSON.stringify(settings.current,null,2));}
 const root=()=>settings.current.outputRoot;const files={get root(){return root()}};for(const method of ['assertOwned','directory','domain','create','renderProgress'])files[method]=(...args)=>new TaskFiles(root())[method](...args);
 const routing=new Routing(core,{revision:()=>settings.current.revision,maxBatch:settings.current.routerLimits.cards}),native=new Native(rpc),knowledge=new Knowledge({store,files}),scheduler=new Scheduler(core,{capacity:()=>settings.current.maxWorkers}),observer=new Observer({store,core,files,settings});
 try{
  await rpc.connect();const account=await rpc.request('account/read');if(account.account?.email?.toLowerCase()!==config.expectedEmail?.toLowerCase())throw Error('Codex account differs from the authorized local account');
  const oldFile=path.join(folder,'state.json');if(fs.existsSync(oldFile))importLegacy(store,JSON.parse(fs.readFileSync(oldFile,'utf8')));
  const mediaCache=new Map();const mediaFor=taskId=>{const task=taskId?core.task(taskId):null,workspace=task?.directories?.work||root(),key=taskId||'inbox';if(!mediaCache.has(key)||mediaCache.get(key).config.workspace!==workspace)mediaCache.set(key,new Media({folder,config:{...config,workspace},token,telegram}));return mediaCache.get(key);};
  const delivery=new Delivery({store,routing,telegram,chatId:config.chatId,mediaFor}),controls=new Controls({store,core,settings,delivery,native,telegram}),approvals=new Approvals({store,core,native,delivery,telegram});
  const router=new Router({store,routing,native,settings,cwd:stateDir,files,catalog:()=>controls.catalog()}),executor=new Executor({core,routing,native,files,settings,scheduler,knowledge,observer,approval:(task,request)=>approvals.present(task,request),prepareInput:async(task,input)=>[...(input.media||[]),{type:'text',text:mediaFor(task.id).instructions(task.directories.output)}]});
  delivery.compose=(key,payload)=>router.compose(key,payload);delivery.stamp=p=>router.stamp(p);
  delivery.validate=(text,p)=>router.validateStyle(text,{eventText:store.get('event',p.eventId||'')?.text,requiredText:p.question});routing.executionReason=id=>scheduler.reason(id);controls.executionReason=id=>scheduler.reason(id);
  const runtime=new Runtime({store,core,routing,config,settings,router,executor,scheduler,knowledge,observer,delivery,controls,approvals,mediaFor,onError,prepareMedia:async event=>{const inbox=files.directory(path.join(root(),'收件'));const media=new Media({folder,config:{...config,workspace:inbox},token,telegram});return media.prepare(event.message);}});
  native.on('notification',m=>{if(m.method==='serverRequest/resolved')approvals.resolved(m.params.requestId);});
  for(const old of store.list('approval','pending'))store.put('approval',old.id,{...old,status:'expired-connection'});
  await runtime.recover();
  return {store,core,routing,native,rpc,settings,files,knowledge,scheduler,observer,router,executor,delivery,controls,approvals,runtime,mediaFor,stateDir,async close(){native.close();rpc.close();await Promise.allSettled([...runtime.jobs.values()]);store.close();}};
 }catch(e){native.close();rpc.close();store.close();throw e;}
}
