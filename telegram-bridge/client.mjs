import {EventEmitter} from 'node:events';
import {spawn,spawnSync} from 'node:child_process';
import {Duplex} from 'node:stream';
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';

export class LocalClient extends EventEmitter {
  constructor(config){super();this.config=config;this.pending=new Map();this.nextId=0;this.closed=false;}
  async connect() {
    const {config}=this;
    const env={...process.env,CODEX_HOME:config.home};
    // This standalone client does not borrow the desktop app's per-chat tool pipe.
    delete env.CODEX_APP_TOOLS_PIPE_PATH;
    const version=spawnSync(config.cli,['app-server','daemon','version'],{env,windowsHide:true,encoding:'utf8',timeout:15000});
    let running=false;
    try{running=JSON.parse(version.stdout.trim().split('\n').at(-1)).status==='running'}catch{}
    const start=running?{status:0}:spawnSync(config.cli,['app-server','daemon','start'],{env,windowsHide:true,encoding:'utf8',timeout:30000});
    if(start.error||start.status!==0){
      const clean=value=>String(value||'').replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g,'$1?[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]');
      const detail={cli:config.cli,status:start.status,errorCode:start.error?.code,error:clean(start.error?.message),stdout:clean(start.stdout).slice(-6000),stderr:clean(start.stderr).slice(-6000),userProfile:env.USERPROFILE,localAppData:env.LOCALAPPDATA};
      if(config.diagnosticFile)writeFileSync(config.diagnosticFile,JSON.stringify(detail,null,2));
      throw Error('Local Codex daemon could not start: '+(detail.errorCode||detail.stderr||detail.stdout||String(detail.status)).slice(0,1000));
    }
    this.child=spawn(config.cli,['app-server','proxy','--sock',config.home+'\\app-server-control\\app-server-control.sock'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stderr.resume();
    this.child.on('error',e=>this.fail(e));
    this.child.on('exit',()=>{if(!this.closed)this.fail(Error('Local Codex proxy disconnected.'))});
    const {Agent,WebSocket}=createRequire(import.meta.url)(config.undici);
    let connected=false;
    this.agent=new Agent({connect:(_opts,cb)=>{if(connected){cb(Error('Unexpected second local transport connection'));return}connected=true;cb(null,Duplex.from({readable:this.child.stdout,writable:this.child.stdin}))}});
    this.ws=new WebSocket('ws://localhost/',{dispatcher:this.agent});
    this.ws.addEventListener('message',e=>{
      let message;try{message=JSON.parse(e.data)}catch{this.fail(Error('Invalid local RPC response'));return}
      const waiting=this.pending.get(message.id);
      if(waiting&&!message.method) {
        clearTimeout(waiting.timer);this.pending.delete(message.id);
        if(message.error)waiting.reject(Object.assign(Error(message.error.message||'Codex rejected the request'),{code:message.error.code}));else waiting.resolve(message.result);
      } else if(message.method&&message.id!==undefined)this.emit('request',message);
      else if(message.method)this.emit('notification',message);
    });
    this.ws.addEventListener('close',()=>{if(!this.closed)this.fail(Error('Local Codex connection closed.'))});
    this.ws.addEventListener('error',()=>{if(!this.closed)this.fail(Error('Local Codex transport failed.'))});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Local connection handshake timed out')),15000);
      this.ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});
      this.ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Local connection handshake failed'))},{once:true});
    });
    const info=await this.request('initialize',{clientInfo:{name:'hanli_private_telegram',title:'Hanli private Telegram client',version:'0.1.0'}});
    if(info.platformFamily!=='windows'||info.codexHome.toLowerCase()!==config.home.toLowerCase())throw Error('The connected Codex instance does not match this Windows profile.');
    this.ws.send(JSON.stringify({method:'initialized'}));
    return info;
  }
  request(method,params={}) {
    if(this.closed||this.ws?.readyState!==1)return Promise.reject(Error('Codex is not connected'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`No confirmation for ${method}; do not automatically repeat it.`))},45000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.ws.send(JSON.stringify({id,method,params}))}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e)}
    });
  }
  respond(id,result){if(this.closed)throw Error('Approval was not sent: local connection closed');this.ws.send(JSON.stringify({id,result}))}
  reject(id,message){if(!this.closed)this.ws.send(JSON.stringify({id,error:{code:-32601,message}}))}
  fail(error){if(this.closed)return;this.close();this.emit('failure',error)}
  close(){this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Local client disconnected'))}this.pending.clear();this.ws?.close();this.child?.kill();this.agent?.destroy().catch(()=>{});}
}
