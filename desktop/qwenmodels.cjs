'use strict';
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {download}=require('./downloader.cjs');
const {writeAtomic}=require('./store.cjs');
const Qwen=require('./qwen.cjs');

// Same pinned revisions as tools/download-qwen-models.py. Every file is checked: LFS files by SHA-256, small files by git blob id.
const MODELS=Object.freeze({
  asr:{repo:'Qwen/Qwen3-ASR-1.7B',revision:'7278e1e70fe206f11671096ffdd38061171dd6e5',folder:'Qwen3-ASR-1.7B'},
  aligner:{repo:'Qwen/Qwen3-ForcedAligner-0.6B',revision:'c7cbfc2048c462b0d63a45797104fc9db3ad62b7',folder:'Qwen3-ForcedAligner-0.6B'},
});
const gitBlobId=bytes=>crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

async function plan(model,{fetchImpl=fetch,signal}={}){
  const response=await fetchImpl(`https://huggingface.co/api/models/${model.repo}/revision/${model.revision}?blobs=true`,{signal});
  if(!response.ok)throw Error('Hugging Face вернул HTTP '+response.status);
  const meta=await response.json(),files=[];
  for(const entry of meta.siblings){
    const name=entry.rfilename;
    if(name.startsWith('.')||name==='README.md')continue;
    if(path.basename(name)!==name)throw Error('Неожиданный вложенный файл модели: '+name);
    files.push({name,size:entry.size,sha256:entry.lfs?.sha256||null,blobId:entry.blobId||null,url:`https://huggingface.co/${model.repo}/resolve/${model.revision}/${name}`});
  }
  return files;
}
async function installModel(model,directory,{signal,onProgress=()=>{},fetchImpl=fetch,downloadFile=download,base=0,grand=0}={}){
  const target=path.join(directory,model.folder);await fsp.mkdir(target,{recursive:true});
  const files=await plan(model,{fetchImpl,signal}),total=grand||files.reduce((s,f)=>s+f.size,0);
  let done=base;
  for(const file of files){
    const dest=path.join(target,file.name),before=done;
    if(file.sha256){
      await downloadFile({url:file.url,dest,sha256:file.sha256,size:file.size,signal,onProgress:p=>onProgress({phase:'downloading',file:file.name,done:before+(p.done||0),total,percent:Math.min(99,100*(before+(p.done||0))/Math.max(1,total)),speed:p.speed,eta:p.eta})});
    }else{
      let ok=false;try{const bytes=await fsp.readFile(dest);ok=bytes.length===file.size&&(!file.blobId||gitBlobId(bytes)===file.blobId);}catch{}
      if(!ok){
        const r=await fetchImpl(file.url,{signal});if(!r.ok)throw Error(file.name+': HTTP '+r.status);
        const bytes=Buffer.from(await r.arrayBuffer());
        if(bytes.length!==file.size||(file.blobId&&gitBlobId(bytes)!==file.blobId))throw Object.assign(Error('Файл модели повреждён: '+file.name),{code:'SHA_MISMATCH'});
        await writeAtomic(dest,bytes);
      }
    }
    done=before+file.size;
  }
  await writeAtomic(path.join(target,'anime-lingo-model.json'),JSON.stringify({repo:model.repo,revision:model.revision,verified:true},null,2));
  return {directory:target,bytes:done-base};
}
async function sizes(options){
  const [a,b]=await Promise.all(Object.values(MODELS).map(m=>plan(m,options)));
  return {asr:a.reduce((s,f)=>s+f.size,0),aligner:b.reduce((s,f)=>s+f.size,0)};
}
// Installs both models; progress is aggregated over the whole download.
async function installQwenModels({directory,signal,onProgress=()=>{},fetchImpl=fetch,downloadFile=download,only}={}){
  const wanted=Object.entries(MODELS).filter(([key])=>!only||only===key);
  const plans=await Promise.all(wanted.map(([,m])=>plan(m,{fetchImpl,signal})));
  const grand=plans.flat().reduce((s,f)=>s+f.size,0);let base=0;
  for(const [index,[,model]] of wanted.entries()){
    const r=await installModel(model,directory,{signal,onProgress,fetchImpl,downloadFile,base,grand});base+=plans[index].reduce((s,f)=>s+f.size,0);void r;
  }
  onProgress({phase:'ready',percent:100,done:grand,total:grand});
}
async function modelStatus(settings){
  const result={};
  for(const [key,field] of [['asr','asrModel'],['aligner','alignerModel']]){
    try{await Qwen.validateModel(settings[field]);result[key]={complete:true,directory:settings[field]};}
    catch(error){result[key]={complete:false,directory:settings[field],reason:error.code==='ENOENT'?'не скачана':error.message};}
  }
  return result;
}
module.exports={MODELS,plan,installModel,installQwenModels,modelStatus,sizes,gitBlobId};
