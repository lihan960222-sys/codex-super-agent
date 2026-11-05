import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {atomicText} from './files.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fallback='Use concise natural Chinese, lead with the result or actual current state.';
/** File metadata avoids repeated reads; content hash avoids rotating on an identical save. */
export class Preferences {
 constructor(file){this.file=file;this.loads=0;}
 current(){let stat;try{stat=fs.statSync(this.file,{bigint:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  const signature=stat?[stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':'):'missing';if(this.cached&&signature===this.signature)return this.cached;
  if(stat&&stat.size>65536n)throw Error('Router preferences exceed 64 KiB');const text=stat?fs.readFileSync(this.file,'utf8'):fallback;this.loads++;this.signature=signature;const version=hash(text);if(this.cached?.version===version)return this.cached;
  this.cached={text,version};return this.cached;
 }
 append(eventId,text){if(typeof text!=='string'||!text.trim()||text.length>4000)throw Error('Invalid preference text');const marker='<!-- preference:'+hash(eventId)+' -->',before=this.current();if(before.text.includes(marker))return before;
  const prior=fs.existsSync(this.file)?fs.readFileSync(this.file,'utf8'):'',after=prior+'\n\n'+marker+'\n## 对话中更新的偏好\n'+text.trim()+'\n';if(Buffer.byteLength(after)>65536)throw Error('Router preferences exceed 64 KiB');
  const history=path.join(path.dirname(this.file),'preference-history');fs.mkdirSync(history,{recursive:true});const backup=path.join(history,before.version+'.md');if(!fs.existsSync(backup))fs.writeFileSync(backup,prior,{flag:'wx'});atomicText(this.file,after);return this.current();
 }
 violations(text,{eventText='',requiredText=''}={}){const source=this.current().text,body=requiredText?String(text).replace(requiredText,''):String(text),errors=[];
  // ponytail: enforce only explicit, mechanically testable rules; personality stays in the stable prompt.
  const detailed=/(这次|本次|现在|此次).{0,15}(详细|展开|长文)|请详细展开/.test(eventText),cancel=source.lastIndexOf('取消字数限制');const limits=[...source.matchAll(/(?:每次|每条)(?:回复|回答)(?:都)?(?:最多|不超过|不得超过)\s*(\d{1,5})\s*(字|字符|句)/g)].filter(m=>m.index>cancel);
  if(!detailed)for(const unit of ['字','字符','句']){const match=limits.filter(m=>m[2]===unit).at(-1);if(!match)continue;const n=Number(match[1]),length=unit==='句'?body.split(/[。！？!?]+/u).filter(s=>s.trim()).length:[...body].length;if(n>0&&length>n)errors.push('回复'+unit+'数不得超过'+n);}
  for(const m of source.matchAll(/(?:禁用词|禁止使用|不要使用)[：:\s]*[「“"]([^」”"\r\n]{1,80})[」”"]/g))if(body.includes(m[1]))errors.push('不得使用：'+m[1]);return errors;
 }
}
