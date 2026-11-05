// Real-clock isolated coordinator soak. Run only in Round 3 after the preceding full rounds.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {openFixture,sleep,redact,baseline,assertTestRoot} from './conversation-fixtures.mjs';
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,'')),root=assertTestRoot(path.resolve(process.argv[3]),path.resolve('local/conversation-validation')),durationMs=1800000;
fs.mkdirSync(root,{recursive:true});const log=[];const previousCalls=[];let f,counter=0,failed=false,next=0;const started=Date.now(),failures=[],interactions=[];
const schedule=[
 [0,'新建独立任务，命名为“连接长测A”。仅在 output/a.txt 写入 SOAK-A-521，一行即可。'],
 [180000,'连接长测A 当前进展如何？'],
 [360000,'另建“连接长测B”，仅在 output/b.txt 写 SOAK-B-632，一行即可。'],
 [600000,'/stop'],
 [630000,'新建“连接长测D”，稍后再执行，仅写一个待确认清单。'],
 [660000,'当前都是什么状态？'],
 [720000,'取消连接长测D，保留记录。'],
 [900000,'恢复全部任务。'],
 [1080000,null],
 [1320000,'继续连接长测A，在原 a.txt 中追加 SOAK-A-RESUME-743，别重复原来的内容。'],
 [1740000,'/status']
];
const record=e=>{const clean=redact({at:Date.now(),...e},[cfg.expectedEmail]);log.push(clean);fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify(clean)+'\n');};
const open=async()=>{f=await openFixture({root,config:cfg,realWorkers:true,record});};
try{await open();let tick=0,lastTurns=0,lastIdleAt=null,idleExtraCalls=0,idleObservedMs=0;
 while(Date.now()-started<durationMs){const elapsed=Date.now()-started;
  if(next<schedule.length&&elapsed>=schedule[next][0]){const [due,text]=schedule[next++];if(text){const n=++counter;f.system.runtime.receive({update_id:n,message:{message_id:n,date:Math.floor(Date.now()/1000),from:{id:1},chat:{id:1,type:'private'},text}});interactions.push({due,receivedAt:elapsed,text});record({kind:'soak-input',due,text});}else{const offset=f.system.store.get('meta','telegram')?.lastUpdate||counter;previousCalls.push(...f.rpc.calls);await f.system.close();await open();counter=offset;lastTurns=0;lastIdleAt=null;record({kind:'soak-restart',elapsed});}}
  f.system.runtime.pump();
  const health=f.system.runtime.health(),active=health.tasks.some(t=>['running','queued','preparing','uncertain'].includes(t.status))||health.pendingReplies||health.pendingEffects||f.system.router.running;
  const turns=f.rpc.calls.filter(c=>c.method==='turn/start').length;
  if(!active&&next<schedule.length&&schedule[next][0]-elapsed>15000){if(lastIdleAt!==null){idleObservedMs+=elapsed-lastIdleAt;if(turns!==lastTurns)idleExtraCalls+=turns-lastTurns;}lastIdleAt=elapsed;lastTurns=turns;}else lastIdleAt=null;
  if(health.leases.length>2||health.pendingEffects>100||health.pendingReplies>100){failures.push({elapsed,reason:'Unbounded queue or capacity',health});failed=true;}
  const manuallyStopped=health.tasks.filter(t=>t.manualStop);if(manuallyStopped.some(t=>t.status!=='stopped')){failures.push({elapsed,reason:'Stopped task revived'});failed=true;}
  if(++tick%40===0)fs.writeFileSync(path.join(root,'health.json'),JSON.stringify({elapsed,...health}));
  await sleep(50);
 }
 const tasks=f.system.store.list('task'),a=tasks.find(t=>t.title.includes('连接长测A')),d=tasks.find(t=>t.title.includes('连接长测D'));
 const aText=a?.output&&fs.existsSync(path.join(a.output,'a.txt'))?fs.readFileSync(path.join(a.output,'a.txt'),'utf8'):'';
 const checks={real30Minutes:Date.now()-started>=durationMs,idleHasNoModelPolling:idleObservedMs>=120000&&idleExtraCalls===0,manualCancelRetained:d?.status==='stopped'&&d.manualStop===true,actualFileContinuation:aText.includes('SOAK-A-521')&&aText.includes('SOAK-A-RESUME-743'),allScheduled:next===schedule.length};
 const result={id:'SOAK-30MIN',status:!failed&&Object.values(checks).every(Boolean)?'pass':'fail',transport:'simulated-telegram',level:'E',sourceCommit:execFileSync('git',['-c','safe.directory='+process.cwd().replaceAll('\\','/'),'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),models:baseline,startedAt:new Date(started).toISOString(),durationMs:Date.now()-started,checks,idleObservedMs,failures,interactions,health:f.system.runtime.health(),calls:[...previousCalls,...f.rpc.calls]};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(redact(result,[cfg.expectedEmail]),null,2));console.log(JSON.stringify({status:result.status,durationMs:result.durationMs,checks}));
}catch(e){fs.writeFileSync(path.join(root,'error.json'),JSON.stringify(redact({error:e.stack,elapsed:Date.now()-started},[cfg.expectedEmail])));process.exitCode=1;}finally{if(f){for(const t of f.system.store.list('task'))if(t.threadId&&t.turnId)await f.system.native.interrupt(t.threadId,t.turnId).catch(()=>{});await f.system.close();}}
