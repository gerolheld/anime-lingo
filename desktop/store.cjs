'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');

// Durable replace: write a unique temp file, fsync it, keep the previous good file as .bak, then rename.
async function writeAtomic(file,text,{mode=0o600,backup=true}={}){
  const temp=`${file}.${randomUUID().slice(0,8)}.tmp`;
  const handle=await fs.open(temp,'w',mode);
  try{await handle.writeFile(text);await handle.sync();}
  catch(error){await handle.close().catch(()=>{});await fs.rm(temp,{force:true});throw error;}
  await handle.close();
  if(backup)try{await fs.copyFile(file,file+'.bak');}catch(error){if(error.code!=='ENOENT'){await fs.rm(temp,{force:true});throw error;}}
  // Windows can briefly refuse to replace a file that antivirus or an indexer has open.
  for(let attempt=0;;attempt++){
    try{await fs.rename(temp,file);return;}
    catch(error){if(attempt>=5||!['EPERM','EBUSY','EACCES'].includes(error.code)){await fs.rm(temp,{force:true});throw error;}await delay(40*(attempt+1));}
  }
}

// Returns {data,source} where source is 'main' | 'backup'; data is null when nothing exists yet.
// A damaged main file is moved aside (never deleted) before the backup is used.
async function readJsonWithBackup(file){
  let firstError;
  for(const [candidate,source] of [[file,'main'],[file+'.bak','backup']]){
    let text;
    try{text=await fs.readFile(candidate,'utf8');}
    catch(error){if(error.code==='ENOENT')continue;firstError??=error;continue;}
    try{
      const data=JSON.parse(text);
      if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Ожидался объект');
      if(source==='backup'){
        await fs.rename(file,`${file}.damaged-${Date.now()}`).catch(()=>{});
        await fs.copyFile(candidate,file).catch(()=>{});
      }
      return {data,source};
    }catch(error){firstError??=error;}
  }
  if(firstError)throw firstError;
  return {data:null,source:null};
}

// Names that are legal on every OS: no reserved characters or device names, no trailing dots or spaces.
function safeFileName(name){
  const clean=String(name||'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,120);
  return !clean||/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean)?'anime-lingo-'+(clean||'file'):clean;
}

function withTimeout(promise,ms){
  let timer;
  return Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(undefined),ms);timer.unref?.();})]).finally(()=>clearTimeout(timer));
}

module.exports={writeAtomic,readJsonWithBackup,withTimeout,safeFileName};
