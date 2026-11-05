import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
export const inside=(file,root)=>{const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))};
export function atomicText(file,text){const temp=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}try{fs.renameSync(temp,file)}catch(e){fs.rmSync(temp,{force:true});throw e}}
const safeId=id=>{if(!/^[a-zA-Z0-9-]{1,80}$/.test(id))throw Error('Invalid stable ID');return id;};
const label=text=>{let s=String(text).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,60)||'未命名';if(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s))s='_'+s;return s;};
export class TaskFiles {
  constructor(root){this.root=fs.realpathSync(root);if(!fs.statSync(root).isDirectory()||path.resolve(root).toLowerCase()!==this.root.toLowerCase())throw Error('Output root must be an existing real directory');}
  assertOwned(file){const target=path.resolve(file);if(!inside(target,this.root))throw Error('Outside output root');let cursor=target;while(!fs.existsSync(cursor)){const parent=path.dirname(cursor);if(parent===cursor)throw Error('Missing volume');cursor=parent;}if(!inside(fs.realpathSync(cursor),this.root)||fs.lstatSync(cursor).isSymbolicLink())throw Error('Linked output directory');return target;}
  directory(file){this.assertOwned(file);fs.mkdirSync(file,{recursive:true});this.assertOwned(file);return file;}
  domain(responsibility){return this.directory(responsibility.directory||path.join(this.root,label(responsibility.name)+'_'+safeId(responsibility.id)));}
  create(responsibility,id,title,{proactive=false}={}){
    const domain=this.domain(responsibility);const root=path.join(domain,proactive?'主动尝试':'任务',safeId(id)+'_'+label(title));
    if(fs.existsSync(root)){
      const marker=JSON.parse(fs.readFileSync(path.join(this.assertOwned(root),'.task.json'),'utf8'));if(marker.id!==id)throw Error('Existing folder belongs to another task');
    }else{this.directory(root);fs.writeFileSync(path.join(root,'.task.json'),JSON.stringify({id,responsibilityId:responsibility.id}),{flag:'wx'});}
    return {root,domain,work:this.directory(path.join(root,'工作区')),output:this.directory(path.join(root,'产物')),knowledge:this.directory(path.join(domain,'知识库'))};
  }
  renderProgress(task){if(!task.directories)return;const d=task.directories;this.assertOwned(d.root);atomicText(path.join(d.root,'进度.md'),`# ${task.title}\n\n更新时间：${task.updatedAt}\n状态：${task.status}\n\n${task.summary||'尚未产生进展报告'}\n\n## 下一步\n${task.report?.next||'等待下一条任务输入或执行结果'}\n\n## 待决定\n${task.report?.question||'无'}\n\n产物：${d.output}\n\n任务：${task.id}\n`);}
}
