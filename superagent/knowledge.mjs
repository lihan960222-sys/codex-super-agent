import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {atomicText,inside} from './files.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ordered=x=>Object.fromEntries(Object.entries(x||{}).sort(([a],[b])=>a.localeCompare(b)));
/** Published claims are source-qualified, not a claim of independently established scientific truth. */
export class Knowledge {
  constructor({store,files}){Object.assign(this,{store,files});}
  evidence(task,item){
    if(!item||typeof item.excerpt!=='string'||!item.excerpt.trim()||item.excerpt.length>4000)return false;
    if(item.kind==='user')return this.store.get('event',item.reference)?.source==='telegram'&&(task.sourceEventId===item.reference||this.store.get('input',item.reference+':'+task.id))&&this.store.get('event',item.reference)?.text.includes(item.excerpt)===true;
    if(item.kind!=='artifact')return false;
    try{const file=path.resolve(task.directories.output,item.reference);this.files.assertOwned(file);if(!inside(fs.realpathSync(file),task.directories.output)||fs.lstatSync(file).isSymbolicLink())return false;const st=fs.statSync(file);if(!st.isFile()||st.nlink!==1||st.size>2_000_000)return false;return fs.readFileSync(file,'utf8').includes(item.excerpt);}catch{return false;}
  }
  propose(task,candidates){
    if(!Array.isArray(candidates)||candidates.length>10)throw Error('Knowledge batch exceeds limit');
    return candidates.map(c=>{
      if(typeof c.subject!=='string'||!c.subject.trim()||typeof c.statement!=='string'||!c.statement.trim()||c.statement.length>4000)throw Error('Invalid knowledge candidate');
      if(/(?:\b\d{6,12}:[A-Za-z0-9_-]{30,}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|(?:password|密码|access_token|refresh_token)\s*[:=]\s*\S{4,})/i.test(JSON.stringify(c)))throw Error('Credential-like knowledge is not permitted');
      const conditions=ordered(c.conditions);const id=hash([task.responsibilityId,c.subject,c.statement,conditions]);const previous=this.store.get('knowledge',id);
      const evidence=(c.evidence||[]).slice(0,8).filter(e=>this.evidence(task,e));
      if(previous&&previous.status!=='pending'){const extra=evidence.filter(e=>!previous.evidence.some(x=>x.taskId===task.id&&x.kind===e.kind&&x.reference===e.reference&&x.excerpt===e.excerpt)).map(e=>{const source={...e,taskId:task.id,sourceRoot:task.directories.output};return {...source,sourceHash:this.sourceHash(source)};});if(extra.length){this.store.put('knowledge',id,{...previous,evidence:[...previous.evidence,...extra].slice(-24),revision:previous.revision+1,updatedAt:new Date().toISOString()});this.materialize(id);return this.store.get('knowledge',id);}return previous;}
      // Publish a source-qualified quote automatically; unsupported paraphrases stay pending.
      const qualifies=evidence.some(e=>e.excerpt.includes(c.statement))&&Object.keys(conditions).length>0;
      const item={id,responsibilityId:task.responsibilityId,subject:c.subject,statement:c.statement,conditions,evidence:evidence.map(e=>{const source={...e,taskId:task.id,sourceRoot:task.directories.output};return {...source,sourceHash:this.sourceHash(source)};}),evidenceLevel:evidence.every(x=>x.kind==='user')?'user-stated':'source-reported',status:qualifies?'published':'pending',revision:(previous?.revision||0)+1,updatedAt:new Date().toISOString(),taskId:task.id,base:task.directories.knowledge};
      this.store.atomic(()=>{
        if(qualifies){const conflicting=this.store.list('knowledge').filter(x=>x.id!==id&&x.responsibilityId===item.responsibilityId&&x.subject===item.subject&&JSON.stringify(x.conditions)===JSON.stringify(conditions)&&['published','disputed'].includes(x.status));
          if(conflicting.length){item.status='disputed';for(const x of conflicting){x.status='disputed';x.revision++;this.store.put('knowledge',x.id,x);this.store.enqueue('knowledge-file',x.id,{id:x.id});this.store.enqueue('knowledge-notice',x.id+':'+x.revision,{id:x.id,revision:x.revision});}}
        }
        this.store.put('knowledge',id,item);this.store.enqueue('knowledge-file',id,{id});
      });
      this.materialize(id);return this.store.get('knowledge',id);
    });
  }
  sourceHash(e){try{if(e.kind==='user')return hash(this.store.get('event',e.reference)?.text);const file=path.resolve(e.sourceRoot,e.reference);this.files.assertOwned(file);if(!inside(fs.realpathSync(file),e.sourceRoot)||fs.statSync(file).size>2_000_000||fs.statSync(file).nlink!==1)return null;return hash(fs.readFileSync(file,'utf8'));}catch{return null;}}
  audit(item){if(item.status==='superseded')return item;let reason;
    if(item.path&&item.renderHash){try{this.files.assertOwned(item.path);if(hash(fs.readFileSync(item.path,'utf8'))!==item.renderHash)reason='manual-edit';}catch{reason='missing-markdown';}}
    if(!reason&&item.status==='published'&&item.evidence.some(e=>!e.sourceHash||e.sourceHash!==this.sourceHash(e)))reason='source-changed';
    if(reason&&item.invalidReason!==reason){item={...item,status:'pending',invalidReason:reason,revision:item.revision+1,updatedAt:new Date().toISOString()};this.store.put('knowledge',item.id,item);this.store.enqueue('knowledge-file',item.id,{id:item.id});this.store.enqueue('knowledge-notice',item.id+':'+item.revision,{id:item.id,revision:item.revision});}return item;
  }
  materialize(id){const item=this.audit(this.store.get('knowledge',id));if(item.invalidReason==='manual-edit'){this.store.cancelEffect('knowledge-file',id);return item;}const dir=this.files.directory(path.join(item.base,item.status==='published'?'条目':'待核实'));const file=path.join(dir,item.id+'.md');this.files.assertOwned(file);
    const {path:oldPath,renderHash,...record}=item;
    const text=`# ${item.subject}\n\n${item.statement}\n\n状态：${item.status}；证据：${item.evidenceLevel}；版本：${item.revision}\n\n适用条件：${JSON.stringify(item.conditions)}\n\n来源：\n${item.evidence.map(e=>`- ${e.kind}: ${e.reference}；任务 ${e.taskId}；来源版本 ${e.sourceHash}\n  ${e.excerpt}`).join('\n')}\n\n<!-- superagent-record\n${JSON.stringify(record,null,2)}\n-->\n`;
    if(fs.existsSync(file)){const old=fs.readFileSync(file,'utf8');if(old!==text){const history=this.files.directory(path.join(item.base,'历史版本'));const saved=path.join(history,id+'-'+hash(old).slice(0,16)+'.md');if(!fs.existsSync(saved))fs.writeFileSync(saved,old,{flag:'wx'});}}
    atomicText(file,text);if(oldPath&&oldPath!==file){this.files.assertOwned(oldPath);atomicText(oldPath,`# 条目状态已更新\n\n当前状态：${item.status}\n当前文件：${file}\n`);}item.path=file;item.renderHash=hash(text);this.store.put('knowledge',id,item);this.store.cancelEffect('knowledge-file',id);this.index(item.base);return item;
  }
  scopes(scope){const seen=new Set();let r=this.store.get('responsibility',scope);while(r?.redirectTo&&!seen.has(r.id)){seen.add(r.id);r=this.store.get('responsibility',r.redirectTo);}return new Set([scope,...seen,...r?[r.id,...r.mergedIds||[]]:[]]);}
  index(base){const entries=this.store.list('knowledge').filter(x=>x.base===base);const file=this.files.assertOwned(path.join(base,'index.md'));atomicText(file,'# 知识索引\n\n'+entries.map(x=>`- [${x.subject}](${x.path||''}) · ${x.status} · v${x.revision} · ${JSON.stringify(x.conditions)}`).join('\n')+'\n');}
  reconcile(){for(const original of this.store.list('knowledge')){if(original.status==='superseded')continue;const item=this.audit(original);if(item.invalidReason==='manual-edit'){try{const raw=fs.readFileSync(this.files.assertOwned(item.path),'utf8');const match=/<!-- superagent-record\s*([\s\S]*?)\s*-->/.exec(raw);if(!match)continue;const candidate=JSON.parse(match[1]);if(candidate.id!==item.id||candidate.responsibilityId!==item.responsibilityId||candidate.revision!==original.revision)continue;const task=this.store.get('task',item.taskId);if(!task)continue;const same=candidate.statement===item.statement&&JSON.stringify(ordered(candidate.conditions))===JSON.stringify(item.conditions);if(same)continue;const saved={...item,status:'superseded'};this.store.put('knowledge',item.id,saved);try{const [next]=this.propose(task,[candidate]);this.store.put('knowledge',item.id,{...saved,supersededBy:next.id});this.store.enqueue('knowledge-notice',item.id+':'+item.revision,{id:item.id,revision:item.revision});}catch(e){this.store.put('knowledge',item.id,item);throw e;}}catch(e){this.store.put('knowledge-edit-error',item.id,{id:item.id,error:e.message,at:Date.now()});}}else if(item.status==='pending'&&item.invalidReason)this.materialize(item.id);this.index(item.base);}}
  search(scope,query,conditions={}){const q=String(query).toLowerCase();return this.store.list('knowledge','published').filter(x=>this.scopes(scope).has(x.responsibilityId)).map(x=>this.audit(x)).filter(x=>x.status==='published'&&Object.entries(x.conditions).every(([k,v])=>conditions[k]!==undefined&&String(conditions[k])===String(v))&&(!q||(x.subject+' '+x.statement).toLowerCase().includes(q))).slice(0,8).map(x=>({id:x.id,subject:x.subject,preview:x.statement.slice(0,160),conditions:x.conditions,evidenceLevel:x.evidenceLevel,revision:x.revision}));}
  read(id,revision){let item=this.store.get('knowledge',id);if(item)item=this.audit(item);if(!item||revision!==undefined&&item.revision!==revision)throw Error('Unknown or stale knowledge reference');return item;}
}
