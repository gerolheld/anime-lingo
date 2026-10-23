'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const videoGpu=require('../desktop/video-gpu.cjs');
const {cpuPlan}=require('../desktop/enhance-cpu.cjs');
const {esrganPlan,enhanceEsrgan,LIMIT}=require('../desktop/enhance-gpu.cjs');
const gpu=require('../desktop/gpu.cjs');
const {Backend}=require('../desktop/backend.cjs');
const {safetyError}=require('../desktop/enhance-limits.cjs');
const temp=async t=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-vgpu-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;};
const NV={name:'NVIDIA GeForce RTX 4070',vendor:'10de',maker:'NVIDIA'},AMD={name:'AMD Radeon RX 7800 XT',vendor:'1002',maker:'AMD'},XE={name:'Intel Arc B580',vendor:'8086',maker:'Intel',driver:'xe'},ARC_WIN={name:'Intel Arc A770',vendor:'8086',maker:'Intel',driver:'igfx'};
const ALL=new Set(['h264_nvenc','h264_amf','h264_vaapi','h264_qsv']);

test('GPU mode is off by default, needs confirmation, and Intel Xe on Linux needs its own',()=>{
  const g=(videoGpu_,gpus,platform='linux')=>videoGpu.gate({settings:{videoGpu:videoGpu_},gpus,platform});
  assert.equal(g(undefined,[NV]).allowed,false);
  assert.match(g({enabled:true},[NV]).reason,/Подтвердите/);
  assert.equal(g({enabled:true,acknowledged:true},[NV]).allowed,true);
  assert.equal(g({enabled:true,acknowledged:true},[XE]).allowed,false);assert.equal(g({enabled:true,acknowledged:true},[XE]).xeBlocked,true);
  assert.equal(g({enabled:true,acknowledged:true,allowIntelXe:true},[XE]).allowed,true);
  assert.equal(g({enabled:true,acknowledged:true},[ARC_WIN],'win32').allowed,true);
  assert.match(g({enabled:false},[NV]).warning,/не изолирован/);
});
test('encoder candidates follow vendor, OS and the ffmpeg build; unavailable ones carry a reason',()=>{
  const ids=(gpus,platform,supported=ALL)=>videoGpu.candidates({gpus,platform,supported,node:'/dev/dri/renderD128'}).filter(c=>c.available).map(c=>c.id);
  assert.deepEqual(ids([NV],'win32'),['nvenc']);assert.deepEqual(ids([AMD],'win32'),['amf']);assert.deepEqual(ids([AMD],'linux'),['vaapi']);
  assert.deepEqual(ids([XE],'linux'),['qsv','vaapi']);assert.deepEqual(ids([ARC_WIN],'win32'),['qsv']);
  const missing=videoGpu.candidates({gpus:[NV],platform:'linux',supported:new Set(),node:null});assert.equal(missing[0].available,false);assert.match(missing[0].reason,/собран без h264_nvenc/);
  assert.match(videoGpu.candidates({gpus:[AMD],platform:'linux',supported:ALL,node:null})[0].reason,/renderD/);
  assert.equal(videoGpu.parseEncoders(' V....D libx264   H.264\n V....D h264_nvenc   NVENC\n A....D aac AAC').has('h264_nvenc'),true);
});
test('an encoder is chosen only after a successful real test, never by the card name',()=>{
  const cands=videoGpu.candidates({gpus:[NV,AMD],platform:'linux',supported:ALL,node:'/dev/dri/renderD128'});
  assert.equal(videoGpu.chooseEncoder({choice:'auto',probes:{},cands}),'cpu');
  assert.equal(videoGpu.chooseEncoder({choice:'auto',probes:{nvenc:{ok:false}},cands}),'cpu');
  assert.equal(videoGpu.chooseEncoder({choice:'auto',probes:{nvenc:{ok:true}},cands}),'nvenc');
  assert.throws(()=>videoGpu.chooseEncoder({choice:'nvenc',probes:{},cands}),/ещё не проверен/);
  assert.throws(()=>videoGpu.chooseEncoder({choice:'amf',probes:{},cands}),/не подходит/);
  assert.equal(videoGpu.chooseEncoder({choice:'cpu',probes:{},cands}),'cpu');
});
test('the encoder test is a one-second synthetic encode with a timeout and reports failures',async()=>{
  const calls=[];
  const ok=await videoGpu.probeEncoder({id:'vaapi',ffmpeg:'ffmpeg',node:'/dev/dri/renderD128',execute:async(b,a,o)=>{calls.push({a,o});return {output:''};}});
  assert.equal(ok.ok,true);const a=calls[0].a;assert.ok(a.includes('testsrc2=size=640x360:rate=24:duration=1'));assert.ok(a.includes('h264_vaapi'));assert.deepEqual(a.slice(a.indexOf('-vaapi_device'),a.indexOf('-vaapi_device')+2),['-vaapi_device','/dev/dri/renderD128']);assert.equal(calls[0].o.timeout,25000);
  const bad=await videoGpu.probeEncoder({id:'nvenc',ffmpeg:'ffmpeg',execute:async()=>{throw Error('No NVENC capable devices found');}});
  assert.equal(bad.ok,false);assert.match(bad.error,/NVENC/);
});
test('hardware encoder arguments are placed before the input and replace libx264',()=>{
  const source={width:1920,height:1080,duration:100,size:1e6};
  for(const [id,expectPre,vf] of [['nvenc',[],'format=yuv420p'],['amf',[],'format=yuv420p'],['vaapi',['-vaapi_device','/dev/dri/renderD128'],'format=nv12,hwupload'],['qsv',['-init_hw_device','qsv=hw','-filter_hw_device','hw'],'format=nv12,hwupload=extra_hw_frames=64']]){
    const p=cpuPlan({input:'i.mkv',output:'o.mkv',source,encoder:id,renderNode:'/dev/dri/renderD128'});
    const i=p.args.indexOf('-i');for(const x of expectPre)assert.ok(p.args.indexOf(x)>=0&&p.args.indexOf(x)<i,id+' '+x);
    assert.ok(p.args.includes(videoGpu.ENCODERS[id].codec));assert.ok(!p.args.includes('libx264'));assert.ok(p.args[p.args.indexOf('-vf')+1].endsWith(vf),id);assert.equal(p.encoder,id);
  }
  assert.ok(cpuPlan({input:'i',output:'o',source}).args.includes('libx264'));
});

// ---------- Real-ESRGAN pipeline with stub processes ----------
const SRC={width:640,height:360,duration:10,frameRate:'24/1',size:5e6};
function stub(dir,{upscaleFrames,fail,probeVfr=false,hdr=false,audio=true,onEsrgan}={}){
  const calls=[],probes={in:{streams:[{codec_type:'video',width:640,height:360,avg_frame_rate:'24/1',r_frame_rate:probeVfr?'25/1':'24/1'},{codec_type:'audio'},{codec_type:'subtitle',codec_name:'mov_text'}],format:{duration:'10'}}};
  if(hdr)probes.in.streams[0].color_transfer='smpte2084';
  const execute=async(binary,args,options)=>{
    calls.push({binary,args,options});
    const name=path.basename(binary);
    if(name==='ffprobe'||binary==='ffprobe'){
      const file=args.at(-1);
      if(file.endsWith('video.mkv'))return {output:JSON.stringify({streams:[{codec_type:'video',width:1280,height:720},{codec_type:'audio'},{codec_type:'subtitle'}],format:{duration:'10.02'}})};
      return {output:JSON.stringify(probes.in)};
    }
    if(name.includes('esrgan')){
      const input=args[args.indexOf('-i')+1],output=args[args.indexOf('-o')+1];await onEsrgan?.({input,output,args});
      if(fail)throw fail;
      const names=await fs.readdir(input);for(const n of names.slice(0,upscaleFrames??names.length))await fs.writeFile(path.join(output,n),'up');return {output:''};
    }
    // ffmpeg
    const last=args.at(-1);
    if(last.includes('%06d.png')){const frames=+args[args.indexOf('-frames:v')+1];for(let i=0;i<frames;i++)await fs.writeFile(last.replace('%06d',String(i).padStart(6,'0')),'f');return {output:''};}
    await fs.writeFile(last,'media');return {output:''};
  };
  return {execute,calls};
}
async function setup(t,over={}){
  const dir=await temp(t),input=path.join(dir,'in.mkv'),output=path.join(dir,'out.mkv');await fs.writeFile(input,'src');
  const events=[],s=stub(dir,over);
  const run=(extra={})=>enhanceEsrgan({input,output,source:SRC,scale:2,esrgan:{binary:'/x/realesrgan-ncnn-vulkan',models:'/x/models'},encoder:'cpu',onProgress:e=>events.push(e),...extra},{execute:s.execute,headroom:async()=>{},sleep:()=>new Promise(r=>setTimeout(r,1)),poll:1});
  return {dir,input,output,events,run,...s};
}
test('Real-ESRGAN runs in 4-second segments, keeps audio/subtitles, cleans up and never touches the source',async t=>{
  const h=await setup(t),result=await h.run();
  const esrgan=h.calls.filter(c=>c.binary.includes('esrgan'));assert.equal(esrgan.length,3,'10 s in 4 s segments');
  const a=esrgan[0].args;assert.equal(a[a.indexOf('-n')+1],'realesr-animevideov3');assert.equal(a[a.indexOf('-s')+1],'2');assert.equal(a[a.indexOf('-m')+1],'/x/models');
  assert.equal(esrgan[0].options.stallMs,LIMIT.stallMs);assert.ok(esrgan[0].options.memoryLimit>=2*1024**3);
  assert.equal(result.engine,'gpu-esrgan');assert.equal(result.frames,240);assert.equal(result.width,1280);
  assert.equal(await fs.readFile(h.input,'utf8'),'src');assert.equal(await fs.readFile(h.output,'utf8'),'media');
  assert.deepEqual((await fs.readdir(h.dir)).sort(),['in.mkv','out.mkv'],'work directory removed');
  const mux=h.calls.find(c=>c.args.includes('concat'));assert.ok(mux.args.includes('-map')&&mux.args.includes('1:s?')&&mux.args.includes('-c:s:0'));
  const percents=h.events.filter(e=>e.progress!==undefined).map(e=>e.progress);for(let i=1;i<percents.length;i++)assert.ok(percents[i]>=percents[i-1]-1e-9,'progress never goes back');
  assert.ok(h.events.some(e=>e.phase==='encoding'));
});
test('a GPU hardware encoder is used for the parts only when one was chosen',async t=>{
  const h=await setup(t),h2=await setup(t);
  await h.run({encoder:'cpu'});await h2.run({encoder:'nvenc'});
  const enc=x=>x.calls.filter(c=>c.args.includes('-framerate')).map(c=>c.args[c.args.indexOf('-c:v')+1]);
  assert.deepEqual([...new Set(enc(h))],['libx264']);assert.deepEqual([...new Set(enc(h2))],['h264_nvenc']);
});
test('every GPU failure becomes GPU_FAILED so the job can be repeated on the CPU; resource stops and cancels are not retried',async t=>{
  const stall=await setup(t,{fail:safetyError('Обработка остановлена: долго нет прогресса. Автоматический повтор отключён.')});
  await assert.rejects(stall.run(),e=>e.code==='GPU_FAILED'&&/Видеокарта не справилась/.test(e.message));
  assert.deepEqual((await fs.readdir(stall.dir)).sort(),['in.mkv'],'temporary files removed after a failure');
  const crash=await setup(t,{fail:Object.assign(Error('realesrgan-ncnn-vulkan: код 139'),{code:'PROCESS_FAILED'})});
  await assert.rejects(crash.run(),e=>e.code==='GPU_FAILED');
  const missing=await setup(t,{upscaleFrames:5});await assert.rejects(missing.run(),e=>e.code==='GPU_FAILED'&&/из \d+ кадров/.test(e.message));
  const memory=await setup(t,{fail:safetyError('Обработка остановлена: системе не хватает свободной памяти.')});
  await assert.rejects(memory.run(),e=>e.code==='ENHANCE_SAFETY_STOP'&&!e.code.includes('GPU'));
  const abort=new AbortController(),cancel=await setup(t,{onEsrgan:()=>abort.abort(),fail:Error('killed')});
  await assert.rejects(cancel.run({signal:abort.signal}),/Отменено/);
  const slow=await setup(t);let tick=0;await assert.rejects(slow.run({maxMs:-1}),e=>e.code==='GPU_FAILED'&&/лимит времени/.test(e.message));void tick;
});
test('unsupported sources are refused before any GPU work: variable frame rate, HDR, oversize results, bad scale',async t=>{
  await assert.rejects((await setup(t,{probeVfr:true})).run(),/постоянную частоту/);
  await assert.rejects((await setup(t,{hdr:true})).run(),/HDR/);
  assert.throws(()=>esrganPlan({source:{...SRC,width:3840,height:2160},scale:2}),/3840×2160/);
  assert.throws(()=>esrganPlan({source:SRC,scale:1}),/масштаб/);
  assert.throws(()=>esrganPlan({source:{...SRC,frameRate:'120/1'},scale:2}),/частота кадров/);
  const none=await setup(t);await assert.rejects(none.run({esrgan:null}),/не установлен/);
  const h=await setup(t);assert.equal(h.calls.some(c=>c.binary.includes('esrgan')),false);
});

// ---------- Backend: gating and automatic fallback ----------
async function backend(t,{caps=[NV],settings={},esrgan={binary:'/x/realesrgan-ncnn-vulkan',models:'/x/m'},gpuExecutor,enhanceExecutor}={}){
  const dir=await temp(t),calls=[];
  const b=await new Backend(dir,{manageModels:false,gpuDetect:async()=>gpu.capabilities(caps,{platform:'linux',exists:()=>true}),encoderSupport:ALL,esrganLocate:async()=>esrgan,
    gpuExecutor:gpuExecutor||(async o=>{calls.push('gpu');return {engine:'gpu-esrgan',width:1280,height:720,seconds:1};}),
    enhanceExecutor:enhanceExecutor||(async o=>{calls.push('cpu'+(o.gpuEncoder?'+enc:'+o.encoder:''));return {engine:o.gpuEncoder?'gpu-encode':'cpu',width:640,height:360,seconds:1};}),
    thumbnailExecutor:async()=>{}}).init();
  b.db.settings.outputDirectory=path.join(dir,'out');b.db.settings.videoGpu={enabled:true,acknowledged:true,allowIntelXe:false,encoder:'auto',maxMinutes:120,probes:{},...settings};
  b.db.episodes.push({id:'e',title:'Episode 1',filePath:'/x/e.mkv',video:true,width:640,height:360,duration:100,frameRate:'24/1',audio:[],cues:[],ruCues:[],subtitleTracks:[],state:'ready'});
  return {b,calls,dir};
}
const finish=async b=>{await b.queue;return b.db.enhancements[0];};
test('GPU modes are refused until enabled, confirmed and (for encoding) probed',async t=>{
  const off=await backend(t,{settings:{enabled:false}});await assert.rejects(off.b.enhance(['e'],{engine:'gpu-esrgan',scale:2}),/выключен/);
  const unconfirmed=await backend(t,{settings:{acknowledged:false}});await assert.rejects(unconfirmed.b.enhance(['e'],{engine:'gpu-esrgan',scale:2}),/Подтвердите/);
  const xe=await backend(t,{caps:[XE]});await assert.rejects(xe.b.enhance(['e'],{engine:'gpu-esrgan',scale:2}),/Intel Xe/);
  const noProbe=await backend(t);await assert.rejects(noProbe.b.enhance(['e'],{engine:'gpu-encode'}),/Нет проверенного/);
  const noTool=await backend(t,{esrgan:null});await assert.rejects(noTool.b.enhance(['e'],{engine:'gpu-esrgan',scale:2}),/Real-ESRGAN не установлен/);
  assert.equal(off.b.db.enhancements.length+xe.b.db.enhancements.length+noProbe.b.db.enhancements.length,0);
  const cpu=await backend(t,{settings:{enabled:false}});await cpu.b.enhance(['e'],{engine:'cpu'});assert.equal((await finish(cpu.b)).state,'ready');assert.deepEqual(cpu.calls,['cpu']);
});
test('a successful GPU job records its engine; a probed encoder drives gpu-encode',async t=>{
  const a=await backend(t);await a.b.enhance(['e'],{engine:'gpu-esrgan',scale:2});const job=await finish(a.b);
  assert.equal(job.state,'ready');assert.equal(job.engine,'gpu-esrgan');assert.deepEqual(a.calls,['gpu']);assert.match(job.outputFile,/\.esrgan-2x-/);assert.equal(job.fallback,undefined);
  const e=await backend(t,{settings:{probes:{nvenc:{ok:true}}}});await e.b.enhance(['e'],{engine:'gpu-encode'});const j2=await finish(e.b);
  assert.equal(j2.state,'ready');assert.deepEqual(e.calls,['cpu+enc:nvenc']);
});
test('a GPU failure is repeated on the CPU, with the reason kept; cancel and resource stops are not',async t=>{
  const f=await backend(t,{gpuExecutor:async()=>{throw Object.assign(Error('Видеокарта не справилась'),{code:'GPU_FAILED'});}});
  await f.b.enhance(['e'],{engine:'gpu-esrgan',scale:2});const job=await finish(f.b);
  assert.equal(job.state,'ready');assert.equal(job.engine,'cpu');assert.equal(job.fallback.from,'gpu-esrgan');assert.match(job.fallback.reason,/не справилась/);assert.deepEqual(f.calls,['cpu']);assert.match(job.outputFile,/\.cpu-2x-/);
  const enc=await backend(t,{settings:{probes:{nvenc:{ok:true}}},enhanceExecutor:async o=>{if(o.gpuEncoder)throw Object.assign(Error('encoder died'),{code:'PROCESS_FAILED'});return {engine:'cpu',width:1,height:1,seconds:1};}});
  await enc.b.enhance(['e'],{engine:'gpu-encode'});const j2=await finish(enc.b);assert.equal(j2.state,'ready');assert.equal(j2.engine,'cpu');assert.equal(j2.fallback.from,'gpu-encode');
  const stop=await backend(t,{gpuExecutor:async()=>{throw safetyError('Обработка остановлена: заканчивается место на диске.');}});
  await stop.b.enhance(['e'],{engine:'gpu-esrgan',scale:2});const j3=await finish(stop.b);assert.equal(j3.state,'error');assert.equal(j3.safetyStopped,true);assert.equal(j3.fallback,undefined);
  const cancel=await backend(t,{gpuExecutor:async o=>{await new Promise((_,rej)=>o.signal.addEventListener('abort',()=>rej(Object.assign(Error('x'),{code:'GPU_FAILED'})),{once:true}));}});
  await cancel.b.enhance(['e'],{engine:'gpu-esrgan',scale:2});await new Promise(r=>setTimeout(r,30));cancel.b.cancelEnhancements();const j4=await finish(cancel.b);assert.equal(j4.state,'cancelled');assert.equal(j4.fallback,undefined);assert.deepEqual(cancel.calls,[]);
});
test('video GPU settings validate input, and turning the mode off withdraws the confirmations',async t=>{
  const {b}=await backend(t,{settings:{enabled:false,acknowledged:false}});
  await assert.rejects(b.configure({videoGpu:{encoder:'x264'}}),/Неизвестный кодировщик/);
  await b.configure({videoGpu:{enabled:true,acknowledged:true,allowIntelXe:true,encoder:'nvenc',maxMinutes:5}});
  assert.deepEqual([b.db.settings.videoGpu.enabled,b.db.settings.videoGpu.acknowledged,b.db.settings.videoGpu.maxMinutes,b.db.settings.videoGpu.encoder],[true,true,10,'nvenc']);
  await b.configure({videoGpu:{enabled:false}});assert.deepEqual([b.db.settings.videoGpu.acknowledged,b.db.settings.videoGpu.allowIntelXe],[false,false]);
  b.db.settings.videoGpu.probes={nvenc:{ok:true}};await b.configure({fontSize:30});assert.equal(b.db.settings.videoGpu.probes.nvenc.ok,true,'probes survive other settings changes');
});
test('the encoder test refuses to run unless the mode is enabled and confirmed, and stores its result',async t=>{
  const off=await backend(t,{settings:{enabled:false}});await assert.rejects(off.b.probeVideoEncoder('nvenc'),/выключен/);
  const on=await backend(t);
  const original=require('../desktop/video-gpu.cjs').probeEncoder;void original;
  const status=await on.b.videoGpuStatus();assert.equal(status.gate.allowed,true);assert.equal(status.encoders[0].id,'nvenc');assert.equal(status.encoders[0].probe,null);assert.equal(status.esrgan.installed,true);
});
