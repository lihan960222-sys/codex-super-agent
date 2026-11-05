import path from 'node:path';import fs from 'node:fs';
const canonical=p=>{const full=path.win32.resolve(p);let cursor=full;while(!fs.existsSync(cursor)){const parent=path.win32.dirname(cursor);if(parent===cursor)return full;cursor=parent;}return path.win32.join(fs.realpathSync(cursor),path.win32.relative(cursor,full));};
const normalize=r=>r.startsWith('write:')?'write:'+canonical(r.slice(6)).replace(/\\+$/,'').toLowerCase():r;
export function conflicts(a,b){a=normalize(a);b=normalize(b);return a==='desktop'||b==='desktop'||a===b||(a.startsWith('write:')&&b.startsWith('write:')&&(a.startsWith(b+'\\')||b.startsWith(a+'\\')));}
export class Scheduler {
 constructor(core,{capacity=()=>2}={}){this.core=core;this.store=core.store;this.capacity=capacity;}
 next(){if(this.store.get('meta','control').paused)return [];return this.store.list('task').filter(t=>!t.manualStop&&t.status==='queued').sort((a,b)=>(a.origin==='proactive')-(b.origin==='proactive')||a.createdAt.localeCompare(b.createdAt));}
 reason(id){const t=this.core.task(id);if(t.status!=='queued')return null;if(this.store.get('meta','control').paused)return '全局调度已暂停';const leases=this.store.list('lease').filter(l=>l.taskId!==id),resources=t.resources?.length?t.resources:['desktop'],blocked=leases.find(l=>resources.some(r=>l.resources.some(s=>conflicts(r,s))));if(blocked)return '等待共享资源：'+this.core.task(blocked.taskId).title+' 尚未释放资源';if(leases.length>=this.capacity())return '等待并发名额（上限 '+this.capacity()+'）';return '已入队，等待调度';}
 acquire(id){return this.store.atomic(()=>{const t=this.core.task(id),leases=this.store.list('lease');if(!this.core.canLaunch(id))return null;const own=leases.find(l=>l.taskId===id);if(own)return own.generation===t.generation?own:null;
   if(leases.length>=this.capacity())return null;const resources=t.resources?.length?t.resources:['desktop'];if(resources.some(r=>typeof r!=='string'||r.length>2000))throw Error('Invalid task resources');
   if(leases.some(l=>resources.some(r=>l.resources.some(s=>conflicts(r,s)))))return null;
   const lease={taskId:id,generation:t.generation,epoch:this.store.get('meta','control').epoch,resources,acquiredAt:Date.now()};this.store.put('lease',id,lease);return lease;
 });}
 release(id,generation){return this.store.atomic(()=>{const lease=this.store.get('lease',id);if(!lease||lease.generation!==generation)return false;this.store.remove('lease',id);return true;});}
}
