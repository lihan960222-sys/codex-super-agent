import test from 'node:test';
import assert from 'node:assert/strict';
const {callTelegram}=await import('./telegram.mjs').catch(()=>({}));
const ok=result=>({status:200,json:async()=>({ok:true,result})});
test('a transient send failure retries the reply and returns the successful Telegram response',async()=>{
  assert.equal(typeof callTelegram,'function');let attempts=0;const sleeps=[];
  const result=await callTelegram('123:dummy','sendMessage',{chat_id:12,text:'reply'},async(url,options)=>{attempts++;assert.equal(url,'https://api.telegram.org/bot123:dummy/sendMessage');assert.equal(JSON.parse(options.body).text,'reply');if(attempts===1)throw Object.assign(Error('network'),{cause:{code:'ECONNRESET'}});return ok({message_id:45})},async ms=>sleeps.push(ms));
  assert.deepEqual(result,{message_id:45});assert.equal(attempts,2);assert.equal(sleeps.length,1);
});
test('invalid credentials are not retried and never appear in the error',async()=>{
  assert.equal(typeof callTelegram,'function');let attempts=0;
  await assert.rejects(callTelegram('123:private','getMe',{},async()=>{attempts++;return {status:401,json:async()=>({ok:false,description:'Unauthorized'})}},async()=>{}),e=>e.transient===false&&!e.message.includes('private'));
  assert.equal(attempts,1);
});
test('rate limiting respects Telegram retry_after and does not drop the reply',async()=>{
  assert.equal(typeof callTelegram,'function');let calls=0;const sleeps=[];
  const result=await callTelegram('123:dummy','sendMessage',{},async()=>++calls===1?{status:429,json:async()=>({ok:false,description:'Too Many Requests',parameters:{retry_after:3}})}:ok(true),async ms=>sleeps.push(ms));
  assert.equal(result,true);assert.deepEqual(sleeps,[3000]);
});
test('an exhausted connection failure remains retryable with no credential disclosure',async()=>{
  assert.equal(typeof callTelegram,'function');let calls=0;
  await assert.rejects(callTelegram('123:private','sendMessage',{},async()=>{calls++;throw Object.assign(Error('secret URL'),{cause:{code:'ETIMEDOUT'}})},async()=>{}),e=>e.transient===true&&!e.message.includes('private')&&e.message.includes('ETIMEDOUT'));
  assert.equal(calls,3);
});
test('long Telegram cooldowns remain in force across later delivery attempts',async()=>{
  assert.equal(typeof callTelegram,'function');const sleeps=[];
  const limited=async()=>({status:429,json:async()=>({ok:false,description:'Too Many Requests',parameters:{retry_after:120}})});
  await assert.rejects(callTelegram('124:cooldown','sendMessage',{chat_id:22},limited,async ms=>sleeps.push(ms)));
  const before=sleeps.length;
  await callTelegram('124:cooldown','sendMessage',{chat_id:22},async()=>ok(true),async ms=>sleeps.push(ms));
  assert.equal(sleeps.length,before+1);assert.ok(sleeps.every(ms=>ms>=119000));
});
