'use strict';
// Windows (and any platform without systemd/bubblewrap): a watchdog, NOT isolation.
// What it does: below-normal priority, a stop when the job's memory or the system's free memory
// is too low, a stop when the disk fills or no progress arrives, and a whole-tree kill on cancel.
// What it does not do: it does not sandbox files, network or devices, and the memory limit is
// enforced by polling every two seconds, so a very fast allocation can overshoot before the stop.
const fs=require('node:fs/promises');
const os=require('node:os');
const {run}=require('./process.cjs');
const {LIMITS,safetyError,checkHeadroom,availableMemory}=require('./enhance-limits.cjs');

async function processMemory(pid,execute=run){
  const r=await execute('tasklist',['/FI','PID eq '+pid,'/FO','CSV','/NH'],{timeout:5000});
  const cells=r.output.trim().split(/"\s*,\s*"/);
  const digits=(cells.at(-1)||'').replace(/\D/g,'');
  return digits?+digits*1024:null;
}
async function runLimited(binary,args,{signal,writeDirectory,onStdout,stallMs=LIMITS.stallMs,runtime=86400,execute=run,memory=availableMemory,statfs=fs.statfs,now=Date.now,interval=setInterval,clear=clearInterval,jobMemory=processMemory,memoryLimit=LIMITS.memory}={}){
  if(signal?.aborted)throw Error('Отменено');
  const abort=new AbortController(),combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
  let last=now(),failure,checking=false,finished=false,pid=null;
  const markProgress=()=>{last=now();};
  const timer=interval(async()=>{
    if(finished||checking||combined.aborted)return;checking=true;
    try{
      if(now()-last>stallMs)throw safetyError('Обработка остановлена: долго нет прогресса. Автоматический повтор отключён.');
      if(await memory()<LIMITS.stopAvailable)throw safetyError('Обработка остановлена: системе не хватает свободной памяти.');
      const s=await statfs(writeDirectory);if(s.bavail*s.bsize<LIMITS.minDisk)throw safetyError('Обработка остановлена: заканчивается место на диске.');
      if(pid){const used=await jobMemory(pid).catch(()=>null);if(used&&used>memoryLimit)throw safetyError('Обработка остановлена: задача заняла больше '+(memoryLimit/1024**3).toFixed(1).replace('.',',').replace(',0','')+' ГиБ памяти.');}
    }catch(error){if(!finished){failure=error.code==='ENHANCE_SAFETY_STOP'?error:safetyError('Не удалось проверить ресурсы: '+error.message);abort.abort();}}finally{checking=false;}
  },2000);timer.unref?.();
  try{
    const result=await execute(binary,args,{signal:combined,timeout:runtime*1000+15000,cwd:writeDirectory,
      onSpawn:child=>{pid=child.pid;try{os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}},
      onData:()=>markProgress(),
      onStdout:text=>{try{onStdout?.(text,markProgress);}catch(error){failure=safetyError('Ошибка отчёта обработки: '+error.message);abort.abort();}}});
    if(signal?.aborted)throw Error('Отменено');if(failure)throw failure;return result;
  }catch(error){
    if(signal?.aborted)throw Error('Отменено');
    if(failure)throw failure;
    // The watchdog's own stops carry ENHANCE_SAFETY_STOP; an ordinary process failure is reported as such.
    throw Object.assign(Error('Задача остановлена: '+error.message.slice(-1600)),{code:'PROCESS_FAILED'});
  }finally{finished=true;clear(timer);}
}
const stopOrphanedEnhancements=async()=>0;
module.exports={LIMITS,runLimited,checkHeadroom,availableMemory,safetyError,stopOrphanedEnhancements,processMemory};
