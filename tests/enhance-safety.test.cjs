'use strict';
// All executors below are fakes. No FFmpeg, GPU, video decoder or model runs.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {cpuPlan,enhanceCPU,thumbnailCPU}=require('../desktop/enhance-cpu.cjs');
const {LIMITS,limitedCommand,runLimited,checkHeadroom,safetyError,stopOrphanedEnhancements}=require('../desktop/enhance-limits.cjs');
const {enhanceVideo}=require('../desktop/enhance.cjs'),{enhanceAnime4K}=require('../desktop/anime4k.cjs'),{Backend}=require('../desktop/backend.cjs');
const source={width:640,height:360,duration:10,size:1024,frameRate:'24/1'},options={input:'/local/anime.mp4',output:'/local/result.mkv',source};
const enough=async()=>8*1024**3,disk=async()=>({bavail:10000000,bsize:4096}),unit='anime-lingo-enhance-1234abcd.service';
async function folder(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-enhance-safety-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const models={state:{phase:'idle'},async with(kind,fn,signal){if(signal?.aborted)throw Error('Отменено');return fn();}};
function fakePipeline({fail=false,bad=false,audioMissing=false,hdr=false,cancel}={}){
  const calls=[];let probes=0;
  const execute=async(binary,args,settings)=>{
    calls.push({binary,args});
    if(binary.endsWith('ffprobe')){const output=probes++>0;return {output:JSON.stringify({streams:[{codec_type:'video',width:bad&&output?1:640,height:360,color_transfer:hdr?'smpte2084':'bt709'},...(!audioMissing||!output?[{codec_type:'audio'}]:[])],format:{duration:10}})};}
    assert.equal(binary,require('../desktop/tools.cjs').ffmpeg());if(fail)throw safetyError('simulated resource stop');await fs.writeFile(args.at(-1),'simulated output, never decoded');settings.onStdout?.('frame=240\nout_time_us=10000000\nprogress=end\n',()=>{});cancel?.();return {output:''};
  };return {execute,calls};
}
test('all old GPU entry points reject before opening files or starting work',async t=>{
 await assert.rejects(enhanceVideo({...options,engine:'anime4k'}),/GPU-улучшение отключено/);await assert.rejects(enhanceVideo({...options,engine:'realesrgan'}),/GPU-улучшение отключено/);await assert.rejects(enhanceAnime4K(options),/отключён/);
 const b=await new Backend(await folder(t),{modelManager:models}).init();for(const engine of ['anime4k','realesrgan','vulkan','unknown'])await assert.rejects(b.enhance(['missing'],{engine}),/GPU-улучшение отключено/);assert.equal(b.db.enhancements.length,0);assert.equal(b.tasks.size,0);
});
test('CPU plan uses software decode, bounded threads, copy tracks and retains original frame times',()=>{
 const p=cpuPlan(options),a=p.args;assert.equal(p.scale,1);assert.equal(a[a.indexOf('-hwaccel')+1],'none');assert.equal(a[a.indexOf('-c:v')+1],'libx264');assert.equal(a[a.indexOf('-c:a')+1],'copy');assert.equal(a[a.indexOf('-c:s')+1],'copy');assert.equal(a[a.indexOf('-fps_mode')+1],'passthrough');assert.ok(a.includes('0:t?'));assert.ok(a.includes('-n'));assert.ok(!a.includes('-y'));assert.equal(/vulkan|qsv|libplacebo|hwupload|rawvideo/.test(a.join(' ')),false);assert.ok(!a[a.indexOf('-vf')+1].includes('fps='));assert.equal(p.width,640);assert.equal(p.height,360);
 assert.ok(cpuPlan({...options,profile:'clean'}).args.join(' ').includes('hqdn3d='));assert.equal(cpuPlan({...options,scale:2}).width,1280);assert.throws(()=>cpuPlan({...options,scale:4}),/CPU/);assert.throws(()=>cpuPlan({...options,source:{...source,width:3840,height:2160},scale:2}),/3840/);assert.throws(()=>cpuPlan({...options,preview:true,start:11}),/за концом/);assert.throws(()=>cpuPlan({...options,profile:'unknown'}),/профиль/);
});
test('short previews exclude subtitle/attachment tails; full output converts MP4 text for MKV',()=>{
 const p=cpuPlan({...options,preview:true,start:2,seconds:3});assert.equal(p.duration,3);assert.ok(!p.args.includes('0:s?'));assert.ok(!p.args.includes('0:t?'));assert.equal(p.args[p.args.indexOf('-map_chapters')+1],'-1');
 const full=cpuPlan({...options,subtitleCodecs:['ass','mov_text']});assert.equal(full.args[full.args.indexOf('-c:s:1')+1],'srt');assert.ok(!full.args.includes('-c:s:0'));
});
test('systemd cgroup and bubblewrap deny GPU devices, network, swapping and unbounded resource use',()=>{
 const c=limitedCommand('/usr/bin/ffmpeg',['-i','/anime/$file % with spaces.mp4'],{unit,writeDirectory:'/tmp/own work'}),s=c.args;
 for(const property of ['MemoryMax=1610612736','MemoryHigh=1258291200','MemorySwapMax=0','CPUQuota=150%','TasksMax=64','OOMPolicy=kill','KillMode=control-group'])assert.ok(s.includes('--property='+property),property);
 assert.ok(s.includes('--expand-environment=no'));assert.ok(s.includes('--unshare-net'));assert.ok(s.includes('--unshare-pid'));assert.deepEqual(s.slice(s.indexOf('--dev'),s.indexOf('--dev')+2),['--dev','/dev']);assert.ok(!s.includes('/dev/dri'));assert.ok(s.includes('/anime/$file % with spaces.mp4'));assert.throws(()=>limitedCommand('/usr/bin/ffmpeg',[],{unit:'other.service',writeDirectory:'/tmp/x'}));assert.throws(()=>limitedCommand('/usr/bin/ffmpeg',[],{unit,writeDirectory:'/'}));
});
test('low memory or disk headroom refuses the task before a subprocess starts',async()=>{
 await assert.rejects(checkHeadroom('/tmp',{memory:async()=>1,statfs:disk}),e=>e.code==='ENHANCE_SAFETY_STOP');await assert.rejects(checkHeadroom('/tmp',{memory:enough,statfs:async()=>({bavail:1,bsize:1})}),/места/);await checkHeadroom('/tmp',{memory:enough,statfs:disk});
});
test('no fallback to an unrestricted process when systemd or isolation fails',async()=>{
 const calls=[];await assert.rejects(runLimited('/usr/bin/ffmpeg',[],{writeDirectory:'/tmp/work',execute:async(b,a)=>{calls.push(b);if(b.endsWith('systemd-run'))throw Error('manager unavailable');return {output:''};},memory:enough,statfs:disk}),e=>e.code==='ENHANCE_SAFETY_STOP'&&/без ограничений запрещена/.test(e.message));assert.equal(calls.includes('/usr/bin/ffmpeg'),false);assert.ok(calls.includes('/usr/bin/systemctl'));
});
test('a progress callback failure stops the unit instead of crashing the app event loop',async()=>{
 let stopped=false;await assert.rejects(runLimited('/usr/bin/ffmpeg',[],{writeDirectory:'/tmp/work',memory:enough,statfs:disk,onStdout(){throw Error('bad callback');},execute:async(b,a,o)=>{if(b.endsWith('systemctl')){stopped=true;return {output:''};}o.onStdout('frame=1\n');return {output:''};}}),/Ошибка отчёта/);assert.equal(stopped,true);
});
for(const condition of ['stall','memory','disk'])test('watchdog stops the cgroup on '+condition+' without retry',async()=>{
 let tick,clock=0,executions=0,stops=0;const p=runLimited('/usr/bin/ffmpeg',[],{writeDirectory:'/tmp/work',now:()=>clock,interval:fn=>{tick=fn;return {unref(){}};},clear(){},memory:condition==='memory'?async()=>1:enough,statfs:condition==='disk'?async()=>({bavail:1,bsize:1}):disk,execute:async(b,a,o)=>{if(b.endsWith('systemctl')){stops++;return {output:''};}executions++;return new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
 clock=condition==='stall'?LIMITS.stallMs+1:1;await tick();await assert.rejects(p,e=>e.code==='ENHANCE_SAFETY_STOP');assert.equal(executions,1);assert.ok(stops>=1);
});
test('cancel explicitly stops the unit, including a second stop after startup races',async()=>{
 const abort=new AbortController();let stops=0;const p=runLimited('/usr/bin/ffmpeg',[],{writeDirectory:'/tmp/work',signal:abort.signal,memory:enough,statfs:disk,execute:async(b,a,o)=>{if(b.endsWith('systemctl')){stops++;return {output:''};}return new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});abort.abort();await assert.rejects(p,/Отменено/);assert.equal(stops,2);
});
test('restart cleanup only stops units owned by enhancement',async()=>{
 const commands=[];const count=await stopOrphanedEnhancements(async(b,a)=>{commands.push(a);return {output:a.includes('list-units')?'anime-lingo-enhance-abc123.service loaded active running\nother.service loaded active running':''};});assert.equal(count,1);assert.deepEqual(commands[1],['--user','stop','anime-lingo-enhance-abc123.service']);
});
test('CPU pipeline verifies streams and commits a separate result without changing input',async t=>{
 const dir=await folder(t),input=path.join(dir,'source.mp4'),output=path.join(dir,'output.mkv');await fs.writeFile(input,'original');const f=fakePipeline(),p=[];const result=await enhanceCPU({input,output,source,onProgress:x=>p.push(x)},{execute:f.execute,headroom:async()=>{}});assert.equal(result.neural,false);assert.equal(result.frames,240);assert.equal(await fs.readFile(output,'utf8'),'simulated output, never decoded');assert.equal(await fs.readFile(input,'utf8'),'original');assert.equal(f.calls.length,3);assert.equal(p.at(-1).phase,'verifying');assert.equal((await fs.readdir(dir)).some(n=>n.startsWith('.lingo-cpu-')),false);
});
for(const mode of ['fail','bad','audioMissing','hdr'])test('pipeline rejects '+mode+' and removes only its temporary files',async t=>{
 const dir=await folder(t),output=path.join(dir,'output.mkv'),f=fakePipeline({[mode]:true});await fs.writeFile(path.join(dir,'keep.txt'),'keep');await assert.rejects(enhanceCPU({input:'/local/source.mp4',output,source},{execute:f.execute,headroom:async()=>{}}));assert.deepEqual(await fs.readdir(dir),['keep.txt']);
});
test('existing output is never overwritten and cancellation before commit publishes nothing',async t=>{
 const dir=await folder(t),output=path.join(dir,'result.mkv');await fs.writeFile(output,'existing');let f=fakePipeline();await assert.rejects(enhanceCPU({...options,output},{execute:f.execute,headroom:async()=>{}}),e=>e.code==='EEXIST');assert.equal(await fs.readFile(output,'utf8'),'existing');await fs.unlink(output);const c=new AbortController();f=fakePipeline({cancel:()=>c.abort()});await assert.rejects(enhanceCPU({...options,output,signal:c.signal},{execute:f.execute,headroom:async()=>{}}),/Отменено/);assert.deepEqual(await fs.readdir(dir),[]);
});
test('thumbnail generation also uses the limited software executor',async t=>{
 const dir=await folder(t),output=path.join(dir,'preview.jpg');await thumbnailCPU('/local/source.mp4',output,1,undefined,{execute:async(b,a,o)=>{assert.equal(b,require('../desktop/tools.cjs').ffmpeg());assert.equal(a[a.indexOf('-hwaccel')+1],'none');assert.ok(o.writeDirectory.startsWith(dir));await fs.writeFile(a.at(-1),'fake jpg');return {output:''};}});assert.equal(await fs.readFile(output,'utf8'),'fake jpg');assert.deepEqual(await fs.readdir(dir),['preview.jpg']);
});
test('resource protection halts pending jobs; subtitles, folders and words survive',async t=>{
 const root=await folder(t);let starts=0;const b=await new Backend(root,{modelManager:models,enhanceExecutor:async()=>{starts++;throw safetyError('test safety stop');}}).init();b.db.settings.outputDirectory=root;b.db.episodes=[1,2].map(n=>({id:'e'+n,title:'Anime '+n,folderId:'folder',filePath:'/local/source.mp4',video:true,...source,cues:[{text:'Hello.',ru:'Привет.'}],ruCues:[],position:5}));const before=structuredClone(b.db.episodes);await b.enhance(['e1','e2']);await b.queue;assert.equal(starts,1);assert.equal(b.db.enhancements.find(j=>j.episodeId==='e1').state,'error');assert.equal(b.db.enhancements.find(j=>j.episodeId==='e1').safetyStopped,true);assert.equal(b.db.enhancements.find(j=>j.episodeId==='e2').state,'cancelled');assert.deepEqual(b.db.episodes,before);assert.equal(b.tasks.size,0);
});
test('backend processes one job at a time, preserves subtitle exports and cancels the entire queue',async t=>{
 const root=await folder(t);let active=0,peak=0;const b=await new Backend(root,{modelManager:models,enhanceExecutor:async o=>{active++;peak=Math.max(peak,active);await Promise.resolve();await fs.writeFile(o.output,'simulated');active--;return {engine:'cpu',width:640,height:360};}}).init();b.db.settings.outputDirectory=root;b.db.episodes=[1,2].map(n=>({id:'e'+n,title:'Anime '+n,filePath:'/local/source.mp4',video:true,...source,cues:[{start:0,end:1,text:'Hello.',ru:'Привет.'}],ruCues:[]}));await b.enhance(['e1','e2']);await b.queue;assert.equal(peak,1);assert.ok(b.db.enhancements.every(j=>j.state==='ready'));assert.match(await fs.readFile(b.db.enhancements[0].outputFile.slice(0,-4)+'.ru.vtt','utf8'),/Привет/);
 let release;const waiting=new Promise(r=>release=r);b.queue=waiting;await b.enhance(['e1','e2']);b.cancelEnhancements();release();await b.queue;assert.ok(b.db.enhancements.slice(0,2).every(j=>j.state==='cancelled'));assert.equal(b.tasks.size,0);
});
test('restart marks interrupted jobs without resuming and cleans only recorded work directories',async t=>{
 const root=await folder(t),work=path.join(root,'.lingo-cpu-abcdef'),keep=path.join(root,'keep');await fs.mkdir(work);await fs.writeFile(path.join(work,'partial'),'partial');await fs.mkdir(keep);await fs.writeFile(path.join(keep,'original'),'keep');await fs.writeFile(path.join(root,'library.json'),JSON.stringify({enhancements:[{id:'a',state:'working',engine:'anime4k',outputFile:path.join(root,'output.mkv'),workDirectory:work},{id:'b',state:'cancelling',outputFile:path.join(root,'another.mkv'),workDirectory:keep}]}));const b=await new Backend(root,{modelManager:models}).init();assert.ok(b.db.enhancements.every(j=>j.state==='interrupted'));assert.equal(b.tasks.size,0);await b.cleanupEnhancementWorkspaces();await assert.rejects(fs.access(work));assert.equal(await fs.readFile(path.join(keep,'original'),'utf8'),'keep');
});
