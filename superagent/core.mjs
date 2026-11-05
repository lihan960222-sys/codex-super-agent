import {randomUUID} from 'node:crypto';
const now=()=>new Date().toISOString();
const validId=x=>typeof x==='string'&&x.length>0&&x.length<=300;
const stopped=t=>t.manualStop===true;

export class Core {
  constructor(store){this.store=store;if(!store.get('meta','control'))store.put('meta','control',{paused:false,epoch:0});}
  receive(event){
    if(!validId(event.id)||typeof event.text!=='string')throw Error('Invalid event');
    return this.store.atomic(()=>{if(this.store.get('event',event.id))return false;this.store.put('event',event.id,{...event,status:'received'});return true;});
  }
  task(id){const t=this.store.get('task',id);if(!t)throw Error('Unknown task');return t;}
  createTask(eventId,decision,part='0'){
    return this.store.atomic(()=>{
      const key=eventId+':'+part,accepted=this.store.get('acceptance',key);if(accepted)return this.task(accepted.taskId);
      const event=this.store.get('event',eventId);if(!event)throw Error('Unknown event');
      if(!decision.title?.trim()||!decision.responsibility?.trim())throw Error('Task needs title and responsibility');
      let responsibility=this.store.list('responsibility').find(x=>x.id===decision.responsibility||x.name===decision.responsibility||x.aliases?.includes(decision.responsibility));
      const visited=new Set();while(responsibility?.redirectTo){if(visited.has(responsibility.id))throw Error('Responsibility redirect cycle');visited.add(responsibility.id);responsibility=this.store.get('responsibility',responsibility.redirectTo);}
      if(!responsibility){if(decision.displayName!==undefined&&(typeof decision.displayName!=='string'||!decision.displayName.trim()||decision.displayName.length>40))throw Error('Invalid worker display name');responsibility={id:randomUUID(),name:decision.responsibility,displayName:decision.displayName?.trim()||decision.responsibility,scope:decision.responsibilityScope||decision.scope||'',aliases:[],revision:1};this.store.put('responsibility',responsibility.id,responsibility);}
      const control=this.store.get('meta','control');const id=randomUUID();
      const task={id,title:decision.title,scope:decision.scope||event.text,responsibilityId:responsibility.id,status:'queued',manualStop:false,generation:1,epoch:control.epoch,createdAt:now(),updatedAt:now(),origin:decision.origin==='proactive'?'proactive':'explicit',resources:decision.resources||['desktop'],sourceEventId:eventId,threadId:null,turnId:null,summary:'',settings:decision.settings||null};
      task.resources=task.resources.map(r=>r==='isolated'?'isolated:'+id:r);
      if(event.origin==='proactive'){task.parentTaskId=event.parentTaskId;task.problemKey=event.problemKey;task.authorizedRule=event.authorizedRule;}
      this.store.put('task',id,task);this.store.put('acceptance',key,{taskId:id});this.addInput(event,id);
      this.store.put('event',eventId,{...event,status:'assigned'});this.store.enqueue('launch',id,{taskId:id,generation:1,epoch:control.epoch});return task;
    });
  }
  addInput(event,taskId){const id=event.id+':'+taskId;if(!this.store.get('input',id))this.store.put('input',id,{id,eventId:event.id,...event.ownerEventId?{ownerEventId:event.ownerEventId}:{},taskId,text:event.text,media:event.media||[],files:event.files||[],status:'pending',at:event.at||now()});const stored=this.store.get('event',event.id);if(stored?.status==='received')this.store.put('event',event.id,{...stored,status:'assigned'});return id;}
  attach(eventId,taskId){
    return this.store.atomic(()=>{
      const event=this.store.get('event',eventId),t=this.task(taskId);if(!event)throw Error('Unknown event');if(stopped(t))throw Error('Task stopped; explicit resume required');
      const inputId=this.addInput(event,taskId);this.store.put('event',eventId,{...event,status:'assigned'});
      if(['completed','failed','waiting','blocked'].includes(t.status)){t.status='queued';t.updatedAt=now();this.store.put('task',t.id,t);}
      this.store.enqueue('delivery',inputId,{taskId,inputId,generation:t.generation,epoch:this.store.get('meta','control').epoch});return t;
    });
  }
  canLaunch(id){const t=this.task(id);return !this.store.get('meta','control').paused&&!stopped(t)&&['queued','waiting'].includes(t.status);}
  validateControl(plan){
    if(!plan||!['selected','pause_all','resume_all'].includes(plan.mode)||Object.keys(plan).some(k=>!['mode','startTaskIds','stopTaskIds','pauseTaskIds'].includes(k)))throw Error('Invalid control plan');
    const start=plan.startTaskIds??[],stop=plan.stopTaskIds??[],pause=plan.pauseTaskIds??[];
    for(const ids of [start,stop,pause])if(!Array.isArray(ids)||ids.length>50||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)throw Error('Invalid control targets');
    if(plan.mode==='selected'&&!start.length&&!stop.length&&!pause.length)throw Error('Empty control plan: omit no-change options; the host supplies Cancel. Use ignore to withdraw a pending request.');
    if(plan.mode!=='selected'&&(start.length||stop.length||pause.length)||start.some(id=>stop.includes(id)||pause.includes(id))||stop.some(id=>pause.includes(id)))throw Error('Contradictory control plan: choose one state change per task or clarify the conflict.');
    for(const id of [...start,...stop,...pause])this.task(id);
    for(const id of start)if(['completed','failed'].includes(this.task(id).status))throw Error('Finished task needs a new authorized followup, not resume');
    for(const id of stop)if(['completed','failed'].includes(this.task(id).status))throw Error('Finished task cannot be stopped; report its actual state');
    for(const id of pause)if(['completed','failed'].includes(this.task(id).status))throw Error('Finished task cannot be paused; report its actual state');
    return {mode:plan.mode,startTaskIds:start,stopTaskIds:stop,...pause.length?{pauseTaskIds:pause}:{}};
  }
  applyControl(input){return this.store.atomic(()=>{
    const plan=this.validateControl(input),before=this.store.get('meta','control');let affected=[];
    if(plan.mode==='pause_all'){this.stop(null);affected=this.store.list('task').filter(t=>t.status==='paused').map(t=>t.id);}
    else if(plan.mode==='resume_all'){affected=this.store.list('task').filter(t=>!t.manualStop&&['paused','queued'].includes(t.status)).map(t=>t.id);this.resume(null);}
    else {
      for(const id of plan.stopTaskIds)if(!this.task(id).manualStop)this.stop(id);
      for(const id of plan.pauseTaskIds||[])this.pause(id);
      if(plan.startTaskIds.length&&before.paused){
        // Unlock selected work without incidentally launching other tasks accepted while paused.
        for(const t of this.store.list('task'))if(t.status==='queued'&&!plan.startTaskIds.includes(t.id)){this.store.put('task',t.id,{...t,status:'paused',generation:t.generation+1,updatedAt:now()});this.store.cancelEffect('launch',t.id);}
        this.store.put('meta','control',{paused:false,epoch:before.epoch+1});
      }
      for(const id of plan.startTaskIds){const t=this.task(id);
        if(['running','preparing','uncertain'].includes(t.status))continue;
        if(t.status==='queued'&&!t.manualStop)this.store.enqueue('launch',id,{taskId:id,generation:t.generation,epoch:this.store.get('meta','control').epoch});
        else this.resume(id);
      }
      affected=[...plan.stopTaskIds,...plan.pauseTaskIds||[],...plan.startTaskIds];
    }
    return {plan,...this.store.get('meta','control'),tasks:affected.map(id=>{const t=this.task(id),r=this.store.get('responsibility',t.responsibilityId);return {id,title:t.title,status:t.status,generation:t.generation,manualStop:t.manualStop,workerName:r?.displayName||r?.name,interruptPending:!!this.store.get('lease',id)&&['paused','stopped'].includes(t.status)};}),at:now()};
  });}
  pause(id){return this.store.atomic(()=>{const t=this.task(id);if(t.manualStop||t.status==='paused')return;if(['completed','failed'].includes(t.status))throw Error('Finished task cannot be paused');const active=['running','preparing','uncertain'].includes(t.status);this.store.put('task',id,{...t,status:'paused',manualStop:false,pausedFor:null,pauseReason:'owner',generation:t.generation+1,updatedAt:now()});this.store.cancelEffect('launch',id);if(active)this.queueInterrupt(t);});}
  stop(id){return this.store.atomic(()=>{
    if(id!==null&&['completed','failed'].includes(this.task(id).status))throw Error('Finished task cannot be stopped; report its actual state');
    let control=this.store.get('meta','control');if(id===null){control={paused:true,epoch:control.epoch+1};this.store.put('meta','control',control);}
    for(const t of id===null?this.store.list('task'): [this.task(id)]){
      if(id===null&&stopped(t))continue;
      if(id===null&&!['queued','running','waiting','uncertain','preparing','blocked'].includes(t.status))continue;
      const active=['running','preparing','uncertain'].includes(t.status);const oldGeneration=t.generation;
      t.generation++;t.status=id===null?'paused':'stopped';t.manualStop=id!==null;t.updatedAt=now();this.store.put('task',t.id,t);
      this.store.cancelEffect('launch',t.id);
      if(active)this.queueInterrupt({...t,generation:oldGeneration});
    }
  });}
  queueInterrupt(t){const a=t.assignmentId&&this.store.get('assignment',t.assignmentId);this.store.enqueue('interrupt',t.id,{taskId:t.id,assignmentId:a?.id,threadId:a?.threadId||t.threadId,turnId:a?.turnId||t.turnId,generation:a?.generation||t.generation});}
  resume(id){return this.store.atomic(()=>{
    const control=this.store.get('meta','control');if(id===null)this.store.put('meta','control',{paused:false,epoch:control.epoch+1});
    for(const t of id===null?this.store.list('task','paused'):[this.task(id)]){
      if(id===null&&stopped(t))continue;
      t.manualStop=false;t.status='queued';t.pausedFor=null;t.pauseReason=null;t.generation++;t.updatedAt=now();this.store.put('task',t.id,t);
      const event={id:'resume:'+t.id+':'+t.generation,source:'control',text:'Resume this previously authorized task from its saved native context and verified artifacts. Preserve completed work; do not blindly repeat earlier side effects.',at:now()};this.receive(event);this.addInput(event,t.id);
      this.store.enqueue('reconcile',t.id,{taskId:t.id,generation:t.generation});
      this.store.enqueue('launch',t.id,{taskId:t.id,generation:t.generation});
    }
  });}
  report(id,generation,report){
    return this.store.atomic(()=>{const t=this.task(id);if(t.generation!==generation||stopped(t)||t.status==='paused')return false;
      const states={progress:'running',waiting:'waiting',ready:'completed',blocked:'blocked',failed:'failed'};if(!states[report.state])throw Error('Invalid report state');
      t.status=states[report.state];t.summary=String(report.summary||'').slice(0,4000);t.updatedAt=now();t.report={...report,at:now()};this.store.put('task',id,t);return true;
    });
  }
  snapshot(){return {...this.store.get('meta','control'),tasks:this.store.list('task'),responsibilities:this.store.list('responsibility')};}
}
