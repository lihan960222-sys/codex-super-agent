const sleep=async ms=>{while(ms>0){const part=Math.min(ms,60000);await new Promise(resolve=>setTimeout(resolve,part));ms-=part;}};
const cooldowns=new Map();
export async function callTelegram(token,method,params={},fetcher=fetch,delay=sleep) {
  let error;
  const bucket=token+':'+method+':'+String(params.chat_id||'');
  for(let attempt=0;attempt<3;attempt++) {
    const remaining=(cooldowns.get(bucket)||0)-Date.now();
    if(remaining>0)await delay(remaining);
    let response,data;
    try {
      response=await fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params),signal:AbortSignal.timeout(method==='getUpdates'?35000:['sendPhoto','sendDocument'].includes(method)?120000:15000)});
      try{data=await response.json()}catch{}
    } catch(e) {
      const code=/^[A-Z0-9_]+$/.test(e.cause?.code||'')?e.cause.code:e.name||'network';
      error=Object.assign(Error(`Telegram ${method} connection failed (${code})`),{transient:true});
    }
    if(data?.ok){if((cooldowns.get(bucket)||0)<=Date.now())cooldowns.delete(bucket);return data.result;}
    let retryAfter=1000*2**attempt;
    if(response) {
      const transient=response.status===429||response.status>=500||!data;
      const description=String(data?.description||`HTTP ${response.status}`).split(token).join('[redacted]');
      error=Object.assign(Error(`Telegram ${method}: ${description}`),{transient,statusCode:response.status});
      if(!transient)throw error;
      if(response.status===429){retryAfter=Math.max(1000,(data?.parameters?.retry_after||1)*1000);cooldowns.set(bucket,Date.now()+retryAfter);error.retryAt=cooldowns.get(bucket);}
    }
    if(attempt<2&&response?.status!==429)await delay(retryAfter);
  }
  throw error;
}
