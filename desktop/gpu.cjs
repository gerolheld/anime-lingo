'use strict';
// One module answers: which graphics cards are here, and which backend can each task use on them.
// Detection is read-only (sysfs / WMI / nvidia-smi): no GPU context is created and no model is touched.
// "available" means the hardware and OS make the backend plausible. It is NOT proof that it runs:
// only a real short test, started by the user, can show that.
const fs=require('node:fs');
const {run}=require('./process.cjs');
const paths=require('./paths.cjs');
const system=require('./system-info.cjs');

const MAKER={'10de':'NVIDIA','1002':'AMD','8086':'Intel'};
const makerOf=g=>g.maker||MAKER[g.vendor]||'';
const GIB=1024**3;

// Official AMD PyTorch-for-Windows wheels cover only these Radeon generations (RDNA3 / RDNA4 listed models).
const AMD_WINDOWS_TORCH=/RX\s*(9070|9060|7900\s*XTX)|R9700/i;
// Intel XPU in PyTorch targets Arc and Core Ultra graphics, not older UHD/HD parts.
const INTEL_XPU=/Arc|Battlemage|Alchemist|Iris\s*Xe|Core\s*Ultra|Data Center GPU/i;
// GeForce RTX 50 (Blackwell) is not supported by the CUDA 12.6 wheels.
const BLACKWELL=/RTX\s*50\d\d|RTX\s*PRO\s*\d*000\s*Blackwell|B[12]00/i;

function nvidiaDriverMajor(g){return Math.floor(parseFloat(String(g.driver||'').replace(/^\d+\.\d+\./,'').replace(/^(\d{1,3}\.\d+).*/,'$1'))||0);}

function vulkanLoaderPresent(platform,exists=fs.existsSync){
  if(platform==='win32')return true; // vulkan-1.dll ships with every GPU driver
  return ['/usr/lib/libvulkan.so.1','/usr/lib64/libvulkan.so.1','/usr/lib/x86_64-linux-gnu/libvulkan.so.1','/lib/x86_64-linux-gnu/libvulkan.so.1'].some(p=>exists(p));
}

const option=(id,available,reason='',extra={})=>({id,available,reason,...extra});

function recognitionOptions(gpus,platform){
  const nvidia=gpus.filter(g=>makerOf(g)==='NVIDIA'),intel=gpus.filter(g=>makerOf(g)==='Intel'),amd=gpus.filter(g=>makerOf(g)==='AMD');
  const out=[];
  if(nvidia.length){
    const g=nvidia[0],blackwell=BLACKWELL.test(g.name),major=nvidiaDriverMajor(g);
    // cu130 for Blackwell and new drivers, cu126 otherwise.
    const wheel=blackwell||major>=580?'cu130':'cu126';
    const needsDriver=blackwell&&major&&major<580;
    out.push(option('cuda',!needsDriver,needsDriver?'Для видеокарты RTX 50 нужен драйвер NVIDIA версии 580 или новее.':'',{device:g.name,torchBackend:wheel}));
  }else out.push(option('cuda',false,'Видеокарта NVIDIA не найдена.'));
  if(intel.length){
    const g=intel.find(x=>INTEL_XPU.test(x.name));
    out.push(g?option('xpu',true,'',{device:g.name,torchBackend:'xpu'}):option('xpu',false,'Графика Intel ('+intel[0].name+') не поддерживается PyTorch XPU: нужна Intel Arc или Core Ultra.'));
  }else out.push(option('xpu',false,'Видеокарта Intel не найдена.'));
  if(amd.length){
    if(platform==='win32'){
      const g=amd.find(x=>AMD_WINDOWS_TORCH.test(x.name));
      out.push(g?option('rocm',false,'Для Radeon на Windows есть только отдельные сборки AMD (ROCm 7.2) для RX 9000 и 7900 XTX. Они не входят в программу: распознавание идёт на CPU.',{device:g.name,experimental:true}):option('rocm',false,'Для этой Radeon нет официальной поддержки PyTorch на Windows. Распознавание идёт на CPU.'));
    }else out.push(option('rocm',true,'',{device:amd[0].name,torchBackend:'rocm7.2',experimental:true}));
  }else out.push(option('rocm',false,'Видеокарта AMD не найдена.'));
  out.push(option('cpu',true,'',{device:'CPU',torchBackend:'cpu'}));
  return out;
}

function translationOptions(gpus,platform,{exists}={}){
  const vulkan=vulkanLoaderPresent(platform,exists);
  const nvidia=gpus.find(g=>makerOf(g)==='NVIDIA'),intel=gpus.find(g=>makerOf(g)==='Intel'),amd=gpus.find(g=>makerOf(g)==='AMD');
  return [
    nvidia?option('cuda',true,'',{device:nvidia.name,cuda:nvidiaDriverMajor(nvidia)>=580?'13.4':'12'}):option('cuda',false,'Видеокарта NVIDIA не найдена.'),
    gpus.length?(vulkan?option('vulkan',true,'',{device:gpus[0].name}):option('vulkan',false,'Не найден загрузчик Vulkan (libvulkan). Установите драйвер видеокарты с поддержкой Vulkan.')):option('vulkan',false,'Видеокарты не найдены.'),
    intel?option('sycl',platform==='win32',platform==='win32'?'':'Для SYCL на Linux нужна установленная среда Intel oneAPI. Используйте Vulkan.',{device:intel.name,manualOnly:true}):option('sycl',false,'Видеокарта Intel не найдена.'),
    amd?option('hip',true,'',{device:amd.name,manualOnly:true,experimental:true}):option('hip',false,'Видеокарта AMD не найдена.'),
    option('cpu',true,'',{device:'CPU'}),
  ];
}

const AUTO_ORDER={recognition:['cuda','xpu','rocm','cpu'],translation:['cuda','vulkan','cpu'],video:['cpu']};

function capabilities(gpus,{platform=process.platform,exists}={}){
  return {
    platform,gpus,
    recognition:recognitionOptions(gpus,platform),
    translation:translationOptions(gpus,platform,{exists}),
    video:[option('cpu',true,'',{device:'CPU'})],
  };
}
// Automatic choice never picks "manualOnly" or experimental backends.
function resolveChoice(task,choice,caps){
  const options=caps[task];if(!options)throw Error('Неизвестная задача: '+task);
  if(!choice||choice==='auto'){
    for(const id of AUTO_ORDER[task]){const o=options.find(x=>x.id===id);if(o?.available&&!o.manualOnly&&!o.experimental)return o;}
    return options.find(o=>o.id==='cpu');
  }
  const wanted=options.find(o=>o.id===choice);
  if(!wanted)throw Error('Неизвестное устройство: '+choice);
  if(!wanted.available)throw Error('Выбранное устройство недоступно ('+choice+'): '+(wanted.reason||'не поддерживается на этом компьютере')+' Выберите «Авто» или другое устройство.');
  return wanted;
}

let cache=null;
async function detect({execute=run,force=false,platform=process.platform,ttl=60000}={}){
  if(!force&&cache&&Date.now()-cache.at<ttl)return cache.value;
  const gpus=platform==='win32'?await system.gpuInfoWindows(execute):await system.mergeNvidia(await system.gpuInfo(),execute);
  const value=capabilities(gpus,{platform});cache={at:Date.now(),value};return value;
}
const clear=()=>{cache=null;};

// Quantization advice for the translator from dedicated video memory (bytes) and RAM.
function recommendQuantization({vram,backendId}){
  if(backendId==='cpu')return 'Q4_K_M';
  // Unknown VRAM (e.g. Intel xe exposes no size in sysfs and measuring needs a GPU probe): the middle option; the start ladder covers a miss.
  if(!vram)return 'Q6_K';
  if(vram>=11*GIB)return 'Q8_0';
  if(vram>=8*GIB)return 'Q6_K';
  return 'Q4_K_M';
}
module.exports={capabilities,resolveChoice,detect,clear,recommendQuantization,recognitionOptions,translationOptions,AUTO_ORDER,makerOf};
