'use strict';
const fsp=require('node:fs/promises');
const path=require('node:path');
const paths=require('./paths.cjs');
const defaultManifest=require('./manifest.json');
const gpu=require('./gpu.cjs');
const tools=require('./tools.cjs');
const llamaLib=require('./llama.cjs');
const pyenv=require('./pyenv.cjs');
const qwenModels=require('./qwenmodels.cjs');
const {download}=require('./downloader.cjs');
const {installFfmpeg}=require('./components.cjs');
const esrganTool=require('./esrgan.cjs');

const NAMES=['ffmpeg','translator-engine','translator-model','translator-import','qwen-env','qwen-models','video-esrgan'];
const failure=(code,message)=>Object.assign(Error(message),{code});
const inside=(base,target)=>{const r=path.relative(path.resolve(base),path.resolve(target));return !!r&&!r.startsWith('..')&&!path.isAbsolute(r);};

// Everything the program downloads: state, progress, pause/resume, removal and a status report for the "Models" screen.
class ComponentManager {
  constructor({settings,runtime=paths.runtimeRoot(),llama,onChange=()=>{},busy=()=>false,manifest=defaultManifest,capabilities=()=>gpu.detect(),deps={}}={}){
    Object.assign(this,{settings,runtime,llama,onChange,busy,manifest,capabilities});
    this.deps={installEsrgan:esrganTool.install,installFfmpeg,downloadFile:download,createEnvironment:pyenv.createEnvironment,installQwenModels:qwenModels.installQwenModels,...deps};
    this.state={};this.jobs=new Map();
  }
  modelsRoot(){const s=this.settings();return s.modelsDirectory||path.join(this.runtime,'models');}
  set(name,patch){this.state[name]=patch;this.onChange();}
  async run(name,job,meta={}){
    if(this.jobs.has(name))throw failure('BUSY',this.label(name)+' уже скачивается');
    const abort=new AbortController();this.jobs.set(name,abort);
    this.set(name,{...meta,state:'downloading',percent:0});
    const progress=p=>this.set(name,{...meta,state:p.phase==='extracting'||p.phase==='verifying'||p.phase==='copying'||p.phase==='installing'?p.phase:'downloading',percent:p.percent==null?null:Math.round(p.percent),speed:p.speed||0,eta:p.eta??null,message:p.message||''});
    try{await job({signal:abort.signal,onProgress:progress});this.set(name,{...meta,state:'ready',percent:100});}
    catch(error){
      if(error.code==='PAUSED'||abort.signal.aborted){this.set(name,{...meta,state:'paused',percent:this.state[name]?.percent??0});}
      else{this.set(name,{...meta,state:'error',error:error.message,code:error.code});throw error;}
    }finally{this.jobs.delete(name);this.onChange();}
    return this.state[name];
  }
  label(name){return ({ffmpeg:'FFmpeg','translator-engine':'Движок перевода','translator-model':'Модель перевода','translator-import':'Импорт модели','qwen-env':'Окружение распознавания','qwen-models':'Модели распознавания','video-esrgan':'Real-ESRGAN (видео на GPU)'})[name]||name;}
  pause(name){this.jobs.get(name)?.abort();return {ok:true};}
  pauseAll(){for(const a of this.jobs.values())a.abort();}

  async recommendedTorchBackend(){
    const s=this.settings(),caps=await this.capabilities();
    const pick=gpu.resolveChoice('recognition',s.gpu===false?'cpu':(s.qwenDevice||'auto'),caps);
    return pick.torchBackend||'cpu';
  }
  async install(name,options={}){
    if(!NAMES.includes(name))throw failure('UNKNOWN','Неизвестный компонент: '+name);
    switch(name){
      case 'ffmpeg':return this.run(name,({signal,onProgress})=>this.deps.installFfmpeg({runtime:this.runtime,signal,onProgress}));
      case 'translator-engine':{
        const backend=await this.llama.resolveBackend();
        return this.run(name,({signal,onProgress})=>this.llama.install(backend,{signal,onProgress,downloadFile:this.deps.downloadFile}));
      }
      case 'translator-model':{
        const s=this.settings();
        const quant=options.quant||(s.translationQuant!=='auto'?s.translationQuant:gpu.recommendQuantization({vram:(await this.capabilities()).gpus?.[0]?.vramTotal,backendId:(await this.llama.resolveBackend()).id}));
        const fileName=llamaLib.quantFile(quant,this.manifest);if(!fileName)throw failure('BAD_QUANT','Неизвестная квантизация: '+quant);
        const entry=this.manifest.hymt.files[fileName];
        return this.run(name,({signal,onProgress})=>this.deps.downloadFile({url:entry.url,dest:path.join(llamaLib.modelsDirectory(s,this.runtime),fileName),sha256:entry.sha256,size:entry.size,signal,onProgress}),{quant});
      }
      case 'translator-import':{
        const found=await llamaLib.scanImport({manifest:this.manifest});
        const candidate=options.quant?found.find(f=>f.quant===options.quant):found[0];
        if(!candidate)throw failure('NOTHING_TO_IMPORT','Скачанная ранее модель не найдена');
        return this.run(name,({signal,onProgress})=>llamaLib.importModel({candidate,settings:this.settings(),runtime:this.runtime,manifest:this.manifest,signal,onProgress}),{quant:candidate.quant});
      }
      case 'qwen-env':{
        if(this.busy())throw failure('BUSY','Дождитесь завершения задач перед установкой окружения');
        const torchBackend=options.torchBackend||await this.recommendedTorchBackend();
        return this.run(name,async({signal,onProgress})=>{await this.deps.createEnvironment({runtime:this.runtime,torchBackend,force:!!options.force,signal,onProgress});});
      }
      case 'video-esrgan':return this.run(name,({signal,onProgress})=>this.deps.installEsrgan({runtime:this.runtime,signal,onProgress}));
      case 'qwen-models':
        return this.run(name,({signal,onProgress})=>this.deps.installQwenModels({directory:this.modelsRoot(),signal,onProgress}));
    }
  }
  async remove(name,options={}){
    if(this.busy())throw failure('BUSY','Дождитесь завершения задач');
    if(this.jobs.has(name))throw failure('BUSY','Сначала остановите загрузку');
    const s=this.settings();
    const drop=async(target,base)=>{if(!inside(base,target))throw failure('UNSAFE','Путь вне папок программы: '+target);await fsp.rm(target,{recursive:true,force:true});};
    switch(name){
      case 'translator-model':{
        const file=llamaLib.quantFile(options.quant||'',this.manifest);if(!file)throw failure('BAD_QUANT','Укажите квантизацию');
        const target=path.join(llamaLib.modelsDirectory(s,this.runtime),file);await drop(target,this.modelsRoot());await fsp.rm(target+'.verified',{force:true});await fsp.rm(target+'.part',{force:true});break;
      }
      case 'translator-engine':{
        const backend=await this.llama.resolveBackend(),keys=llamaLib.assetKeys(backend.id,{platform:process.platform,cuda:backend.cuda});
        await drop(this.llama.releaseDirectory(keys.main),this.runtime);break;
      }
      case 'qwen-models':
        for(const key of options.only?[options.only]:['asr','aligner']){const target=key==='asr'?s.asrModel:s.alignerModel;await drop(target,this.modelsRoot());}break;
      case 'qwen-env':await drop(pyenv.environmentDirectory(this.runtime),this.runtime);break;
      case 'video-esrgan':await drop(esrganTool.directory(this.runtime),this.runtime);break;
      default:throw failure('UNKNOWN','Этот компонент нельзя удалить');
    }
    this.state[name]=undefined;this.onChange();return {ok:true};
  }

  // ---- report for the UI ----
  async status(){
    const s=this.settings(),caps=await this.capabilities().catch(()=>null);
    const out={platform:process.platform,runtime:this.runtime,modelsDirectory:this.modelsRoot(),jobs:this.state,gpus:caps?.gpus||[],capabilities:caps};
    out.ffmpeg=tools.status();
    let backend=null;try{backend=await this.llama.resolveBackend();}catch(error){out.translatorError=error.message;}
    if(backend){
      const exe=await this.llama.binaryPath(backend),keys=llamaLib.assetKeys(backend.id,{platform:process.platform,cuda:backend.cuda});
      const assets=[keys.main,keys.runtime].filter(Boolean).map(k=>this.manifest.llama.assets[k]);
      out.translatorEngine={backend:backend.id,device:backend.device,installed:!!exe,tag:this.manifest.llama.tag,downloadBytes:assets.reduce((a,x)=>a+x.size,0)};
      const installed=await llamaLib.installedQuants(s,{runtime:this.runtime,manifest:this.manifest}),recommended=gpu.recommendQuantization({vram:backend.gpu?.vramTotal,backendId:backend.id});
      out.translatorModels=llamaLib.QUANT_ORDER.map(quant=>{const name=llamaLib.quantFile(quant,this.manifest);return {quant,name,size:this.manifest.hymt.files[name].size,installed:installed.some(i=>i.quant===quant),recommended:quant===recommended};});
      out.importable=await llamaLib.scanImport({manifest:this.manifest}).catch(()=>[]);
      out.activeQuant=llamaLib.chooseQuant(s.translationQuant,recommended,installed);
    }
    const info=await pyenv.inspectEnvironment({python:s.qwenPython});
    let wanted=null;try{wanted=await this.recommendedTorchBackend();}catch(error){out.recognitionError=error.message;}
    out.recognitionEnv={...info,ready:pyenv.envReady(info),wantedBackend:wanted,mismatch:!!(info.torchBackend&&wanted&&this.sameFamily(info.torchBackend)!==this.sameFamily(wanted))};
    out.recognitionModels=await qwenModels.modelStatus(s);
    const esrgan=await esrganTool.locate(this.runtime);out.videoEsrgan={installed:!!esrgan,source:esrgan?.source||null,verified:!!esrgan?.verified,downloadBytes:this.manifest.realesrgan.assets[process.platform==='win32'?'win-x64':'linux-x64'].size};
    out.loaded={translator:this.llama.status()};
    const free=async dir=>{try{let d=dir;for(;;){try{const st=await fsp.statfs(d);return st.bavail*st.bsize;}catch{const up=path.dirname(d);if(up===d)return null;d=up;}}}catch{return null;}};
    out.disk={modelsFree:await free(this.modelsRoot()),runtimeFree:await free(this.runtime)};
    return out;
  }
  sameFamily(tag){return String(tag).replace(/\d.*$/,'');}
}
module.exports={ComponentManager,NAMES,inside};
