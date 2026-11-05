import {existsSync,readFileSync} from 'node:fs';import {atomicText} from './files.mjs';
export class Settings {
  constructor(file,legacy){this.file=file;this.current={schemaVersion:1,revision:1,outputRoot:'E:\\codex_bot',maxWorkers:2,worker:{model:legacy.model,effort:legacy.reasoningEffort||'high'},router:{model:'gpt-6-luna',effort:'low'},watchdog:{model:legacy.model,effort:'low'},approvalsReviewer:legacy.approvalsReviewer||'user',proactive:{attemptMs:900000,maxRetries:2},routerLimits:{cards:8,initialChars:12000,totalChars:24000,reads:6,turns:3,tools:12,deadlineMs:90000,rotateChars:48000,rotateDecisions:32},watchdogLimits:{pollMs:60000,staleMs:300000,maxRepairs:2}};if(existsSync(file))this.load();else atomicText(file,JSON.stringify(this.current,null,2));}
  validate(value){
    if(value.schemaVersion!==1||!Number.isInteger(value.revision)||!Number.isInteger(value.maxWorkers)||value.maxWorkers<1||value.maxWorkers>16)throw Error('Invalid settings revision or capacity');
    for(const role of ['router','worker','watchdog'])if(typeof value[role]?.model!=='string'||!value[role].model||!['low','medium','high','xhigh','max','ultra'].includes(value[role].effort))throw Error('Invalid role model/effort');
    for(const role of ['router','worker','watchdog'])if(Object.keys(value[role]).some(k=>!['model','effort'].includes(k)))throw Error('Unknown role setting');
    if(!['user','auto_review'].includes(value.approvalsReviewer))throw Error('Invalid approval reviewer');
    if(!Number.isFinite(value.proactive?.attemptMs)||value.proactive.attemptMs<1000||!Number.isInteger(value.proactive.maxRetries)||value.proactive.maxRetries<0||value.proactive.maxRetries>5)throw Error('Invalid proactive limits');
    const required={routerLimits:['cards','initialChars','totalChars','reads','turns','tools','deadlineMs','rotateChars','rotateDecisions'],watchdogLimits:['pollMs','staleMs','maxRepairs']};
    for(const [section,keys]of Object.entries(required)){if(!value[section]||keys.some(k=>!Number.isSafeInteger(value[section][k])||value[section][k]<1)||Object.keys(value[section]).some(k=>!keys.includes(k)))throw Error('Invalid or missing host budget');}
    if(!/^[a-zA-Z]:[\\/]/.test(value.outputRoot||''))throw Error('Output root must be absolute Windows path');return value;
  }
  load(){const next=this.validate(JSON.parse(readFileSync(this.file,'utf8')));this.current=next;return next;}
  save(patch,revision){if(revision!==this.current.revision)throw Error('Stale configuration revision');const allowed=['router','worker','watchdog','maxWorkers','approvalsReviewer','proactive','routerLimits','watchdogLimits'];for(const k of Object.keys(patch))if(!allowed.includes(k))throw Error('Setting is not editable here: '+k);const next=structuredClone(this.current);for(const [k,v]of Object.entries(patch))next[k]=v&&typeof v==='object'?{...next[k],...v}:v;next.revision++;this.validate(next);atomicText(this.file,JSON.stringify(next,null,2));this.current=next;return next;}
  resolve(role,responsibility,explicit){return {...this.current[role],...(role==='worker'?responsibility?.settings:null),...explicit,approvalsReviewer:this.current.approvalsReviewer};}
}
