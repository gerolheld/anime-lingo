'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');

// A cancelled stage must stop its whole process tree (ffmpeg spawned by Python, llama-server helpers, ...).
// POSIX: the child leads its own process group and the group is signalled. Windows: taskkill /T /F.
function killTree(child,{grace=1500,platform=process.platform}={}){
  if(!child.pid||child.exitCode!==null||child.signalCode)return;
  if(platform==='win32'){
    const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    killer.on('error',()=>{try{child.kill();}catch{}});
    return;
  }
  const signalGroup=signal=>{try{process.kill(-child.pid,signal);}catch{try{child.kill(signal);}catch{}}};
  signalGroup('SIGTERM');
  // The leader may already be gone while group members linger, so the group is always swept.
  setTimeout(()=>signalGroup('SIGKILL'),grace).unref();
}
const missingTool=(binary,error)=>{
  const name=path.basename(String(binary)).replace(/\.exe$/i,'');
  if(error.code==='ENOENT'&&['ffmpeg','ffprobe'].includes(name))return Object.assign(Error('Не найден '+name+'. Откройте «Диагностика» и установите компонент FFmpeg.'),{code:'ENOENT',tool:name});
  return error;
};
function run(binary,args,{signal,onData,onStdout,onSpawn,timeout=0,cwd,env}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Error('Отменено'));
    const child=spawn(binary,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,cwd,env:env?{...process.env,...env}:process.env,detached:process.platform!=='win32'});
    let output='',errors='',finished=false,timedOut=false;
    const kill=()=>killTree(child);
    const timer=timeout?setTimeout(()=>{timedOut=true;kill();},timeout):null;
    const cleanup=()=>{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',kill);};
    signal?.addEventListener('abort',kill,{once:true});
    if(child.pid)try{onSpawn?.(child);}catch{}
    child.stdout.on('data',b=>{output=(output+b).slice(-8*1024*1024);onData?.(b.toString());onStdout?.(b.toString());});
    child.stderr.on('data',b=>{errors=(errors+b).slice(-24000);onData?.(b.toString());});
    child.on('error',e=>{cleanup();reject(missingTool(binary,e));});
    child.on('close',code=>{cleanup();if(signal?.aborted)reject(Error('Отменено'));else if(timedOut)reject(Error(path.basename(binary)+': превышено время ожидания'));else if(code!==0)reject(Error(`${path.basename(binary)}: ${errors.slice(-1600)||'код '+code}`));else resolve({output,errors});});
  });
}
module.exports={run,killTree};
