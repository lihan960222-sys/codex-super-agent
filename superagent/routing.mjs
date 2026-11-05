import {randomUUID} from 'node:crypto';
const messageKey=(chat,message)=>JSON.stringify([String(chat),String(message)]);
const text=value=>String(value||'').trim();
const stamp=()=>new Date().toISOString();
const actionClaim=/(?:已(?:经)?|现已|成功|这就|马上|立即|现在就).{0,12}(?:启动|恢复|停止|暂停|开始(?:执行|运行|任务)|更改|修改设置)|(?:明白|好的|好)[，,：:\s]*(?:开始|启动|恢复|停止)|\b(?:I(?:'ve| have)?|we(?:'ve| have)?)\s+(?:started|resumed|stopped|paused|enabled)\b/i;
const statusText=t=>`${t.title}：${({queued:'已排队，尚未开始执行',paused:'已暂停',stopped:'已停止，保留记录',running:'执行中',preparing:'准备中',uncertain:'正在核对执行状态',waiting:'等待中'})[t.status]||t.status}`;

/** Durable source relations. A private chat is never itself a task subscription. */
export class Routing {
  constructor(core,{revision=()=>1,maxBatch=8}={}){this.core=core;this.store=core.store;this.revision=revision;this.maxBatch=maxBatch;}
  bind(chatId,messageId,taskId){this.core.task(taskId);const key=messageKey(chatId,messageId),old=this.store.get('binding',key);this.store.put('binding',key,{chatId:String(chatId),messageId:String(messageId),taskIds:[...new Set([...(old?.taskIds||[]),taskId])]});}
  targets(event){return this.store.get('binding',messageKey(event.chatId,event.replyTo))?.taskIds||[];}
  accept(event){return this.store.atomic(()=>{
    const previous=this.store.get('event',event.id);if(previous&&previous.status!=='received')return {kind:'duplicate'};
    if(!previous)this.core.receive(event);event=this.store.get('event',event.id);
    if(['/stop','全部停止'].includes(text(event.text))){this.core.stop(null);this.store.put('event',event.id,{...event,status:'control'});return {kind:'stopped',taskId:null};}
    const question=this.store.get('question-binding',messageKey(event.chatId,event.replyTo));if(question){const saved=this.store.get('question',question.questionId);event={...event,...saved?.status==='pending'?{questionId:question.questionId}:{closedQuestionId:question.questionId}};}
    const targets=this.targets(event);
    if(targets.length===1){const task=this.core.task(targets[0]);
      if(['停止','停止任务','停下','stop','取消','取消任务'].includes(text(event.text).toLowerCase())){
        if(['completed','failed'].includes(task.status)){this.store.put('event',event.id,{...event,status:'candidate',relatedTaskIds:targets});return {kind:'candidate'};}
        this.control(event,{mode:'selected',stopTaskIds:[task.id]});this.store.put('event',event.id,{...event,status:'control'});return {kind:'stopped',taskId:task.id};
      }
      if(!task.manualStop&&task.status!=='paused'&&!this.store.get('meta','control').paused&&!event.questionId&&!event.handedBack?.includes(task.id)){
        this.core.attach(event.id,task.id);this.bind(event.chatId,event.messageId,task.id);this.dispatchNotice(event,task);return {kind:'direct',taskId:task.id};
      }
    }
    this.store.put('event',event.id,{...event,status:'candidate',relatedTaskIds:targets});return {kind:'candidate'};
  });}
  handback(eventId,taskId,generation,reason){return this.store.atomic(()=>{
    const task=this.core.task(taskId),event=this.store.get('event',eventId),input=this.store.get('input',eventId+':'+taskId);
    if(task.generation!==generation||task.manualStop||!event||!input||event.handedBack?.includes(taskId))return false;
    this.store.put('input',input.id,{...input,status:'returned'});this.store.cancelEffect('delivery',input.id);
    this.store.put('event',eventId,{...event,status:'candidate',handedBack:[...(event.handedBack||[]),taskId],handbackReason:text(reason).slice(0,1000)});return true;
  });}
  begin(){return this.store.atomic(()=>{
    const current=this.store.list('evaluation','active')[0];if(current)return current;
    const paused=this.store.get('meta','control').paused;
    const events=this.store.list('event','candidate').filter(e=>!paused||e.origin!=='proactive').slice(0,this.maxBatch);if(!events.length)return null;
    const batch={id:randomUUID(),status:'active',revision:this.revision(),epoch:this.store.get('meta','control').epoch,events:events.map(e=>e.id),createdAt:stamp()};
    this.store.put('evaluation',batch.id,batch);for(const e of events)this.store.put('event',e.id,{...e,status:'routing'});return batch;
  });}
  expire(id){return this.store.atomic(()=>{const b=this.store.get('evaluation',id);if(!b||b.status!=='active')return;for(const id of b.events){const e=this.store.get('event',id);if(e.status==='routing')this.store.put('event',id,{...e,status:'candidate'});}this.store.put('evaluation',id,{...b,status:'expired'});});}
  cards(){return this.store.list('task').map(t=>({id:t.id,title:t.title,responsibilityId:t.responsibilityId,status:t.status,manualStop:t.manualStop,summary:(t.summary||'').slice(0,1200),next:t.report?.next||null,output:t.output||null}));}
  dispatchNotice(event,task){if(event.source==='telegram')this.store.enqueue('reply','dispatch:'+event.id,{taskId:task.id,eventId:event.id,notice:'dispatch',text:task.title+' — Owner input assigned to this task. Describe the current observed state; assignment alone does not mean execution has started.'});}
  control(event,plan,question){
    if(event.source!=='telegram')throw Error('Only owner messages control tasks');
    if(question&&!question.options)throw Error('Legacy control question needs fresh structured clarification before confirmation');
    if(question?.controlEpoch!==undefined&&(question.controlEpoch!==this.store.get('meta','control').epoch||question.taskCount!==undefined&&question.taskCount!==this.store.list('task').length||Object.entries(question.generations||{}).some(([id,g])=>this.core.task(id).generation!==g)))throw Error('Control question is stale; clarify again against current state');
    const validated=this.core.validateControl(plan);
    if(question?.options&&!question.options.some(o=>JSON.stringify(this.core.validateControl(o.plan))===JSON.stringify(validated)))throw Error('Control plan does not match clarification options');
    const receipt=this.core.applyControl(validated);this.store.put('control-receipt',event.id,{eventId:event.id,...receipt});
    this.store.enqueue('reply','control:'+event.id,{eventId:event.id,controlTasks:receipt.tasks,text:(receipt.paused?'调度已暂停。':'调度已开启。')+'\n'+receipt.tasks.map(statusText).join('\n')});return receipt;
  }
  decide(id,actions){return this.store.atomic(()=>{
    const b=this.store.get('evaluation',id);if(!b)throw Error('Unknown evaluation');if(b.status==='completed')return b.results;
    const control=this.store.get('meta','control');if(b.status!=='active'||b.revision!==this.revision()||b.epoch!==control.epoch)throw Error('Stale evaluation');
    if(!Array.isArray(actions)||actions.length!==b.events.length||new Set(actions.map(a=>a.eventId)).size!==b.events.length||actions.some(a=>!b.events.includes(a.eventId)))throw Error('Decide each original event exactly once');
    const results=[];
    for(const a of actions){const e=this.store.get('event',a.eventId);let task,receipt;
      const questionId=a.questionId||e.questionId,boundQuestion=questionId&&this.store.get('question',questionId),question=boundQuestion?.status==='pending'?boundQuestion:null;
      if(questionId&&(!boundQuestion||boundQuestion.kind==='native'))throw Error('Unknown routing question');
      if((e.closedQuestionId||boundQuestion&&boundQuestion.status!=='pending')&&!['status','answer','ignore','clarify'].includes(a.kind))throw Error('Closed question cannot authorize another action; show status or ask a fresh clarification');
      if(question?.kind==='control'&&!['control','stop','resume','clarify','status','ignore'].includes(a.kind))throw Error('Pending control confirmation requires a control plan or clarification');
      if(e.origin==='proactive'&&(!e.authorizedRule||!e.parentTaskId||!['create','ignore'].includes(a.kind)))throw Error('Proactive events may only create an isolated attempt or be ignored');
      switch(a.kind){
        case 'create':if(a.resources&&(!Array.isArray(a.resources)||a.resources.some(r=>r!=='desktop'&&r!=='isolated'&&!/^write:[a-z]:[\\/]/i.test(r))))throw Error('Invalid task resource');task=this.core.createTask(e.id,{...a,origin:e.origin==='proactive'?'proactive':'explicit'});this.dispatchNotice(e,task);break;
        case 'attach':if(e.handedBack?.includes(a.taskId))throw Error('Cannot attach returned input back to its worker');task=this.core.attach(e.id,a.taskId);this.dispatchNotice(e,task);break;
        case 'control':receipt=this.control(e,a.plan,question);break;
        case 'stop':receipt=this.control(e,a.taskId?{mode:'selected',stopTaskIds:[a.taskId]}:{mode:'pause_all'},question);break;
        case 'resume':receipt=this.control(e,a.taskId?{mode:'selected',startTaskIds:[a.taskId]}:{mode:'resume_all'},question);break;
        case 'status':{
          const tasks=a.taskId?[this.core.task(a.taskId)]:this.core.snapshot().tasks;
          this.store.enqueue('reply','status:'+e.id,{eventId:e.id,taskId:a.taskId,taskRefs:tasks.map(t=>({id:t.id,title:t.title})),text:(this.store.get('meta','control').paused?'调度已暂停。\n':'调度已开启。\n')+(tasks.map(t=>`${statusText(t)}\n${t.summary||'尚无执行结果'}${t.report?.next?'\n下一步：'+t.report.next:''}${t.output?'\n产物：'+t.output:''}`).join('\n\n')||'暂无任务')});break;
        }
        case 'clarify':{
          if(!text(a.question)||text(a.question).length>1000)throw Error('Invalid clarification');
          if(!a.options&&/(停止|取消|恢复|启动|\bstop\b|\bcancel\b|\bresume\b)/i.test(e.text+' '+a.question))throw Error('Control clarification requires structured options with concrete task plans');
          let options;
          if(a.options!==undefined){if(!Array.isArray(a.options)||!a.options.length||a.options.length>4)throw Error('Invalid control options');options=a.options.map(o=>{if(!text(o.label)||o.label.length>200)throw Error('Invalid option label');return {label:o.label,plan:this.core.validateControl(o.plan)};});}
          const global=options?.some(o=>o.plan.mode!=='selected'),targets=global?this.store.list('task').map(t=>t.id):options?[...new Set(options.flatMap(o=>[...o.plan.startTaskIds,...o.plan.stopTaskIds]))]:[];
          this.store.put('question',e.id,{id:e.id,eventId:e.id,text:a.question,status:'pending',taskIds:e.relatedTaskIds||[],kind:options?'control':'routing',originalText:question?.originalText||this.store.get('event',question?.eventId||'')?.text||e.text,...options?{options,controlEpoch:this.store.get('meta','control').epoch,...global?{taskCount:targets.length}:{},generations:Object.fromEntries(targets.map(id=>[id,this.core.task(id).generation]))}:{}});this.store.enqueue('reply','question:'+e.id,{eventId:e.id,questionId:e.id,text:a.question,question:a.question,routerWritten:true});break;
        }
        case 'ignore':if(!text(a.reason))throw Error('Ignore requires reason');break;
        case 'answer':if(typeof a.text!=='string'||!a.text.trim()||a.text.length>4000)throw Error('Invalid coordination answer');if(question?.kind==='control'||actionClaim.test(a.text))throw Error('Use control with a concrete plan; answer cannot confirm actions');this.store.enqueue('reply','answer:'+e.id,{eventId:e.id,text:a.text,routerWritten:true});break;
        case 'settings':{
          if(e.source!=='telegram')throw Error('Only owner messages change settings');const revision=a.responsibilityId?this.store.get('responsibility',a.responsibilityId)?.revision:this.revision();
          this.store.enqueue('settings','settings:'+e.id,{eventId:e.id,effectId:e.id,revision,patch:a.patch,responsibilityId:a.responsibilityId,model:a.model,effort:a.effort});break;
        }
        case 'responsibility':{
          if(e.source!=='telegram')throw Error('Only owner messages change responsibilities');const r=this.store.get('responsibility',a.responsibilityId);if(!r)throw Error('Unknown responsibility');
          if(a.mergeInto){const target=this.store.get('responsibility',a.mergeInto);if(!target||target.redirectTo||target.id===r.id)throw Error('Invalid merge target');this.store.put('responsibility',target.id,{...target,revision:target.revision+1,aliases:[...new Set([...(target.aliases||[]),r.name,...r.aliases])],mergedIds:[...new Set([...(target.mergedIds||[]),r.id,...(r.mergedIds||[])])]});this.store.put('responsibility',r.id,{...r,redirectTo:target.id,revision:r.revision+1});}
          else {if(a.name!==undefined&&(!text(a.name)||a.name.length>120))throw Error('Invalid responsibility name');if(a.displayName!==undefined&&(typeof a.displayName!=='string'||!text(a.displayName)||a.displayName.length>40))throw Error('Invalid worker display name');this.store.put('responsibility',r.id,{...r,name:a.name||r.name,displayName:a.displayName?.trim()||r.displayName||a.name||r.name,scope:a.scope??r.scope,aliases:[...new Set([...(r.aliases||[]),r.name,...r.displayName?[r.displayName]:[],...a.displayName?[a.displayName.trim()]:[]])],revision:r.revision+1});}
          const changed=this.store.get('responsibility',a.mergeInto||r.id);this.store.enqueue('reply','responsibility:'+e.id,{eventId:e.id,text:'职责设置已保存：'+JSON.stringify({name:changed.name,displayName:changed.displayName||changed.name,scope:changed.scope})});break;
        }
        default:throw Error('Unknown routing action');
      }
      if(task){this.bind(e.chatId,e.messageId,task.id);if(question){const original=this.store.get('event',question.eventId);if(original)this.core.addInput(original,task.id);}}
      if(question&&a.kind!=='status')this.store.put('question',question.id,{...question,status:a.kind==='clarify'?'superseded':a.kind==='ignore'?'cancelled':'resolved',answerEventId:e.id,...task?{taskId:task.id}:{}});
      const next=this.store.get('event',e.id);this.store.put('event',e.id,{...next,status:a.kind==='clarify'?'clarification':'assigned',decision:a.kind});results.push({eventId:e.id,kind:a.kind,...task?{taskId:task.id}:{},...receipt?{receipt}:{}});
    }
    this.store.put('evaluation',id,{...b,status:'completed',results,completedAt:stamp()});return results;
  });}
}
