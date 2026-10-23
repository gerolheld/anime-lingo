'use strict';
// Real-ESRGAN (ncnn-vulkan) in short segments: extract frames -> upscale on the GPU -> encode a part -> repeat -> concatenate.
// Each segment runs under a watchdog (no-progress stall, per-segment limit, overall limit). Any GPU failure throws
// code GPU_FAILED and the caller repeats the whole job on the CPU. Nothing here runs unless the user enabled the GPU mode.
const fs=require('node:fs/promises');
const path=require('node:path');
const isolation=require('./isolation.cjs');
const tools=require('./tools.cjs');
const videoGpu=require('./video-gpu.cjs');
const {LIMITS,checkHeadroom,safetyError}=isolation;

const MODEL='realesr-animevideov3';
const LIMIT={segmentSeconds:4,stallMs:90000,segmentMs:420000,maxScale:4,maxFps:60,maxPixels:3840*2160};
const gpuFailure=(message,cause)=>Object.assign(Error(message),{code:'GPU_FAILED',cause});

function esrganPlan({source,scale,preview=false,start=0,seconds=3}){
  if(![2,3,4].includes(+scale))throw Error('Real-ESRGAN: масштаб 2×, 3× или 4×');
  if(!source||![source.width,source.height,source.duration].every(n=>Number.isFinite(n)&&n>0))throw Error('Неверные параметры исходного видео');
  const [a,b]=String(source.frameRate||'24/1').split('/').map(Number),fps=a/(b||1);
  if(!(fps>=1&&fps<=LIMIT.maxFps))throw Error('Real-ESRGAN: частота кадров от 1 до 60');
  const width=source.width*scale,height=source.height*scale;
  if(width*height>LIMIT.maxPixels)throw Error('Результат не должен превышать 3840×2160. Выберите меньший масштаб.');
  const duration=preview?Math.min(source.duration-start,Math.min(10,+seconds)):source.duration;
  if(duration<=0)throw Error('Начало пробы находится за концом серии');
  const frames=Math.round(duration*fps);
  // PNG frames of one segment live on disk twice (input and output).
  const segmentFrames=Math.max(1,Math.round(LIMIT.segmentSeconds*fps)),segmentBytes=segmentFrames*(width*height*3*.6+source.width*source.height*3*.6);
  return {width,height,duration,fps,frameRate:`${a}/${b||1}`,frames,segmentFrames,scale:+scale,requiredDisk:Math.ceil(segmentBytes*1.2+duration*8e6/8*1.5+(source.size||0)+LIMITS.minDisk)};
}
async function countFiles(dir){try{return (await fs.readdir(dir)).length;}catch{return 0;}}

async function enhanceEsrgan(options,{execute=isolation.watchdog().runLimited,headroom=checkHeadroom,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),poll=1000}={}){
  const {input,output,source,signal,onProgress=()=>{},esrgan,encoder='cpu',renderNode=null,maxMs=120*60000}=options;
  if(signal?.aborted)throw Error('Отменено');
  if(!esrgan?.binary)throw Error('Real-ESRGAN не установлен. Откройте «Модели» → «Видео» и скачайте его.');
  const plan=esrganPlan(options);await headroom(path.dirname(output),{requiredDisk:plan.requiredDisk});
  const work=await fs.mkdtemp(path.join(path.dirname(output),'.lingo-gpu-'));await fs.chmod(work,0o700).catch(()=>{});
  const started=now(),spec=encoder==='cpu'?videoGpu.CPU_ENCODER:videoGpu.encoderArgs(encoder,{node:renderNode});
  const ffmpeg=tools.ffmpeg(),ffprobe=tools.ffprobe(),parts=[];let done=0,frameStart=options.preview?+options.start||0:0;
  const run=(binary,args,extra={})=>execute(binary,args,{writeDirectory:work,signal,...extra});
  try{
    await options.onWorkspace?.(work);
    const probed=JSON.parse((await run(ffprobe,['-v','error','-threads','1','-show_format','-show_streams','-of','json',input],{stallMs:30000,runtime:60})).output);
    const v=probed.streams?.find(s=>s.codec_type==='video');
    if(!v||v.width!==source.width||v.height!==source.height)throw Error('Параметры исходного видео изменились. Добавь файл заново.');
    if(['smpte2084','arib-std-b67'].includes(v.color_transfer))throw Error('HDR не поддерживается. Исходный файл сохранён.');
    if(v.avg_frame_rate&&v.r_frame_rate&&v.avg_frame_rate!==v.r_frame_rate)throw Error('Real-ESRGAN поддерживает только постоянную частоту кадров. Используйте режим CPU.');
    onProgress({phase:'processing',engine:'gpu-esrgan',device:'GPU · Real-ESRGAN'+(encoder==='cpu'?' + CPU-кодирование':' + '+videoGpu.ENCODERS[encoder].label),done:0,total:plan.frames,progress:0,fps:0,eta:null});
    const end=frameStart+plan.duration;let t=frameStart,index=0;
    while(t<end-1e-6){
      if(signal?.aborted)throw Error('Отменено');
      if(now()-started>maxMs)throw gpuFailure('GPU-обработка превысила лимит времени и остановлена. Задача будет повторена на CPU.');
      const seg=Math.min(LIMIT.segmentSeconds,end-t),inDir=path.join(work,'in'),outDir=path.join(work,'out'),part=path.join(work,`part-${String(index).padStart(5,'0')}.mkv`);
      await fs.rm(inDir,{recursive:true,force:true});await fs.rm(outDir,{recursive:true,force:true});await fs.mkdir(inDir);await fs.mkdir(outDir);
      const frames=Math.round(seg*plan.fps);
      await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-hwaccel','none','-threads',String(LIMITS.threads),'-ss',String(t),'-i',input,'-t',String(seg),'-map','0:v:0','-an','-fps_mode','passthrough','-frames:v',String(frames),path.join(inDir,'%06d.png')],{stallMs:60000,runtime:300});
      const extracted=await countFiles(inDir);if(!extracted)throw Error('Не удалось извлечь кадры из видео');
      // GPU stage: watched by output growth and by the process's own output.
      let finished=false;const monitor=(async()=>{while(!finished){await sleep(poll);const n=await countFiles(outDir);onProgress({phase:'processing',done:done+Math.min(n,extracted),total:plan.frames,progress:Math.min(99,100*(done+Math.min(n,extracted))/plan.frames),eta:null});}})();
      try{
        await execute(esrgan.binary,['-i',inDir,'-o',outDir,'-m',esrgan.models,'-n',MODEL,'-s',String(plan.scale),'-f','png','-t','0'],{writeDirectory:work,signal,stallMs:LIMIT.stallMs,runtime:LIMIT.segmentMs/1000,memoryLimit:3*1024**3});
      }catch(error){
        if(signal?.aborted)throw Error('Отменено');
        if(error.code==='ENHANCE_SAFETY_STOP'&&/памяти|диске/.test(error.message))throw error; // resource stops are not retried
        throw gpuFailure('Видеокарта не справилась с обработкой ('+String(error.message).slice(-300)+'). Задача будет повторена на CPU.',error);
      }finally{finished=true;await monitor;}
      const upscaled=await countFiles(outDir);if(upscaled!==extracted)throw gpuFailure(`Real-ESRGAN вернул ${upscaled} из ${extracted} кадров. Задача будет повторена на CPU.`);
      await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...spec.pre,'-framerate',plan.frameRate,'-i',path.join(outDir,'%06d.png'),'-vf',spec.vf||'format=yuv420p','-c:v',spec.codec,...spec.quality,'-an',part],{stallMs:120000,runtime:600});
      parts.push(part);done+=extracted;t+=seg;index++;
      await fs.rm(inDir,{recursive:true,force:true});await fs.rm(outDir,{recursive:true,force:true});
      const elapsed=(now()-started)/1000;onProgress({phase:'processing',done,total:plan.frames,progress:Math.min(99,100*done/plan.frames),fps:done/Math.max(.001,elapsed),eta:done>0?Math.max(0,(plan.frames-done)*(elapsed/done)):null});
    }
    onProgress({phase:'encoding',eta:null});
    const list=path.join(work,'parts.txt');await fs.writeFile(list,parts.map(p=>`file '${path.basename(p).replace(/'/g,"'\\''")}'`).join('\n')+'\n');
    const subtitleOptions=[];if(!options.preview)probed.streams.filter(s=>s.codec_type==='subtitle').forEach((s,i)=>{if(['mov_text','text'].includes(s.codec_name))subtitleOptions.push('-c:s:'+i,'srt');});
    const merged=path.join(work,'video.mkv'),muxArgs=['-hide_banner','-loglevel','error','-nostdin','-n','-f','concat','-safe','0','-i',list,...(options.preview&&frameStart?['-ss',String(frameStart)]:[]),...(options.preview?['-t',String(plan.duration)]:[]),'-i',input,'-map','0:v:0','-map','1:a?',...(options.preview?[]:['-map','1:s?','-map','1:t?']),'-map_metadata','1','-map_chapters',options.preview?'-1':'1','-c','copy',...subtitleOptions,merged];
    await run(ffmpeg,muxArgs,{stallMs:120000,runtime:3600});
    if(signal?.aborted)throw Error('Отменено');
    const result=JSON.parse((await run(ffprobe,['-v','error','-threads','1','-show_format','-show_streams','-of','json',merged],{stallMs:30000,runtime:60})).output),video=result.streams.find(s=>s.codec_type==='video'),duration=+result.format?.duration;
    if(!video||video.width!==plan.width||video.height!==plan.height||!Number.isFinite(duration)||Math.abs(duration-plan.duration)>Math.max(3,plan.duration*.01))throw Error('Результат не прошёл проверку размера или длительности');
    for(const type of ['audio','subtitle','attachment']){const expected=options.preview&&type!=='audio'?0:probed.streams.filter(s=>s.codec_type===type).length;if(result.streams.filter(s=>s.codec_type===type).length!==expected)throw Error('Не все дорожки сохранены в результате');}
    await fs.link(merged,output);
    return {engine:'gpu-esrgan',profile:'esrgan',device:'GPU · Real-ESRGAN',encoder:encoder==='cpu'?'libx264':spec.codec,frames:done,width:plan.width,height:plan.height,seconds:(now()-started)/1000,preservedFrameTiming:true,neural:true,limits:LIMITS,model:MODEL};
  }finally{await fs.rm(work,{recursive:true,force:true});await options.onWorkspace?.(null);}
}
module.exports={esrganPlan,enhanceEsrgan,gpuFailure,LIMIT,MODEL};
