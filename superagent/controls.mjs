import {randomUUID} from 'node:crypto';
const effortName=x=>({low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',ultra:'极高'}[x]||x)+' ('+x+')';
export class Controls {
 constructor(deps){Object.assign(this,deps);}
 async catalog(){if(this.cached&&Date.now()-this.cached.at<300000)return this.cached.models;const models=[];let cursor;do{const r=await this.native.rpc.request('model/list',{limit:100,includeHidden:false,...cursor?{cursor}:{}});models.push(...r.data);cursor=r.nextCursor;if(models.length>1000)throw Error('Model catalog too large');}while(cursor);this.cached={at:Date.now(),models};return models;}
 async check(model,effort){const entry=(await this.catalog()).find(x=>x.model===model);if(!entry)throw Error('Requested model unavailable');if(!entry.supportedReasoningEfforts?.some(x=>x.reasoningEffort===effort))throw Error('Unsupported model effort');}
 async apply(p){
  if(p.effectId&&this.store.get('setting-applied',p.effectId))return;
  if(p.effectId&&!p.responsibilityId&&this.settings.current.revision>p.revision&&p.patch&&Object.entries(p.patch).every(([k,v])=>v&&typeof v==='object'?Object.entries(v).every(([field,value])=>this.settings.current[k]?.[field]===value):this.settings.current[k]===v)){this.store.put('setting-applied',p.effectId,{at:Date.now(),reconciled:true});return;}
  if(p.responsibilityId){const r=this.store.get('responsibility',p.responsibilityId);if(!r||r.revision!==p.revision)throw Error('Stale responsibility revision');await this.check(p.model,p.effort);this.store.put('responsibility',r.id,{...r,revision:r.revision+1,settings:{model:p.model,effort:p.effort}});}
  else {for(const role of ['router','worker','watchdog'])if(p.patch?.[role]){const value={...this.settings.current[role],...p.patch[role]};await this.check(value.model,value.effort);}this.settings.save(p.patch,p.revision);}
  if(p.effectId)this.store.put('setting-applied',p.effectId,{at:Date.now()});
 }
 button(text,action){const id=randomUUID();this.store.put('button',id,{id,...action,revision:this.settings.current.revision,createdAt:Date.now()});return {text,callback_data:'sa:'+id};}
 say(id,text,rows,extra={}){return this.delivery.enqueue('controls:'+id,{text,...extra,...rows?{replyMarkup:{inline_keyboard:rows}}:{}});}
 async showModels(id,role='worker',responsibilityId){const models=await this.catalog();return this.say(id,'模型',models.slice(0,40).map(m=>[this.button(m.displayName||m.model,{kind:'model',role,responsibilityId,model:m.model})]));}
 async command(e){const [cmd,...args]=e.text.trim().split(/\s+/);
  if(cmd==='/model'&&args.length){const [model,effort]=args;if(!effort)throw Error('请同时填写模型和思考强度，或使用 /model 菜单。');await this.apply({patch:{worker:{model,effort}},revision:this.settings.current.revision});return this.say(e.id,`模型：${model}\n思考强度：${effort}`);}
  if(cmd==='/permissions'&&args.length){const mode={auto:'auto_review',manual:'user'}[args[0]];if(!mode)throw Error('使用 /permissions auto 或 /permissions manual');await this.apply({patch:{approvalsReviewer:mode},revision:this.settings.current.revision});return this.say(e.id,'权限：'+(mode==='auto_review'?'自动':'手动'));}
  if(cmd==='/permissions')return this.say(e.id,'权限',[[this.button('自动',{kind:'permissions',mode:'auto_review'}),this.button('手动',{kind:'permissions',mode:'user'})]]);
  if(cmd==='/model')return this.say(e.id,'模型',[[this.button('Router',{kind:'role',role:'router'}),this.button('Worker',{kind:'role',role:'worker'})],[this.button('职责',{kind:'responsibilities'})]]);
  if(cmd==='/settings'){const s=this.settings.current;return this.say(e.id,`Router：${s.router.model} / ${s.router.effort}\nWorker：${s.worker.model} / ${s.worker.effort}\n权限：${s.approvalsReviewer==='auto_review'?'自动':'手动'}\n并发：${s.maxWorkers}`,[[this.button('模型',{kind:'roles'}),this.button('权限',{kind:'permissions-menu'})]]);}
  if(cmd==='/status'){const snap=this.core.snapshot();return this.say(e.id,`${snap.paused?'调度已暂停':'电脑在线'}\n`+snap.tasks.slice(-15).map(t=>`${t.title}：${t.status}\n${t.summary||this.executionReason?.(t.id)||t.report?.question||({paused:'已暂停',stopped:'已停止，保留记录',completed:'已完成',failed:'执行失败'}[t.status]||'等待执行')}`).join('\n\n'),undefined,{eventId:e.id,taskRefs:snap.tasks.slice(-15).map(t=>({id:t.id,title:t.title}))});}
  return this.say(e.id,'直接描述任务即可。回复某条任务消息可继续该任务；“全部停止”暂停所有任务，“恢复全部任务”继续。模型和权限可在设置里调整。');
 }
 async callback(c){const cb=c.callback;if(!cb.data?.startsWith('sa:'))return this.say(c.id,'请重新打开设置。');const id=cb.data.slice(3),b=this.store.get('button',id);
  if(!b||b.used||b.revision!==this.settings.current.revision||Date.now()-b.createdAt>86400000){await this.telegram('answerCallbackQuery',{callback_query_id:cb.id,text:'此按钮已失效，请重新打开设置。'});return;}
  switch(b.kind){
   case 'roles':await this.command({id:c.id,text:'/model'});break;
   case 'permissions-menu':await this.command({id:c.id,text:'/permissions'});break;
   case 'role':await this.showModels(c.id,b.role,b.responsibilityId);break;
   case 'responsibilities':await this.say(c.id,'职责',this.store.list('responsibility').slice(-40).map(r=>[this.button(r.displayName||r.name,{kind:'role',role:'worker',responsibilityId:r.id})]));break;
   case 'model':{const model=(await this.catalog()).find(m=>m.model===b.model);if(!model)throw Error('Model no longer available');await this.say(c.id,'思考强度',model.supportedReasoningEfforts.map(x=>[this.button(effortName(x.reasoningEffort),{kind:'effort',role:b.role,model:b.model,effort:x.reasoningEffort,responsibilityId:b.responsibilityId,responsibilityRevision:b.responsibilityId?this.store.get('responsibility',b.responsibilityId)?.revision:null})]));break;}
   case 'effort':await this.apply(b.responsibilityId?{responsibilityId:b.responsibilityId,revision:b.responsibilityRevision,model:b.model,effort:b.effort}:{patch:{[b.role]:{model:b.model,effort:b.effort}},revision:b.revision});await this.say(c.id,`模型：${b.model}\n思考强度：${effortName(b.effort)}`);break;
   case 'permissions':await this.apply({patch:{approvalsReviewer:b.mode},revision:b.revision});await this.say(c.id,'权限：'+(b.mode==='auto_review'?'自动':'手动'));break;
   default:throw Error('Invalid setting action');
  }
  this.store.put('button',id,{...b,used:true});await this.telegram('answerCallbackQuery',{callback_query_id:cb.id});
 }
}
