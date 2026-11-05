const chunks=text=>{const parts=[];let rest=String(text||'');while(rest.length){let n=Math.min(rest.length,3500);if(n<rest.length&&/[\uD800-\uDBFF]/.test(rest[n-1]))n--;parts.push({kind:'text',text:rest.slice(0,n)});rest=rest.slice(n);}return parts;};
/** Telegram has no send idempotency key. Checkpoint acknowledged parts; uncertain sends can repeat, never execute work. */
export class Delivery {
 constructor({store,routing,telegram,chatId,mediaFor,compose,stamp,clock=Date.now}){Object.assign(this,{store,routing,telegram,chatId,mediaFor,compose,stamp,clock});this.running=false;}
 async enqueue(key,payload){if(this.store.get('outbox',key)||this.store.get('delivered',key))return;let text=payload.text||'',attachments=payload.attachments||[];
  if(payload.artifactRoot&&this.mediaFor){const media=this.mediaFor(payload.taskId);const prepared=await media.reply(text,payload.artifactRoot);text=prepared.text;attachments=[...attachments,...prepared.attachments||[]];}
  this.store.atomic(()=>{const order=(this.store.get('meta','outbox-order')?.value||Date.now())+1;this.store.put('meta','outbox-order',{value:order});this.store.put('outbox',key,{id:key,order,routerDelivery:!!this.compose,payload:{...payload,text,attachments},parts:[...chunks(text),...attachments],next:0,status:'pending',createdAt:Date.now()});});
 }
 withdraw(item,reason){this.store.atomic(()=>{this.store.put('delivered',item.id,{id:item.id,status:'withdrawn',reason,at:this.clock(),taskId:item.payload.taskId});this.store.remove('outbox',item.id);});}
 async flush(){if(this.running)return;this.running=true;let firstError;const waitingTasks=new Set();try{for(const item of this.store.list('outbox').sort((a,b)=>(a.order||a.createdAt)-(b.order||b.createdAt))){
   if(item.status==='blocked')continue;
   if(this.compose&&!item.routerDelivery){const remaining=item.parts.slice(item.next);item.payload={...item.payload,text:remaining.filter(p=>p.kind==='text').map(p=>p.text).join('\n'),attachments:remaining.filter(p=>p.kind!=='text')};item.next=0;item.routerDelivery=true;this.store.put('outbox',item.id,item);}
   const approval=item.id.startsWith('approval:')&&this.store.get('approval',item.id.slice(9)),question=item.payload.questionId&&this.store.get('question',item.payload.questionId);
   if(this.compose&&(approval&&approval.status!=='pending'||question&&question.status!=='pending')){this.withdraw(item,'Request no longer pending');continue;}
   if(this.compose&&item.payload.question&&item.payload.taskId&&!item.payload.questionId){const p=item.payload,t=this.store.get('task',p.taskId),answered=p.report?.at&&this.store.list('input').some(i=>i.taskId===p.taskId&&i.at>p.report.at&&this.store.get('event',i.eventId)?.source==='telegram');if(t&&(answered||t.manualStop||t.status==='paused'||t.report?.question!==p.question)){if(item.id.startsWith('attention:')){this.withdraw(item,'Worker question superseded or task stopped');continue;}item.payload={...p,text:p.text?.replaceAll(p.question,''),question:null,report:p.report?{...p.report,question:null}:p.report};item.composed=null;this.store.put('outbox',item.id,item);}}
   if(this.compose&&item.payload.taskId){if(waitingTasks.has(item.payload.taskId))continue;waitingTasks.add(item.payload.taskId);}
   if(item.status==='blocked'||(item.due||0)>this.clock())continue;let failed=false;
   if(this.validate&&item.next===0&&item.payload.routerWritten)try{this.validate(item.payload.text,item.payload);}catch{item.payload.routerWritten=false;item.composed=null;this.store.put('outbox',item.id,item);}
   if(this.compose&&item.next===0&&!item.payload.routerWritten){
    try{
     if(item.payload.notice==='started'&&['running','completed','waiting','blocked','failed','stopped','paused'].includes(this.store.get('delivered',item.payload.dispatchKey)?.observedStatus)){this.withdraw(item,'Current state already communicated with dispatch');waitingTasks.delete(item.payload.taskId);continue;}
     if(!item.composed||this.stamp&&item.composed.stamp!==this.stamp(item.payload)){
      const composed=await this.compose(item.id,item.payload);if(!composed)break;
      const currentApproval=item.id.startsWith('approval:')&&this.store.get('approval',item.id.slice(9)),currentQuestion=item.payload.questionId&&this.store.get('question',item.payload.questionId);
      if(currentApproval&&currentApproval.status!=='pending'||currentQuestion&&currentQuestion.status!=='pending'){this.withdraw(item,'Request resolved while composing');waitingTasks.delete(item.payload.taskId);continue;}
      item.composed=composed;item.parts=[...chunks(composed.text),...(item.payload.attachments||[]).map(a=>({...a,caption:undefined}))];this.store.put('outbox',item.id,item);
     }
    }catch(e){this.store.put('outbox',item.id,{...item,status:'pending',due:this.clock()+10000,error:e.message});firstError??=e;continue;}
   }
   for(let i=item.next;i<item.parts.length;i++){
    if(this.stamp&&item.composed&&item.composed.stamp!==this.stamp(item.payload)){item.composed=null;item.next=0;item.parts=[];this.store.put('outbox',item.id,{...item,status:'pending',due:0});failed=true;break;}
    const part=item.parts[i],p=item.payload;this.store.put('outbox',item.id,{...item,status:'sending',sendingPart:i});let result;
    try{result=part.kind==='text'?await this.telegram('sendMessage',{chat_id:this.chatId,text:part.text,...p.replyMarkup&&i===item.parts.length-1?{reply_markup:p.replyMarkup}:{}}):await this.mediaFor(p.taskId).deliver(part,this.chatId);}
    catch(e){if(e.artifactFailure){item.next=i+1;this.store.put('outbox',item.id,{...item,status:'pending'});await this.enqueue('delivery-warning:'+item.id,{taskId:p.taskId,text:'附件无法发送，任务产物保留在本机目录。'});continue;}
      const attempts=(item.attempts||0)+1,blocked=attempts>=3;this.store.put('outbox',item.id,{...item,status:blocked?'blocked':'uncertain',attempts,error:e.message,lastAttempt:this.clock(),due:this.clock()+Math.min(300000,5000*2**attempts)});if(blocked&&!item.id.startsWith('delivery-warning:'))await this.enqueue('delivery-warning:'+item.id,{taskId:p.taskId,text:'有一条结果的发送状态无法确认，已停止自动重发；文件和任务记录仍在本机。'});firstError??=e;failed=true;break;}
    this.store.atomic(()=>{if(p.taskId)this.routing.bind(this.chatId,result.message_id,p.taskId);for(const t of p.controlTasks||[])this.routing.bind(this.chatId,result.message_id,t.id);if(p.questionId)this.store.put('question-binding',JSON.stringify([String(this.chatId),String(result.message_id)]),{questionId:p.questionId});if(item.id.startsWith('approval:'))this.store.put('approval-binding',JSON.stringify([String(this.chatId),String(result.message_id)]),{approvalId:item.id.slice(9)});item.next=i+1;item.status='pending';item.attempts=0;item.due=0;this.store.put('outbox',item.id,item);});
   }
   if(!failed)this.store.atomic(()=>{this.store.put('delivered',item.id,{id:item.id,at:this.clock(),taskId:item.payload.taskId,observedStatus:item.composed?.status,text:item.composed?.text||item.payload.text,taskIds:[...new Set([...(item.payload.taskRefs||[]),...(item.payload.controlTasks||[]),...item.payload.taskId?[this.store.get('task',item.payload.taskId)].filter(Boolean):[]].filter(t=>item.composed?.controlGroup||(item.composed?.text||item.payload.text||'').includes(t.title)).map(t=>t.id))]});this.store.remove('outbox',item.id);waitingTasks.delete(item.payload.taskId);});
  }if(firstError)throw firstError;}finally{this.running=false;}}
}
