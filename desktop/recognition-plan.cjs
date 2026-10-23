'use strict';
const gpu=require('./gpu.cjs');
const pyenv=require('./pyenv.cjs');

const family=tag=>String(tag||'').replace(/\d.*$/,'');
const SERVES={cuda:['cu'],xpu:['xpu'],rocm:['rocm'],cpu:['cpu','cu','xpu','rocm']};
// What the recognition stage will actually run on, given the settings, the hardware and the installed PyTorch build.
// An explicitly chosen device that cannot be used is an error; "auto" falls back to the CPU and says why.
function planDevice({settings,caps,env}){
  if(!pyenv.envReady(env))return {problem:'Окружение распознавания не установлено. Откройте «Модели» и установите его.'};
  const choice=settings.gpu===false?'cpu':(settings.qwenDevice||'auto');
  if(choice==='cpu')return {device:'cpu',reason:settings.gpu===false?'Использование видеокарты выключено в настройках.':'Выбрано в настройках.',build:env.torchBackend};
  const explicit=choice!=='auto';
  let pick;
  try{pick=gpu.resolveChoice('recognition',choice,caps);}catch(error){return {problem:error.message};}
  const build=family(env.torchBackend);
  if(pick.id==='cpu')return {device:'cpu',reason:'Подходящей видеокарты для распознавания не найдено.',build:env.torchBackend};
  if(!SERVES[pick.id].includes(build)){
    const message=`В окружении установлена сборка PyTorch «${env.torchBackend}», а для ${pick.id.toUpperCase()} нужна другая. Переустановите окружение в разделе «Модели».`;
    if(explicit)return {problem:message};
    return {device:'cpu',reason:message,build:env.torchBackend,degraded:true};
  }
  return {device:pick.id,reason:'',build:env.torchBackend,name:pick.device};
}
// Time for one run on the CPU. Without a measurement on this machine the range is deliberately wide and flagged as such;
// after every CPU run the real speed (processing time / audio time) is stored and the range narrows around it.
const UNMEASURED=Object.freeze({low:1.0,high:4.0});
function estimateCpu({seconds,factor,threads=6}){
  const calibrated=Number.isFinite(factor)&&factor>0;
  const low=calibrated?factor*.85:UNMEASURED.low*Math.max(1,6/Math.max(1,threads)),high=calibrated?factor*1.3:UNMEASURED.high*Math.max(1,6/Math.max(1,threads));
  return {minSeconds:Math.round(seconds*low),maxSeconds:Math.round(seconds*high),calibrated};
}
function updateFactor(previous,measured){return Number.isFinite(previous)&&previous>0?+(previous*.6+measured*.4).toFixed(3):+measured.toFixed(3);}
function formatDuration(seconds){
  if(seconds<90)return 'около минуты';
  const m=Math.round(seconds/60);if(m<90)return m+' мин';
  const h=Math.floor(m/60),r=m%60;return h+' ч'+(r?' '+r+' мин':'');
}
module.exports={planDevice,estimateCpu,updateFactor,formatDuration,family};
