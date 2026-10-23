'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const AL=require('../extension/core.js');
const {run}=require('./process.cjs');
const {writeAtomic,readJsonWithBackup,withTimeout,safeFileName}=require('./store.cjs');
const {ModelManager}=require('./models.cjs');
const {enhanceVideo}=require('./enhance.cjs');
const {cpuPlan,thumbnailCPU}=require('./enhance-cpu.cjs');
const isolation=require('./isolation.cjs');
const {LIMITS}=isolation;
const tools=require('./tools.cjs');
const paths=require('./paths.cjs');
const {installFfmpeg}=require('./components.cjs');
const {ComponentManager}=require('./component-manager.cjs');
const pyenv=require('./pyenv.cjs');
const plan=require('./recognition-plan.cjs');
const gpu=require('./gpu.cjs');
const videoGpu=require('./video-gpu.cjs');
const esrganTool=require('./esrgan.cjs');
const {enhanceEsrgan,esrganPlan}=require('./enhance-gpu.cjs');
const {LlamaServer,QUANT_ORDER}=require('./llama.cjs');
const Qwen=require('./qwen.cjs');
const {inspectSystem}=require('./system-info.cjs');
const {requestTranslation}=require('./translation.cjs');
const {decodeCover,folderView}=require('./folders.cjs');
const runtime=paths.runtimeRoot();
const MODEL_ID='hy-mt2';
const APP_VERSION=require('../package.json').version;
const VIDEO_GPU_DEFAULTS={enabled:false,acknowledged:false,allowIntelXe:false,encoder:'auto',maxMinutes:120,probes:{}};
const DEFAULTS={themePreset:'default',themeColor:'#ff6b6b',themeDepth:'normal',libraryRoot:'',uiLanguage:'auto',firstRunDone:false,videoGpu:VIDEO_GPU_DEFAULTS,endpoint:'',translationDevice:'auto',translationQuant:'auto',modelsDirectory:'',fontSize:36,ruSize:24,bottom:12,opacity:55,offset:0,pauseOnHover:true,readingMode:true,readingSize:5,readingHold:true,readingAutoPause:false,readingPauseDelay:0,subtitleStyle:'modern',chunkSeconds:12,gpu:true,
  qwenPython:paths.pythonIn(path.join(runtime,'qwen-env')),asrModel:path.join(runtime,'models/Qwen3-ASR-1.7B'),alignerModel:path.join(runtime,'models/Qwen3-ForcedAligner-0.6B'),qwenDevice:'auto',asrChunkSeconds:30,
  enhanceBinary:path.join(runtime,'realesrgan',paths.exe('anime-lingo-enhance')),enhanceModels:path.join(runtime,'realesrgan/models'),outputDirectory:paths.videosDirectory(),enhanceTile:0};
function stamp(t,comma=false){const ms=Math.max(0,Math.round(t*1000));return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}${comma?',':'.'}${String(ms%1000).padStart(3,'0')}`;}
function exportSubs(cues,{format='vtt',language='both'}={}){const text=c=>language==='en'?c.text:language==='ru'?(c.ru||''):[c.ru,c.text].filter(Boolean).join('\n');return (format==='vtt'?'WEBVTT\n\n':'')+cues.filter(c=>text(c)).map((c,i)=>`${format==='srt'?i+1+'\n':''}${stamp(c.start,format==='srt')} --> ${stamp(c.end,format==='srt')}\n${text(c)}\n`).join('\n');}
function parseWhisper(data,offset=0){const raw=(data.transcription||[]).map(s=>({start:offset+(s.offsets?.from??0)/1000,end:offset+(s.offsets?.to??0)/1000,text:AL.plain(s.text||''),ru:''})).filter(c=>c.text&&Number.isFinite(c.start)&&c.end>c.start&&!/^\s*\[(?:blank_audio|silence|music)\]\s*$/i.test(c.text));const cues=[];for(const cue of raw){const prev=cues.at(-1);if(prev&&!/[.!?…]["'”’)]?$/.test(prev.text)&&cue.start-prev.end<.8&&prev.text.length+cue.text.length<220){prev.text+=' '+cue.text;prev.end=cue.end;}else cues.push(cue);}return cues;}
function pcmWav(pcm,rate=16000){const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);}
const MEDIA_EXTENSIONS=/\.(mp4|mkv|webm|mov|m4v|avi|mp3|m4a|wav|flac|ogg)$/i,SUBTITLE_EXTENSIONS=/\.(srt|vtt)$/i;
// Windows paths are case-insensitive; the same file must not be added twice under different spellings.
const samePath=(a,b)=>process.platform==='win32'||process.platform==='darwin'?a.toLowerCase()===b.toLowerCase():a===b;
// Dropped folders are searched (3 levels deep, at most 200 files) for media and subtitles; everything else is counted, not imported.
async function expandPaths(inputs,{limit=200,depth=3}={}){
  const files=[],skipped=[];
  const visit=async(entry,level)=>{
    if(files.length>=limit)return;
    let stat;try{stat=await fs.stat(entry);}catch(error){skipped.push({name:path.basename(entry),error:'Файл недоступен: '+error.message});return;}
    if(stat.isDirectory()){
      if(level>depth)return;
      const names=(await fs.readdir(entry).catch(()=>[])).sort((x,y)=>x.localeCompare(y,undefined,{numeric:true}));
      for(const name of names)if(!name.startsWith('.'))await visit(path.join(entry,name),level+1);
    }else if(MEDIA_EXTENSIONS.test(entry)||SUBTITLE_EXTENSIONS.test(entry))files.push(entry);
    else if(level===0)skipped.push({name:path.basename(entry),error:'Неподдерживаемый тип файла. Поддерживаются видео, аудио, SRT и VTT.'});
  };
  for(const input of inputs)await visit(input,0);
  return {files,skipped};
}
// The compatible copy is tied to the source file (time and size), so an edited or replaced source is converted again.
const playbackName=(e,index)=>`${e.id}-${index}-${Math.abs(Math.round(e.modified||0)%1e9).toString(36)}-${(e.size||0).toString(36)}.mp4`;
const languageOf=name=>/(?:^|[. _-])(ru|rus|russian|рус)(?:[. _-]|$)/i.test(name)?'ru':/(?:^|[. _-])(en|eng|english)(?:[. _-]|$)/i.test(name)?'en':'unknown';
const textSubtitle=codec=>['subrip','srt','webvtt','ass','ssa','mov_text','text'].includes(codec);
class Backend extends EventEmitter {
  constructor(root,{dictionaryRoot=path.join(__dirname,'../extension/data'),manageModels=true,modelManager,enhanceExecutor=enhanceVideo,thumbnailExecutor=thumbnailCPU,gpuExecutor=enhanceEsrgan,gpuDetect=()=>gpu.detect(),encoderSupport=null,esrganLocate=()=>esrganTool.locate(),installer=installFfmpeg,llama,translationTimeout=120000}={}){super();this.installer=installer;this.gpuExecutor=gpuExecutor;this.gpuDetect=gpuDetect;this.encoderList=encoderSupport;this.esrganLocate=esrganLocate;this.translationTimeout=translationTimeout;this.enhanceExecutor=enhanceExecutor;this.thumbnailExecutor=thumbnailExecutor;this.root=root;this.dictionaryRoot=dictionaryRoot;this.queue=Promise.resolve();this.tasks=new Map();this.mediaTasks=new Map();this.live=new Map();this.translationCache=new Map();this.pendingTranslations=new Map();this.lastError='';this.shutdown=new AbortController();this.db={settings:{...DEFAULTS},episodes:[],folders:[],words:[],history:[],enhancements:[],ignored:[]};this.libraryScan={running:false,added:0,errors:[]};this.llama=llama||new LlamaServer({settings:()=>this.db.settings,capabilities:()=>gpu.detect()});this.models=modelManager||new ModelManager({settings:()=>this.db.settings,llama:this.llama,enabled:manageModels,onState:()=>this.notify()});this.components=new ComponentManager({settings:()=>this.db.settings,llama:this.llama,onChange:()=>this.notify(),busy:()=>this.tasks.size>0||this.models.state.phase!=='idle',deps:{installFfmpeg:installer}});}
  async init(){await fs.mkdir(this.root,{recursive:true,mode:0o700});await fs.chmod(this.root,0o700);try{const {data:d,source}=await readJsonWithBackup(path.join(this.root,'library.json'));if(d){this.db={...this.db,...d,settings:{...DEFAULTS,...d.settings,videoGpu:{...VIDEO_GPU_DEFAULTS,...d.settings?.videoGpu,probes:{...d.settings?.videoGpu?.probes}}}};if(source==='backup')this.lastError='library.json был повреждён, восстановлена предыдущая копия. Повреждённый файл сохранён рядом (library.json.damaged-*).';}}catch(e){throw Error('Не удалось прочитать библиотеку: '+e.message+'. Файл не изменён.');}if(this.db.settings.readingVersion!==1){this.db.settings.readingVersion=1;this.db.settings.readingMode=true;this.db.settings.readingSize=5;this.db.settings.readingHold=true;this.db.settings.readingAutoPause=false;this.db.settings.pauseOnHover=true;}if(path.basename(this.db.settings.enhanceBinary)==='realesrgan-ncnn-vulkan'){this.db.settings.enhanceBinary=path.join(path.dirname(this.db.settings.enhanceBinary),'anime-lingo-enhance');if(this.db.settings.enhanceTile===128)this.db.settings.enhanceTile=0;}// LM Studio is gone: the translator is an embedded llama-server on a random local port.
    if(this.db.settings.endpoint==='http://127.0.0.1:1234/v1')this.db.settings.endpoint='';delete this.db.settings.model;delete this.db.settings.modelKey;delete this.db.settings.whisperBinary;delete this.db.settings.whisperModel;for(const e of this.db.episodes)if(['extracting','recognizing','aligning','translating','queued'].includes(e.state)){e.state='interrupted';e.error='Обработка прервана. Можно запустить снова.';}for(const j of this.db.enhancements)if(['queued','working','encoding','cancelling'].includes(j.state)){j.state='interrupted';j.error='Улучшение прервано. Запустите повторно.';}await this.save();return this;}
  async save(){const snapshot=JSON.stringify(this.db,null,2);this.writeQueue=(this.writeQueue||Promise.resolve()).catch(()=>{}).then(async()=>{await writeAtomic(path.join(this.root,'library.json'),snapshot);});return this.writeQueue;}
  snapshot(){return {platform:process.platform,version_:APP_VERSION,enhancePolicy:{engine:'cpu',gpuBlocked:true,limits:LIMITS,isolation:{mode:isolation.mode,full:isolation.full,label:isolation.label},recoveryError:this.enhanceRecoveryError||''},settings:this.db.settings,folders:this.db.folders.map(folderView),episodes:this.db.episodes.map(e=>({...e,cues:undefined,ruCues:undefined,filePath:undefined,playbackPath:undefined,subtitleTracks:(e.subtitleTracks||[]).map(t=>({...t,file:undefined}))})),words:this.db.words,history:this.db.history.slice(0,1000),enhancements:this.db.enhancements.map(j=>({...j,outputFile:undefined,beforeImage:undefined,afterImage:undefined,workDirectory:undefined})),modelState:this.models.state,libraryScan:this.libraryScan,ignoredCount:(this.db.ignored||[]).length,components:this.components.state,tools:tools.status(),live:[...this.live].map(([id,s])=>({id,active:s.active,error:s.error,lag:s.lag||0,queued:s.pending||0,cues:s.cues?.length||0})),lastError:this.lastError};}
  notify(){this.emit('change',this.snapshot());}
  async configure(value){const resourceKeys=['endpoint','translationDevice','translationQuant','modelsDirectory','qwenPython','asrModel','alignerModel','qwenDevice','asrChunkSeconds','gpu','enhanceBinary','enhanceModels','enhanceTile'];if((this.tasks.size||this.models.state.phase!=='idle')&&resourceKeys.some(k=>value[k]!==undefined&&value[k]!==this.db.settings[k]))throw Error('Дождитесь завершения задач перед изменением моделей. Оформление субтитров можно менять сейчас.');const s={...this.db.settings};for(const k of ['endpoint','qwenPython','asrModel','alignerModel','qwenDevice','translationDevice','translationQuant','modelsDirectory','uiLanguage','themePreset','themeColor','themeDepth','enhanceBinary','enhanceModels','outputDirectory'])if(typeof value[k]==='string')s[k]=value[k].slice(0,2000);if(s.endpoint)AL.localEndpoint(s.endpoint);if(typeof value.modelsDirectory==='string'&&value.modelsDirectory!==this.db.settings.modelsDirectory){if(value.modelsDirectory&&!path.isAbsolute(value.modelsDirectory))throw Error('Укажите полный путь к папке моделей');const root=value.modelsDirectory||path.join(runtime,'models');s.asrModel=path.join(root,'Qwen3-ASR-1.7B');s.alignerModel=path.join(root,'Qwen3-ForcedAligner-0.6B');}if(value.enhanceTile!==undefined&&(!Number.isInteger(+value.enhanceTile)||(+value.enhanceTile!==0&&(+value.enhanceTile<32||+value.enhanceTile>2048))))throw Error('Размер плитки: 0 (авто) или от 32 до 2048');if(!['auto','ru','en'].includes(s.uiLanguage))throw Error('Неизвестный язык интерфейса');if(!['default','red','orange','gold','green','teal','violet','pink','graphite','custom'].includes(s.themePreset))throw Error('Неизвестная цветовая тема');if(!/^#[0-9a-fA-F]{6}$/.test(s.themeColor))throw Error('Цвет темы: формат #rrggbb');if(!['deep','normal','soft'].includes(s.themeDepth))throw Error('Неизвестная глубина фона');if(!['auto','cpu','xpu','cuda','rocm'].includes(s.qwenDevice))throw Error('Неизвестное устройство распознавания');if(!['auto','cpu','cuda','vulkan','sycl','hip'].includes(s.translationDevice))throw Error('Неизвестное устройство перевода');if(!['auto',...QUANT_ORDER].includes(s.translationQuant))throw Error('Неизвестная квантизация перевода');for(const [k,min,max] of [['fontSize',18,64],['ruSize',12,48],['bottom',2,40],['opacity',0,100],['offset',-600,600],['chunkSeconds',4,30],['asrChunkSeconds',15,60],['enhanceTile',0,2048],['readingPauseDelay',0,3]])if(value[k]!==undefined){if(!Number.isFinite(+value[k]))throw Error('Некорректная настройка '+k);s[k]=Math.max(min,Math.min(max,+value[k]));}if(value.readingSize!==undefined){if(![3,5,6].includes(+value.readingSize))throw Error('Размер короткой части: 3, 5 или 6 слов');s.readingSize=+value.readingSize;}if(value.subtitleStyle!==undefined){if(!['modern','classic'].includes(value.subtitleStyle))throw Error('Неизвестный стиль субтитров');s.subtitleStyle=value.subtitleStyle;}for(const k of ['gpu','pauseOnHover','readingMode','readingHold','readingAutoPause','firstRunDone'])if(value[k]!==undefined)s[k]=!!value[k];if(value.videoGpu!==undefined){const v=value.videoGpu||{},next={...this.db.settings.videoGpu};for(const k of ['enabled','acknowledged','allowIntelXe'])if(v[k]!==undefined)next[k]=!!v[k];if(v.encoder!==undefined){if(!['auto','cpu',...Object.keys(videoGpu.ENCODERS)].includes(v.encoder))throw Error('Неизвестный кодировщик');next.encoder=v.encoder;}if(v.maxMinutes!==undefined){if(!Number.isFinite(+v.maxMinutes))throw Error('Некорректный лимит времени');next.maxMinutes=Math.max(10,Math.min(600,Math.round(+v.maxMinutes)));}if(!next.enabled){next.acknowledged=false;next.allowIntelXe=false;}s.videoGpu=next;}if(typeof value.libraryRoot==='string'){const dir=value.libraryRoot.trim();if(dir){if(!path.isAbsolute(dir))throw Error('Укажите полный путь к папке библиотеки');let stat;try{stat=await fs.stat(dir);}catch{throw Error('Папка библиотеки не найдена: '+dir);}if(!stat.isDirectory())throw Error('Это не папка: '+dir);}s.libraryRoot=dir;}
    this.db.settings=s;this.translationCache.clear();await this.save();this.notify();return s;}
  async probe(file){const r=await run(tools.ffprobe(),['-v','error','-show_format','-show_streams','-of','json',file],{timeout:30000});const d=JSON.parse(r.output),v=d.streams.find(s=>s.codec_type==='video');return {duration:+d.format?.duration||0,audio:d.streams.filter(s=>s.codec_type==='audio').map(s=>({index:s.index,language:s.tags?.language||'und',title:s.tags?.title||s.codec_name,channels:s.channels})),subtitleTracks:d.streams.filter(s=>s.codec_type==='subtitle').map(s=>({id:'embedded:'+s.index,type:'embedded',index:s.index,language:s.tags?.language||'und',label:s.tags?.title||s.tags?.language||s.codec_name,text:textSubtitle(s.codec_name),codec:s.codec_name})),video:!!v,videoCodec:v?.codec_name||'',width:v?.width||0,height:v?.height||0,frameRate:v?.avg_frame_rate&&v.avg_frame_rate!=='0/0'?v.avg_frame_rate:v?.r_frame_rate||'24/1'};}
  episode(id){const e=this.db.episodes.find(e=>e.id===id);if(!e)throw Error('Серия не найдена');return e;}
  folder(id){const f=this.db.folders.find(f=>f.id===id);if(!f)throw Error('Папка не найдена');return f;}
  editLibrary(operation){const job=(this.folderQueue||Promise.resolve()).catch(()=>{}).then(operation);this.folderQueue=job;return job;}
  saveFolder(value){return this.editLibrary(async()=>{
    const existing=value.id?this.folder(value.id):null;
    if(typeof value.name!=='string')throw Error('Введи название аниме');
    const name=value.name.normalize('NFC').trim();
    if(!name||name.length>140||/[\x00-\x1f\x7f]/.test(name))throw Error('Название папки: от 1 до 140 символов');
    if(this.db.folders.some(f=>f.id!==existing?.id&&f.name.toLocaleLowerCase()===name.toLocaleLowerCase()))throw Error('Папка с таким названием уже есть');
    if(!existing&&this.db.folders.length>=500)throw Error('В библиотеке уже 500 папок');
    const cover=value.cover==null?null:decodeCover(value.cover),id=existing?.id||randomUUID();
    let coverFile=existing?.coverFile;
    if(cover){const dir=path.join(this.root,'covers');await fs.mkdir(dir,{recursive:true,mode:0o700});coverFile=randomUUID()+'.'+cover.extension;await fs.writeFile(path.join(dir,coverFile),cover.bytes,{mode:0o600,flag:'wx'});}
    else if(value.cover===null)coverFile=null;
    const dirName=existing?existing.dirName:(this.db.settings.libraryRoot?await this.ensureFolderDirectory(name):undefined);
    const next={...existing,id,name,created:existing?.created||Date.now(),updated:Date.now(),coverFile,...(dirName?{dirName}:{})},previous=this.db.folders;
    this.db.folders=existing?previous.map(f=>f.id===id?next:f):[...previous,next];
    try{await this.save();}catch(error){this.db.folders=previous;if(coverFile&&coverFile!==existing?.coverFile)await fs.rm(path.join(this.root,'covers',coverFile),{force:true}).catch(()=>{});throw error;}
    if(existing?.coverFile&&existing.coverFile!==coverFile)await fs.rm(path.join(this.root,'covers',existing.coverFile),{force:true}).catch(()=>{});
    this.notify();return folderView(next);
  });}
  moveEpisodes(ids,folderId=null){return this.editLibrary(async()=>{
    if(!Array.isArray(ids)||!ids.length||ids.length>200)throw Error('Выбери от 1 до 200 серий');
    if(folderId!==null)this.folder(folderId);
    const episodes=[...new Set(ids)].map(id=>this.episode(id)),previous=episodes.map(e=>e.folderId);
    for(const e of episodes)e.folderId=folderId;
    try{await this.save();}catch(error){episodes.forEach((e,i)=>e.folderId=previous[i]);throw error;}
    this.notify();return {ok:true,count:episodes.length};
  });}
  removeFolder(id){return this.editLibrary(async()=>{
    const folder=this.folder(id),previous=this.db.folders,episodes=this.db.episodes.filter(e=>e.folderId===id);
    if(folder.dirName&&this.db.settings.libraryRoot)this.hide(path.join(this.db.settings.libraryRoot,folder.dirName));
    this.db.folders=previous.filter(f=>f.id!==id);for(const e of episodes)e.folderId=null;
    try{await this.save();}catch(error){this.db.folders=previous;for(const e of episodes)e.folderId=id;throw error;}
    if(folder.coverFile)await fs.rm(path.join(this.root,'covers',folder.coverFile),{force:true}).catch(()=>{});
    this.notify();return {ok:true,count:episodes.length};
  });}
  // ---- library folder on disk ----
  // The library folder is a normal directory the user can fill with a file manager or a torrent client:
  // every sub-folder is an anime, every video inside is an episode. Nothing is ever deleted from disk, and
  // an episode or folder removed in the app is remembered in `ignored` so the next scan does not bring it back.
  insideLibraryRoot(file){const root=this.db.settings.libraryRoot;if(!root||!file)return false;const rel=path.relative(root,file);return !!rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);}
  hide(file){const list=(this.db.ignored||(this.db.ignored=[]));if(!list.some(p=>samePath(p,file)))list.push(file);}
  async ensureFolderDirectory(name){
    const root=this.db.settings.libraryRoot,base=safeFileName(name);let candidate=base,n=2;
    while(this.db.folders.some(f=>f.dirName&&f.dirName.toLowerCase()===candidate.toLowerCase()))candidate=`${base} (${n++})`;
    await fs.mkdir(path.join(root,candidate),{recursive:true});return candidate;
  }
  createFolderFromDisk(name,dirName){return this.editLibrary(async()=>{
    const clean=String(name).normalize('NFC').replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,140);
    const same=this.db.folders.find(f=>f.name.toLocaleLowerCase()===clean.toLocaleLowerCase());
    if(same){if(!same.dirName){same.dirName=dirName;await this.save();}return same;}
    if(this.db.folders.length>=500)return null;
    const folder={id:randomUUID(),name:clean,dirName,created:Date.now(),updated:Date.now(),coverFile:null};
    this.db.folders.push(folder);await this.save();return folder;
  });}
  scanLibrary({restore=false}={}){
    if(!this.db.settings.libraryRoot)return Promise.resolve({added:0,folders:0});
    if(this.scanTask)return this.scanTask;
    this.scanTask=this.runScan(restore).finally(()=>{this.scanTask=null;this.libraryScan={...this.libraryScan,running:false};this.notify();});
    return this.scanTask;
  }
  async runScan(restore){
    const root=this.db.settings.libraryRoot;
    if(restore){this.db.ignored=[];await this.save();}
    this.libraryScan={running:true,added:0,errors:[]};this.notify();
    let entries;
    try{entries=await fs.readdir(root,{withFileTypes:true});}
    catch(error){this.libraryScan={running:false,added:0,errors:['Папка библиотеки недоступна: '+error.message]};return {added:0,folders:0,error:error.message};}
    const hidden=file=>(this.db.ignored||[]).some(p=>samePath(p,file));
    const known=new Set(this.db.episodes.map(e=>process.platform==='win32'?e.filePath.toLowerCase():e.filePath));
    const isKnown=f=>known.has(process.platform==='win32'?f.toLowerCase():f);
    entries.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
    const batches=[];let folders=0;
    const rootMedia=[];
    for(const entry of entries){
      if(entry.name.startsWith('.'))continue;
      const full=path.join(root,entry.name);
      if(entry.isDirectory()){
        if(hidden(full))continue;
        const found=this.db.folders.find(f=>f.dirName&&f.dirName.toLowerCase()===entry.name.toLowerCase())||this.db.folders.find(f=>!f.dirName&&f.name.toLowerCase()===entry.name.toLowerCase());
        let folder=found;
        if(!folder){folder=await this.createFolderFromDisk(entry.name,entry.name);if(folder)folders++;}
        else if(!folder.dirName){folder.dirName=entry.name;await this.save();}
        const {files}=await expandPaths([full]);
        batches.push({folderId:folder?.id,files:files.filter(f=>!hidden(f)&&(SUBTITLE_EXTENSIONS.test(f)||!isKnown(f)))});
      }else if(MEDIA_EXTENSIONS.test(entry.name)&&!hidden(full)&&!isKnown(full))rootMedia.push(full);
    }
    if(rootMedia.length)batches.push({folderId:undefined,files:rootMedia});
    let added=0;
    for(const batch of batches){
      const media=batch.files.filter(f=>MEDIA_EXTENSIONS.test(f)&&!isKnown(f)),subs=batch.files.filter(f=>SUBTITLE_EXTENSIONS.test(f));
      for(let i=0;i<media.length;i+=40){
        const chunk=media.slice(i,i+40),stems=chunk.map(f=>path.basename(f,path.extname(f)).toLowerCase());
        const pair=subs.filter(s=>{const n=path.basename(s,path.extname(s)).toLowerCase();return stems.some(st=>n===st||n.startsWith(st+'.')||n.startsWith(st+' ')||n.startsWith(st+'_'));});
        try{
          const result=await this.addFiles([...chunk,...pair],undefined,batch.folderId);
          added+=result.episodes.length;this.libraryScan={...this.libraryScan,added,errors:[...this.libraryScan.errors,...result.errors.map(e=>e.name+': '+e.error)].slice(0,20)};this.notify();
        }catch(error){this.libraryScan={...this.libraryScan,errors:[...this.libraryScan.errors,error.message].slice(0,20)};}
      }
    }
    this.libraryScan={running:false,added,errors:this.libraryScan.errors};this.notify();
    return {added,folders};
  }
  coverPath(id){const file=this.folder(id).coverFile;return file&&path.basename(file)===file?path.join(this.root,'covers',file):null;}
  async sidecars(e){const dir=path.dirname(e.filePath),stem=path.basename(e.filePath,path.extname(e.filePath)).toLowerCase();const files=await fs.readdir(dir);return files.filter(name=>/\.(srt|vtt)$/i.test(name)).filter(name=>{const n=path.basename(name,path.extname(name)).toLowerCase();return n===stem||n.startsWith(stem+'.')||n.startsWith(stem+' ')||n.startsWith(stem+'_');}).map(name=>({id:'file:'+name,type:'file',file:path.join(dir,name),language:languageOf(name),label:name,text:true}));}
  async addFile(file){const stat=await fs.stat(file);if(!stat.isFile())throw Error('Выберите видео или аудиофайл');const existing=this.db.episodes.find(e=>samePath(e.filePath,file)&&e.size===stat.size&&e.modified===stat.mtimeMs);if(existing)return existing;const probe=await this.probe(file);if(!probe.audio.length&&!probe.video)throw Error('В файле нет видео или аудио');const e={id:randomUUID(),title:path.basename(file,path.extname(file)),filePath:file,size:stat.size,modified:stat.mtimeMs,...probe,audioIndex:probe.audio.find(a=>/^(en|eng)$/i.test(a.language))?.index??probe.audio[0]?.index,state:'new',progress:0,cues:[],ruCues:[],created:Date.now(),position:0};e.subtitleTracks.push(...await this.sidecars(e));this.db.episodes.unshift(e);const english=e.subtitleTracks.find(t=>t.text&&/^(en|eng|english)$/i.test(t.language));const russian=e.subtitleTracks.find(t=>t.text&&/^(ru|rus|russian)$/i.test(t.language));for(const [track,language] of [[english,'en'],[russian,'ru']])if(track){try{await this.selectSubtitles(e.id,track.id,language);}catch(err){e.subtitleWarning=err.message;}}if(!english){const unknown=e.subtitleTracks.find(t=>t.type==='file'&&t.language==='unknown');if(unknown){try{const text=await this.readSubtitleTrack(e,unknown);await this.attachSubtitles(e.id,text,'auto');}catch(err){e.subtitleWarning=err.message;}}}await this.save();this.notify();return e;}
  async addFiles(input,targetId,folderId){if(folderId!=null)this.folder(folderId);if(!Array.isArray(input)||input.length>200)throw Error('Выберите не больше 200 файлов');const expanded=await expandPaths(input),files=expanded.files;const episodes=[],errors=[...expanded.skipped];const media=files.filter(f=>! /\.(srt|vtt)$/i.test(f));for(const file of media){try{episodes.push(await this.addFile(file));}catch(e){errors.push({name:path.basename(file),error:e.message});}}if(!media.length&&targetId)episodes.push(this.episode(targetId));const subs=files.filter(f=>/\.(srt|vtt)$/i.test(f));for(const file of subs){const name=path.basename(file,path.extname(file)).toLowerCase();const e=episodes.find(e=>{const stem=path.basename(e.filePath,path.extname(e.filePath)).toLowerCase();return name===stem||name.startsWith(stem+'.')||name.startsWith(stem+' ')||name.startsWith(stem+'_');})||(episodes.length===1?episodes[0]:null);if(!e){errors.push({name:path.basename(file),error:'Не удалось сопоставить субтитры с серией. Импортируйте их в открытом плеере.'});continue;}try{await this.attachSubtitles(e.id,await this.readSubtitleFile(file),languageOf(file));}catch(err){errors.push({name:path.basename(file),error:err.message});}}if(folderId!=null&&episodes.length)await this.moveEpisodes(episodes.map(e=>e.id),folderId);return {episodes,errors};}
  async readSubtitleFile(file){const stat=await fs.stat(file);if(stat.size>AL.MAX_BYTES)throw Error('Максимум 4 МиБ для субтитров');const bytes=await fs.readFile(file);if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(bytes);if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be').decode(bytes);try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('windows-1251').decode(bytes);}}
  async readSubtitleTrack(e,track){if(!track.text)throw Error('Это графические субтитры. Импортируйте текстовый SRT/VTT.');if(track.type==='file')return this.readSubtitleFile(track.file);return (await run(tools.ffmpeg(),['-hide_banner','-loglevel','error','-nostdin','-i',e.filePath,'-map',`0:${track.index}`,'-f','srt','pipe:1'],{timeout:60000})).output;}
  async selectSubtitles(id,trackId,language='en'){const e=this.episode(id),track=e.subtitleTracks.find(t=>t.id===trackId);if(!track)throw Error('Дорожка субтитров не найдена');await this.attachSubtitles(id,await this.readSubtitleTrack(e,track),language);e[language==='ru'?'ruSource':'enSource']=track.label;await this.save();return e;}
  alignRussian(e){const timeline=new AL.Timeline(e.ruCues||[]);for(const c of e.cues)c.ru=timeline.active((c.start+c.end)/2).map(r=>r.text).join('\n');}
  async attachSubtitles(id,text,language='en'){const e=this.episode(id),parsed=AL.parseSubtitles(text);if(!parsed.length)throw Error('В файле нет реплик');if(language==='unknown'||language==='auto'){const all=parsed.slice(0,20).map(c=>c.text).join(' ');language=/[а-яё]/i.test(all)?(/[a-z]{2,}/i.test(all)?'both':'ru'):'en';}if(language==='ru'){e.ruCues=parsed.map(c=>({...c}));e.ruSource='Импорт SRT / VTT';this.alignRussian(e);}else if(language==='both'){e.cues=parsed.map(c=>({...c,text:c.text.split('\n').filter(l=>!/[а-яё]/i.test(l)).join('\n'),ru:c.text.split('\n').filter(l=>/[а-яё]/i.test(l)).join('\n')})).filter(c=>c.text);e.ruCues=e.cues.filter(c=>c.ru).map(c=>({start:c.start,end:c.end,text:c.ru}));e.enSource=e.ruSource='Двуязычный SRT / VTT';}else{e.cues=parsed.map(c=>({...c,ru:''}));e.enSource='Импорт SRT / VTT';this.alignRussian(e);}e.cueCount=e.cues.length;e.state=e.cues.length?(e.cues.every(c=>c.ru)?'ready':'recognized'):'new';e.progress=e.state==='ready'?100:55;await this.save();this.notify();return e;}
  async playback(id,audioIndex){const e=this.episode(id);const index=audioIndex===undefined?e.audioIndex:+audioIndex;if(e.audio.length&&!e.audio.some(a=>a.index===index))throw Error('Неизвестная аудиодорожка');if(e.audioIndex!==index&&(this.tasks.has(id)||this.live.get(id)?.active))throw Error('Остановите обработку перед сменой аудиодорожки');if(e.audioIndex!==index&&/^(Whisper|Qwen3)/.test(e.enSource||'')){e.cues=[];e.ruCues=[];e.cueCount=0;e.state='new';}e.audioIndex=index;const compatible=!e.video||(['h264','vp8','vp9','av1'].includes(e.videoCodec)&&['.mp4','.m4v','.webm'].includes(path.extname(e.filePath).toLowerCase()));if(e.audio.length<=1&&compatible){e.playbackPath=null;await this.save();return {ok:true};}const dir=path.join(this.root,'media');await fs.mkdir(dir,{recursive:true});const output=path.join(dir,playbackName(e,index));try{await fs.access(output);}catch{const abort=new AbortController();if(this.mediaTasks.has(id))throw Error('Видео уже подготавливается');this.mediaTasks.set(id,abort);try{await run(tools.ffmpeg(),['-hide_banner','-loglevel','error','-nostdin','-y','-i',e.filePath,'-map','0:v:0?',...(e.audio.length?['-map',`0:${index}`]:[]),'-sn','-c:v',e.videoCodec==='h264'?'copy':'libx264',...(e.videoCodec==='h264'?[]:['-preset','veryfast','-crf','21']),'-c:a','aac','-b:a','160k','-movflags','+faststart',output+'.part.mp4'],{signal:abort.signal});await fs.rename(output+'.part.mp4',output);}finally{this.mediaTasks.delete(id);await fs.rm(output+'.part.mp4',{force:true});}}e.playbackPath=output;await this.save();return {ok:true};}
  translationKey(text,context){return JSON.stringify([MODEL_ID,this.db.settings.translationQuant,text,context]);}
  async translateRaw(text,context='',signal){if(typeof text!=='string'||!text.trim()||text.length>12000)throw Error('Некорректный текст');const s=this.db.settings,key=this.translationKey(text,context);if(this.translationCache.has(key))return this.translationCache.get(key);const prompt=(context?'[Background Information]\n'+context.slice(-5000)+'\nPlease translate the following text into Russian, taking the provided background information into consideration. Only translate [Source Text], without repeating or translating the background.\n[Source Text]\n':'Translate the following text into Russian. Note that you should only output the translated result without any additional explanation:\n')+text;if(!this.models.target()&&!this.models.canRecover())throw Error('Движок перевода не запущен');const value=await requestTranslation({target:()=>{const t=this.models.target();if(t)AL.localEndpoint(t.endpoint);return t;},model:MODEL_ID,timeout:this.translationTimeout,prompt,maxTokens:Math.min(2000,Math.max(250,text.length)),signal,recover:signal=>this.models.recoverTranslation(signal)});this.translationCache.set(key,value);if(this.translationCache.size>2000)this.translationCache.delete(this.translationCache.keys().next().value);return value;}
  translate(text,context='',signal){signal=signal?AbortSignal.any([signal,this.shutdown.signal]):this.shutdown.signal;const key=this.translationKey(text,context);if(this.translationCache.has(key))return Promise.resolve(this.translationCache.get(key));if(this.pendingTranslations.has(key))return this.pendingTranslations.get(key);if(this.pendingTranslations.size>=4)return Promise.reject(Error('Переводчик занят. Доступен локальный словарь.'));const request=this.models.with('translation',()=>this.translateRaw(text,context,signal),signal).finally(()=>this.pendingTranslations.delete(key));this.pendingTranslations.set(key,request);return request;}
  async lookup(word,context){this.dict??=Promise.all([0,1,2,3].map(i=>fs.readFile(path.join(this.dictionaryRoot,`eng-ru-${i}.json`),'utf8').then(JSON.parse))).then(parts=>Object.assign({},...parts));return AL.lookup(await this.dict,word,context);}
  async wordMeaning(word,context){const quick=await this.lookup(word,context);try{const translated=await this.translate(word,`The word to translate occurs in this sentence: ${context}\nTranslate only that word in this meaning, as a short Russian gloss, not the whole sentence.`);if(translated.length>250)throw Error('Ответ модели слишком длинный для перевода слова');return {...quick,wordTranslation:translated,source:'Hy-MT2 · перевод в контексте',contextual:true};}catch(e){return {...quick,unavailable:e.message};}}
  async saveWord(v){
    const kind=v.kind==='phrase'?'phrase':'word',limit=kind==='phrase'?2000:150;
    if(typeof v.word!=='string'||!v.word.trim()||v.word.length>limit||typeof v.context!=='string'||v.context.length>12000)throw Error('Некорректное слово или фраза');
    let w=this.db.words.find(w=>w.word.toLowerCase()===v.word.toLowerCase()&&w.context===v.context);
    if(!w){if(this.db.words.length>=5000)throw Error('В словаре уже 5000 записей');w={id:randomUUID(),word:v.word,context:v.context,created:Date.now(),learned:false,favorite:false,kind};this.db.words.unshift(w);}
    w.translation=String(v.translation||'').slice(0,2000);
    const episode=this.db.episodes.find(e=>e.id===v.episodeId);
    if(episode){w.episodeId=episode.id;w.title=episode.title;if(Number.isFinite(v.position))w.position=Math.max(0,Math.min(episode.duration,v.position));}
    if(typeof v.ruContext==='string')w.ruContext=v.ruContext.slice(0,12000);
    if(typeof v.phonetic==='string')w.phonetic=v.phonetic.slice(0,200);
    this.db.history.unshift({id:randomUUID(),kind,word:w.word,context:w.context,translation:w.translation,episodeId:w.episodeId,title:w.title,position:w.position,date:Date.now()});this.db.history=this.db.history.slice(0,1000);
    await this.save();this.notify();return w;
  }
  async updateWord(id,action,value){
    const w=this.db.words.find(w=>w.id===id);if(!w)throw Error('Слово не найдено');
    if(action==='delete')this.db.words=this.db.words.filter(w=>w.id!==id);
    else if(action==='favorite')w.favorite=!w.favorite;
    else if(action==='level'){if(value!==''&&!['A1','A2','B1','B2','C1','C2'].includes(value))throw Error('Неверный уровень');w.level=value;}
    else if(action==='learned'||action===undefined){w.learned=!w.learned;w.learnedAt=w.learned?Date.now():null;}
    else throw Error('Неизвестное действие со словом');
    await this.save();this.notify();return w;
  }
  async recognize(wav,dir,signal,offset=0,onProgress){return Qwen.recognize({settings:this.db.settings,wav,directory:dir,models:this.models,signal,offset,onProgress});}
  recognitionKey(e){const s=this.db.settings;return JSON.stringify(['qwen3-pipeline-1',e.filePath,e.size,e.modified,e.audioIndex,s.asrModel,s.alignerModel,s.asrChunkSeconds]);}
  async prepare(id,{audioIndex,translateOnly=false}={}){
    const e=this.episode(id);
    if(this.tasks.has(id))throw Error('Серия уже обрабатывается');
    if(audioIndex!==undefined&&!e.audio.some(a=>a.index===+audioIndex))throw Error('Неизвестная аудиодорожка');
    if(audioIndex!==undefined&&e.audioIndex!==+audioIndex){e.audioIndex=+audioIndex;if(/^(Whisper|Qwen3)/.test(e.enSource||'')){e.cues=[];e.ruCues=[];e.cueCount=0;e.state='new';}}
    const key=this.recognitionKey(e);
    if(['partial','interrupted','cancelled','error'].includes(e.state)&&e.pipeline==='qwen3'&&e.recognitionKey===key&&e.cues.length)translateOnly=true;
    if(translateOnly&&!e.cues.length)throw Error('Сначала импортируйте или создайте английские субтитры');
    if(!translateOnly&&!e.audio.length)throw Error('В файле нет звука');
    if(!translateOnly&&e.duration>21600)throw Error('Распознавание поддерживает файлы длительностью до 6 часов. Разделите длинный файл.');
    const abort=new AbortController(),previousError=e.error;
    this.tasks.set(id,abort);e.state='queued';e.error='';await this.save();this.notify();
    const task=async()=>{
      let dir;
      try{
        if(abort.signal.aborted)throw Error('Отменено');
        if(!translateOnly){
          dir=path.join(this.root,'jobs',e.id);
          let oldKey;try{oldKey=JSON.parse(await fs.readFile(path.join(dir,'source.json'),'utf8')).key;}catch{}
          if(oldKey!==key)await fs.rm(dir,{recursive:true,force:true});
          await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.writeFile(path.join(dir,'source.json'),JSON.stringify({key}),{mode:0o600});
          const wav=path.join(dir,'audio.wav');
          try{await fs.access(wav);}catch{
            e.state='extracting';e.progress=3;this.notify();
            try{await run(tools.ffmpeg(),['-hide_banner','-loglevel','error','-nostdin','-y','-i',e.filePath,'-map',`0:${e.audioIndex}`,'-vn','-t','21600','-af','aresample=16000:async=1:first_pts=0','-ar','16000','-ac','1','-c:a','pcm_s16le',path.join(dir,'audio.part.wav')],{signal:abort.signal});await fs.rename(path.join(dir,'audio.part.wav'),wav);}finally{await fs.rm(path.join(dir,'audio.part.wav'),{force:true});}
          }
          e.state='recognizing';e.progress=10;this.notify();const recognitionStarted=Date.now();
          const cues=await this.recognize(wav,dir,abort.signal,0,data=>{
            if(data.event==='progress'){e.state=data.stage==='align'?'aligning':'recognizing';e.progress=(data.stage==='align'?45:10)+(data.percent||0)*(data.stage==='align'?.15:.35);}
            if(data.event==='device')e.computeDevice=data.name||data.device;
            this.notify();
          });
          if((e.computeDevice||'').toLowerCase()==='cpu'&&e.duration>60){const factor=(Date.now()-recognitionStarted)/1000/e.duration;this.db.settings.cpuRecognitionFactor=plan.updateFactor(this.db.settings.cpuRecognitionFactor,factor);}
          e.cues=cues;e.ruCues=[];e.enSource='Qwen3-ASR-1.7B · английская озвучка';e.wordTimeSource='Qwen3-ForcedAligner-0.6B';e.ruSource='Hy-MT2';e.pipeline='qwen3';e.recognitionKey=key;e.cueCount=cues.length;
          await this.save();await fs.rm(dir,{recursive:true,force:true});dir=null;
        }
        e.state='translating';this.notify();
        if(e.cues.some(c=>!c.ru))await this.models.with('translation',async()=>{
          for(let i=0;i<e.cues.length;i++){
            if(abort.signal.aborted)throw Error('Отменено');
            const c=e.cues[i],context=e.cues.slice(Math.max(0,i-2),i+3).filter(x=>x!==c).map(x=>x.text).join('\n');
            if(!c.ru)c.ru=await this.translateRaw(c.text,context,abort.signal);
            e.progress=60+40*(i+1)/e.cues.length;
            if(i%4===0)await this.save();this.notify();
          }
        },abort.signal);
        e.state='ready';e.progress=100;e.finished=Date.now();if(this.lastError===previousError)this.lastError='';
      }catch(err){e.state=abort.signal.aborted?'cancelled':e.cues?.length?'partial':'error';e.error=err.message;this.lastError=err.message;}
      finally{this.tasks.delete(id);await this.save();this.notify();}
    };
    this.queue=this.queue.catch(()=>{}).then(task);return {ok:true};
  }
  cancel(id){this.tasks.get(id)?.abort();this.mediaTasks.get(id)?.abort();const j=this.db.enhancements.find(j=>j.id===id);if(j&&['queued','working'].includes(j.state)){j.state=j.state==='queued'?'cancelled':'cancelling';j.error='Отменено пользователем';this.save().catch(e=>this.lastError=e.message);this.notify();}}
  async remove(id){const queued=this.episode(id).state==='queued';this.cancel(id);if(!queued)for(let waited=0;(this.tasks.has(id)||this.mediaTasks.has(id))&&waited<20000;waited+=50)await new Promise(r=>setTimeout(r,50));if(!queued&&(this.tasks.has(id)||this.mediaTasks.has(id)))throw Error('Обработка не остановилась за 20 секунд. Повторите удаление позже.');if(this.db.enhancements.some(j=>j.episodeId===id&&['queued','working','cancelling'].includes(j.state)))throw Error('Сначала отмените улучшение этой серии');this.stopLive(id);{const gone=this.db.episodes.find(e=>e.id===id);if(gone&&this.insideLibraryRoot(gone.filePath))this.hide(gone.filePath);}await fs.rm(path.join(this.root,'jobs',id),{recursive:true,force:true});const dir=path.join(this.root,'media');for(const n of await fs.readdir(dir).catch(()=>[]))if(n.startsWith(id+'-'))await fs.rm(path.join(dir,n),{force:true});this.db.episodes=this.db.episodes.filter(e=>e.id!==id);await this.save();this.notify();}
  // Downloads and installs run outside the model queue; a failure is reported in the component state and lastError.
  async installComponent(name,options={}){
    try{return await this.components.install(name,options);}
    catch(error){if(error.code==='BUSY'||error.code==='UNKNOWN')throw error;this.lastError=error.message;return this.components.state[name]||{state:'error',error:error.message};}
  }
  pauseComponent(name){return this.components.pause(name);}
  removeComponent(name,options){return this.components.remove(name,options);}
  componentsStatus(){return this.components.status();}
  // Shown before a run: which device will be used and, for the CPU, how long it may take.
  async recognitionPlan(id,audioIndex){
    const e=this.episode(id),s=this.db.settings;
    const resumable=['partial','interrupted','cancelled','error'].includes(e.state)&&e.pipeline==='qwen3'&&e.recognitionKey===this.recognitionKey(e)&&e.cues.length;
    if(resumable)return {recognition:false};
    const env=await pyenv.inspectEnvironment({python:s.qwenPython}),chosen=plan.planDevice({settings:s,caps:await gpu.detect(),env});
    if(chosen.problem)return {recognition:true,problem:chosen.problem};
    const result={recognition:true,device:chosen.device,reason:chosen.reason,name:chosen.name,build:chosen.build};
    if(chosen.device==='cpu'){
      const seconds=Math.max(1,e.duration||0),estimate=plan.estimateCpu({seconds,factor:s.cpuRecognitionFactor,threads:os.cpus().length});
      Object.assign(result,{estimate,estimateText:plan.formatDuration(estimate.minSeconds)+' — '+plan.formatDuration(estimate.maxSeconds)});
    }
    return result;
  }
  // A plain-text report for bug reports. Personal paths are shortened; no library content, subtitles or words are included.
  async errorReport(message=''){
    const s=this.db.settings,caps=await this.gpuDetect().catch(()=>null),home=os.homedir();
    const clean=text=>String(text??'').split(home).join('~').replace(/\\Users\\[^\\]+/g,'\\Users\\<user>');
    const env=await pyenv.inspectEnvironment({python:s.qwenPython}).catch(()=>({}));
    const lines=[
      `Anime Lingo ${APP_VERSION} · ${process.platform} ${os.release()} ${os.arch()}`,
      `Electron ${process.versions.electron||'—'} · Node ${process.versions.node}`,
      '',`Сообщение: ${clean(message)}`,`Последняя ошибка: ${clean(this.lastError||'—')}`,'',
      `Видеокарты: ${(caps?.gpus||[]).map(g=>`${g.name}${g.vramTotal?' '+Math.round(g.vramTotal/1024**3)+' ГБ':''}${g.driver?' драйвер '+g.driver:''}`).join('; ')||'не найдены'}`,
      `Устройства: распознавание=${s.qwenDevice}, перевод=${s.translationDevice}, квантизация=${s.translationQuant}, GPU вкл=${s.gpu}`,
      `Видео GPU: включено=${!!s.videoGpu?.enabled}, подтверждено=${!!s.videoGpu?.acknowledged}`,
      `Окружение Python: ${env.exists?`PyTorch ${env.torchVersion||'?'} (${env.torchBackend||'?'}), qwen-asr=${env.qwenAsr}`:'не установлено'}`,
      `FFmpeg: ${clean(tools.status().ffmpeg||'не найден')} (${tools.status().source||'—'})`,
      `Защита обработки: ${isolation.mode}`,
      `Состояние моделей: ${this.models.state.phase} · ${this.models.state.label}`,
      `Переводчик: ${JSON.stringify(this.llama.status()).slice(0,600)}`,
      `Компоненты: ${clean(JSON.stringify(this.components.state)).slice(0,1200)}`,
      '','Хвост журнала llama-server:',clean((this.llama.tail||'').slice(-1500))||'—',
    ];
    return lines.join('\n');
  }
  hintPosition(id,seconds){const e=this.db.episodes.find(e=>e.id===id);if(e&&Number.isFinite(+seconds))e.position=Math.max(0,Math.min(e.duration||Infinity,+seconds));}
  async position(id,seconds){const e=this.episode(id);e.position=Math.max(0,Math.min(e.duration||Infinity,+seconds||0));e.lastWatched=Date.now();await this.save();}
  async ensureModel(){await this.models.with('translation',async()=>{await this.translateRaw('Hello.');});return this.diagnostics();}
  async diagnostics(){return inspectSystem({root:this.root,settings:this.db.settings,modelState:this.models.state,lastError:this.lastError});}
  // ---- GPU video modes (explicit opt-in, see video-gpu.cjs) ----
  async supportedEncoders(){
    if(!this.encoderList){try{this.encoderList=videoGpu.parseEncoders((await run(tools.ffmpeg(),['-hide_banner','-encoders'],{timeout:15000})).output);}catch{this.encoderList=new Set();}}
    return this.encoderList;
  }
  async videoGpuStatus(){
    const caps=await this.gpuDetect(),s=this.db.settings,cands=videoGpu.candidates({gpus:caps.gpus,platform:process.platform,supported:await this.supportedEncoders()});
    const esrgan=await this.esrganLocate();
    return {settings:s.videoGpu,gate:videoGpu.gate({settings:s,gpus:caps.gpus}),encoders:cands.map(c=>({...c,probe:s.videoGpu.probes[c.id]||null})),esrgan:esrgan?{installed:true,source:esrgan.source,verified:esrgan.verified}:{installed:false},gpus:caps.gpus};
  }
  // A real one-second test encode. It uses the GPU, so it only runs on an explicit request while the mode is enabled and confirmed.
  async probeVideoEncoder(id){
    const caps=await this.gpuDetect(),gate=videoGpu.gate({settings:this.db.settings,gpus:caps.gpus});
    if(!gate.allowed)throw Error(gate.reason);
    if(this.tasks.size||this.models.state.phase!=='idle')throw Error('Дождитесь завершения задач перед проверкой кодировщика.');
    const cand=videoGpu.candidates({gpus:caps.gpus,supported:await this.supportedEncoders()}).find(c=>c.id===id);
    if(!cand)throw Error('Кодировщик '+id+' не подходит этой видеокарте или ОС.');if(!cand.available)throw Error(cand.reason);
    const result=await this.models.with('enhancement',()=>videoGpu.probeEncoder({id,ffmpeg:tools.ffmpeg(),execute:run}),this.shutdown.signal);
    this.db.settings.videoGpu.probes[id]={...result,ffmpeg:tools.status().ffmpeg};await this.save();this.notify();return this.db.settings.videoGpu.probes[id];
  }
  async resolveGpuEngine(engine){
    const caps=await this.gpuDetect(),s=this.db.settings,gate=videoGpu.gate({settings:s,gpus:caps.gpus});
    if(!gate.allowed)throw Error(gate.reason);
    const cands=videoGpu.candidates({gpus:caps.gpus,platform:process.platform,supported:await this.supportedEncoders()});
    const encoder=videoGpu.chooseEncoder({choice:s.videoGpu.encoder,probes:s.videoGpu.probes,cands});
    const node=videoGpu.renderNode();
    if(engine==='gpu-encode'){if(encoder==='cpu')throw Error('Нет проверенного аппаратного кодировщика. Откройте «Модели» → «Видео» и нажмите «Проверить».');return {encoder,node};}
    const esrgan=await this.esrganLocate();if(!esrgan)throw Error('Real-ESRGAN не установлен. Откройте «Модели» → «Видео» и скачайте его.');
    return {encoder,node,esrgan};
  }
  async enhance(ids,{scale=1,preview=false,start=0,seconds=3,engine='cpu',profile='clarity'}={}){
    if(!['cpu','gpu-encode','gpu-esrgan'].includes(engine))throw Error('Режим «'+engine+'» не поддерживается: прежнее GPU-улучшение (Anime4K, встроенный Real-ESRGAN) отключено после зависаний Intel Xe — GPU-улучшение отключено в старом виде. Новые режимы gpu-encode и gpu-esrgan включаются отдельно в «Модели» → «Видео».');
    if(this.enhanceRecoveryError)throw Error('Не удалось остановить прежнюю обработку. Закрой приложение и проверь запущенные процессы улучшения: '+this.enhanceRecoveryError);
    if(!Array.isArray(ids)||!ids.length||ids.length>100)throw Error('Выберите от 1 до 100 серий');
    if(!Number.isFinite(+start)||+start<0||!Number.isFinite(+seconds)||+seconds<1||+seconds>10)throw Error('Проба: начало от 0 секунд, длительность от 1 до 10 секунд');
    const sources=[...new Set(ids)].map(id=>this.episode(id));
    const gpuSetup=engine==='cpu'?null:await this.resolveGpuEngine(engine);
    for(const e of sources){
      if(!e.video||!e.filePath)throw Error('Выбери видеофайл');
      if(engine==='gpu-esrgan')esrganPlan({source:e,scale:+scale,preview:!!preview,start:+start,seconds:+seconds});
      else cpuPlan({input:e.filePath,output:'pending.mkv',source:e,scale:+scale,profile,preview:!!preview,start:+start,seconds:+seconds,encoder:gpuSetup?.encoder,renderNode:gpuSetup?.node});
    }
    const jobs=[];
    for(const e of sources){
      const job={id:randomUUID(),episodeId:e.id,title:e.title,engine,profile:engine==='gpu-esrgan'?'esrgan':profile,scale:+scale,preview:!!preview,start:preview?+start:0,seconds:+seconds,state:'queued',progress:0,created:Date.now(),limits:LIMITS,encoder:gpuSetup?.encoder},abort=new AbortController();
      this.db.enhancements.unshift(job);this.tasks.set(job.id,abort);jobs.push(job);
      const task=async()=>{
        try{
          if(abort.signal.aborted)throw Error('Отменено');
          const dir=job.preview?path.join(this.root,'previews'):this.db.settings.outputDirectory;await fs.mkdir(dir,{recursive:true});
          const safe=e.title.replace(/[\\/\x00-\x1f<>:"|?*]/g,'_').slice(0,120)||'episode';
          const common=()=>({input:e.filePath,output:job.outputFile,scale:job.scale,source:e,signal:abort.signal,onWorkspace:async directory=>{job.workDirectory=directory;await this.save();},preview:job.preview,start:job.start,seconds:job.seconds,onProgress:p=>{Object.assign(job,p);this.notify();}});
          const nameFor=name=>path.join(dir,`${safe}.${name}-${job.scale}x-${job.id.slice(0,8)}.mkv`);
          job.outputFile=nameFor(engine==='cpu'?'cpu':engine.replace('gpu-',''));job.state='working';job.started=Date.now();this.notify();
          await this.models.with('enhancement',async()=>{
            const runCpu=()=>this.enhanceExecutor({...common(),engine:'cpu',profile:engine==='gpu-esrgan'?'clarity':job.profile});
            if(engine==='cpu')job.result=await runCpu();
            else{
              try{
                job.result=engine==='gpu-esrgan'
                  ?await this.gpuExecutor({...common(),esrgan:gpuSetup.esrgan,encoder:gpuSetup.encoder,renderNode:gpuSetup.node,maxMs:this.db.settings.videoGpu.maxMinutes*60000})
                  :await this.enhanceExecutor({...common(),engine:'cpu',profile:job.profile,gpuEncoder:true,encoder:gpuSetup.encoder,renderNode:gpuSetup.node});
              }catch(error){
                const gpuFault=error.code==='GPU_FAILED'||(engine==='gpu-encode'&&error.code==='PROCESS_FAILED');
                if(abort.signal.aborted||!gpuFault)throw error;
                // A failed GPU attempt never fails the job: it is repeated in the safe CPU mode and the reason is kept.
                job.fallback={from:engine,reason:error.message,at:Date.now()};job.engine='cpu';job.profile=engine==='gpu-esrgan'?'clarity':job.profile;job.outputFile=nameFor('cpu');job.progress=0;job.done=0;this.notify();
                await fs.rm(job.outputFile,{force:true}).catch(()=>{});
                job.result=await runCpu();
              }
            }
            if(abort.signal.aborted)throw Error('Отменено');
            if(job.preview){
              const before=path.join(dir,job.id+'-before.jpg'),after=path.join(dir,job.id+'-after.jpg');
              try{await this.thumbnailExecutor(e.filePath,before,job.start,abort.signal);await this.thumbnailExecutor(job.outputFile,after,0,abort.signal);job.beforeImage=before;job.afterImage=after;job.comparisonReady=true;}
              catch(error){if(abort.signal.aborted)throw error;if(error.code==='ENHANCE_SAFETY_STOP')this.cancelEnhancements('Очередь остановлена защитой при создании сравнения.',job.id);job.comparisonReady=false;job.previewWarning='Видео готово, сравнение кадров недоступно: '+error.message;}
            }else if(e.cues.length){
              const base=job.outputFile.slice(0,-4);await fs.writeFile(base+'.en.vtt',exportSubs(e.cues,{language:'en'}));if(e.cues.some(c=>c.ru))await fs.writeFile(base+'.ru.vtt',exportSubs(e.cues,{language:'ru'}));
            }
          },abort.signal);
          job.state='ready';job.progress=100;job.finished=Date.now();
        }catch(error){
          job.state=abort.signal.aborted?'cancelled':'error';job.error=abort.signal.aborted?(job.error||error.message):error.message;this.lastError=error.message;
          if(error.code==='ENHANCE_SAFETY_STOP'){job.safetyStopped=true;this.cancelEnhancements('Очередь остановлена после срабатывания защиты. Запусти нужные серии вручную.');}
        }finally{this.tasks.delete(job.id);await this.save();this.notify();}
      };
      this.queue=this.queue.catch(()=>{}).then(task);
    }
    await this.save();this.notify();return jobs.map(j=>({id:j.id}));
  }
  cancelEnhancements(reason='Обработка отменена пользователем',exceptId=null){
    let count=0;for(const job of this.db.enhancements)if(job.id!==exceptId&&['queued','working','cancelling'].includes(job.state)){this.tasks.get(job.id)?.abort();job.state=job.state==='queued'?'cancelled':'cancelling';job.error=reason;count++;}
    this.save().catch(e=>this.lastError=e.message);this.notify();return {ok:true,count};
  }

  async cleanupEnhancementWorkspaces(){
    for(const job of this.db.enhancements){
      const work=job.workDirectory;
      if(work&&job.outputFile&&path.dirname(work)===path.dirname(job.outputFile)&&/^\.lingo-cpu-[A-Za-z0-9]+$/.test(path.basename(work))){
        const stat=await fs.lstat(work).catch(()=>null);if(stat?.isDirectory()&&!stat.isSymbolicLink())await fs.rm(work,{recursive:true,force:true});
      }
      delete job.workDirectory;
    }
    await this.save();
  }
  enhancement(id){const j=this.db.enhancements.find(j=>j.id===id);if(!j)throw Error('Задача улучшения не найдена');return j;}
  async useEnhanced(id){const j=this.enhancement(id);if(j.state!=='ready')throw Error('Улучшение ещё не завершено');const original=this.db.episodes.find(e=>e.id===j.episodeId),e=await this.addFile(j.outputFile);if(original&&!j.preview){e.folderId=original.folderId||null;e.cues=structuredClone(original.cues);e.ruCues=structuredClone(original.ruCues||[]);e.cueCount=e.cues.length;e.state=original.state==='ready'?'ready':e.cues.length?'recognized':'new';e.enSource=original.enSource;e.ruSource=original.ruSource;await this.save();this.notify();}return e;}
  startLive(id){if(this.tasks.size)throw Error('Завершите или отмените обработку очереди перед распознаванием во время просмотра.');this.stopLive(id);this.live.set(id,{id,active:true,abort:new AbortController(),cues:[],pending:0,version:0,previous:''});this.notify();return {ok:true};}
  stopLive(id){const s=this.live.get(id);if(s){s.active=false;s.abort.abort();if(s.cues.length){const e=this.db.episodes.find(e=>e.id===id);if(e){e.liveCues=structuredClone(s.cues);this.save().catch(e=>this.lastError=e.message);}}}this.notify();}
  resetLive(id,version){const s=this.live.get(id);if(s){s.version=version;s.previous='';s.carry=null;}}
  async liveChunk(id,{pcm,sampleRate=16000,start=0,version=0,wallTime=Date.now(),rate=1}){const s=this.live.get(id);if(!s?.active)throw Error('Распознавание остановлено');if(s.pending>=2)return {dropped:true};if(typeof pcm!=='string'||pcm.length>4*1024*1024||![16000,22050,24000,44100,48000].includes(sampleRate)||!Number.isFinite(start)||!Number.isFinite(rate)||rate<.25||rate>4)throw Error('Некорректный аудиофрагмент');const buffer=Buffer.from(pcm,'base64');if(buffer.length>sampleRate*2*32||buffer.length<sampleRate/2)throw Error('Некорректная длина аудио');let sum=0;for(let i=0;i+1<buffer.length;i+=2)sum+=(buffer.readInt16LE(i)/32768)**2;if(Math.sqrt(sum/(buffer.length/2))<.002)return {silence:true};s.pending++;const task=async()=>{let dir;try{if(!s.active||version!==s.version)return;dir=await fs.mkdtemp(path.join(this.root,'live-'));const input=path.join(dir,'input.wav'),wav=path.join(dir,'audio.wav');await fs.writeFile(input,pcmWav(buffer,sampleRate));await run(tools.ffmpeg(),['-loglevel','error','-y','-i',input,'-ar','16000','-ac','1',wav],{signal:s.abort.signal});const cues=await this.recognize(wav,dir,s.abort.signal);if(cues.length)await this.models.with('translation',async()=>{for(const c of cues){if(!s.active||version!==s.version)return;c.start=start+c.start*rate;c.end=start+c.end*rate;for(const w of c.words||[]){w.start=start+w.start*rate;w.end=start+w.end*rate;}c.ru=await this.translateRaw(c.text,s.previous,s.abort.signal);s.previous=(s.previous+'\n'+c.text).slice(-1500);s.cues.push(c);s.cues=s.cues.slice(-40000);s.lag=(Date.now()-wallTime)/1000;this.emit('live-cue',{id,cue:c,version,lag:s.lag});}},s.abort.signal);s.error='';}catch(err){if(s.active){s.error=err.message;this.lastError=err.message;this.emit('live-error',{id,error:err.message});}}finally{if(dir)await fs.rm(dir,{recursive:true,force:true});s.pending--;this.notify();}};this.queue=this.queue.catch(()=>{}).then(task);return {queued:true};}
  async localChunk(id,start,version=0){const e=this.episode(id),s=this.live.get(id);if(!s?.active)throw Error('Распознавание остановлено');if(!Number.isFinite(start)||start<0||start>(e.duration||21600))throw Error('Некорректная позиция');const dir=await fs.mkdtemp(path.join(this.root,'extract-'));try{const file=path.join(dir,'audio.pcm');await run(tools.ffmpeg(),['-loglevel','error','-nostdin','-y','-ss',String(start),'-i',e.filePath,'-map',`0:${e.audioIndex}`,'-t',String(this.db.settings.chunkSeconds),'-vn','-af','aresample=16000:async=1:first_pts=0','-ar','16000','-ac','1','-f','s16le',file],{signal:s.abort.signal});const pcm=await fs.readFile(file);if(pcm.length<8000)return {end:true};return this.liveChunk(id,{pcm:pcm.toString('base64'),sampleRate:16000,start,version,wallTime:Date.now()});}finally{await fs.rm(dir,{recursive:true,force:true});}}
  async close(){this.shutdown.abort();for(const c of this.mediaTasks.values())c.abort();for(const c of this.tasks.values())c.abort();for(const id of this.live.keys())this.stopLive(id);const limit=this.closeTimeout??8000;await withTimeout(this.folderQueue?.catch(()=>{}),limit);await withTimeout(this.queue.catch(()=>{}),limit);await withTimeout(this.models.release().catch(e=>{this.lastError=e.message;}),limit);await this.save();}
}
module.exports={Backend,DEFAULTS,run,exportSubs,stamp,parseWhisper,pcmWav,languageOf,expandPaths,samePath,playbackName};
