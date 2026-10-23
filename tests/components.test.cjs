'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const pyenv=require('../desktop/pyenv.cjs');
const qwenModels=require('../desktop/qwenmodels.cjs');
const plan=require('../desktop/recognition-plan.cjs');
const gpu=require('../desktop/gpu.cjs');
const paths=require('../desktop/paths.cjs');
const {ComponentManager,inside}=require('../desktop/component-manager.cjs');
const {LlamaServer}=require('../desktop/llama.cjs');
const temp=async t=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-comp-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;};

// A fake site-packages for the current platform.
async function fakeEnvironment(runtime,{torch='2.14.1+xpu',qwen=true}={}){
  const env=pyenv.environmentDirectory(runtime),python=paths.pythonIn(env);
  await fs.mkdir(path.dirname(python),{recursive:true});await fs.writeFile(python,'');
  const site=process.platform==='win32'?path.join(env,'Lib','site-packages'):path.join(env,'lib','python3.12','site-packages');
  await fs.mkdir(site,{recursive:true});
  if(torch)await fs.mkdir(path.join(site,`torch-${torch}.dist-info`));
  if(qwen)await fs.mkdir(path.join(site,'qwen_asr-0.0.6.dist-info'));
  return {env,python};
}

test('an existing environment is recognised from package metadata without starting Python',async t=>{
  const runtime=await temp(t),{python}=await fakeEnvironment(runtime);
  const info=await pyenv.inspectEnvironment({python});
  assert.equal(info.exists,true);assert.equal(info.torchVersion,'2.14.1');assert.equal(info.torchBackend,'xpu');assert.equal(info.qwenAsr,true);assert.equal(pyenv.envReady(info),true);
  const cpu=await temp(t);await fakeEnvironment(cpu,{torch:'2.14.1+cu126',qwen:false});
  const i2=await pyenv.inspectEnvironment({python:paths.pythonIn(pyenv.environmentDirectory(cpu))});assert.equal(i2.torchBackend,'cu126');assert.equal(pyenv.envReady(i2),false);
  assert.equal((await pyenv.inspectEnvironment({python:path.join(runtime,'nope','python')})).exists,false);
});
test('environment creation uses managed Python 3.12, the chosen PyTorch build and keeps everything inside the runtime folder',async t=>{
  const runtime=await temp(t),calls=[];
  const execute=async(bin,args,options)=>{
    calls.push({bin,args,env:options.env});
    if(args[0]==='pip')await fakeEnvironment(runtime,{torch:'2.14.1+'+args[args.indexOf('--torch-backend')+1]});
    return {output:''};
  };
  const info=await pyenv.createEnvironment({runtime,torchBackend:'cu126',execute,uv:'/fake/uv'});
  assert.equal(info.torchBackend,'cu126');assert.equal(calls.length,2);
  assert.deepEqual(calls[0].args.slice(0,4),['venv','--managed-python','--python','3.12']);
  const pip=calls[1].args;assert.equal(pip[pip.indexOf('--torch-backend')+1],'cu126');
  for(const pin of ['torch==2.14.1','torchaudio==2.11.0','torchvision==0.29.1','qwen-asr==0.0.6'])assert.ok(pip.includes(pin),pin);
  assert.ok(calls[0].env.UV_PYTHON_INSTALL_DIR.startsWith(runtime));assert.ok(calls[0].env.UV_CACHE_DIR.startsWith(runtime));
  await assert.rejects(pyenv.createEnvironment({runtime,torchBackend:'cu128',execute,uv:'x'}),/Неизвестная сборка/);
  await assert.rejects(pyenv.createEnvironment({runtime:await temp(t),torchBackend:'cpu',execute:async()=>({output:''}),uv:'x'}),e=>e.code==='ENV_INCOMPLETE');
});
test('uv is downloaded once, verified, unpacked and reused',async t=>{
  const runtime=await temp(t),seen=[];
  const downloadFile=async o=>{seen.push(o.sha256);await fs.mkdir(path.dirname(o.dest),{recursive:true});await fs.writeFile(o.dest,'archive');};
  const extract=async(archive,dir)=>{await fs.mkdir(path.join(dir,'uv-pkg'),{recursive:true});await fs.writeFile(path.join(dir,'uv-pkg',paths.exe('uv')),'#!/bin/sh\n');};
  const uv=await pyenv.installUv({runtime,downloadFile,extract});
  assert.equal(uv,pyenv.uvBinary(runtime));assert.match(seen[0],/^[a-f0-9]{64}$/);
  await pyenv.installUv({runtime,downloadFile,extract});assert.equal(seen.length,1,'second call finds the installed binary');
});
function hub(files){
  const meta={siblings:files.map(f=>({rfilename:f.name,size:f.bytes.length,blobId:f.lfs?undefined:qwenModels.gitBlobId(f.bytes),lfs:f.lfs?{sha256:crypto.createHash('sha256').update(f.bytes).digest('hex')}:undefined}))};
  return async url=>{
    if(url.includes('/api/models/'))return new Response(JSON.stringify(meta));
    const f=files.find(x=>url.endsWith('/'+x.name));return f?new Response(f.bytes):new Response('no',{status:404});
  };
}
test('Qwen models: LFS files go through the verified downloader, small files are checked by git blob id, a marker is written',async t=>{
  const dir=await temp(t),weights=crypto.randomBytes(500),files=[{name:'config.json',bytes:Buffer.from('{"a":1}')},{name:'model.safetensors',bytes:weights,lfs:true}];
  const seen=[],events=[];
  const downloadFile=async o=>{seen.push(path.basename(o.dest));await fs.mkdir(path.dirname(o.dest),{recursive:true});await fs.writeFile(o.dest,weights);o.onProgress({phase:'downloading',done:250});};
  await qwenModels.installQwenModels({directory:dir,fetchImpl:hub(files),downloadFile,onProgress:p=>events.push(p)});
  assert.equal(seen.filter(n=>n==='model.safetensors').length,2,'both models');
  for(const m of Object.values(qwenModels.MODELS)){
    assert.equal(await fs.readFile(path.join(dir,m.folder,'config.json'),'utf8'),'{"a":1}');
    assert.equal(JSON.parse(await fs.readFile(path.join(dir,m.folder,'anime-lingo-model.json'),'utf8')).revision,m.revision);
  }
  assert.ok(events.some(e=>e.phase==='downloading'&&e.percent>0&&e.percent<100));assert.equal(events.at(-1).percent,100);
  const corrupt=hub([{name:'config.json',bytes:Buffer.from('{"a":1}')}]);
  const tampered=async url=>url.includes('/api/')?corrupt(url):new Response('{"a":2}');
  await assert.rejects(qwenModels.installQwenModels({directory:await temp(t),fetchImpl:tampered,downloadFile,only:'asr'}),e=>e.code==='SHA_MISMATCH');
});
test('recognition device: explicit choices fail loudly, automatic falls back to CPU with the reason',()=>{
  const intel=gpu.capabilities([{name:'Intel Arc B580',vendor:'8086',maker:'Intel'}],{platform:'linux',exists:()=>true});
  const none=gpu.capabilities([],{platform:'linux',exists:()=>true});
  const amdWin=gpu.capabilities([{name:'AMD Radeon RX 6700 XT',vendor:'1002',maker:'AMD'}],{platform:'win32'});
  const env=b=>({exists:true,torchVersion:'2.14.1',torchBackend:b,qwenAsr:true});
  const p=(settings,caps,e)=>plan.planDevice({settings:{gpu:true,qwenDevice:'auto',...settings},caps,env:e});
  assert.equal(p({},intel,env('xpu')).device,'xpu');
  assert.equal(p({},intel,env('cpu')).device,'cpu');assert.match(p({},intel,env('cpu')).reason,/PyTorch/);
  assert.match(p({qwenDevice:'xpu'},intel,env('cpu')).problem,/Переустановите/);
  assert.match(p({qwenDevice:'cuda'},intel,env('xpu')).problem,/недоступно \(cuda\)/);
  assert.equal(p({},none,env('cpu')).device,'cpu');
  assert.equal(p({},amdWin,env('cpu')).device,'cpu');
  assert.equal(p({gpu:false},intel,env('xpu')).device,'cpu');
  assert.match(p({},intel,{exists:false}).problem,/не установлено/);
});
test('CPU time estimate is a wide honest range at first and narrows around the measured speed',()=>{
  const first=plan.estimateCpu({seconds:1400,factor:undefined,threads:6});
  assert.equal(first.calibrated,false);assert.ok(first.maxSeconds>=3*first.minSeconds);
  const measured=plan.estimateCpu({seconds:1400,factor:2,threads:6});
  assert.equal(measured.calibrated,true);assert.ok(measured.minSeconds>=2200&&measured.maxSeconds<=3700);
  assert.equal(plan.updateFactor(undefined,2),2);assert.equal(plan.updateFactor(2,3),2.4);
  assert.equal(plan.formatDuration(30),'около минуты');assert.equal(plan.formatDuration(600),'10 мин');assert.equal(plan.formatDuration(7500),'2 ч 5 мин');
});

function manager(t,over={}){
  return (async()=>{
    const runtime=await temp(t),settings={gpu:true,translationDevice:'auto',translationQuant:'auto',modelsDirectory:'',qwenDevice:'auto',qwenPython:paths.pythonIn(pyenv.environmentDirectory(runtime)),asrModel:path.join(runtime,'models','Qwen3-ASR-1.7B'),alignerModel:path.join(runtime,'models','Qwen3-ForcedAligner-0.6B'),...(over.settings||{})};
    const caps=async()=>gpu.capabilities([{name:'AMD Radeon RX 7800 XT',vendor:'1002',maker:'AMD',vramTotal:16*1024**3,vramUsed:0}],{platform:process.platform,exists:()=>true});
    const llama=new LlamaServer({settings:()=>settings,runtime,capabilities:caps});
    const changes=[];const m=new ComponentManager({settings:()=>settings,runtime,llama,onChange:()=>changes.push(1),capabilities:caps,busy:over.busy,deps:over.deps||{}});
    return {m,runtime,settings,changes,llama};
  })();
}
test('translator model download targets the pinned file, URL and SHA-256 in the models folder',async t=>{
  const calls=[];
  const {m,runtime}=await manager(t,{deps:{downloadFile:async o=>{calls.push(o);o.onProgress({phase:'downloading',percent:50,speed:1e6});}}});
  await m.install('translator-model',{quant:'Q6_K'});
  assert.equal(calls.length,1);assert.equal(path.basename(calls[0].dest),'HY-MT2-7B-Q6_K.gguf');assert.ok(calls[0].dest.startsWith(path.join(runtime,'models','Hy-MT2-7B-GGUF')));
  assert.match(calls[0].sha256,/^[a-f0-9]{64}$/);assert.match(calls[0].url,/huggingface\.co\/tencent\/Hy-MT2-7B-GGUF\/resolve\/[a-f0-9]{40}\/HY-MT2-7B-Q6_K\.gguf$/);
  assert.equal(m.state['translator-model'].state,'ready');
  await assert.rejects(m.install('translator-model',{quant:'Q2'}),/Неизвестная квантизация/);
  await assert.rejects(m.install('curl'),/Неизвестный компонент/);
});
test('without a choice the model recommended for 16 GB of VRAM (Q8_0) is downloaded',async t=>{
  const calls=[];const {m}=await manager(t,{deps:{downloadFile:async o=>{calls.push(o);}}});
  await m.install('translator-model');assert.equal(path.basename(calls[0].dest),'HY-MT2-7B-Q8_0.gguf');
});
test('pausing keeps the state, a second start resumes, and a failure is reported with its message',async t=>{
  let mode='pause';
  const {m}=await manager(t,{deps:{downloadFile:async o=>{if(mode==='pause')await new Promise((_,rej)=>o.signal.addEventListener('abort',()=>rej(Object.assign(Error('p'),{code:'PAUSED'})),{once:true}));if(mode==='fail')throw Object.assign(Error('SHA-256 не совпала'),{code:'SHA_MISMATCH'});}}});
  const running=m.install('translator-model',{quant:'Q4_K_M'});await new Promise(r=>setTimeout(r,20));
  assert.equal(m.state['translator-model'].state,'downloading');
  await assert.rejects(m.install('translator-model',{quant:'Q4_K_M'}),e=>e.code==='BUSY');
  m.pause('translator-model');assert.equal((await running).state,'paused');
  mode='fail';await assert.rejects(m.install('translator-model',{quant:'Q4_K_M'}),/SHA-256/);assert.equal(m.state['translator-model'].state,'error');
  mode='ok';assert.equal((await m.install('translator-model',{quant:'Q4_K_M'})).state,'ready');
});
test('the Python environment cannot be installed or removed while tasks run, and its backend follows the hardware',async t=>{
  let busy=true;const created=[];
  const {m,runtime}=await manager(t,{busy:()=>busy,deps:{createEnvironment:async o=>{created.push(o.torchBackend);}}});
  await assert.rejects(m.install('qwen-env'),e=>e.code==='BUSY');await assert.rejects(m.remove('qwen-env'),e=>e.code==='BUSY');
  busy=false;await m.install('qwen-env');assert.deepEqual(created,['cpu'],'AMD is never chosen automatically for recognition');
  await m.install('qwen-env',{torchBackend:'cu130'});assert.equal(created.at(-1),'cu130');
  await fakeEnvironment(runtime);await m.remove('qwen-env');assert.equal(await fs.access(pyenv.environmentDirectory(runtime)).then(()=>true,()=>false),false);
});
test('removal stays inside program folders and leaves a hard-linked original untouched',async t=>{
  const {m,runtime}=await manager(t);
  const models=path.join(runtime,'models','Hy-MT2-7B-GGUF'),original=path.join(await temp(t),'HY-MT2-7B-Q8_0.gguf');
  await fs.mkdir(models,{recursive:true});await fs.writeFile(original,'weights');await fs.link(original,path.join(models,'HY-MT2-7B-Q8_0.gguf'));
  await m.remove('translator-model',{quant:'Q8_0'});
  assert.equal(await fs.readFile(original,'utf8'),'weights');assert.equal(await fs.access(path.join(models,'HY-MT2-7B-Q8_0.gguf')).then(()=>true,()=>false),false);
  assert.equal(inside(runtime,path.join(runtime,'a')),true);assert.equal(inside(runtime,path.join(runtime,'..','x')),false);assert.equal(inside(runtime,runtime),false);
  const evil=await manager(t,{settings:{asrModel:'/etc'}});await assert.rejects(evil.m.remove('qwen-models',{only:'asr'}),e=>e.code==='UNSAFE');
});
test('status reports what is installed, what is recommended and whether the environment fits the hardware',async t=>{
  const {m,runtime}=await manager(t);
  let st=await m.status();
  assert.equal(st.recognitionEnv.ready,false);assert.equal(st.translatorEngine.installed,false);assert.equal(st.translatorEngine.backend,'vulkan');
  assert.deepEqual(st.translatorModels.map(x=>[x.quant,x.installed,x.recommended]),[['Q8_0',false,true],['Q6_K',false,false],['Q4_K_M',false,false]]);
  assert.equal(st.recognitionModels.asr.complete,false);assert.ok(st.disk.runtimeFree>0);
  await fakeEnvironment(runtime,{torch:'2.14.1+xpu'});
  st=await m.status();assert.equal(st.recognitionEnv.ready,true);assert.equal(st.recognitionEnv.wantedBackend,'cpu');assert.equal(st.recognitionEnv.mismatch,true,'XPU build on a machine whose recognition runs on CPU is flagged');
});
test('the recognition plan stops before a run when the environment is missing and shows a CPU estimate otherwise',async t=>{
  const {Backend}=require('../desktop/backend.cjs');
  const dir=await temp(t),b=await new Backend(dir,{manageModels:false}).init();
  b.db.settings.qwenPython=path.join(dir,'none','python');
  b.db.episodes.push({id:'e',title:'e',filePath:'/x.mp4',audio:[{index:1}],cues:[],ruCues:[],subtitleTracks:[],state:'new',duration:1400});
  assert.match((await b.recognitionPlan('e')).problem,/не установлено/);
  const {python}=await fakeEnvironment(dir,{torch:'2.14.1+cpu'});b.db.settings.qwenPython=python;
  const cpu=await b.recognitionPlan('e');
  assert.equal(cpu.device,'cpu');assert.equal(cpu.estimate.calibrated,false);assert.match(cpu.estimateText,/мин/);
  b.db.settings.cpuRecognitionFactor=2;assert.equal((await b.recognitionPlan('e')).estimate.calibrated,true);
  Object.assign(b.db.episodes[0],{state:'partial',pipeline:'qwen3',recognitionKey:b.recognitionKey(b.db.episodes[0]),cues:[{start:0,end:1,text:'a',ru:''}]});
  assert.deepEqual(await b.recognitionPlan('e'),{recognition:false});
});
