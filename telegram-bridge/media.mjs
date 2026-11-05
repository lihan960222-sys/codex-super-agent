import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Telegram} from 'telegraf';
import {HttpsProxyAgent} from 'https-proxy-agent';
import {callTelegram} from './telegram.mjs';
import {parseTelegramPhotoDirective} from './vendor/photo-directives.mjs';

const run=promisify(execFile);
const inside=(file,root)=>{const r=path.relative(root,file);return r!==''&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r)};
const photoExtensions=new Set(['.png','.jpg','.jpeg','.webp','.gif']);
export const hasMedia=m=>!!(m?.photo?.length||m?.voice||m?.audio||m?.document);

// Adapter only: Telegraf handles Telegram uploads; Whisper/FFmpeg perform audio work.
export class Media {
  constructor({folder,config,token,telegram,uploader}) {
    Object.assign(this,{folder,config,token,telegram});
    const agent=config.proxy?new HttpsProxyAgent(config.proxy):undefined;
    this.api=new Telegram(token,{...(agent?{agent,attachmentAgent:agent}:{}),webhookReply:false});
    this.uploader=uploader||((method,chatId,bytes,name,caption)=>callTelegram(token,method,{chat_id:chatId},async(_url,request)=>{
      try{const result=await this.api.callApi(method,{chat_id:chatId,[method==='sendPhoto'?'photo':'document']:{source:bytes,filename:name},...(caption?{caption}:{})},{signal:request.signal});return {status:200,json:async()=>({ok:true,result})}}
      catch(e){if(e.response)return {status:e.response.error_code||500,json:async()=>e.response};throw e;}
    }));
  }
  async scope() {
    const workspace=await fs.realpath(this.config.workspace),parent=path.join(workspace,'.telegram-output');
    await fs.mkdir(parent,{recursive:true});if(await fs.realpath(parent)!==parent)throw Error('附件输出目录不能使用目录链接。');
    const root=path.join(parent,randomUUID());await fs.mkdir(root);return root;
  }
  instructions(root) {
    return `\n\nTelegram file delivery: save only this task's deliverable files in ${root}. For an image reply, add a standalone [[telegram_photo:ABSOLUTE_PATH]] line. For MD, PDF or other files, add [[telegram_file:ABSOLUTE_PATH]]. Do not put these markers in code fences. Only newly created files in this exact directory may be uploaded. Never attach credentials or unrelated files. Reuse installed document tools for PDF creation; do not invent an image-generation service. ${this.config.documentPython?'Existing document Python runtime: '+this.config.documentPython+' (reportlab and pypdf available).':''}`;
  }
  async snapshot(file,root,kind='document',caption) {
    if(!path.isAbsolute(file))throw Error('附件必须是本次任务的绝对路径。');
    const canonicalRoot=await fs.realpath(root),canonical=await fs.realpath(file);
    if(path.relative(path.resolve(root),canonicalRoot)!=='')throw Error('任务输出根目录已被替换。');
    if(!inside(canonical,canonicalRoot)||(await fs.lstat(file)).isSymbolicLink())throw Error('拒绝发送任务目录之外的附件或链接。');
    const handle=await fs.open(canonical,'r');
    let bytes;
    try{
      const before=await handle.stat();const limit=kind==='photo'?10*1024*1024:50*1024*1024;
      if(!before.isFile()||before.nlink!==1||before.size>limit)throw Error('附件不是独立文件或超过发送大小限制。');
      if(kind==='photo'&&!photoExtensions.has(path.extname(canonical).toLowerCase()))throw Error('不支持的图片格式。');
      const buffer=Buffer.alloc(before.size+1);let count=0;
      while(count<buffer.length){const read=await handle.read(buffer,count,buffer.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
      bytes=buffer.subarray(0,count);const after=await handle.stat(),currentPath=await fs.realpath(file),current=await fs.stat(currentPath);
      // Windows equivalent binding: same opened file identity, canonical root and bytes.
      if(!inside(currentPath,canonicalRoot)||before.ino!==current.ino||before.dev!==current.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs||bytes.length!==before.size||current.nlink!==1)throw Error('附件在准备发送时发生变化。');
    }finally{await handle.close();}
    const directory=path.join(this.folder,'outgoing');await fs.mkdir(directory,{recursive:true});
    const snapshot=path.join(directory,randomUUID()+path.extname(canonical));await fs.writeFile(snapshot,bytes,{flag:'wx'});
    return {kind,path:snapshot,name:path.basename(canonical),caption,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  async deliver(artifact,chatId) {
    let bytes;
    try{const root=await fs.realpath(path.join(this.folder,'outgoing')),file=await fs.realpath(artifact.path);if(!inside(file,root))throw Error('path');bytes=await fs.readFile(file);if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw Error('checksum');}
    catch{throw Object.assign(Error('附件缓存缺失、位置无效或内容校验失败。'),{artifactFailure:true});}
    try{
      try{return await this.uploader(artifact.kind==='photo'?'sendPhoto':'sendDocument',chatId,bytes,artifact.name,artifact.caption)}
      catch(e){if(artifact.kind==='photo'&&e.statusCode===400)return await this.uploader('sendDocument',chatId,bytes,artifact.name,artifact.caption);throw e;}
    }catch(e){if([400,413,415].includes(e.statusCode))e.artifactFailure=true;throw e;}
  }
  async nativeImage(item,threadId){
    if(!/^[a-zA-Z0-9-]+$/.test(threadId)||item.status!=='completed'||!item.savedPath)throw Error('没有可回传的原生图片。');
    return this.snapshot(item.savedPath,path.join(this.config.home,'generated_images',threadId),'photo');
  }
  async reply(text,root) {
    const kept=[],attachments=[];let fence=null;
    for(const line of String(text).split('\n')){
      const marker=/^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0];if(marker){fence=fence===marker?null:fence||marker;kept.push(line);continue;}
      const kind=line.trimStart().startsWith('[[telegram_file:')?'document':'photo';
      const candidate=!fence&&parseTelegramPhotoDirective(kind==='document'?line.replace('[[telegram_file:','[[telegram_photo:'):line);
      if(!candidate){kept.push(line);continue;}
      try{if(attachments.length>=5)throw Error('单次回复附件最多 5 个。');attachments.push(await this.snapshot(candidate.path,root,kind,candidate.caption));}
      catch{kept.push('附件未发送：文件必须存在于本次任务的输出目录，且未超过大小限制。');}
    }
    return {text:kept.join('\n').trim(),attachments};
  }
  async prepare(message,{signal}={}) {
    const voice=message.voice||message.audio;
    const photo=message.photo?.at(-1),document=message.document;
    const attachment=photo||voice||document;
    if(!attachment)throw Error('没有可读取的附件。');
    const image=!!photo||document?.mime_type?.startsWith('image/');
    const isPdf=!image&&!voice&&(document?.mime_type==='application/pdf'||/\.pdf$/i.test(document?.file_name||''));
    const isMd=!image&&!voice&&/\.(md|txt)$/i.test(document?.file_name||'');
    if(!image&&!voice&&!isPdf&&!isMd)throw Error('当前支持图片、语音、音频、PDF、MD 和 TXT 输入。');
    const max=image?10*1024*1024:20*1024*1024;
    if((attachment.file_size||0)>max||(voice?.duration||0)>600)throw Error('附件过大或语音超过 10 分钟。');
    const info=await this.telegram('getFile',{file_id:attachment.file_id});
    if(!info.file_path||info.file_path.split('/').some(x=>x==='..'))throw Error('Telegram 文件位置无效。');
    const url=`https://api.telegram.org/file/bot${this.token}/${info.file_path.split('/').map(encodeURIComponent).join('/')}`;
    const ext=image?(path.extname(info.file_path)||'.jpg'):voice?(path.extname(info.file_path)||'.ogg'):isPdf?'.pdf':'.md';
    const root=path.join(await fs.realpath(this.config.workspace),'.telegram-input');await fs.mkdir(root,{recursive:true});
    if(await fs.realpath(root)!==root)throw Error('附件接收目录不能使用目录链接。');
    const folder=path.join(root,randomUUID());await fs.mkdir(folder);const file=path.join(folder,'input'+ext);
    try{
      const response=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});if(!response.ok)throw Error('download');
      let count=0;const chunks=[];for await(const chunk of response.body){count+=chunk.length;if(count>max)throw Error('too large');chunks.push(Buffer.from(chunk));}
      await fs.writeFile(file,Buffer.concat(chunks),{flag:'wx'});
    }catch{throw Error('附件下载失败或超过大小限制，请稍后重新发送。');}
    const caption=String(message.caption||'').trim();
    const files=voice?[]:[{path:file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')}];
    if(image)return {text:caption||'请查看并说明这张图片。',input:[{type:'localImage',path:file}],files};
    if(!voice)return {text:(caption||'请读取并处理这个文件。')+`\n用户提供的本地文件：${file}`,input:[],files};
    const transcript=await this.transcribe(file,folder,signal);return {text:caption?caption+'\n'+transcript:transcript,input:[],transcript};
  }
  async transcribe(file,folder,signal) {
    const audio=this.config.audio;if(!audio?.ffmpeg||!audio?.whisper||!audio?.model)throw Error('语音转录工具尚未配置完成。');
    const wav=path.join(folder,'voice.wav'),prefix=path.join(folder,'transcript');
    await run(audio.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-y','-i',file,'-ar','16000','-ac','1','-c:a','pcm_s16le',wav],{windowsHide:true,timeout:60000,maxBuffer:1024*1024,signal});
    await run(audio.whisper,['-m',audio.model,'-f',wav,'-l','auto','-otxt','-of',prefix,'-np','-t','4'],{windowsHide:true,timeout:180000,maxBuffer:1024*1024,signal});
    const text=(await fs.readFile(prefix+'.txt','utf8')).trim();if(!text||text.length>20000)throw Error('语音未识别出有效文字，请重新录音。');return text;
  }
}
