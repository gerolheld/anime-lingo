'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {run}=require('./process.cjs');
const LIMITS=Object.freeze({memory:1536*1024**2,memoryHigh:1200*1024**2,cpuQuota:150,threads:2,tasks:64,minAvailable:2304*1024**2,stopAvailable:768*1024**2,minDisk:256*1024**2,stallMs:120000});
function safetyError(message){return Object.assign(Error(message),{code:'ENHANCE_SAFETY_STOP'});}
async function availableMemory(){try{const text=await fs.readFile('/proc/meminfo','utf8'),m=text.match(/^MemAvailable:\s+(\d+) kB/m);if(m)return +m[1]*1024;}catch{}return os.freemem();}
function limitedCommand(binary,args,{unit,writeDirectory,runtime=86400}={}){
  if(!/^anime-lingo-enhance-[a-f0-9-]+\.service$/.test(unit||''))throw Error('Некорректное имя задачи');
  if(!path.isAbsolute(binary)||!path.isAbsolute(writeDirectory)||writeDirectory===path.parse(writeDirectory).root)throw Error('Некорректный путь обработки');
  const properties={MemoryMax:LIMITS.memory,MemoryHigh:LIMITS.memoryHigh,MemorySwapMax:0,CPUQuota:LIMITS.cpuQuota+'%',TasksMax:LIMITS.tasks,Nice:10,IOWeight:20,OOMPolicy:'kill',KillMode:'control-group',TimeoutStopSec:'3s',RuntimeMaxSec:runtime+'s',UMask:'0077',NoNewPrivileges:'yes'};
  return {binary:'/usr/bin/systemd-run',args:['--user','--quiet','--wait','--pipe','--collect','--service-type=exec','--expand-environment=no','--unit='+unit,...Object.entries(properties).map(([k,v])=>'--property='+k+'='+v),'/usr/bin/bwrap','--die-with-parent','--new-session','--unshare-user','--unshare-pid','--unshare-net','--unshare-ipc','--unshare-uts','--ro-bind','/','/','--proc','/proc','--dev','/dev','--bind',writeDirectory,writeDirectory,'--chdir',writeDirectory,'--clearenv','--setenv','PATH','/usr/bin:/bin','--setenv','LANG','C.UTF-8','--setenv','OMP_NUM_THREADS',String(LIMITS.threads),'--setenv','OPENBLAS_NUM_THREADS','1','--',binary,...args]};
}
async function checkHeadroom(directory,{requiredDisk=LIMITS.minDisk,memory=availableMemory,statfs=fs.statfs}={}){
  try{
    if(await memory()<LIMITS.minAvailable)throw safetyError('Мало свободной памяти для улучшения. Освободи не менее 2,25 ГиБ ОЗУ.');
    const s=await statfs(directory);if(s.bavail*s.bsize<requiredDisk)throw safetyError('Недостаточно свободного места для результата улучшения.');
  }catch(error){if(error.code==='ENHANCE_SAFETY_STOP')throw error;throw safetyError('Не удалось проверить ресурсы перед обработкой: '+error.message);}
}
async function runLimited(binary,args,{signal,writeDirectory,onStdout,stallMs=LIMITS.stallMs,runtime=86400,execute=run,memory=availableMemory,statfs=fs.statfs,now=Date.now,interval=setInterval,clear=clearInterval}={}){
  if(signal?.aborted)throw Error('Отменено');
  const unit='anime-lingo-enhance-'+randomUUID()+'.service',command=limitedCommand(binary,args,{unit,writeDirectory,runtime}),abort=new AbortController(),combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
  let last=now(),failure,checking=false,stopping,finished=false;
  const stop=(again=false)=>{if(!stopping||again)stopping=execute('/usr/bin/systemctl',['--user','stop',unit],{timeout:8000}).catch(()=>{});return stopping;};
  const onAbort=()=>stop();
  const markProgress=()=>{last=now();};
  combined.addEventListener('abort',onAbort,{once:true});
  const timer=interval(async()=>{
    if(finished||checking||combined.aborted)return;checking=true;
    try{
      if(now()-last>stallMs)throw safetyError('Обработка остановлена: долго нет прогресса. Автоматический повтор отключён.');
      if(await memory()<LIMITS.stopAvailable)throw safetyError('Обработка остановлена: системе не хватает свободной памяти.');
      const s=await statfs(writeDirectory);if(s.bavail*s.bsize<LIMITS.minDisk)throw safetyError('Обработка остановлена: заканчивается место на диске.');
    }catch(error){if(!finished){failure=error.code==='ENHANCE_SAFETY_STOP'?error:safetyError('Не удалось проверить ресурсы: '+error.message);abort.abort();}}finally{checking=false;}
  },2000);timer.unref?.();
  try{
    const result=await execute(command.binary,command.args,{signal:combined,timeout:runtime*1000+15000,onStdout:text=>{try{onStdout?.(text,markProgress);}catch(error){failure=safetyError('Ошибка отчёта обработки: '+error.message);abort.abort();}}});
    if(signal?.aborted)throw Error('Отменено');if(failure)throw failure;return result;
  }catch(error){
    if(signal?.aborted)throw Error('Отменено');
    if(failure)throw failure;
    throw safetyError('Задача остановлена. GPU не запускался; работа без ограничений запрещена. '+error.message.slice(-1600));
  }finally{
    finished=true;clear(timer);combined.removeEventListener('abort',onAbort);
    // Killing systemd-run alone does not reliably stop its service. Stop the cgroup too.
    await stopping;await stop(true);
  }
}
async function stopOrphanedEnhancements(execute=run){
  const r=await execute('/usr/bin/systemctl',['--user','list-units','--all','--plain','--no-legend','anime-lingo-enhance-*.service'],{timeout:8000});
  const units=r.output.split(/\s+/).filter(x=>/^anime-lingo-enhance-[a-f0-9-]+\.service$/.test(x));
  for(const unit of units)await execute('/usr/bin/systemctl',['--user','stop',unit],{timeout:8000});
  return units.length;
}
module.exports={LIMITS,limitedCommand,runLimited,checkHeadroom,availableMemory,safetyError,stopOrphanedEnhancements};
