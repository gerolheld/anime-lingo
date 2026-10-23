'use strict';
const {setTimeout:delay}=require('node:timers/promises');
const NETWORK=/ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|terminated|other side closed/i;
const NETWORK_CODES=['ECONNRESET','ECONNREFUSED','EPIPE','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'];
// The embedded llama-server can die or stop answering. Both are worth a restart; HTTP errors about the request itself are not.
const hung=error=>error.name==='TimeoutError';
const unreachable=error=>NETWORK.test(error.message)||NETWORK_CODES.includes(error.cause?.code);
function transient(error){return [408,429,500,502,503,504].includes(error.status)||hung(error)||unreachable(error);}
// `target` is called for every attempt: after a restart the server has a new port and key.
async function requestTranslation({endpoint,headers={},target,model,prompt,maxTokens,signal,recover,timeout=120000}){
  for(let attempt=0;attempt<3;attempt++){
    if(signal?.aborted)throw Error('Отменено');
    try{
      const limit=AbortSignal.timeout(timeout),where=target?target():{endpoint,headers};
      if(!where)throw Object.assign(Error('fetch failed'),{cause:{code:'ECONNREFUSED'}});
      const response=await fetch(where.endpoint+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...where.headers},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:.2,max_tokens:maxTokens,stream:false}),signal:signal?AbortSignal.any([signal,limit]):limit});
      if(!response.ok){const error=Error('Переводчик: HTTP '+response.status+' '+(await response.text()).slice(0,500));error.status=response.status;throw error;}
      const data=await response.json(),value=data.choices?.[0]?.message?.content?.trim();
      if(!value)throw Error('Переводчик вернул пустой ответ');
      return value;
    }catch(caught){
      if(signal?.aborted)throw Error('Отменено');
      // DOMException messages are read-only, so a hang is re-created as a plain error with the same name.
      const error=hung(caught)?Object.assign(Error('Переводчик не ответил за '+Math.round(timeout/1000)+' секунд'),{name:'TimeoutError'}):caught;
      if(!transient(error)||attempt===2)throw error;
      await delay(350*(attempt+1),undefined,{signal});
      // A dead or frozen server is restarted at once; other temporary errors get one more plain retry first.
      if(hung(error)||unreachable(error)||attempt===1)await recover?.(signal);
    }
  }
}
module.exports={requestTranslation,transient};
