import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const module=await import('./media.mjs').catch(()=>({}));
const temporary=prefix=>realpathSync.native(mkdtempSync(join(tmpdir(),prefix)));

test('only real task-owned files are snapshotted and later uploads use fixed validated bytes',async t=>{
  assert.equal(typeof module.Media,'function');
  const root=temporary('lihan-media-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const scope=join(root,'task');mkdirSync(scope);const file=join(scope,'result.md');writeFileSync(file,'FIRST');
  const sent=[];const media=new module.Media({folder:join(root,'private'),config:{workspace:root},token:'dummy',telegram:async()=>{},uploader:async(...args)=>sent.push(args)});
  const artifact=await media.snapshot(file,scope,'document');writeFileSync(file,'CHANGED');await media.deliver(artifact,123);
  assert.equal(sent[0][2].toString(),'FIRST');
  const outside=join(root,'outside.md');writeFileSync(outside,'PRIVATE');await assert.rejects(media.snapshot(outside,scope,'document'));
  const link=join(scope,'escape.md');try{symlinkSync(outside,link,'file');await assert.rejects(media.snapshot(link,scope,'document'));}catch(e){if(e.code!=='EPERM')throw e;}
});

test('portable upstream output directives support Windows paths and do not send fenced examples',async t=>{
  assert.equal(typeof module.Media,'function');
  const root=temporary('lihan-artifact-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'result.md');writeFileSync(file,'hello');
  const media=new module.Media({folder:join(root,'private'),config:{workspace:root},token:'dummy',telegram:async()=>{}});
  const result=await media.reply(`done\n[[telegram_file:${file}]]\n\`\`\`\n[[telegram_file:C:\\private\\secret.md]]\n\`\`\``,root);
  assert.equal(result.attachments.length,1);assert.ok(result.text.includes('C:\\private\\secret.md'));
});

test('replacing the task root with a junction cannot authorize an outside regular file',async t=>{
  const root=temporary('lihan-root-link-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const scope=join(root,'task'),outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'private.md'),'PRIVATE');
  try{symlinkSync(outside,scope,'junction')}catch(e){if(e.code==='EPERM'){t.skip('Junction creation unavailable');return;}throw e;}
  const media=new module.Media({folder:join(root,'private'),config:{workspace:root},token:'dummy',telegram:async()=>{}});
  await assert.rejects(media.snapshot(join(scope,'private.md'),scope,'document'));
});

test('native image output is accepted only from the official matching thread directory',async t=>{
  assert.equal(typeof module.Media.prototype.nativeImage,'function');
  const root=temporary('lihan-native-image-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const output=join(root,'generated_images','thread-a');mkdirSync(output,{recursive:true});const file=join(output,'test.png');writeFileSync(file,'PNG');
  const media=new module.Media({folder:join(root,'private'),config:{home:root},token:'dummy',telegram:async()=>{}});
  const artifact=await media.nativeImage({savedPath:file,status:'completed'},'thread-a');assert.equal(artifact.kind,'photo');
  await assert.rejects(media.nativeImage({savedPath:file,status:'completed'},'other-thread'));
});
