'use strict';
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');

const MARGIN=64*1024**2;
const failure=(code,message)=>Object.assign(Error(message),{code});
function checkUrl(url){
  const u=new URL(url);
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','::1'].includes(u.hostname)))throw failure('BAD_URL','Скачивание разрешено только по HTTPS');
  if(u.username||u.password)throw failure('BAD_URL','Адрес с логином не поддерживается');
}
async function hashFile(file,{signal,onProgress}={}){
  const hash=crypto.createHash('sha256');let done=0;const total=(await fsp.stat(file)).size;
  for await(const chunk of fs.createReadStream(file,{signal})){hash.update(chunk);done+=chunk.length;onProgress?.(done,total);}
  return hash.digest('hex');
}
// A fully verified file is remembered by size+mtime so a multi-gigabyte model is hashed once, not on every start.
async function isVerified(file,sha256,{signal}={}){
  let stat;try{stat=await fsp.stat(file);}catch{return false;}
  const marker=file+'.verified';
  try{const m=JSON.parse(await fsp.readFile(marker,'utf8'));if(m.sha256===sha256&&m.size===stat.size&&m.mtimeMs===stat.mtimeMs)return true;}catch{}
  if(await hashFile(file,{signal})!==sha256)return false;
  await fsp.writeFile(marker,JSON.stringify({sha256,size:stat.size,mtimeMs:stat.mtimeMs})).catch(()=>{});
  return true;
}
/**
 * Resumable, verified download. Aborting the signal pauses it and keeps `<dest>.part`;
 * calling download() again continues from the saved bytes. A wrong hash deletes the partial file.
 */
async function download({url,dest,sha256,size,signal,onProgress=()=>{},fetchImpl=fetch,minFree=MARGIN}){
  checkUrl(url);
  if(!/^[a-f0-9]{64}$/.test(sha256||''))throw failure('NO_HASH','Для файла не задана контрольная сумма SHA-256');
  await fsp.mkdir(path.dirname(dest),{recursive:true});
  if(await isVerified(dest,sha256,{signal})){onProgress({phase:'ready',done:size||0,total:size||0,percent:100,skipped:true});return {file:dest,skipped:true};}
  const part=dest+'.part';
  let have=0;try{have=(await fsp.stat(part)).size;}catch{}
  if(size&&have>size){await fsp.rm(part,{force:true});have=0;}
  if(size){
    const stat=await fsp.statfs(path.dirname(dest)).catch(()=>null);
    if(stat&&stat.bavail*stat.bsize<size-have+minFree)throw failure('NO_SPACE','Недостаточно места на диске: нужно ещё '+Math.ceil((size-have+minFree)/1024**2)+' МиБ');
  }
  const headers=have?{Range:`bytes=${have}-`}:{};
  const response=await fetchImpl(url,{headers,signal,redirect:'follow'});
  let total=size||0;
  if(response.status===416){have=0;await fsp.rm(part,{force:true});return download({url,dest,sha256,size,signal,onProgress,fetchImpl,minFree});}
  if(!response.ok&&response.status!==206)throw failure('HTTP','Сервер вернул HTTP '+response.status);
  if(response.status===200&&have){have=0;await fsp.rm(part,{force:true});}
  const length=+response.headers.get('content-length')||0;if(!total)total=have+length;
  const hash=crypto.createHash('sha256');
  if(have)for await(const chunk of fs.createReadStream(part))hash.update(chunk);
  const out=fs.createWriteStream(part,{flags:have?'a':'w',mode:0o600});
  let done=have,last=0,startedAt=Date.now(),startBytes=have;
  const meter=async function*(source){
    for await(const chunk of source){
      hash.update(chunk);done+=chunk.length;
      const now=Date.now();
      if(now-last>=250){last=now;const speed=(done-startBytes)/Math.max(.001,(now-startedAt)/1000);onProgress({phase:'downloading',done,total,percent:total?Math.min(99,100*done/total):0,speed,eta:total&&speed>0?(total-done)/speed:null});}
      yield chunk;
    }
  };
  try{await pipeline(Readable.fromWeb(response.body),meter,out,{signal});}
  catch(error){
    if(signal?.aborted){const e=Error('Загрузка приостановлена');e.code='PAUSED';e.done=done;throw e;}
    throw error;
  }
  if(total&&done!==total)throw failure('INCOMPLETE','Загрузка оборвалась на '+done+' из '+total+' байт. Нажмите «Продолжить».');
  if(hash.digest('hex')!==sha256){await fsp.rm(part,{force:true});throw failure('SHA_MISMATCH','Контрольная сумма SHA-256 не совпала. Повреждённый файл удалён, загрузите снова.');}
  await fsp.rename(part,dest);
  const stat=await fsp.stat(dest);
  await fsp.writeFile(dest+'.verified',JSON.stringify({sha256,size:stat.size,mtimeMs:stat.mtimeMs})).catch(()=>{});
  onProgress({phase:'ready',done,total:done,percent:100});
  return {file:dest,skipped:false};
}
module.exports={download,isVerified,hashFile,checkUrl};
