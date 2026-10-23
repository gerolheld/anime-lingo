'use strict';
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {killTree}=require('./process.cjs');
const paths=require('./paths.cjs');
const defaultManifest=require('./manifest.json');
const {download,isVerified,hashFile}=require('./downloader.cjs');
const {extractArchive,findFile}=require('./extract.cjs');

const QUANT_ORDER=['Q8_0','Q6_K','Q4_K_M'];
const MODEL_LAYERS=32;           // Hy-MT2-7B (hunyuan-dense): block_count read from the GGUF header
const CONTEXT=4096;
const failure=(code,message,extra={})=>Object.assign(Error(message),{code},extra);

// ---------- which release asset belongs to which backend ----------
function assetKeys(backend,{platform=process.platform,cuda}={}){
  const os_=platform==='win32'?'win':'linux';
  switch(backend){
    case 'cpu':return {main:`${os_}-cpu-x64`};
    case 'vulkan':return {main:`${os_}-vulkan-x64`};
    case 'cuda':{
      const generation=cuda==='13.4'?'13.4':platform==='win32'?'12.4':'12.8';
      return {main:`${os_}-cuda-${generation}-x64`,runtime:`${os_}-cudart-${generation}-x64`};
    }
    case 'sycl':return {main:platform==='win32'?'win-sycl-x64':'linux-sycl-fp16-x64'};
    case 'hip':return {main:`${os_}-rocm-x64`};
    default:throw failure('BAD_BACKEND','Неизвестный бэкенд перевода: '+backend);
  }
}

// ---------- model file selection ----------
const modelsDirectory=(settings,runtime=paths.runtimeRoot())=>path.join(settings.modelsDirectory||path.join(runtime,'models'),'Hy-MT2-7B-GGUF');
const quantFile=(quant,manifest=defaultManifest)=>Object.keys(manifest.hymt.files).find(name=>name.toLowerCase().includes(quant.toLowerCase()));
async function installedQuants(settings,{runtime,manifest=defaultManifest}={}){
  const dir=modelsDirectory(settings,runtime),found=[];
  for(const quant of QUANT_ORDER){
    const name=quantFile(quant,manifest);if(!name)continue;
    const file=path.join(dir,name);
    try{const stat=await fsp.stat(file);if(stat.size===manifest.hymt.files[name].size)found.push({quant,file,name});}catch{}
  }
  return found;
}
// Explicit choice wins. "auto": the recommended quantization if it is on disk, else the best installed one, else the recommendation.
function chooseQuant(choice,recommended,installed){
  if(choice&&choice!=='auto'){if(!QUANT_ORDER.includes(choice))throw failure('BAD_QUANT','Неизвестная квантизация: '+choice);return choice;}
  if(installed.some(i=>i.quant===recommended))return recommended;
  return installed[0]?.quant||recommended;
}
// Layers kept on the GPU. Unknown free VRAM -> all layers (the start ladder falls back if that does not fit).
function gpuLayers({backend,modelBytes,freeVram}){
  if(backend==='cpu')return 0;
  if(!freeVram)return 999;
  const kv=.6*1024**3,overhead=.7*1024**3,need=modelBytes+kv+overhead;
  if(freeVram>=need)return 999;
  const perLayer=modelBytes/MODEL_LAYERS,fit=Math.floor((freeVram-kv-overhead)/perLayer);
  return Math.max(0,Math.min(MODEL_LAYERS-1,fit));
}

// ---------- process ----------
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{const t=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(t);reject(Error('Отменено'));},{once:true});});

class LlamaServer {
  constructor({settings,runtime=paths.runtimeRoot(),manifest=defaultManifest,capabilities=async()=>null,spawnProcess=spawn,fetchImpl=fetch,onLog=()=>{},readyTimeout=600000,platform=process.platform}={}){
    Object.assign(this,{settings,runtime,manifest,capabilities,spawnProcess,fetchImpl,onLog,readyTimeout,platform});
    this.child=null;this.port=0;this.apiKey='';this.tail='';this.info=null;this.starting=null;this.stopping=null;this.exit=null;this.crash=null;
  }
  get running(){return !!this.child&&this.exit===null;}
  get endpoint(){return this.running?`http://127.0.0.1:${this.port}/v1`:null;}
  headers(){return this.running?{Authorization:'Bearer '+this.apiKey}:{};}
  releaseDirectory(key){return path.join(this.runtime,'llama',this.manifest.llama.tag,key);}

  // --- installation (explicit, with progress) ---
  async resolveBackend(){
    const s=this.settings(),caps=await this.capabilities();
    const choice=s.translationDevice||'auto';
    if(!caps)return {id:choice==='auto'||!s.gpu?'cpu':choice,cuda:undefined,device:'CPU'};
    const {resolveChoice}=require('./gpu.cjs');
    const pick=resolveChoice('translation',s.gpu===false?'cpu':choice,caps);
    return {id:pick.id,cuda:pick.cuda,device:pick.device,gpu:caps.gpus[0]};
  }
  async binaryPath(backend){
    const keys=assetKeys(backend.id,{platform:this.platform,cuda:backend.cuda});
    const dir=this.releaseDirectory(keys.main);
    try{if(!JSON.parse(await fsp.readFile(path.join(dir,'.installed.json'),'utf8')).ok)return null;}catch{return null;}
    return findFile(dir,paths.exe('llama-server'),3);
  }
  async install(backend,{signal,onProgress=()=>{},downloadFile=download,extract=extractArchive}={}){
    const keys=assetKeys(backend.id,{platform:this.platform,cuda:backend.cuda}),dir=this.releaseDirectory(keys.main),cache=path.join(this.runtime,'downloads');
    const names=[keys.main,...(keys.runtime?[keys.runtime]:[])];
    for(const key of names){
      const entry=this.manifest.llama.assets[key];if(!entry)throw failure('NO_ASSET','В манифесте нет сборки '+key);
      const archive=path.join(cache,entry.name);
      await downloadFile({url:entry.url,dest:archive,sha256:entry.sha256,size:entry.size,signal,onProgress:p=>onProgress({...p,component:key})});
      onProgress({phase:'extracting',component:key,percent:99});
      const target=key===keys.main?dir:path.join(dir,'.runtime');
      await fsp.rm(target,{recursive:true,force:true});
      await extract(archive,target,{signal});
    }
    const exe=await findFile(dir,paths.exe('llama-server'),3);
    if(!exe)throw failure('NO_BINARY','В архиве llama.cpp нет llama-server');
    if(keys.runtime){ // CUDA runtime libraries must sit next to the server
      const runtimeDir=path.join(dir,'.runtime');
      for(const entry of await fsp.readdir(runtimeDir,{recursive:true,withFileTypes:true})){
        if(entry.isFile())await fsp.copyFile(path.join(entry.parentPath??entry.path,entry.name),path.join(path.dirname(exe),entry.name));
      }
      await fsp.rm(runtimeDir,{recursive:true,force:true});
    }
    if(this.platform!=='win32')await fsp.chmod(exe,0o755);
    await fsp.writeFile(path.join(dir,'.installed.json'),JSON.stringify({ok:true,tag:this.manifest.llama.tag,backend:backend.id,files:names}));
    return exe;
  }

  // --- lifecycle ---
  async start({signal}={}){
    if(this.running)return this.info;
    if(this.starting)return this.starting;
    this.starting=this.#start(signal).finally(()=>{this.starting=null;});
    return this.starting;
  }
  async #start(signal){
    await this.stopping;
    const s=this.settings(),backend=await this.resolveBackend(),exe=await this.binaryPath(backend);
    if(!exe)throw failure('LLAMA_MISSING',`Не установлен движок перевода (${backend.id}). Откройте «Модели» и скачайте его.`,{backend:backend.id});
    const installed=await installedQuants(s,{runtime:this.runtime,manifest:this.manifest});
    const {recommendQuantization}=require('./gpu.cjs');
    const quant=chooseQuant(s.translationQuant,recommendQuantization({vram:backend.gpu?.vramTotal,backendId:backend.id}),installed);
    const model=installed.find(i=>i.quant===quant);
    if(!model)throw failure('MODEL_MISSING',`Не скачана модель перевода ${quant}. Откройте «Модели» и скачайте её.`,{quant});
    const modelBytes=this.manifest.hymt.files[model.name].size;
    const free=backend.gpu?.vramTotal?backend.gpu.vramTotal-(backend.gpu.vramUsed||0):0;
    const first=gpuLayers({backend:backend.id,modelBytes,freeVram:free});
    // If the model does not fit, retry with fewer layers, then on the CPU. Never retried after a user cancel.
    const ladder=backend.id==='cpu'?[0]:[...new Set([first,first>16?16:first,0])];
    let lastError;
    for(const layers of ladder){
      if(signal?.aborted)throw Error('Отменено');
      try{return await this.#spawnAndWait({exe,model,layers,backend,signal});}
      catch(error){lastError=error;await this.#kill();if(signal?.aborted||error.code==='ABORTED')throw Error('Отменено');}
    }
    throw lastError;
  }
  async #spawnAndWait({exe,model,layers,backend,signal}){
    const port=await freePort(),apiKey=crypto.randomBytes(24).toString('hex');
    const keyFile=path.join(os.tmpdir(),'lingo-key-'+crypto.randomBytes(6).toString('hex'));
    await fsp.writeFile(keyFile,apiKey+'\n',{mode:0o600});
    const args=['-m',model.file,'--host','127.0.0.1','--port',String(port),'--api-key-file',keyFile,'-c',String(CONTEXT),'-np','1','-ngl',String(layers),'--no-webui','--no-warmup'];
    const dir=path.dirname(exe),env={...process.env,...(this.platform==='win32'?{}:{LD_LIBRARY_PATH:dir+(process.env.LD_LIBRARY_PATH?path.delimiter+process.env.LD_LIBRARY_PATH:'')})};
    this.tail='';this.exit=null;this.crash=null;
    const child=this.child=this.spawnProcess(exe,args,{cwd:dir,env,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:this.platform!=='win32'});
    const append=b=>{this.tail=(this.tail+b).slice(-8000);this.onLog(String(b));};
    child.stdout?.on('data',append);child.stderr?.on('data',append);
    const exited=new Promise(resolve=>{
      child.on('error',e=>{this.exit={code:null,error:e.message};resolve();});
      child.on('exit',(code,sig)=>{this.exit={code,signal:sig};resolve();});
    });
    this.exited=exited;
    const cleanKey=()=>fsp.rm(keyFile,{force:true}).catch(()=>{});
    const base=`http://127.0.0.1:${port}`,deadline=Date.now()+this.readyTimeout;
    try{
      for(;;){
        if(signal?.aborted)throw failure('ABORTED','Отменено');
        if(this.exit)throw failure('LLAMA_EXITED',`llama-server завершился при загрузке (код ${this.exit.code??this.exit.signal??this.exit.error}). ${this.#reason()}`,{tail:this.tail});
        if(Date.now()>deadline)throw failure('LLAMA_TIMEOUT','Модель не загрузилась за '+Math.round(this.readyTimeout/1000)+' секунд.',{tail:this.tail});
        try{const r=await this.fetchImpl(base+'/health',{signal:AbortSignal.timeout(2000)});if(r.ok)break;}catch{}
        await sleep(250,signal).catch(()=>{throw failure('ABORTED','Отменено');});
      }
    }catch(error){await cleanKey();throw error;}
    await cleanKey();
    this.port=port;this.apiKey=apiKey;
    this.info={backend:backend.id,device:backend.device,quant:model.quant,layers,model:model.file,port};
    exited.then(()=>{if(this.child===child&&this.info&&!this.stopping)this.crash={...this.exit,tail:this.tail,at:Date.now()};});
    return this.info;
  }
  #reason(){
    const t=this.tail;
    if(/out of memory|OutOfDevice|cudaMalloc|failed to allocate|ErrorOutOfDeviceMemory/i.test(t))return 'Не хватило видеопамяти.';
    if(/no device|failed to load.*backend|vulkan.*not found|libvulkan/i.test(t))return 'Видеокарта или драйвер недоступны для этого бэкенда.';
    return t.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0,400);
  }
  async #kill(){
    const child=this.child;if(!child)return;
    if(this.exit===null){killTree(child,{platform:this.platform});await Promise.race([this.exited,sleep(10000)]).catch(()=>{});}
    if(this.exit===null&&child.pid)try{process.kill(child.pid,'SIGKILL');}catch{}
    this.child=null;this.info=null;this.port=0;this.apiKey='';
  }
  // Unloading the model = ending the process. Resolves only after the process has really gone.
  async stop(){
    if(this.stopping)return this.stopping;
    if(!this.child)return;
    this.stopping=this.#kill().finally(()=>{this.stopping=null;});
    return this.stopping;
  }
  status(){
    return {running:this.running,...(this.info||{}),crash:this.crash,pid:this.child?.pid||null};
  }
}

// ---------- import of an already downloaded GGUF (LM Studio) ----------
function importCandidates(home=os.homedir()){
  return [path.join(home,'.lmstudio','models','tencent','Hy-MT2-7B-GGUF'),path.join(home,'.cache','lm-studio','models','tencent','Hy-MT2-7B-GGUF')];
}
async function scanImport({manifest=defaultManifest,directories=importCandidates()}={}){
  const found=[];
  for(const dir of directories){
    let names;try{names=await fsp.readdir(dir);}catch{continue;}
    for(const name of names){
      const entry=Object.entries(manifest.hymt.files).find(([n])=>n.toLowerCase()===name.toLowerCase());
      if(!entry)continue;
      const file=path.join(dir,name);
      try{if((await fsp.stat(file)).size===entry[1].size)found.push({name:entry[0],file,quant:QUANT_ORDER.find(q=>entry[0].toLowerCase().includes(q.toLowerCase())),size:entry[1].size});}catch{}
    }
  }
  return found;
}
// Verifies the SHA-256 first, then links (no extra disk space on the same volume) or copies. The original is left in place.
async function importModel({candidate,settings,runtime,manifest=defaultManifest,signal,onProgress=()=>{}}){
  const entry=manifest.hymt.files[candidate.name];if(!entry)throw failure('NOT_PINNED','Файл не входит в список поддерживаемых моделей');
  const dest=path.join(modelsDirectory(settings,runtime),candidate.name);
  await fsp.mkdir(path.dirname(dest),{recursive:true});
  if(await isVerified(dest,entry.sha256,{signal}))return {file:dest,method:'already'};
  onProgress({phase:'verifying',percent:0});
  const sha=await hashFile(candidate.file,{signal,onProgress:(d,t)=>onProgress({phase:'verifying',percent:Math.round(100*d/t)})});
  if(sha!==entry.sha256)throw failure('SHA_MISMATCH','Контрольная сумма файла не совпала с официальной. Файл не импортирован.');
  await fsp.rm(dest,{force:true});
  let method='link';
  try{await fsp.link(candidate.file,dest);}catch{method='copy';onProgress({phase:'copying',percent:0});await fsp.copyFile(candidate.file,dest);}
  const stat=await fsp.stat(dest);
  await fsp.writeFile(dest+'.verified',JSON.stringify({sha256:sha,size:stat.size,mtimeMs:stat.mtimeMs}));
  return {file:dest,method};
}
module.exports={LlamaServer,assetKeys,gpuLayers,chooseQuant,installedQuants,modelsDirectory,quantFile,scanImport,importModel,importCandidates,QUANT_ORDER,CONTEXT};
