'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const isolation=require('./isolation.cjs');
const {LIMITS,runLimited,checkHeadroom,safetyError}=isolation;
const tools=require('./tools.cjs');
const videoGpu=require('./video-gpu.cjs');
function cpuPlan({input,output,source,scale=1,profile='clarity',preview=false,start=0,seconds=3,subtitleCodecs=[],encoder=null,renderNode=null}){
  if(![1,2].includes(+scale))throw Error('В режиме CPU доступны исходный размер и 2×');
  if(!['clarity','clean'].includes(profile))throw Error('Неизвестный профиль улучшения');
  if(!source||![source.width,source.height,source.duration].every(n=>Number.isFinite(n)&&n>0)||!Number.isFinite(+start)||+start<0||!Number.isFinite(+seconds)||+seconds<=0)throw Error('Неверные параметры исходного видео');
  const width=Math.ceil(source.width*scale/2)*2,height=Math.ceil(source.height*scale/2)*2;
  if(width>3840||height>2160)throw Error('Безопасный режим ограничен разрешением 3840×2160. Выбери исходный размер.');
  const duration=preview?Math.min(source.duration-start,Math.min(10,+seconds)):source.duration;if(duration<=0)throw Error('Начало пробы находится за концом серии');
  const rate=width*height>1920*1080?28:16,filters=[];
  if(profile==='clean')filters.push('hqdn3d=1.0:0.75:1.5:1.1');
  if(width!==source.width||height!==source.height)filters.push(`scale=${width}:${height}:flags=lanczos`);
  const hw=encoder&&encoder!=='cpu'?videoGpu.encoderArgs(encoder,{node:renderNode}):null;
  filters.push('unsharp=5:5:0.35:3:3:0',hw?.vf||'format=yuv420p');
  const subtitleOptions=[];if(!preview)subtitleCodecs.forEach((codec,index)=>{if(['mov_text','text'].includes(codec))subtitleOptions.push('-c:s:'+index,'srt');});
  const args=['-hide_banner','-loglevel','error','-nostdin','-nostats','-n',...(hw?hw.pre:[]),'-hwaccel','none','-threads',String(LIMITS.threads),'-filter_threads','1','-filter_complex_threads','1','-protocol_whitelist','file,pipe',...(preview&&start?['-ss',String(start)]:[]),'-i',input,...(preview?['-t',String(duration)]:[]),'-map','0:v:0','-map','0:a?',...(!preview?['-map','0:s?','-map','0:t?']:[]),'-map_metadata','0','-map_chapters',preview?'-1':'0','-vf',filters.join(','),...(hw?['-c:v',hw.codec,...hw.quality,'-maxrate',rate+'M','-bufsize',rate*2+'M']:['-c:v','libx264','-threads',String(LIMITS.threads),'-preset','veryfast','-crf','19','-maxrate',rate+'M','-bufsize',rate*2+'M','-x264-params','ref=2:bframes=2:sync-lookahead=2:rc-lookahead=10']),'-fps_mode','passthrough','-c:a','copy','-c:s','copy','-c:t','copy',...subtitleOptions,'-progress','pipe:1',output];
  return {args,width,height,duration,scale:+scale,profile,encoder:hw?encoder:'cpu',requiredDisk:Math.ceil(duration*rate*1000000/8*1.15)+(source.size||0)+LIMITS.minDisk};
}
async function probe(file,writeDirectory,signal,execute){
  const result=await execute(tools.ffprobe(),['-v','error','-threads','1','-protocol_whitelist','file,pipe','-probesize','5000000','-analyzeduration','5000000','-show_format','-show_streams','-of','json',file],{writeDirectory,signal,stallMs:30000,runtime:45});return JSON.parse(result.output);
}
async function enhanceCPU(options,{execute=options.gpuEncoder?isolation.watchdog().runLimited:runLimited,headroom=checkHeadroom,now=Date.now}={}){
  const {input,output,source,signal,onProgress=()=>{}}=options;if(signal?.aborted)throw Error('Отменено');
  // Validate before creating a work directory or starting a subprocess.
  const plan=cpuPlan({...options,output:'pending.mkv'});await headroom(path.dirname(output),{requiredDisk:plan.requiredDisk});
  const work=await fs.mkdtemp(path.join(path.dirname(output),'.lingo-cpu-'));await fs.chmod(work,0o700).catch(()=>{});
  const partial=path.join(work,'video.mkv'),started=now(),rate=String(source.frameRate||'24/1').split('/').map(Number),fps=rate[0]/(rate[1]||1)||24;let done=0,position=0,buffer='',lastUpdate=0,points=[{time:now(),position:0}];
  try{
    await options.onWorkspace?.(work);
    const original=await probe(input,work,signal,execute),v=original.streams?.find(s=>s.codec_type==='video');
    if(!v||v.width!==source.width||v.height!==source.height)throw Error('Параметры исходного видео изменились. Добавь файл заново.');
    if(['smpte2084','arib-std-b67'].includes(v.color_transfer))throw Error('HDR пока не поддерживается бережным улучшением. Исходный файл сохранён.');
    onProgress({phase:'processing',engine:options.gpuEncoder?'gpu-encode':'cpu',device:options.gpuEncoder?'CPU + '+videoGpu.ENCODERS[options.encoder].label:'CPU',limits:LIMITS,done:0,total:null,progress:0,fps:0,eta:null});
    const command=cpuPlan({...options,output:partial,subtitleCodecs:original.streams.filter(s=>s.codec_type==='subtitle').map(s=>s.codec_name)});
    await execute(tools.ffmpeg(),command.args,{writeDirectory:work,signal,onStdout:(text,markProgress=()=>{})=>{
      buffer+=text;const lines=buffer.split('\n');buffer=lines.pop().slice(-8192);
      for(const line of lines){const m=line.match(/^(frame|out_time_us)=(\d+)/);if(!m)continue;const value=+m[2];if(m[1]==='frame'){if(value>done){done=value;markProgress();}}else if(value/1e6>position){position=value/1e6;markProgress();}}
      const current=now();points.push({time:current,position});while(points.length>2&&points[1].time<current-15000)points.shift();const elapsed=(current-points[0].time)/1000,speed=elapsed>0?(position-points[0].position)/elapsed:0;
      if(current-lastUpdate>=500){lastUpdate=current;onProgress({phase:'processing',done,processedSeconds:position,total:Math.round(plan.duration*fps),progress:Math.min(99,100*position/plan.duration),fps:(current-started)>0?done*1000/(current-started):0,eta:elapsed>=3&&position>=2&&speed>0?Math.max(0,(plan.duration-position)/speed):null});}
    }});
    if(signal?.aborted)throw Error('Отменено');if(!done)throw Error('Обработчик не подтвердил готовые кадры');onProgress({phase:'verifying',eta:null});
    const result=await probe(partial,work,signal,execute),video=result.streams.find(s=>s.codec_type==='video'),duration=+result.format?.duration;
    if(!video||video.width!==plan.width||video.height!==plan.height||!Number.isFinite(duration)||Math.abs(duration-plan.duration)>Math.max(3,plan.duration*.005))throw Error('Результат не прошёл проверку размера или длительности');
    for(const type of ['audio','subtitle','attachment']){const expected=options.preview&&type!=='audio'?0:original.streams.filter(s=>s.codec_type===type).length;if(result.streams.filter(s=>s.codec_type===type).length!==expected)throw Error('Не все дорожки сохранены в результате');}
    if(!options.preview&&/^\d+$/.test(v.nb_frames||'')&&+v.nb_frames!==done)throw Error('Число обработанных кадров не совпало с исходным');
    if(signal?.aborted)throw Error('Отменено');
    // Same filesystem; hard link commits without replacing an existing file.
    await fs.link(partial,output);
    return {engine:options.gpuEncoder?'gpu-encode':'cpu',profile:plan.profile,device:options.gpuEncoder?'CPU + '+videoGpu.ENCODERS[options.encoder].label:'CPU',encoder:plan.encoder==='cpu'?'libx264':videoGpu.ENCODERS[plan.encoder].codec,frames:done,width:plan.width,height:plan.height,seconds:(now()-started)/1000,preservedFrameTiming:true,neural:false,limits:LIMITS};
  }finally{await fs.rm(work,{recursive:true,force:true});await options.onWorkspace?.(null);}
}
async function thumbnailCPU(input,output,start,signal,{execute=runLimited}={}){
  const work=await fs.mkdtemp(path.join(path.dirname(output),'.lingo-thumb-'));
  try{const target=path.join(work,'frame.jpg');await execute(tools.ffmpeg(),['-hide_banner','-loglevel','error','-nostdin','-n','-hwaccel','none','-threads','1','-filter_threads','1','-protocol_whitelist','file,pipe','-ss',String(start),'-i',input,'-map','0:v:0','-frames:v','1','-vf','scale=960:540:force_original_aspect_ratio=decrease','-threads','1',target],{writeDirectory:work,signal,stallMs:30000,runtime:45});await fs.link(target,output);}finally{await fs.rm(work,{recursive:true,force:true});}
}
module.exports={cpuPlan,enhanceCPU,thumbnailCPU};
