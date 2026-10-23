// Smoke test of the INSTALLED Windows app on a real Windows machine (GitHub runner). Reports, never fixes.
// Env: INSTALLED_EXE, REPO, OUT. Every step is independent: a failure is recorded and the run continues.
import {_electron as electron} from 'playwright';
import {mkdtemp,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const EXE=process.env.INSTALLED_EXE,REPO=process.env.REPO||'.',OUT=process.env.OUT||'smoke-out';
await mkdir(OUT,{recursive:true});
const results=[];
const step=async(name,fn,timeoutMs=300000)=>{
  const started=Date.now();let outcome;
  try{
    const detail=await Promise.race([fn(),new Promise((_,rej)=>setTimeout(()=>rej(Error('timed out after '+Math.round(timeoutMs/1000)+' s')),timeoutMs))]);
    outcome={name,ok:true,seconds:Math.round((Date.now()-started)/1000),detail:detail===undefined?'':typeof detail==='string'?detail:JSON.stringify(detail).slice(0,600)};
  }catch(error){outcome={name,ok:false,seconds:Math.round((Date.now()-started)/1000),error:String(error.stack||error).slice(0,900)};}
  results.push(outcome);console.log((outcome.ok?'PASS ':'FAIL ')+name+' ('+outcome.seconds+'s) '+(outcome.detail||outcome.error||''));
};
const data=await mkdtemp(join(tmpdir(),'lingo-data-')),runtime=await mkdtemp(join(tmpdir(),'lingo-runtime-')),library=await mkdtemp(join(tmpdir(),'lingo-library-'));
let app,page;
const main=(fn,arg)=>app.evaluate(fn,arg);
await step('launch the installed app',async()=>{
  app=await electron.launch({executablePath:EXE,args:[],env:{...process.env,ANIME_LINGO_TEST:'1',ANIME_LINGO_DATA:data,ANIME_LINGO_RUNTIME:runtime},timeout:90000});
  page=await app.firstWindow();page.on('pageerror',e=>results.push({name:'renderer error',ok:false,error:e.message.slice(0,300)}));
  await page.waitForSelector('#open-media',{timeout:60000});
  const info=await page.evaluate(()=>({title:document.title,lang:document.documentElement.lang,version:document.getElementById('app-version')?.textContent,dpr:devicePixelRatio,nav:navigator.language,w:innerWidth,h:innerHeight}));
  await page.screenshot({path:join(OUT,'01-first-window.png')});return info;
});
await step('window controls work (minimize, maximize, restore)',async()=>{
  const state=await main(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.minimize();const a=w.isMinimized();w.restore();w.maximize();const b=w.isMaximized();w.unmaximize();return {minimized:a,maximized:b,frameless:!w.isMenuBarVisible()};});
  if(!state.minimized||!state.maximized)throw Error(JSON.stringify(state));return state;
});
await step('wizard appears on first start and can be dismissed',async()=>{
  await page.waitForSelector('#wizard .wizard-card',{timeout:30000});await page.screenshot({path:join(OUT,'02-wizard.png')});
  const text=await page.locator('#wizard').innerText();await page.evaluate(async()=>{await call('settings',{firstRunDone:true});closeWizard();});return text.slice(0,200).replace(/\n/g,' | ');
});
await step('diagnostics: Windows GPU/CPU/RAM detection (WMI + registry + nvidia-smi)',async()=>{
  const d=await main(async()=>{const r=await global.__lingoTest.backend.diagnostics();return {platform:r.system.platform,gpus:r.system.gpu,cpu:r.system.cpu.name,threads:r.system.cpu.threads,ram:r.system.memory.total,disk:!!r.system.disk,items:r.items.map(i=>i.name+':'+i.ok)};});
  if(d.platform!=='win32')throw Error('platform '+d.platform);return d;
});
await step('components status shows the real situation',async()=>{
  const s=await main(()=>global.__lingoTest.backend.componentsStatus().then(s=>({engine:s.translatorEngine,env:s.recognitionEnv.ready,ffmpeg:s.ffmpeg.ready,runtime:s.runtime,caps:s.capabilities.translation.map(o=>o.id+':'+o.available)})));return s;
});
await step('install FFmpeg (download, SHA-256, system tar.exe extraction)',async()=>{
  const r=await main(async()=>{const b=global.__lingoTest.backend;await b.installComponent('ffmpeg');const t=require(require('path').join(process.resourcesPath,'app.asar','desktop','tools.cjs'));return {state:b.components.state.ffmpeg,status:t.status()};});
  if(r.state.state!=='ready'||!r.status.ready)throw Error(JSON.stringify(r));return r.status.ffmpeg;
},900000);
const clip=join(library,'Test Show','clip.mp4');await mkdir(join(library,'Test Show'),{recursive:true});await copyFile(resolve(REPO,'tests/clip.mp4'),clip);
let episodeId;
await step('import a video through the real ffprobe and play it in the window',async()=>{
  const e=await main(async(_,file)=>{const ep=await global.__lingoTest.backend.addFile(file);return {id:ep.id,duration:ep.duration,w:ep.width,h:ep.height,state:ep.state};},clip);episodeId=e.id;
  await page.evaluate(async id=>{await selectEpisode(id);},e.id);
  await page.waitForFunction(()=>{const v=document.getElementById('video');return v&&v.readyState>=2&&v.duration>0;},null,{timeout:60000});
  await page.evaluate(()=>{const v=document.getElementById('video');v.muted=true;return v.play();});await page.waitForTimeout(1500);
  const played=await page.evaluate(()=>document.getElementById('video').currentTime);await page.screenshot({path:join(OUT,'03-playing.png')});
  if(!(played>0.3))throw Error('video did not advance: '+played);return {...e,played};
});
await step('drag-and-drop style import of a folder (library folder scan with real files)',async()=>{
  const r=await main(async(_,dir)=>{const b=global.__lingoTest.backend;await b.configure({libraryRoot:dir});const scan=await b.scanLibrary();return {scan,folders:b.db.folders.map(f=>f.name+'/'+f.dirName),episodes:b.db.episodes.length};},library);
  if(!r.folders.length)throw Error(JSON.stringify(r));return r;
});
await step('"+ Folder" creates a real sub-folder on disk with a Windows-safe name',async()=>{
  const r=await main(async(_,dir)=>{const f=await global.__lingoTest.backend.saveFolder({name:'Re:Zero / Season 2?'});return {dirName:f.dirName,exists:require('fs').existsSync(require('path').join(dir,f.dirName))};},library);
  if(!r.exists||/[:?/]/.test(r.dirName))throw Error(JSON.stringify(r));return r;
});
await step('safe-mode CPU enhancement of the clip with the Windows watchdog (real ffmpeg)',async()=>{
  const r=await main(async(_,id)=>{const b=global.__lingoTest.backend;const jobs=await b.enhance([id],{engine:'cpu',preview:true,start:0,seconds:1});await b.queue;const j=b.enhancement(jobs[0].id);return {state:j.state,error:j.error,frames:j.result?.frames,encoder:j.result?.encoder,isolation:b.snapshot().enhancePolicy.isolation.mode};},episodeId);
  if(r.state!=='ready'||r.isolation!=='watchdog')throw Error(JSON.stringify(r));return r;
},600000);
await step('cancelling an enhancement stops the whole ffmpeg process tree',async()=>{
  const r=await main(async(_,id)=>{const b=global.__lingoTest.backend;const jobs=await b.enhance([id],{engine:'cpu',preview:false,scale:1});await new Promise(r=>setTimeout(r,2500));b.cancelEnhancements();await b.queue;await new Promise(r=>setTimeout(r,2500));const {execFileSync}=require('child_process');const list=execFileSync('tasklist',['/FI','IMAGENAME eq ffmpeg.exe','/NH']).toString();return {state:b.enhancement(jobs[0].id).state,running:/ffmpeg\.exe/i.test(list)};},episodeId);
  if(r.running)throw Error('ffmpeg.exe is still running after cancel: '+JSON.stringify(r));return r;
},300000);
await step('GPU video modes are locked by default and the encoder probe refuses to run',async()=>{
  const r=await main(async(_,id)=>{const b=global.__lingoTest.backend;let a='',c='';try{await b.enhance([id],{engine:'gpu-esrgan',scale:2});}catch(e){a=e.message;}try{await b.probeVideoEncoder('nvenc');}catch(e){c=e.message;}return {a,c};},episodeId);
  if(!/выключен/.test(r.a)||!/выключен/.test(r.c))throw Error(JSON.stringify(r));return r;
});
await step('language switch to Russian and back, theme change, no renderer crash',async()=>{
  await page.evaluate(()=>call('settings',{uiLanguage:'ru'}));await page.waitForFunction(()=>document.documentElement.lang==='ru',null,{timeout:20000});await page.waitForSelector('#open-media');
  const ru=await page.locator('.sidebar [data-page=library] span').innerText();await page.screenshot({path:join(OUT,'04-russian.png')});
  await page.evaluate(()=>call('settings',{uiLanguage:'en',themePreset:'red'}));await page.waitForFunction(()=>document.documentElement.lang==='en',null,{timeout:20000});await page.waitForSelector('#open-media');await page.waitForTimeout(500);
  const themed=await page.evaluate(()=>document.querySelector('link[data-themed]').media);await page.screenshot({path:join(OUT,'05-red-theme.png')});
  if(ru!=='Библиотека'||themed!=='all')throw Error(JSON.stringify({ru,themed}));return {ru,themed};
});
await step('recognition plan on this machine (no GPU): CPU device and a time estimate',async()=>{
  const r=await main(async(_,id)=>global.__lingoTest.backend.recognitionPlan(id),episodeId);return r;
});
await step('install the translation engine (llama.cpp CPU) and start it',async()=>{
  const r=await main(async()=>{const b=global.__lingoTest.backend;await b.installComponent('translator-engine');const st=await b.componentsStatus();const exe=await b.llama.binaryPath(await b.llama.resolveBackend());const {execFileSync}=require('child_process');const v=execFileSync(exe,['--version'],{timeout:60000}).toString()+'';return {engine:st.translatorEngine,version:v.split('\n')[0]};});
  if(!r.engine.installed)throw Error(JSON.stringify(r));return r;
},900000);
await step('download Hy-MT2 Q4_K_M (4.4 GB, SHA-256 verified) and translate with the embedded llama-server',async()=>{
  const r=await main(async()=>{const b=global.__lingoTest.backend;await b.configure({translationQuant:'Q4_K_M'});const dl=await b.installComponent('translator-model',{quant:'Q4_K_M'});if(dl.state!=='ready')throw Error('download: '+JSON.stringify(dl));
    let pid,out;await b.models.with('translation',async()=>{pid=b.llama.child.pid;out=await b.translateRaw('Nothing changes in this world.','');});
    await new Promise(r=>setTimeout(r,1500));const {execFileSync}=require('child_process');const alive=execFileSync('tasklist',['/FI','PID eq '+pid,'/NH']).toString().includes(String(pid));return {out,backend:b.llama.status(),pidStillAlive:alive};});
  if(!/[А-Яа-я]/.test(r.out)||r.pidStillAlive)throw Error(JSON.stringify(r));return r;
},2400000);
await step('create the Python environment (uv + managed Python 3.12 + PyTorch CPU + qwen-asr)',async()=>{
  const r=await main(async()=>{const b=global.__lingoTest.backend;const s=await b.installComponent('qwen-env',{torchBackend:'cpu'});const st=await b.componentsStatus();return {state:s,env:st.recognitionEnv};});
  if(!r.env.ready)throw Error(JSON.stringify(r));return r.env;
},2400000);
await step('the app closes cleanly and leaves no stray processes',async()=>{
  await app.close();await new Promise(r=>setTimeout(r,3000));
  const {execFileSync}=await import('node:child_process');const list=execFileSync('tasklist',['/NH']).toString();
  const strays=['llama-server.exe','ffmpeg.exe','Anime Lingo.exe'].filter(n=>list.toLowerCase().includes(n.toLowerCase()));
  if(strays.length)throw Error('still running: '+strays.join(', '));return 'clean';
},120000);
const failed=results.filter(r=>!r.ok);
await writeFile(join(OUT,'report.json'),JSON.stringify({results,failed:failed.length},null,2));
let md='| # | Check | Result | Time |\n|---|---|---|---|\n';results.forEach((r,i)=>{md+=`| ${i+1} | ${r.name} | ${r.ok?'PASS':'**FAIL**'} | ${r.seconds??''} s |\n`;});
await writeFile(join(OUT,'report.md'),md);console.log('\n'+md);
process.exit(0);
