import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
const {decryptToken}=await import('./bridge.mjs');
test('Windows credential decryption does not inherit incompatible PowerShell 7 modules',()=>{
  assert.equal(typeof decryptToken,'function','The production credential reader must be testable without connecting Telegram.');
  const env={...process.env};for(const key of Object.keys(env))if(key.toUpperCase()==='PSMODULEPATH')delete env[key];
  const powershell='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const encrypted=spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',"$s=ConvertTo-SecureString 'DUMMY_CREDENTIAL_ROUNDTRIP' -AsPlainText -Force; ConvertFrom-SecureString $s"],{env,windowsHide:true,encoding:'utf8'});
  assert.equal(encrypted.status,0,'The known-compatible Windows PowerShell fixture must encrypt the dummy value.');
  const folder=mkdtempSync(join(tmpdir(),'codex-credential-test-'));const tokenFile=join(folder,'token.dpapi');
  const original=process.env.PSModulePath;
  try {
    writeFileSync(tokenFile,encrypted.stdout.trim());
    process.env.PSModulePath='C:\\Users\\Administrator\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\powershell\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';
    assert.equal(decryptToken({powershell,tokenFile}),'DUMMY_CREDENTIAL_ROUNDTRIP');
  } finally {
    if(original===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=original;
    if(!resolve(folder).startsWith(resolve(tmpdir())+sep))throw Error('Unexpected test cleanup path');
    rmSync(folder,{recursive:true,force:true});
  }
});
