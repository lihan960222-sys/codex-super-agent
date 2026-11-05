import path from 'node:path';import {createHash} from 'node:crypto';
const stable=x=>'legacy-'+createHash('sha256').update(x).digest('hex').slice(0,24);
export function importLegacy(store,legacy){if(store.get('meta','legacy-import'))return;if(legacy.busy||legacy.pendingTask||legacy.preparingInput)throw Error('Legacy bridge has active work; migrate only when idle');
 store.atomic(()=>{const projects=Object.values(legacy.projects||{});if(legacy.workspace&&!projects.some(p=>p.path?.toLowerCase()===legacy.workspace.toLowerCase()))projects.push({path:legacy.workspace,threadId:legacy.threadId});
  for(const project of projects){if(!project.path)continue;const responsibilityId=stable(project.path.toLowerCase()),id=stable(project.threadId||project.path.toLowerCase()),title=path.win32.basename(project.path)||'旧项目';
   store.put('responsibility',responsibilityId,{id:responsibilityId,name:title,scope:'既有本地项目：'+project.path,aliases:[project.path],revision:1,projectRoot:project.path});
   if(!store.get('task',id))store.put('task',id,{id,title,responsibilityId,status:'waiting',manualStop:false,generation:1,epoch:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),origin:'explicit',resources:['desktop','write:'+project.path],sourceEventId:'legacy:'+id,threadId:project.threadId||null,turnId:null,legacy:true,legacyWorkspace:project.path,summary:'从原 bot 保留的项目会话；详细历史仍在原生会话内。',settings:null});
  }
  for(const row of legacy.outbox||[]){if(legacy.delivered?.includes(row.id))continue;const parts=[];if(!row.textSent&&row.text){if(typeof row.text==='object')parts.push(row.text);else for(let offset=0;offset<row.text.length;offset+=3000)parts.push({kind:'text',text:row.text.slice(offset,offset+3000)});}parts.push(...row.attachments||[]);store.put('outbox','legacy:'+row.id,{id:'legacy:'+row.id,payload:{},parts,next:0,status:'pending',createdAt:Date.now()});}
  store.put('meta','telegram',{lastUpdate:legacy.lastUpdate??-1});store.put('meta','legacy-import',{version:1,at:Date.now(),projects:projects.length});
 });}
