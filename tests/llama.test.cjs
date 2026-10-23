'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {LlamaServer,assetKeys,gpuLayers,chooseQuant,scanImport,importModel}=require('../desktop/llama.cjs');
const {Backend}=require('../desktop/backend.cjs');
const gpu=require('../desktop/gpu.cjs');
const FAKE=path.join(__dirname,'fake-llama-server.cjs');
const temp=async t=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-llama-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;};
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const until=async(check,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await new Promise(r=>setTimeout(r,40));}return false;};
const SIZE=1000;
function manifestFor(files){return {llama:{tag:'b1',assets:{}},hymt:{files:Object.fromEntries(files.map(([name,size,sha])=>[name,{size,sha256:sha}]))}};}
// Pretend the release and the model are installed; the "binary" is only a marker, the fake script is what runs.
async function installed(t,{mode='ok',settings={},backend='vulkan',quant='Q4_K_M',log}={}){
  const runtime=await temp(t),manifest=manifestFor([['Hy-MT2-7B-Q4_K_M.gguf',SIZE,'a'.repeat(64)]]);
  const keys=assetKeys(backend,{platform:process.platform}),dir=path.join(runtime,'llama','b1',keys.main);
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,process.platform==='win32'?'llama-server.exe':'llama-server'),'');
  await fs.writeFile(path.join(dir,'.installed.json'),JSON.stringify({ok:true}));
  const models=path.join(runtime,'models','Hy-MT2-7B-GGUF');await fs.mkdir(models,{recursive:true});await fs.writeFile(path.join(models,'Hy-MT2-7B-Q4_K_M.gguf'),Buffer.alloc(SIZE));
  const spawns=[];
  const spawnProcess=(exe,args,options)=>{spawns.push(args);return spawn(process.execPath,[FAKE,...args],{...options,env:{...options.env,FAKE_LLAMA_MODE:mode,...(log?{FAKE_LLAMA_LOG:log}:{})}});};
  const s={gpu:true,translationDevice:'auto',translationQuant:'auto',...settings};
  const caps=async()=>gpu.capabilities([{name:'Test GPU',vendor:'1002',maker:'AMD',vramTotal:8*1024**3,vramUsed:0}],{platform:process.platform,exists:()=>true});
  const server=new LlamaServer({settings:()=>s,runtime,manifest,spawnProcess,capabilities:caps,readyTimeout:15000});
  t.after(()=>server.stop());
  return {server,spawns,runtime,s};
}

test('release assets match backend and platform, with the right CUDA generation',()=>{
  assert.deepEqual(assetKeys('vulkan',{platform:'win32'}),{main:'win-vulkan-x64'});
  assert.deepEqual(assetKeys('cuda',{platform:'win32',cuda:'12'}),{main:'win-cuda-12.4-x64',runtime:'win-cudart-12.4-x64'});
  assert.deepEqual(assetKeys('cuda',{platform:'linux',cuda:'13.4'}),{main:'linux-cuda-13.4-x64',runtime:'linux-cudart-13.4-x64'});
  assert.equal(assetKeys('hip',{platform:'linux'}).main,'linux-rocm-x64');assert.throws(()=>assetKeys('metal'),/Неизвестный бэкенд/);
  const m=require('../desktop/manifest.json');for(const b of ['cpu','vulkan','cuda','sycl','hip'])for(const p of ['win32','linux'])for(const k of Object.values(assetKeys(b,{platform:p,cuda:'13.4'})))assert.ok(m.llama.assets[k],k);
});
test('GPU layers follow free VRAM and quantization follows the recommendation',()=>{
  const GB=1024**3;
  assert.equal(gpuLayers({backend:'cpu',modelBytes:7.6*GB,freeVram:12*GB}),0);
  assert.equal(gpuLayers({backend:'vulkan',modelBytes:7.6*GB,freeVram:12*GB}),999);
  assert.equal(gpuLayers({backend:'vulkan',modelBytes:7.6*GB,freeVram:0}),999);
  const partial=gpuLayers({backend:'vulkan',modelBytes:7.6*GB,freeVram:6*GB});assert.ok(partial>0&&partial<32,String(partial));
  assert.equal(gpuLayers({backend:'cuda',modelBytes:7.6*GB,freeVram:1*GB}),0);
  assert.equal(gpu.recommendQuantization({vram:12*GB,backendId:'vulkan'}),'Q8_0');assert.equal(gpu.recommendQuantization({vram:8*GB,backendId:'cuda'}),'Q6_K');
  assert.equal(gpu.recommendQuantization({vram:4*GB,backendId:'cuda'}),'Q4_K_M');assert.equal(gpu.recommendQuantization({vram:12*GB,backendId:'cpu'}),'Q4_K_M');assert.equal(gpu.recommendQuantization({vram:null,backendId:'vulkan'}),'Q6_K');
  assert.equal(chooseQuant('auto','Q8_0',[{quant:'Q6_K'}]),'Q6_K');assert.equal(chooseQuant('auto','Q6_K',[{quant:'Q8_0'},{quant:'Q6_K'}]),'Q6_K');
  assert.equal(chooseQuant('auto','Q6_K',[]),'Q6_K');assert.equal(chooseQuant('Q4_K_M','Q8_0',[]),'Q4_K_M');assert.throws(()=>chooseQuant('Q2','Q8_0',[]),/Неизвестная квантизация/);
});
test('start launches a private authenticated server on localhost and stop ends the process',async t=>{
  const log=path.join(await temp(t),'spawn.log'),{server,spawns}=await installed(t,{log});
  const info=await server.start();
  assert.match(server.endpoint,/^http:\/\/127\.0\.0\.1:\d+\/v1$/);assert.equal(info.layers,999);
  const args=spawns[0];assert.equal(args[args.indexOf('--host')+1],'127.0.0.1');assert.ok(!args.includes(server.apiKey),'key never appears on the command line');
  assert.ok(args.includes('--api-key-file'));
  const keyFile=args[args.indexOf('--api-key-file')+1];assert.equal(await fs.access(keyFile).then(()=>true,()=>false),false,'key file is removed once the server is up');
  assert.equal((await fetch(server.endpoint+'/chat/completions',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(server.endpoint+'/chat/completions',{method:'POST',headers:server.headers(),body:'{}'})).status,200);
  const pid=server.child.pid;assert.ok(alive(pid));
  await server.stop();assert.ok(!alive(pid));assert.equal(server.running,false);assert.equal(server.endpoint,null);
  await server.start();await server.stop();
});
test('cancelling while the model is still loading kills the process and reports cancellation',async t=>{
  const {server}=await installed(t,{mode:'slow-load'});
  const abort=new AbortController(),start=server.start({signal:abort.signal});
  assert.ok(await until(()=>server.child?.pid));const pid=server.child.pid;
  abort.abort();await assert.rejects(start,/Отменено/);
  assert.ok(await until(()=>!alive(pid)),'process is gone');assert.equal(server.running,false);
});
test('a model that does not fit in VRAM is retried with fewer layers and finally on the CPU',async t=>{
  const {server,spawns}=await installed(t,{mode:'oom-with-gpu',settings:{translationDevice:'vulkan'}});
  const info=await server.start();
  assert.equal(info.layers,0);assert.ok(spawns.length>=2);assert.equal(spawns.at(-1)[spawns.at(-1).indexOf('-ngl')+1],'0');
});
test('missing engine, missing model and unavailable explicit device give clear errors',async t=>{
  const a=await installed(t,{settings:{translationQuant:'Q8_0'}});
  await assert.rejects(a.server.start(),e=>e.code==='MODEL_MISSING'&&/Q8_0/.test(e.message));
  const b=await installed(t,{backend:'cpu',settings:{translationDevice:'cuda'}});
  await assert.rejects(b.server.start(),/недоступно \(cuda\)/);
  const c=await installed(t,{backend:'cpu',settings:{translationDevice:'vulkan'}});
  await assert.rejects(c.server.start(),e=>e.code==='LLAMA_MISSING'&&/vulkan/.test(e.message));
});
test('Backend restarts a crashed translator and a frozen one without losing the request',async t=>{
  const log=path.join(await temp(t),'spawn.log'),{server}=await installed(t,{mode:'die-after-first',log});
  const dir=await temp(t),b=await new Backend(dir,{llama:server,translationTimeout:400}).init();
  const answers=[];
  await b.models.with('translation',async()=>{
    answers.push(await b.translateRaw('one'));
    assert.ok(await until(()=>!server.running),'server died after the first answer');
    answers.push(await b.translateRaw('two'));
  });
  assert.deepEqual(answers,['перевод 1','перевод 1']);
  const spawned=(await fs.readFile(log,'utf8')).trim().split('\n').length;assert.equal(spawned,2);
  await b.close();assert.equal(server.running,false);
});
test('a frozen translator is replaced after the timeout',async t=>{
  const {server}=await installed(t,{mode:'hang-second'});
  const dir=await temp(t),b=await new Backend(dir,{llama:server,translationTimeout:400}).init();
  let frozen,answers=[];
  await b.models.with('translation',async()=>{
    answers.push(await b.translateRaw('one'));frozen=server.child.pid;
    answers.push(await b.translateRaw('two'));
  });
  assert.deepEqual(answers,['перевод 1','перевод 1']);
  assert.ok(await until(()=>!alive(frozen)),'frozen process was ended');
  assert.equal(server.running,false,'unloaded after the lease');
  await b.close();
});
test('importing an existing GGUF checks SHA-256, links without copying and leaves the original',async t=>{
  const source=await temp(t),runtime=await temp(t),bytes=crypto.randomBytes(4096),sha=crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(source,'HY-MT2-7B-Q8_0.gguf'),bytes);
  const manifest=manifestFor([['HY-MT2-7B-Q8_0.gguf',bytes.length,sha]]);
  const found=await scanImport({manifest,directories:[source,path.join(source,'missing')]});
  assert.equal(found.length,1);assert.equal(found[0].quant,'Q8_0');
  const events=[];const r=await importModel({candidate:found[0],settings:{},runtime,manifest,onProgress:p=>events.push(p.phase)});
  assert.equal(r.method,'link');assert.deepEqual(await fs.readFile(r.file),bytes);assert.ok((await fs.stat(r.file)).ino===(await fs.stat(found[0].file)).ino||process.platform==='win32');
  assert.equal((await importModel({candidate:found[0],settings:{},runtime,manifest})).method,'already');
  await fs.writeFile(path.join(source,'HY-MT2-7B-Q8_0.gguf'),Buffer.concat([bytes.subarray(1),Buffer.from([0])]));
  const bad=await temp(t);
  await assert.rejects(importModel({candidate:found[0],settings:{},runtime:bad,manifest}),e=>e.code==='SHA_MISMATCH');
  assert.ok((await fs.stat(found[0].file)).size>0);
});

test('engine installation downloads the pinned archive, merges CUDA runtime files next to the server and marks it installed',async t=>{
  const runtime=await temp(t),seen=[];
  const manifest={llama:{tag:'b9',assets:{'linux-cuda-12.8-x64':{name:'main.tar.gz',url:'https://x/main',sha256:'1'.repeat(64),size:1},'linux-cudart-12.8-x64':{name:'rt.tar.gz',url:'https://x/rt',sha256:'2'.repeat(64),size:1},'win-cuda-12.4-x64':{name:'main.zip',url:'https://x/m',sha256:'1'.repeat(64),size:1},'win-cudart-12.4-x64':{name:'rt.zip',url:'https://x/r',sha256:'2'.repeat(64),size:1}}},hymt:{files:{}}};
  const server=new LlamaServer({settings:()=>({}),runtime,manifest,platform:process.platform});
  const downloadFile=async o=>{seen.push(o.sha256);};
  const exeName=process.platform==='win32'?'llama-server.exe':'llama-server';
  const extract=async(archive,dir)=>{await fs.mkdir(path.join(dir,'pkg'),{recursive:true});if(archive.includes('main'))await fs.writeFile(path.join(dir,'pkg',exeName),'bin');else await fs.writeFile(path.join(dir,'cudart64_12.dll'),'rt');};
  const backend={id:'cuda',cuda:process.platform==='win32'?'12':'12.8'};
  assert.equal(await server.binaryPath(backend),null);
  const exe=await server.install(backend,{downloadFile,extract});
  assert.deepEqual(seen,['1'.repeat(64),'2'.repeat(64)]);assert.equal(path.basename(exe),exeName);
  assert.equal(await fs.readFile(path.join(path.dirname(exe),'cudart64_12.dll'),'utf8'),'rt');
  assert.equal(await server.binaryPath(backend),exe);
  assert.equal(await fs.access(path.join(path.dirname(exe),'..','.runtime')).then(()=>true,()=>false),false);
  await assert.rejects(server.install({id:'vulkan'},{downloadFile,extract}),e=>e.code==='NO_ASSET');
});
