import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {LocalClient} from '../telegram-bridge/client.mjs';
export class Client extends LocalClient {request(method,params={}){return super.request(method,method==='initialize'?{...params,capabilities:{experimentalApi:true}}:params);}}
export const coordinatorConfig={web_search:'disabled',features:{apps:false,plugins:false,remote_plugin:false,browser_use:false,browser_use_external:false,computer_use:false,multi_agent:false,shell_tool:false,unified_exec:false,image_generation:false,skill_search:false,skill_mcp_dependency_install:false,goals:false,code_mode_host:false,workspace_dependencies:false}};

/** One connection, explicit owned-thread bindings; never retry an unacknowledged turn here. */
export class Native extends EventEmitter {
  constructor(rpc){super();this.rpc=rpc;this.bindings=new Map();this.waiters=new Map();this.onNotification=m=>this.observe(m);this.onRequest=m=>void this.handle(m);this.onFailure=e=>{for(const w of this.waiters.values())w.reject(e);this.emit('disconnected',e);};rpc.on('notification',this.onNotification);rpc.on('request',this.onRequest);rpc.on('failure',this.onFailure);}
  bind(id,binding){this.bindings.set(id,binding);}
  async verifyCoordinator(threadId){let cursor;do{const r=await this.rpc.request('mcpServerStatus/list',{threadId,limit:100,detail:'toolsAndAuthOnly',...(cursor?{cursor}:{})});if(!Array.isArray(r.data))throw Error('Cannot verify coordinator external tools');if(r.data.some(s=>Object.keys(s.tools||{}).length))throw Error('Coordinator has external MCP tools');if(r.nextCursor&&r.nextCursor===cursor)throw Error('Invalid external tool pagination');cursor=r.nextCursor;}while(cursor);}
  unbind(id){this.bindings.delete(id);}
  async handle(m){const binding=this.bindings.get(m.params?.threadId);if(!binding){this.rpc.reject(m.id,'Unknown session');return;}
    try{
      if(m.method==='item/tool/call'){
        if(!binding.tool)throw Error('No dynamic tools in this session');const result=await binding.tool(m.params.tool,m.params.arguments,m.params);
        this.rpc.respond(m.id,{success:true,contentItems:[{type:'inputText',text:JSON.stringify(result??{})}]});
      }else if(binding.approval)await binding.approval(m);else this.rpc.reject(m.id,'This role cannot request execution permissions');
    }catch(e){try{if(m.method==='item/tool/call')this.rpc.respond(m.id,{success:false,contentItems:[{type:'inputText',text:String(e.message).slice(0,1500)}]});else this.rpc.reject(m.id,String(e.message).slice(0,1500));}catch{}this.emit('toolFailure',{threadId:m.params?.threadId,method:m.method,error:e.message});}
  }
  observe(m){const p=m.params||{},binding=this.bindings.get(p.threadId);if(!binding)return;const waiter=this.waiters.get(p.threadId);
    if(waiter){const id=p.turnId||p.turn?.id;if(id){let turn=waiter.turns.get(id);if(!turn){turn={items:new Map(),turn:null};waiter.turns.set(id,turn);}
      if(m.method==='item/completed'&&p.item?.type==='agentMessage')turn.items.set(p.item.id,p.item.text||'');
      if(m.method==='turn/completed')turn.turn=p.turn;
      if(waiter.turnId===id&&turn.turn)waiter.resolve({turn:turn.turn,text:[...turn.items.values()].join('\n')});
    }}
    binding.observe?.(m);this.emit('notification',m);
  }
  async start(params,binding){const r=await this.rpc.request('thread/start',{allowProviderModelFallback:false,...params});this.bind(r.thread.id,binding);return r;}
  async unload(id){await this.rpc.request('thread/unsubscribe',{threadId:id});const deadline=Date.now()+20000;while(true){let cursor,found=false;do{const r=await this.rpc.request('thread/loaded/list',{limit:100,...cursor?{cursor}:{}});if(!Array.isArray(r.data))throw Error('Cannot verify native session unload');found||=r.data.includes(id);cursor=r.nextCursor;}while(cursor&&!found);if(!found){this.unbind(id);return;}if(Date.now()>deadline)throw Error('Native session remains loaded; capability change not applied');await new Promise(r=>setTimeout(r,250));}}
  async resume(id,params,binding){this.bind(id,binding);try{return await this.rpc.request('thread/resume',{threadId:id,excludeTurns:true,...params});}catch(e){this.unbind(id);throw e;}}
  async turn(id,text,{timeoutMs=90000,clientUserMessageId=randomUUID(),onStarted,...params}={}){
    if(!this.bindings.has(id))throw Error('Unknown session');if(this.waiters.has(id))throw Error('Session already has a waiting turn');
    let timer;const w={turnId:null,turns:new Map()};const done=new Promise((resolve,reject)=>{Object.assign(w,{resolve,reject});timer=setTimeout(()=>reject(Error('Native turn deadline exceeded')),timeoutMs);});done.catch(()=>{});this.waiters.set(id,w);
    try{const r=await this.rpc.request('turn/start',{threadId:id,clientUserMessageId,input:Array.isArray(text)?text:[{type:'text',text}],...params});w.turnId=r.turn.id;await onStarted?.(r.turn.id);
      const early=w.turns.get(w.turnId);if(early?.turn)w.resolve({turn:early.turn,text:[...early.items.values()].join('\n')});const result=await done;
      if(result.turn.status!=='completed')throw Error(result.turn.error?.message||'Turn '+result.turn.status);return result;
    }finally{clearTimeout(timer);this.waiters.delete(id);}
  }
  async interrupt(threadId,turnId){if(!this.bindings.has(threadId)||!turnId)return;return this.rpc.request('turn/interrupt',{threadId,turnId});}
  close(){for(const w of this.waiters.values())w.reject(Error('Native adapter closed'));this.rpc.off('notification',this.onNotification);this.rpc.off('request',this.onRequest);this.rpc.off('failure',this.onFailure);this.bindings.clear();}
}
