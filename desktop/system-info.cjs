'use strict';
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {run}=require('./process.cjs');
const paths=require('./paths.cjs');
const tools=require('./tools.cjs');
const isolation=require('./isolation.cjs');
async function read(file){try{return (await fs.readFile(file,'utf8')).trim();}catch{return '';}}
async function exists(file){try{await fs.access(file);return true;}catch{return false;}}
async function modelFiles(directory){try{const names=await fs.readdir(directory);return names.includes('config.json')&&names.some(n=>/\.safetensors$/.test(n));}catch{return false;}}
async function gpuInfo(){
  let entries=[];try{entries=await fs.readdir('/sys/class/drm');}catch{}
  let ids='';for(const file of ['/usr/share/hwdata/pci.ids','/usr/share/misc/pci.ids']){ids=await read(file);if(ids)break;}
  const devices=[];
  for(const name of entries.filter(n=>/^card\d+$/.test(n))){
    const base='/sys/class/drm/'+name+'/device',vendor=(await read(base+'/vendor')).replace(/^0x/,''),device=(await read(base+'/device')).replace(/^0x/,'');if(!vendor||!device)continue;
    let driver='';try{driver=path.basename(await fs.readlink(base+'/driver'));}catch{}
    const section=ids.split('\n'+vendor+'  ')[1]?.split(/\n[^\t#]/)[0]||'',model=section.match(new RegExp('\\n\\t'+device+'  ([^\\n]+)'))?.[1];
    const maker=vendor==='8086'?'Intel':vendor==='10de'?'NVIDIA':vendor==='1002'?'AMD':vendor;
    const total=+(await read(base+'/mem_info_vram_total'))||0,used=+(await read(base+'/mem_info_vram_used'))||0;
    devices.push({name:model?maker+' '+model:maker+' / '+(driver||'PCIe'),vendor,device,driver,vramTotal:total||null,vramUsed:total?used:null});
  }
  return devices;
}
const VENDORS={'10de':'NVIDIA','1002':'AMD','8086':'Intel'};
// Read-only queries: WMI for the adapter list, the display-class registry key for the real VRAM size
// (Win32_VideoController.AdapterRAM is 32-bit and caps at 4 GiB), nvidia-smi when present. Nothing runs on the GPU.
const WINDOWS_GPU_SCRIPT=`$ErrorActionPreference='SilentlyContinue';$vram=@{};$cls='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';Get-ChildItem $cls|ForEach-Object{$p=Get-ItemProperty $_.PSPath;$q=$p.'HardwareInformation.qwMemorySize';if($p.DriverDesc -and $q){if($q -is [byte[]]){$q=[BitConverter]::ToUInt64($q,0)};$vram[$p.DriverDesc]=[uint64]$q}};@(Get-CimInstance Win32_VideoController|ForEach-Object{[pscustomobject]@{name=$_.Name;pnp=$_.PNPDeviceID;driver=$_.DriverVersion;adapterRam=$_.AdapterRAM;vram=$vram[$_.Name]}})|ConvertTo-Json -Compress`;
function parseWindowsGpus(text){
  let list;try{list=JSON.parse(text||'[]');}catch{return [];}
  if(!Array.isArray(list))list=[list];
  return list.filter(g=>g&&g.name&&!/Microsoft Basic|Remote Display|Hyper-V/i.test(g.name)).map(g=>{
    const ven=(String(g.pnp||'').match(/VEN_([0-9A-F]{4})/i)?.[1]||'').toLowerCase(),dev=(String(g.pnp||'').match(/DEV_([0-9A-F]{4})/i)?.[1]||'').toLowerCase();
    const total=+g.vram||0;
    return {name:g.name,vendor:ven,device:dev,maker:VENDORS[ven]||ven,driver:g.driver||'',vramTotal:total||null,vramUsed:null,vramApproximate:!total&&+g.adapterRam?true:undefined,vramAdapterRam:!total&&+g.adapterRam?+g.adapterRam:undefined};
  });
}
function parseNvidiaSmi(text){
  return String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(l=>{const [name,total,used,driver]=l.split(/\s*,\s*/);return {name,vramTotal:(+total||0)*1024**2||null,vramUsed:(+used||0)*1024**2,driver};}).filter(g=>g.name);
}
async function gpuInfoWindows(execute=run){
  let devices=[];
  try{devices=parseWindowsGpus((await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',WINDOWS_GPU_SCRIPT],{timeout:20000})).output);}catch{}
  return mergeNvidia(devices,execute);
}
async function mergeNvidia(devices,execute=run){
  let smi=[];try{smi=parseNvidiaSmi((await execute('nvidia-smi',['--query-gpu=name,memory.total,memory.used,driver_version','--format=csv,noheader,nounits'],{timeout:10000})).output);}catch{}
  if(!smi.length)return devices;
  const nvidia=devices.filter(d=>d.vendor==='10de');
  if(!nvidia.length)return [...devices,...smi.map(g=>({...g,vendor:'10de',device:'',maker:'NVIDIA',vramApproximate:undefined}))];
  nvidia.forEach((d,i)=>{const g=smi.find(x=>d.name.includes(x.name)||x.name.includes(d.name))||smi[i];if(g)Object.assign(d,{vramTotal:g.vramTotal,vramUsed:g.vramUsed,driver:g.driver||d.driver,vramApproximate:undefined,vramAdapterRam:undefined});});
  return devices;
}
async function inspectSystem({root,settings,modelState,lastError='',execute=run}){
  const checked=Date.now(),items=[];
  const definitions=[['Python / Qwen',settings.qwenPython]];
  if(isolation.mode==='systemd-bwrap')definitions.push(['Ограничение ресурсов CPU','/usr/bin/systemd-run'],['Изоляция обработки','/usr/bin/bwrap']);
  for(const [name,file] of definitions){const ok=await exists(file);items.push({name,ok,detail:ok?'Файл найден: '+file:'Не найден файл: '+file});}
  if(isolation.mode==='watchdog')items.push({name:'Защита обработки',ok:true,detail:'Упрощённый режим (watchdog), не изоляция: пониженный приоритет, контроль памяти и диска, остановка при зависании.'});
  for(const [name,dir] of [['Qwen3-ASR-1.7B',settings.asrModel],['Qwen3-ForcedAligner-0.6B',settings.alignerModel]]){const ok=await modelFiles(dir);items.push({name,ok,detail:ok?'Файлы модели найдены; запуск не выполнялся.':'Не найдены config.json или веса safetensors: '+dir});}
  let ffmpeg='';try{const r=await execute(tools.ffmpeg(),['-version'],{timeout:10000});ffmpeg=(r.output||r.errors).split('\n')[0];const where=tools.status();items.push({name:'FFmpeg',ok:true,detail:ffmpeg+(where.ffmpeg?' · '+where.ffmpeg+(where.source==='own'?' (скачан программой)':where.source==='system'?' (системный)':''):'')});}catch(e){items.push({name:'FFmpeg',ok:false,detail:e.message});}
  items.push({name:'Устройство Qwen',ok:true,detail:'Настроено: '+(settings.gpu?settings.qwenDevice:'cpu')+'. GPU и модели для диагностики не запускаются.'});
  const cpus=os.cpus(),total=os.totalmem(),free=os.freemem();let disk=null;
  try{const stat=await fs.statfs(root);disk={total:stat.blocks*stat.bsize,available:stat.bavail*stat.bsize,used:(stat.blocks-stat.bfree)*stat.bsize};}catch{}
  const devices=paths.isWindows()?await gpuInfoWindows(execute):await mergeNvidia(await gpuInfo(),execute);
  return {checked,items,system:{platform:os.platform(),release:os.release(),arch:os.arch(),cpu:{name:cpus[0]?.model||'Неизвестный процессор',threads:cpus.length,mhz:cpus[0]?.speed||0,load:os.loadavg()},memory:{total,used:total-free,free},gpu:devices,disk,ffmpeg,modelsPath:settings.asrModel},modelState,lastError,nonInvasive:true,modelsRun:false,gpuProbed:false,decoderRun:false};
}
module.exports={gpuInfo,inspectSystem,parseWindowsGpus,parseNvidiaSmi,mergeNvidia,gpuInfoWindows};
