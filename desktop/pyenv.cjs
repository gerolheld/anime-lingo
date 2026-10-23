'use strict';
const fsp=require('node:fs/promises');
const path=require('node:path');
const paths=require('./paths.cjs');
const manifest=require('./manifest.json');
const {download}=require('./downloader.cjs');
const {extractArchive,findFile}=require('./extract.cjs');
const {run}=require('./process.cjs');

// Versions the recognition pipeline was verified with (see test-results/qwen-runtime-versions.txt).
const PINS=Object.freeze({torch:'2.14.1',torchaudio:'2.11.0',torchvision:'0.29.1',qwenAsr:'qwen-asr==0.0.6',python:'3.12'});
// uv accepts these PyTorch index names; resolution for each was checked against the real indexes with uv 0.13.5 (dry run).
const TORCH_BACKENDS=Object.freeze(['cpu','cu126','cu130','xpu','rocm7.2']);
const failure=(code,message)=>Object.assign(Error(message),{code});

const environmentDirectory=(runtime=paths.runtimeRoot())=>path.join(runtime,'qwen-env');
const uvDirectory=runtime=>path.join(runtime,'uv');
const uvBinary=runtime=>path.join(uvDirectory(runtime),paths.exe('uv'));

async function siteDirectory(environment){
  const candidates=process.platform==='win32'?[path.join(environment,'Lib','site-packages')]:[];
  if(process.platform!=='win32'){
    const lib=path.join(environment,'lib');
    for(const name of await fsp.readdir(lib).catch(()=>[]))if(/^python3\.\d+$/.test(name))candidates.push(path.join(lib,name,'site-packages'));
  }
  for(const dir of candidates)try{await fsp.access(dir);return dir;}catch{}
  return null;
}
// Reads the installed PyTorch build from package metadata. Python and torch are never started,
// so inspecting an environment cannot touch a GPU.
async function inspectEnvironment({python,environment}={}){
  const env=environment||path.dirname(path.dirname(python));
  const result={exists:false,python,torchVersion:null,torchBackend:null,qwenAsr:false};
  try{await fsp.access(python);}catch{return result;}
  result.exists=true;
  const site=await siteDirectory(env);if(!site)return result;
  for(const name of await fsp.readdir(site).catch(()=>[])){
    let m=name.match(/^torch-(\d+\.\d+\.\d+)(?:\+([\w.]+))?\.dist-info$/);
    if(m){result.torchVersion=m[1];result.torchBackend=m[2]||(process.platform==='darwin'?'mps':'cpu');}
    if(/^qwen_asr-[\d.]+\.dist-info$/.test(name))result.qwenAsr=true;
  }
  return result;
}
const envReady=info=>info.exists&&!!info.torchVersion&&info.qwenAsr;

async function installUv({runtime=paths.runtimeRoot(),platform=process.platform,signal,onProgress=()=>{},downloadFile=download,extract=extractArchive}={}){
  const entry=manifest.uv.assets[platform==='win32'?'win-x64':'linux-x64'],archive=path.join(runtime,'downloads',entry.name);
  const target=uvBinary(runtime);
  try{await fsp.access(target);return target;}catch{}
  await downloadFile({url:entry.url,dest:archive,sha256:entry.sha256,signal,onProgress});
  const work=path.join(runtime,'downloads','uv-unpack');await fsp.rm(work,{recursive:true,force:true});
  await extract(archive,work,{signal});
  const found=await findFile(work,paths.exe('uv'),3);if(!found)throw failure('NO_UV','В архиве нет uv');
  await fsp.mkdir(uvDirectory(runtime),{recursive:true});await fsp.copyFile(found,target);
  if(platform!=='win32')await fsp.chmod(target,0o755);
  await fsp.rm(work,{recursive:true,force:true});
  return target;
}
// Python 3.12 (uv-managed, stored inside the runtime folder) + the chosen PyTorch build + qwen-asr.
async function createEnvironment({runtime=paths.runtimeRoot(),torchBackend,force=false,signal,onProgress=()=>{},execute=run,uv}={}){
  if(!TORCH_BACKENDS.includes(torchBackend))throw failure('BAD_BACKEND','Неизвестная сборка PyTorch: '+torchBackend);
  if(torchBackend==='rocm7.2'&&process.platform==='win32')throw failure('NO_ROCM_WINDOWS','Сборка PyTorch для ROCm есть только для Linux.');
  const environment=environmentDirectory(runtime),python=paths.pythonIn(environment);
  const exe=uv||await installUv({runtime,signal,onProgress});
  const env={UV_CACHE_DIR:path.join(runtime,'uv-cache'),UV_PYTHON_INSTALL_DIR:path.join(runtime,'python'),UV_NO_PROGRESS:'1',UV_NO_CONFIG:'1',PYTHONUTF8:'1'};
  if(force)await fsp.rm(environment,{recursive:true,force:true});
  const log=text=>{const line=text.trim().split(/\r?\n/).filter(Boolean).at(-1);if(line)onProgress({phase:'installing',percent:null,message:line.slice(0,160)});};
  onProgress({phase:'installing',percent:null,message:'Python '+PINS.python});
  await execute(exe,['venv','--managed-python','--python',PINS.python,'--allow-existing',environment],{signal,env,onData:log,timeout:30*60000});
  onProgress({phase:'installing',percent:null,message:'PyTorch ('+torchBackend+') и qwen-asr'});
  await execute(exe,['pip','install','--python',python,'--torch-backend',torchBackend,`torch==${PINS.torch}`,`torchaudio==${PINS.torchaudio}`,`torchvision==${PINS.torchvision}`,PINS.qwenAsr],{signal,env,onData:log,timeout:120*60000});
  const info=await inspectEnvironment({python,environment});
  if(!envReady(info))throw failure('ENV_INCOMPLETE','Окружение Python создано не полностью. Повторите установку.');
  return info;
}
module.exports={PINS,TORCH_BACKENDS,environmentDirectory,uvBinary,inspectEnvironment,envReady,installUv,createEnvironment};
