'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const zlib=require('node:zlib');
const {execFileSync}=require('node:child_process');
const {parseWindowsGpus,parseNvidiaSmi,mergeNvidia}=require('../desktop/system-info.cjs');
const {speakCommand,speak}=require('../desktop/speech.cjs');
const win=require('../desktop/enhance-limits-win.cjs');
const isolation=require('../desktop/isolation.cjs');
const tools=require('../desktop/tools.cjs');
const {installFfmpeg}=require('../desktop/components.cjs');
const {extractArchive}=require('../desktop/extract.cjs');
const temp=async t=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-plat-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;};

test('Windows adapters are parsed with vendor, real VRAM and without virtual displays',()=>{
  const json=JSON.stringify([
    {name:'NVIDIA GeForce RTX 4070',pnp:'PCI\\VEN_10DE&DEV_2786&SUBSYS_1',driver:'32.0.15.6094',adapterRam:4293918720,vram:12884901888},
    {name:'AMD Radeon RX 7800 XT',pnp:'PCI\\VEN_1002&DEV_747E',driver:'31.0.24033.1003',adapterRam:4293918720,vram:17163091968},
    {name:'Intel(R) Arc(TM) A770',pnp:'PCI\\VEN_8086&DEV_56A0',driver:'31.0.101.5333',adapterRam:2147483648,vram:null},
    {name:'Microsoft Basic Display Adapter',pnp:'ROOT\\BASIC',driver:'10.0',adapterRam:0}]);
  const gpus=parseWindowsGpus(json);
  assert.deepEqual(gpus.map(g=>g.maker),['NVIDIA','AMD','Intel']);
  assert.equal(gpus[0].vramTotal,12884901888);assert.equal(gpus[2].vramTotal,null);assert.equal(gpus[2].vramApproximate,true);
  assert.equal(parseWindowsGpus(JSON.stringify({name:'Intel Arc B580',pnp:'PCI\\VEN_8086&DEV_E20B'})).length,1,'a single adapter arrives as an object');
  assert.deepEqual(parseWindowsGpus('not json'),[]);
});
test('nvidia-smi supplies exact VRAM and driver, or adds the card when WMI missed it',async()=>{
  const smi='NVIDIA GeForce RTX 4070, 12282, 1500, 560.94\n';
  assert.deepEqual(parseNvidiaSmi(smi),[{name:'NVIDIA GeForce RTX 4070',vramTotal:12282*1024**2,vramUsed:1500*1024**2,driver:'560.94'}]);
  const execute=async()=>({output:smi});
  const merged=await mergeNvidia([{name:'NVIDIA GeForce RTX 4070',vendor:'10de',vramTotal:4293918720,vramApproximate:true}],execute);
  assert.equal(merged[0].vramTotal,12282*1024**2);assert.equal(merged[0].driver,'560.94');assert.equal(merged[0].vramApproximate,undefined);
  assert.equal((await mergeNvidia([],execute))[0].maker,'NVIDIA');
  assert.deepEqual(await mergeNvidia([{name:'AMD',vendor:'1002'}],async()=>{throw Error('missing');}),[{name:'AMD',vendor:'1002'}]);
});
test('speech never puts the sentence into the script text and reports a missing synthesizer',async()=>{
  const w=speakCommand('He said "hi"; $(rm -rf /)','win32');
  assert.equal(w.binary,'powershell.exe');assert.ok(!w.args.join(' ').includes('rm -rf'));assert.equal(w.env.LINGO_SPEAK_TEXT,'He said "hi"; $(rm -rf /)');
  const l=speakCommand('--help','linux');assert.deepEqual(l.args.slice(-2),['--','--help']);
  assert.equal(speakCommand('   ','linux'),null);
  await assert.rejects(speak('hello',{platform:'linux',execute:async()=>{throw Object.assign(Error('x'),{code:'ENOENT'});}}),/espeak-ng/);
});
const clock=()=>{let now=0;return {now:()=>now,advance:ms=>{now+=ms;}};};
function harness(over={}){
  const c=clock();let tick;
  const options={writeDirectory:os.tmpdir(),now:c.now,interval:fn=>{tick=fn;return {unref(){}};},clear(){},memory:async()=>8*1024**3,statfs:async()=>({bavail:1e9,bsize:4096}),jobMemory:async()=>100*1024**2,...over};
  return {options,c,tick:()=>tick()};
}
const hangUntilAbort=(signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('killed')),{once:true}));
test('Windows watchdog stops a job that exceeds its memory limit, and says it is not isolation',async()=>{
  const h=harness({jobMemory:async()=>2*1024**3});
  const p=win.runLimited('ffmpeg',[],{...h.options,execute:async(b,a,o)=>{o.onSpawn({pid:process.pid});return hangUntilAbort(o.signal);}});
  await new Promise(r=>setTimeout(r,10));await h.tick();
  await assert.rejects(p,e=>e.code==='ENHANCE_SAFETY_STOP'&&/1,5 ГиБ/.test(e.message));
  assert.match(require('../desktop/isolation.cjs').pick('win32').label,/не изоляция/);
});
for(const [name,over,advance,pattern] of [
  ['low system memory',{memory:async()=>100*1024**2},0,/не хватает свободной памяти/],
  ['full disk',{statfs:async()=>({bavail:10,bsize:4096})},0,/место на диске/],
  ['no progress',{},130000,/нет прогресса/]]){
  test('Windows watchdog stops on '+name,async()=>{
    const h=harness(over);
    const p=win.runLimited('ffmpeg',[],{...h.options,execute:async(b,a,o)=>hangUntilAbort(o.signal)});
    await new Promise(r=>setTimeout(r,10));h.c.advance(advance);await h.tick();
    await assert.rejects(p,e=>e.code==='ENHANCE_SAFETY_STOP'&&pattern.test(e.message));
  });
}
test('Windows watchdog reports user cancellation as cancellation and has nothing to clean after a crash',async()=>{
  const abort=new AbortController(),h=harness();
  const p=win.runLimited('ffmpeg',[],{...h.options,signal:abort.signal,execute:async(b,a,o)=>hangUntilAbort(o.signal)});
  abort.abort();await assert.rejects(p,/Отменено/);
  assert.equal(await win.stopOrphanedEnhancements(),0);
});
test('isolation picks systemd+bubblewrap on Linux and the honest watchdog elsewhere',()=>{
  const l=isolation.pick('linux'),w=isolation.pick('win32');
  assert.equal(l.mode,'systemd-bwrap');assert.equal(l.full,true);assert.equal(typeof l.limitedCommand,'function');
  assert.equal(w.mode,'watchdog');assert.equal(w.full,false);assert.equal(w.limitedCommand,undefined);
});
test('ffmpeg lookup order: Linux prefers the system build, Windows the downloaded one',async t=>{
  const runtime=await temp(t),sys=await temp(t);
  const exe=(dir,name)=>path.join(dir,process.platform==='win32'?name+'.exe':name);
  await fs.mkdir(path.join(runtime,'bin'));
  for(const n of ['ffmpeg','ffprobe']){await fs.writeFile(exe(path.join(runtime,'bin'),n),'');await fs.writeFile(exe(sys,n),'');}
  const env={PATH:sys};
  const linuxPlan=(await tools.locate('ffmpeg',{runtime,env,platform:'linux'}));
  assert.equal(linuxPlan.source,'system');
  // locate() builds the downloaded file name from the requested platform, so use the real one on this machine.
  const own=await tools.locate('ffmpeg',{runtime,env:{PATH:''},platform:process.platform});assert.equal(own.source,'own');
  if(process.platform==='win32')assert.equal((await tools.locate('ffmpeg',{runtime,env,platform:'win32'})).source,'own');
  assert.equal(await tools.locate('ffmpeg',{runtime:path.join(runtime,'none'),env:{PATH:''},platform:process.platform}),null);
  assert.equal((await tools.locate('ffmpeg',{runtime,env:{PATH:'',ANIME_LINGO_FFMPEG:exe(sys,'ffmpeg')},platform:'linux'})).source,'env');
});
test('Linux fallback installs gunzipped ffmpeg and ffprobe through the verified downloader',async t=>{
  if(process.platform==='win32')return;
  const runtime=await temp(t),seen=[];
  const downloadFile=async({dest,sha256})=>{seen.push(sha256);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,zlib.gzipSync('#!/bin/sh\necho fake\n'));};
  const status=await installFfmpeg({runtime,platform:'linux',downloadFile});
  assert.equal(seen.length,2);assert.ok(seen.every(s=>/^[a-f0-9]{64}$/.test(s)));
  assert.equal((await fs.readFile(path.join(runtime,'bin','ffmpeg'),'utf8')),'#!/bin/sh\necho fake\n');
  assert.ok((await fs.stat(path.join(runtime,'bin','ffprobe'))).mode&0o111);
  assert.ok(status.ffmpeg);
});
test('archives are unpacked by the system tar and unsafe entries are refused',async t=>{
  const dir=await temp(t);await fs.mkdir(path.join(dir,'src','bin'),{recursive:true});await fs.writeFile(path.join(dir,'src','bin','x.txt'),'ok');
  const archive=path.join(dir,'a.tar.gz');
  try{execFileSync('tar',['-czf',archive,'-C',path.join(dir,'src'),'.']);}catch{t.skip('tar недоступен');return;}
  const entries=await extractArchive(archive,path.join(dir,'out'));
  assert.ok(entries.length>0);assert.equal(await fs.readFile(path.join(dir,'out','bin','x.txt'),'utf8'),'ok');
  await assert.rejects(extractArchive(archive,path.join(dir,'out2'),{execute:async(b,a)=>({output:'../evil\n',errors:''})}),/Небезопасный путь/);
});
test('FFmpeg install reports progress, can be paused and resumed, and surfaces errors',async t=>{
  const {Backend}=require('../desktop/backend.cjs');
  const dir=await temp(t);let mode='ok';const seen=[];
  const installer=async({signal,onProgress})=>{
    onProgress({phase:'downloading',percent:40,speed:1e6});seen.push(40);
    if(mode==='pause'){await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('p'),{code:'PAUSED'})),{once:true}));}
    if(mode==='fail')throw Error('SHA-256 не совпала');
    onProgress({phase:'extracting',percent:99});
  };
  const b=await new Backend(dir,{manageModels:false,installer}).init();
  await assert.rejects(()=>b.installComponent('curl'),/Неизвестный компонент/);
  mode='pause';const running=b.installComponent('ffmpeg');
  await new Promise(r=>setTimeout(r,20));assert.equal(b.snapshot().components.ffmpeg.state,'downloading');
  await assert.rejects(()=>b.installComponent('ffmpeg'),/уже скачивается/);
  b.pauseComponent('ffmpeg');assert.equal((await running).state,'paused');
  mode='fail';assert.equal((await b.installComponent('ffmpeg')).state,'error');assert.match(b.lastError,/SHA-256/);
  mode='ok';assert.equal((await b.installComponent('ffmpeg')).state,'ready');
});
