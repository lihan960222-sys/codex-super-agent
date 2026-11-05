const hasMedia=m=>!!(m?.voice||m?.audio||m?.photo?.length||m?.document);
/** Intake never waits for inference, downloads, uploads or execution. */
export class Runtime {
 constructor(deps){Object.assign(this,deps);this.jobs=new Map();this.onError=deps.onError||(()=>{});}
 receive(update){return this.store.atomic(()=>{
   const last=this.store.get('meta','telegram')?.lastUpdate??-1;if(update.update_id<=last)return false;
   const callback=update.callback_query,m=callback?.message||update.message,actor=callback?.from||m?.from;
   if(m?.chat?.type==='private'&&String(actor?.id)===String(this.config.ownerId)&&String(m.chat.id)===String(this.config.chatId)){
     const id='telegram:'+update.update_id;
     if(callback)this.store.put('callback',id,{id,status:'pending',callback,receivedAt:Date.now()});
     else {
       const event={id,source:'telegram',chatId:String(m.chat.id),messageId:String(m.message_id),replyTo:m.reply_to_message?String(m.reply_to_message.message_id):null,text:String(m.text||m.caption||''),at:new Date((m.date||Date.now()/1000)*1000).toISOString(),message:m,media:[],status:'received'};
       this.core.receive(event);
       const qref=this.store.get('question-binding',JSON.stringify([event.chatId,event.replyTo]));const question=qref&&this.store.get('question',qref.questionId);
       const aref=this.store.get('approval-binding',JSON.stringify([event.chatId,event.replyTo]));
       if(['/stop','全部停止'].includes(event.text.trim())){this.routing.accept(event);this.store.enqueue('reply','stop:'+id,{eventId:id,text:'已暂停全部任务。'});}
       else if(aref)this.store.put('event',id,{...event,status:'approval-answer',approvalId:aref.approvalId});
       else if(question?.kind==='native'&&question.status==='pending')this.store.put('event',id,{...event,status:'native-answer',questionId:question.id});
       else if(hasMedia(m))this.store.put('event',id,{...event,status:'media-pending'});
       else if(/^\/(settings|model|permissions|status|help|start|new)(\s|$)/.test(event.text))this.store.put('event',id,{...event,status:'command'});
       else this.routing.accept(event);
     }
   }
   this.store.put('meta','telegram',{lastUpdate:update.update_id});return true;
 });}
 async prepareOne(id){const e=this.store.get('event',id);if(e?.status!=='media-pending')return;let prepared;try{prepared=await this.prepareMedia(e);}catch(error){this.store.atomic(()=>{const latest=this.store.get('event',id);if(latest?.status!=='media-pending')return;this.store.put('event',id,{...latest,status:'media-failed',error:String(error.message).slice(0,1000)});this.store.enqueue('reply','media-error:'+id,{eventId:id,text:/语音|audio|transcri/i.test(error.message)?'语音未能识别出有效内容，本次未执行任务。请重新发送语音或改用文字。':'附件处理失败，本次未执行任务。请检查文件后重新发送。'});});return;}
   const latest=this.store.get('event',id);if(latest.status!=='media-pending')return;
   this.store.atomic(()=>{this.store.put('event',id,{...latest,text:prepared.text,media:prepared.input||[],hasOwnerInstruction:!!(latest.message?.caption||latest.message?.text||latest.message?.voice||latest.message?.audio),status:'received'});this.routing.accept(this.store.get('event',id));});
 }
 track(key,operation){if(this.jobs.has(key))return;const promise=Promise.resolve().then(operation).catch(e=>this.onError(e,key)).finally(()=>this.jobs.delete(key));this.jobs.set(key,promise);return promise;}
 async effect(row){const claimed=this.store.claimEffect(row.kind,row.key);if(!claimed)return;const p=claimed.payload;try{let result=true;
   switch(row.kind){
    case 'launch':result=await this.executor.start(p.taskId);break;
    case 'delivery':result=await this.executor.deliver(p.taskId);if(!result&&this.store.get('input',p.inputId)?.status!=='pending')result=true;break;
    case 'interrupt':result=await this.executor.interrupt(p);break;
    case 'reconcile':result=await this.executor.reconcile(p.taskId);break;
    case 'reply':await this.delivery.enqueue(row.key,p);break;
    case 'knowledge-propose':this.knowledge.propose(this.core.task(p.taskId),p.candidates);break;
    case 'knowledge-notice':for(const use of this.store.list('knowledge-use').filter(x=>x.id===p.id&&x.revision<p.revision)){const t=this.core.task(use.taskId);if(t.manualStop||!['running','queued','preparing','uncertain'].includes(t.status))continue;const event={id:'knowledge-update:'+p.id+':'+p.revision+':'+t.id,source:'knowledge',text:'Previously retrieved knowledge '+p.id+' changed or was invalidated. Do not rely on the older version; retrieve current evidence before continuing the same task.'};this.core.receive(event);const inputId=this.core.addInput(event,t.id);this.store.enqueue('delivery',inputId,{taskId:t.id,inputId});}break;
    case 'knowledge-file':this.knowledge.materialize(p.id);break;
    case 'settings':try{await this.controls.apply(p);await this.delivery.enqueue('settings-result:'+row.key,{eventId:p.eventId,text:'设置已更新。'});}catch(e){if(/revision|Invalid|Unsupported|unavailable|editable/.test(e.message)){await this.delivery.enqueue('settings-result:'+row.key,{eventId:p.eventId,text:'设置未更改：'+e.message});}else throw e;}break;
    case 'preferences':this.router.preferences.append(p.eventId,p.text);await this.delivery.enqueue('preferences-result:'+row.key,{eventId:p.eventId,text:'全局交互偏好已保存，后续对话按新偏好回复。'});break;
    case 'native-image':{const task=this.core.task(p.taskId),a=this.store.get('assignment',p.assignmentId);if(task.manualStop||task.generation!==p.generation||!a||a.turnId!==p.turnId||a.threadId!==p.threadId)break;const artifact=await this.mediaFor(p.taskId).nativeImage(p.item,p.threadId);await this.delivery.enqueue(row.key,{taskId:p.taskId,attachments:[artifact]});break;}
    default:throw Error('Unknown durable effect '+row.kind);
   }
   if(result)this.store.settleEffect(claimed);else this.store.deferEffect(claimed,'Waiting for eligibility or native evidence',{delay:5000});
  }catch(e){this.store.deferEffect(claimed,e.message,{delay:Math.min(60000,1000*2**Math.min(claimed.attempts,6))});throw e;}
 }
 pump(){
   this.supervise();
   for(const e of this.store.list('event','received'))this.routing.accept(e);
   for(const e of this.store.list('event','media-pending'))this.track('media:'+e.id,()=>this.prepareOne(e.id));
   for(const e of this.store.list('event','command'))this.track('command:'+e.id,async()=>{try{await this.controls.command(e);this.store.put('event',e.id,{...e,status:'control'});}catch(error){this.store.atomic(()=>{this.store.put('event',e.id,{...e,status:'command-failed',error:String(error.message).slice(0,1000)});this.store.enqueue('reply','command-error:'+e.id,{eventId:e.id,text:'命令未完成：'+String(error.message).slice(0,300)+'。可用 /settings 核对当前设置。'});});}});
   for(const e of this.store.list('event','native-answer'))this.track('native-answer:'+e.id,async()=>{await this.approvals.answerEvent(e,this.store.get('question',e.questionId));this.store.put('event',e.id,{...e,status:'answered'});});
   for(const e of this.store.list('event','approval-answer'))this.track('approval-answer:'+e.id,async()=>{await this.approvals.answerApprovalEvent(e);this.store.put('event',e.id,{...e,status:'answered'});});
   for(const c of this.store.list('callback','pending'))this.track('callback:'+c.id,async()=>{if(/^(ap|qa):/.test(c.callback.data||''))await this.approvals.callback(c.callback);else if(c.callback.data?.startsWith('cq:'))await this.routing.callback(c,this.controls.telegram);else await this.controls.callback(c);this.store.put('callback',c.id,{...c,status:'handled'});});
   if(this.router)this.track('router',()=>this.router.tick());
   const priority={interrupt:0,reconcile:1,delivery:2,reply:3,settings:3,launch:4};
   for(const effect of this.store.effects().filter(x=>x.status==='pending'&&x.due<=Date.now()).sort((a,b)=>(priority[a.kind]??5)-(priority[b.kind]??5)||(a.kind==='launch'&&b.kind==='launch'?Number(this.store.get('task',a.payload.taskId)?.origin==='proactive')-Number(this.store.get('task',b.payload.taskId)?.origin==='proactive'):0)||a.seq-b.seq))this.track('effect:'+effect.kind+':'+effect.key,()=>this.effect(effect));
   if(this.delivery)this.track('outbox',()=>this.delivery.flush());
 }
 supervise(){if(!this.observer)return;const tasks=this.store.list('task'),humanBusy=tasks.some(t=>t.origin!=='proactive'&&!t.manualStop&&['queued','running','preparing','uncertain'].includes(t.status));for(const t of tasks){if(t.origin!=='proactive')continue;
   if(!this.core.snapshot().paused&&(t.status==='failed'||t.stopReason==='proactive-budget')&&!this.store.get('proactive-retry',t.id)){const attempt=this.store.get('speculation',t.problemKey);if(attempt?.taskId===t.id&&attempt.attempts<this.settings.current.proactive.maxRetries+1){this.store.atomic(()=>{const original=this.store.get('event',t.sourceEventId),event={...original,id:'retry:'+t.id,at:new Date().toISOString(),text:original.text+'\nPrevious isolated attempt failed or reached its time budget. Try a different approach using the original copy source; do not repeat failed actions blindly.'};this.core.receive(event);const next=this.core.createTask(event.id,{title:t.title,responsibility:t.responsibilityId,origin:'proactive',resources:['isolated']});this.store.put('proactive-retry',t.id,{taskId:next.id});});}}
   if(t.manualStop)continue;
   if(t.problemKey&&this.observer.expired(t.problemKey)&&['queued','running','preparing','paused','uncertain'].includes(t.status)){this.core.stop(t.id);this.store.put('task',t.id,{...this.core.task(t.id),stopReason:'proactive-budget'});continue;}
   if(humanBusy&&['running','preparing'].includes(t.status)){this.store.atomic(()=>{this.store.put('task',t.id,{...t,status:'paused',pausedFor:'owner',generation:t.generation+1});this.core.queueInterrupt(t);});}
   else if(!humanBusy&&t.status==='paused'&&t.pausedFor==='owner'&&!this.core.snapshot().paused&&!this.store.get('lease',t.id)){this.core.resume(t.id);const event={id:'priority-resume:'+t.id+':'+t.generation,source:'watchdog',text:'Resume the existing isolated attempt after yielding to owner tasks. Original scope and attempt deadline still apply.'};this.core.receive(event);this.core.addInput(event,t.id);this.store.put('task',t.id,{...this.core.task(t.id),pausedFor:null});this.store.enqueue('launch',t.id,{taskId:t.id});}
  }}
 async recover(){
   for(const b of this.store.list('evaluation','active'))this.routing.expire(b.id);
   for(const e of this.store.effects())if(e.status!=='pending')this.store.deferEffect(e,'Recover durable work after restart',{delay:0});
   for(const t of this.store.list('task')){
     const a=t.assignmentId&&this.store.get('assignment',t.assignmentId);if(!a||a.status==='finished')continue;
     if(a.status==='preparing'){this.store.put('assignment',a.id,{...a,status:'abandoned-before-submit'});this.scheduler.release(t.id,a.generation);if(!t.manualStop&&t.status!=='paused'){this.store.put('task',t.id,{...t,status:'queued'});this.store.enqueue('launch',t.id,{taskId:t.id});}}
     else {if(!t.manualStop&&t.status!=='paused')this.store.put('task',t.id,{...t,status:'uncertain'});this.store.enqueue('reconcile',t.id,{taskId:t.id});}
   }
 }
 health(){const control=this.store.get('meta','control');return {at:new Date().toISOString(),...control,tasks:this.store.list('task').map(t=>({id:t.id,status:t.status,generation:t.generation,createdAt:t.createdAt,lastActivityAt:t.lastActivityAt,lastProgressAt:t.lastProgressAt,origin:t.origin,manualStop:t.manualStop,awaitingApproval:this.store.list('approval','pending').some(a=>a.taskId===t.id),summary:t.summary?.slice(0,1000),report:t.report?{state:t.report.state,question:t.report.question,next:t.report.next}:null})),leases:this.store.list('lease'),pendingEffects:this.store.effects().length,pendingReplies:this.store.list('outbox').length,lastUpdate:this.store.get('meta','telegram')?.lastUpdate??-1};}
}
