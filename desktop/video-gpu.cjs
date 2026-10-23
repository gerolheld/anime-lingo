'use strict';
// GPU help for video enhancement is an explicit, opt-in mode. Nothing here runs unless the user enabled it;
// the encoder is chosen only after a real one-second test encode (started by the user), never by the card's name.
const fs=require('node:fs');
const {makerOf}=require('./gpu.cjs');

const ENCODERS=Object.freeze({
  nvenc:{codec:'h264_nvenc',vendors:['NVIDIA'],platforms:['win32','linux'],label:'NVIDIA NVENC',quality:['-rc','vbr','-cq','19','-b:v','0'],vf:null,pre:[]},
  amf:{codec:'h264_amf',vendors:['AMD'],platforms:['win32'],label:'AMD AMF',quality:['-rc','cqp','-qp_i','19','-qp_p','19','-qp_b','19'],vf:null,pre:[]},
  vaapi:{codec:'h264_vaapi',vendors:['AMD','Intel'],platforms:['linux'],label:'VAAPI',quality:['-qp','19'],vf:'format=nv12,hwupload',pre:node=>['-vaapi_device',node]},
  qsv:{codec:'h264_qsv',vendors:['Intel'],platforms:['win32','linux'],label:'Intel Quick Sync',quality:['-global_quality','19'],vf:'format=nv12,hwupload=extra_hw_frames=64',pre:()=>['-init_hw_device','qsv=hw','-filter_hw_device','hw']},
});
const ORDER=['nvenc','amf','qsv','vaapi'];

function parseEncoders(text){const out=new Set();for(const line of String(text).split(/\r?\n/)){const m=line.match(/^\s*[VAS][\w.]{5}\s+(\S+)/);if(m)out.add(m[1]);}return out;}
function renderNode(list=()=>{try{return fs.readdirSync('/dev/dri');}catch{return [];}}){const n=list().filter(x=>/^renderD\d+$/.test(x)).sort()[0];return n?'/dev/dri/'+n:null;}

// Encoders that fit the hardware, the OS and this ffmpeg build. "available" is still only a candidate until probed.
function candidates({gpus,platform=process.platform,supported=new Set(),node=renderNode()}){
  const out=[];
  for(const id of ORDER){
    const e=ENCODERS[id];if(!e.platforms.includes(platform))continue;
    const gpu=gpus.find(g=>e.vendors.includes(makerOf(g)));if(!gpu)continue;
    let reason='';
    if(!supported.has(e.codec))reason='Этот ffmpeg собран без '+e.codec+'.';
    else if(id==='vaapi'&&!node)reason='Не найдено устройство /dev/dri/renderD*.';
    out.push({id,codec:e.codec,label:e.label,device:gpu.name,available:!reason,reason});
  }
  return out;
}
function encoderArgs(id,{node}={}){
  const e=ENCODERS[id];if(!e)throw Error('Неизвестный кодировщик: '+id);
  return {codec:e.codec,pre:typeof e.pre==='function'?e.pre(node):e.pre,vf:e.vf,quality:e.quality};
}
// Plain CPU encoder arguments, used when no probed hardware encoder is available.
const CPU_ENCODER={codec:'libx264',pre:[],vf:null,quality:['-preset','veryfast','-crf','19']};

// A one-second synthetic encode with a hard timeout. Result is a plain object the caller stores.
async function probeEncoder({id,ffmpeg,execute,node=renderNode(),timeout=25000,signal,now=Date.now}){
  const spec=encoderArgs(id,{node}),started=now();
  const args=['-hide_banner','-loglevel','error','-nostdin','-y',...spec.pre,'-f','lavfi','-i','testsrc2=size=640x360:rate=24:duration=1','-vf',[...(spec.vf?[]:['format=yuv420p']),...(spec.vf?[spec.vf]:[])].join(','),'-c:v',spec.codec,...spec.quality,'-frames:v','24','-f','null','-'];
  try{await execute(ffmpeg,args,{timeout,signal});return {ok:true,ms:now()-started,at:started};}
  catch(error){return {ok:false,error:String(error.message).slice(-300),ms:now()-started,at:started};}
}
// Auto picks the first candidate whose probe succeeded; without one the CPU encoder is used.
function chooseEncoder({choice='auto',probes={},cands}){
  if(choice==='cpu')return 'cpu';
  if(choice!=='auto'){
    const c=cands.find(x=>x.id===choice);
    if(!c)throw Error('Кодировщик '+choice+' не подходит этой видеокарте или ОС.');
    if(!c.available)throw Error(c.reason);
    if(!probes[choice]?.ok)throw Error('Кодировщик '+c.label+' ещё не проверен коротким тестом. Откройте «Модели» → «Видео» и нажмите «Проверить».');
    return choice;
  }
  return cands.find(c=>c.available&&probes[c.id]?.ok)?.id||'cpu';
}

// May the GPU mode run at all? Intel Xe under Linux hung the whole system in 2.5, so it needs a separate confirmation.
function gate({settings,gpus,platform=process.platform}){
  const cfg=settings.videoGpu||{};
  const xe=platform==='linux'&&gpus.some(g=>makerOf(g)==='Intel'&&g.driver==='xe');
  const warning='GPU-режим не изолирован: процесс получает доступ к видеокарте. Долгая обработка на некоторых драйверах может подвесить систему. Работа идёт короткими отрезками с наблюдением за зависанием; при сбое задача автоматически повторяется на CPU. Исходное видео не изменяется.';
  if(!cfg.enabled)return {allowed:false,reason:'GPU-режим выключен. Включите его в разделе «Модели» → «Видео».',warning,xe};
  if(!cfg.acknowledged)return {allowed:false,reason:'Подтвердите предупреждение в разделе «Модели» → «Видео».',warning,xe};
  if(xe&&!cfg.allowIntelXe)return {allowed:false,reason:'На Intel Xe в Linux GPU-режим выключен: ранее он вешал систему. Включайте только осознанно.',warning,xe,xeBlocked:true};
  return {allowed:true,warning,xe};
}
module.exports={ENCODERS,CPU_ENCODER,parseEncoders,renderNode,candidates,encoderArgs,probeEncoder,chooseEncoder,gate};
