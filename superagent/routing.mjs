import {randomUUID} from 'node:crypto';
const messageKey=(chat,message)=>JSON.stringify([String(chat),String(message)]);
const text=value=>String(value||'').trim();
export const requestsNewTask=value=>/(新建|另开|另建|另外(?:做|建)|另做|独立(?:任务|项目|会话)|\bnew (?:task|project|session)\b|\banother\b)/i.test(value);
const needsSemantic=value=>requestsNewTask(value)||/(暂停|暫停|停止|停下|停一下|停掉|取消|恢复|恢復|先放|先不做|别动|不执行|等.{0,30}再|发错|切换|权限|模型|设置|文风|语气|全局偏好|以后.{0,15}(回复|回答|简短)|\b(?:stop|pause|cancel|resume|switch)\b)/i.test(value);
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
    if(!event.replyTo&&!event.questionId&&!event.media?.length&&!event.message?.voice&&!event.message?.document){const matches=this.store.list('question','pending').filter(q=>q.kind!=='native'&&q.createdAt&&Date.now()-q.createdAt<86400000&&String(q.chatId)===String(event.chatId)&&text(q.originalText)===text(event.text));if(matches.length===1)event={...event,questionId:matches[0].id};}
    if(event.questionId)this.store.put('event',event.id,event);
    const targets=this.targets(event);
    if(targets.length===1){const task=this.core.task(targets[0]);
      if(['停止','停止任务','停下','stop','取消','取消任务'].includes(text(event.text).toLowerCase())){
        if(['completed','failed'].includes(task.status)){this.store.put('event',event.id,{...event,status:'candidate',relatedTaskIds:targets});return {kind:'candidate'};}
        this.control(event,{mode:'selected',stopTaskIds:[task.id]});this.store.put('event',event.id,{...event,status:'control'});return {kind:'stopped',taskId:task.id};
      }
      if(!needsSemantic(event.text)&&!task.manualStop&&task.status!=='paused'&&!this.store.get('meta','control').paused&&!event.questionId&&!event.handedBack?.includes(task.id)){
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
  cards(){return this.store.list('task').map(t=>({id:t.id,title:t.title,responsibilityId:t.responsibilityId,status:t.status,manualStop:t.manualStop,summary:(t.summary||'').slice(0,1200),next:t.report?.next||null,question:t.report?.question||null,waitReason:this.executionReason?.(t.id)||null,output:t.output||null}));}
  dispatchNotice(event,task,part=0){if(event.source==='telegram'){const key='dispatch:'+event.id+(part?':'+task.id:'');this.store.put('dispatch-key',event.id+':'+task.id,{key});this.store.enqueue('reply',key,{taskId:task.id,eventId:event.id,notice:'dispatch',text:task.title+' — Owner input assigned to this task. Describe the current observed state; assignment alone does not mean execution has started.'});}}
  control(event,plan,question,taskInputs=[]){
    if(event.source!=='telegram')throw Error('Only owner messages control tasks');
    if(question&&!question.options&&!question.adjusting)throw Error('Legacy control question needs fresh structured clarification before confirmation');
    if(!question?.adjusting&&question?.controlEpoch!==undefined&&(question.controlEpoch!==this.store.get('meta','control').epoch||question.taskCount!==undefined&&question.taskCount!==this.store.list('task').length||Object.entries(question.generations||{}).some(([id,g])=>this.core.task(id).generation!==g)))throw Error('Control question is stale; clarify again against current state');
    const validated=this.core.validateControl(plan);
    if(question?.options&&!question.options.some(o=>JSON.stringify(this.core.validateControl(o.plan))===JSON.stringify(validated)))throw Error('Control plan does not match clarification options');
    if(!taskInputs.length&&question?.options)taskInputs=question.options.find(o=>JSON.stringify(this.core.validateControl(o.plan))===JSON.stringify(validated))?.taskInputs||[];
    const original=question&&this.store.get('event',question.rootEventId||question.eventId);
    if(!Array.isArray(taskInputs)||taskInputs.length>50)throw Error('Invalid scoped task instructions');
    const sources=[event,original].filter(Boolean),starting=validated.mode==='resume_all'?this.store.list('task').filter(t=>!t.manualStop&&['paused','queued'].includes(t.status)).map(t=>t.id):validated.startTaskIds;for(const input of taskInputs)if(!starting.includes(input.taskId)||typeof input.text!=='string'||!input.text.trim()||input.text.length>4000||!sources.some(e=>e.text.includes(input.text)))throw Error('Task instructions must quote the owner request and target a selected start');
    const receipt=this.core.applyControl(validated);this.store.put('control-receipt',event.id,{eventId:event.id,...receipt});
    for(const [index,input]of taskInputs.entries()){const scoped={...event,id:'control-work:'+event.id+':'+input.taskId+':'+index,ownerEventId:original?.id||event.id,text:input.text,media:original?.media||event.media||[]};this.core.receive(scoped);const inputId=this.core.addInput(scoped,input.taskId);this.store.enqueue('delivery',inputId,{taskId:input.taskId,inputId,generation:this.core.task(input.taskId).generation});this.bind(event.chatId,event.messageId,input.taskId);}
    this.store.enqueue('reply','control:'+event.id,{eventId:event.id,controlTasks:receipt.tasks,text:(receipt.paused?'调度已暂停。':'调度已开启。')+'\n'+receipt.tasks.map(statusText).join('\n')});return receipt;
  }
  controlCard(question){const descriptions=question.options.map((o,index)=>{const p=o.plan,lines=[];if(p.mode!=='selected')lines.push(p.mode==='pause_all'?'全局调度及未完成任务 → 暂停':'全局调度及可恢复任务 → 继续（单独停止的任务保持停止）');else for(const [ids,verb]of [[p.pauseTaskIds||[],'暂停'],[p.stopTaskIds,'停止'],[p.startTaskIds,'继续']])for(const id of ids)lines.push(this.core.task(id).title+' → '+verb);return (question.options.length>1?(index+1)+'、':'')+lines.join('；');});
    const button=(text,action,index)=>{const id=randomUUID();this.store.put('control-button',id,{id,questionId:question.id,action,index,createdAt:Date.now()});return {text,callback_data:'cq:'+id};};
    return {text:question.text+'\n\n'+descriptions.join('\n'),replyMarkup:{inline_keyboard:[...question.options.map((o,index)=>[button(question.options.length===1?'确认':'确认 '+(index+1),'confirm',index)]),[button('调整','adjust'),button('取消','cancel')]]}};
  }
  async callback(row,telegram){const button=this.store.get('control-button',String(row.callback.data||'').slice(3));let response='此卡片已失效，请重新说明需要的操作。';
    this.store.atomic(()=>{const q=button&&this.store.get('question',button.questionId);if(!q||q.status!=='pending'||button.used||Date.now()-button.createdAt>86400000)return;
      if(button.action==='cancel'){this.store.put('question',q.id,{...q,status:'cancelled',answerEventId:row.id});response='已取消这次待确认操作，任务保持原状。';}
      else if(button.action==='adjust'){const next={...q,id:row.id,eventId:row.id,rootEventId:q.rootEventId||q.eventId,kind:'routing',adjusting:true,taskIds:Object.keys(q.generations||{}),status:'pending',text:'请说明要调整的任务或操作。',options:undefined,createdAt:Date.now()};this.store.put('question',q.id,{...q,status:'superseded',answerEventId:row.id});this.store.put('question',next.id,next);this.store.put('event',row.id,{id:row.id,source:'telegram',chatId:q.chatId,text:q.originalText,status:'clarification'});this.store.enqueue('reply','adjust:'+row.id,{eventId:row.id,questionId:next.id,text:next.text,question:next.text});response='请说明调整内容。';}
      else if(button.action==='confirm'){try{const original=this.store.get('event',q.rootEventId||q.eventId),event={...original,id:row.id,source:'telegram',text:q.originalText,status:'control'};this.control(event,q.options[button.index].plan,q);this.store.put('question',q.id,{...q,status:'resolved',answerEventId:row.id});response='操作已确认，正在发送实际状态。';}catch(e){if(!/stale|Finished|match clarification/.test(e.message))throw e;this.store.put('question',q.id,{...q,status:'expired'});return;}}
      this.store.put('control-button',button.id,{...button,used:true});
    });await telegram('answerCallbackQuery',{callback_query_id:row.callback.id,text:response});
  }
  decide(id,actions){return this.store.atomic(()=>{
    const b=this.store.get('evaluation',id);if(!b)throw Error('Unknown evaluation');if(b.status==='completed')return b.results;
    const control=this.store.get('meta','control');if(b.status!=='active'||b.revision!==this.revision()||b.epoch!==control.epoch)throw Error('Stale evaluation');
    if(!Array.isArray(actions)||actions.length>50||actions.some(a=>!b.events.includes(a.eventId))||b.events.some(id=>{const group=actions.filter(a=>a.eventId===id);return !group.length||group.length>1&&group.some(a=>a.kind!=='create');}))throw Error('Decide each original event exactly once; only independent creates may share an event');
    const results=[],parts=new Map();
    for(const a of actions){const e=this.store.get('event',a.eventId);let task,receipt;
      const controlled=a.kind==='control'?[...a.plan?.startTaskIds||[],...a.plan?.stopTaskIds||[],...a.plan?.pauseTaskIds||[]]:['stop','resume'].includes(a.kind)&&a.taskId?[a.taskId]:[],adjustments=controlled.length?this.store.list('question','pending').filter(q=>q.adjusting&&String(q.chatId)===String(e.chatId)&&controlled.every(id=>q.taskIds?.includes(id))):[];
      const questionId=a.questionId||e.questionId||(adjustments.length===1?adjustments[0].id:null),boundQuestion=questionId&&this.store.get('question',questionId),question=boundQuestion?.status==='pending'?boundQuestion:null;
      if(questionId&&(!boundQuestion||boundQuestion.kind==='native'))throw Error('Unknown routing question');
      if((e.closedQuestionId||boundQuestion&&boundQuestion.status!=='pending')&&!['status','answer','ignore','clarify'].includes(a.kind))throw Error('Closed question cannot authorize another action; show status or ask a fresh clarification');
      if(question?.kind==='control'&&!['control','stop','resume','clarify','status','ignore'].includes(a.kind))throw Error('Pending control confirmation requires a control plan or clarification');
      if(e.origin==='proactive'&&(!e.authorizedRule||!e.parentTaskId||!['create','ignore'].includes(a.kind)))throw Error('Proactive events may only create an isolated attempt or be ignored');
      switch(a.kind){
        case 'create':{if(a.resources&&(!Array.isArray(a.resources)||a.resources.some(r=>r!=='desktop'&&r!=='isolated'&&!/^write:[a-z]:[\\/]/i.test(r))))throw Error('Invalid task resource');const part=parts.get(e.id)||0;parts.set(e.id,part+1);const multi=actions.filter(x=>x.eventId===e.id).length>1;task=this.core.createTask(e.id,{...a,...multi?{scope:a.scope||a.title}:{},origin:e.origin==='proactive'?'proactive':'explicit'},String(part));this.dispatchNotice(e,task,part);break;}
        case 'attach':if(e.handedBack?.includes(a.taskId))throw Error('Cannot attach returned input back to its worker');task=this.core.attach(e.id,a.taskId);this.dispatchNotice(e,task);break;
        case 'control':receipt=this.control(e,a.plan,question,a.taskInputs);break;
        case 'stop':receipt=this.control(e,a.taskId?{mode:'selected',stopTaskIds:[a.taskId]}:{mode:'pause_all'},question);break;
        case 'resume':receipt=this.control(e,a.taskId?{mode:'selected',startTaskIds:[a.taskId]}:{mode:'resume_all'},question);break;
        case 'status':{
          const tasks=a.taskId?[this.core.task(a.taskId)]:this.core.snapshot().tasks;
          this.store.enqueue('reply','status:'+e.id,{eventId:e.id,taskId:a.taskId,taskRefs:tasks.map(t=>({id:t.id,title:t.title})),text:(this.store.get('meta','control').paused?'调度已暂停。\n':'调度已开启。\n')+(tasks.map(t=>`${statusText(t)}\n${t.summary||'尚无执行结果'}${this.executionReason?.(t.id)?'\n'+this.executionReason(t.id):''}${t.report?.question?'\n等待补充：'+t.report.question:''}${t.report?.next?'\n下一步：'+t.report.next:''}${t.output?'\n产物：'+t.output:''}`).join('\n\n')||'暂无任务')});break;
        }
        case 'clarify':{
          if(!text(a.question)||text(a.question).length>1000)throw Error('Invalid clarification');
          if(!a.options&&/(暂停|停止|取消|恢复|启动|\bstop\b|\bcancel\b|\bresume\b)/i.test(e.text+' '+a.question))throw Error('Control clarification requires structured options with concrete task plans');
          let options;
          if(a.options!==undefined){if(!Array.isArray(a.options)||!a.options.length||a.options.length>4)throw Error('Invalid control options');options=a.options.map(o=>{if(!text(o.label)||o.label.length>200)throw Error('Invalid option label');return {label:o.label,plan:this.core.validateControl(o.plan),...o.taskInputs?{taskInputs:o.taskInputs}:{}};});}
          const global=options?.some(o=>o.plan.mode!=='selected'),targets=global?this.store.list('task').map(t=>t.id):options?[...new Set(options.flatMap(o=>[...o.plan.startTaskIds,...o.plan.stopTaskIds,...o.plan.pauseTaskIds||[]]))]:[];
          const saved={id:e.id,eventId:e.id,rootEventId:question?.rootEventId||question?.eventId||e.id,chatId:e.chatId,createdAt:Date.now(),text:a.question,status:'pending',taskIds:e.relatedTaskIds||[],kind:options?'control':'routing',originalText:question?.originalText||this.store.get('event',question?.eventId||'')?.text||e.text,...options?{options,controlEpoch:this.store.get('meta','control').epoch,...global?{taskCount:targets.length}:{},generations:Object.fromEntries(targets.map(id=>[id,this.core.task(id).generation]))}:{}};this.store.put('question',e.id,saved);const card=options?this.controlCard(saved):{text:a.question};this.store.enqueue('reply','question:'+e.id,{eventId:e.id,questionId:e.id,...card,question:card.text,routerWritten:true});break;
        }
        case 'ignore':if(!text(a.reason))throw Error('Ignore requires reason');break;
        case 'answer':if(typeof a.text!=='string'||!a.text.trim()||a.text.length>4000)throw Error('Invalid coordination answer');if(question?.kind==='control'||actionClaim.test(a.text))throw Error('Use control with a concrete plan; answer cannot confirm actions');this.store.enqueue('reply','answer:'+e.id,{eventId:e.id,text:a.text,routerWritten:true});break;
        case 'settings':{
          if(e.source!=='telegram')throw Error('Only owner messages change settings');const revision=a.responsibilityId?this.store.get('responsibility',a.responsibilityId)?.revision:this.revision();
          this.store.enqueue('settings','settings:'+e.id,{eventId:e.id,effectId:e.id,revision,patch:a.patch,responsibilityId:a.responsibilityId,model:a.model,effort:a.effort});break;
        }
        case 'preferences':if(e.source!=='telegram'||typeof a.text!=='string'||!a.text.trim()||!e.text.includes(a.text))throw Error('Preferences must quote an explicit owner message');this.store.enqueue('preferences','preferences:'+e.id,{eventId:e.id,text:a.text});break;
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
