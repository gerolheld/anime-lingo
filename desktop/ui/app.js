'use strict';
const $=id=>document.getElementById(id),video=$('video'),EMPTY_CUES=[];
const S={settings:{},episodes:[],folders:[],libraryFolder:null,selectedLibrary:new Set(),words:[],history:[],enhancements:[],selectedEnhance:new Set(),current:null,mode:'prepare',live:false,version:0,liveCues:[],translations:new Map(),tipToken:0,diagnostics:null,page:'watch'};
const titles={watch:'Время для новой истории',library:'Твоя библиотека',enhance:'Улучшение видео',words:'Твой личный словарь',history:'История изучения',settings:'Настройки',diagnostics:'Проверка системы',models:'Модели и устройства'};
const stages={new:'Ещё не обработано',queued:'В очереди',extracting:'Получаю английский звук',recognizing:'Qwen3-ASR распознаёт английскую речь',aligning:'ForcedAligner синхронизирует слова',recognized:'Английские субтитры готовы',translating:'Перевожу реплики на русский',ready:'Субтитры готовы',partial:'Перевод не завершён',error:'Ошибка обработки',interrupted:'Обработка прервана',cancelled:'Обработка отменена'};
async function call(method,data){const r=await window.lingo.call(method,data);if(r.error)throw Error(r.error);return r.value;}
function toast(text,error=false){
  clearTimeout(S.toastTimer);const box=$('toast');box.hidden=false;box.textContent=text;box.classList.toggle('error',error);
  if(error){
    // Every error can be turned into a report (system, versions, component state, the message) and copied in one click.
    const copy=document.createElement('button');copy.type='button';copy.className='toast-action';copy.textContent='Скопировать отчёт';
    copy.onclick=async()=>{try{const report=await call('error-report',{message:text});await call('copy-text',{text:report});copy.textContent='Отчёт скопирован';}catch(e){copy.textContent='Не удалось скопировать';}};
    box.append(copy);
  }
  S.toastTimer=setTimeout(()=>box.hidden=true,error?15000:4500);
}
const task=fn=>async(...args)=>{try{return await fn(...args);}catch(e){toast(e.message,true);}};
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function button(text,cls,fn){const b=el('button',cls,text);b.onclick=task(fn);return b;}
function fps(value){const [a,b]=String(value||'0/1').split('/').map(Number);return (a/(b||1)).toFixed(2).replace(/\.?0+$/,'');}
function time(t){if(!Number.isFinite(t))return '00:00';const h=Math.floor(t/3600),m=Math.floor(t/60)%60,s=Math.floor(t)%60;return (h?h+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');}
function page(name){
  S.page=name;document.body.dataset.page=name;if(name!=='enhance')$('enhance-preview-video').pause();
  for(const n of document.querySelectorAll('.page'))n.classList.toggle('active',n.id==='page-'+name);
  for(const n of document.querySelectorAll('.sidebar [data-page]'))n.classList.toggle('active',n.dataset.page===name);
  $('page-title').textContent=titles[name];
  const descriptions={enhance:'Резкость линий и мягкое шумоподавление. По умолчанию — безопасный режим на процессоре.',words:'Сохраняй слова вместе с фразой, в которой они встретились.',history:'Сохранённые слова и фразы. История хранится на этом компьютере.',settings:'Настрой приложение под себя. Удобный просмотр, точный перевод и максимум комфорта.'};
  $('page-subtitle').textContent=descriptions[name]||'';$('page-subtitle').hidden=!descriptions[name];
  $('header-history-clear').hidden=name!=='history';$('header-diagnostics').hidden=name!=='diagnostics';$('open-media').hidden=['history','diagnostics'].includes(name);$('connection').hidden=name==='history';
  $('subtitle-dialog').hidden=true;$('word-menu').hidden=true;for(const d of document.querySelectorAll('dialog[open]'))d.close();
  if(name!=='watch'){hideTip(false);closePhrase(false);video.pause();}
  if(name==='library'){renderLibrary();scanLibraryIfDue();}if(name==='words')renderWords();if(name==='history')renderHistory();if(name==='enhance')renderEnhance();if(name==='diagnostics'&&!S.diagnostics)diagnostics();if(name==='models')refreshModels();if(name==='enhance')refreshEnhanceEngines();
}
for(const b of document.querySelectorAll('.sidebar [data-page]'))b.onclick=()=>page(b.dataset.page);
async function refresh(){const d=await call('snapshot');Object.assign(S,d);renderState();fillSettings();return d;}
function renderComponents(){
  const box=$('component-install');if(!box)return;
  const c=S.components?.ffmpeg||{},ready=S.tools?.ready;
  box.hidden=!!ready&&c.state!=='downloading'&&c.state!=='extracting';
  if(box.hidden)return;
  const busy=['downloading','extracting'].includes(c.state);
  const text=busy?(c.state==='extracting'?'Распаковываю FFmpeg…':`Скачиваю FFmpeg: ${c.percent||0}%`):c.state==='paused'?`Загрузка приостановлена (${c.percent||0}%).`:c.state==='error'?'Не удалось скачать FFmpeg: '+c.error:'FFmpeg не найден. Он нужен для импорта видео, звука и субтитров. Программа скачает закреплённую сборку с проверкой SHA-256.';
  const button=el('button','primary',busy?'Приостановить':c.state==='paused'?'Продолжить':c.state==='error'?'Повторить':'Скачать FFmpeg');
  button.onclick=task(async()=>{await call(busy?'pause-component':'install-component',{name:'ffmpeg'});});
  box.replaceChildren(el('strong','','FFmpeg'),el('span','',text),button);
}
// Text that belongs to the user (titles, subtitles, saved words and their translations) is never translated.
LingoI18n.setProvider(()=>{
  const out=[];
  for(const e of S.episodes||[])out.push(e.title);
  for(const f of S.folders||[])out.push(f.name);
  for(const w of S.words||[])out.push(w.word,w.translation,w.context,w.ruContext);
  for(const h of S.history||[])out.push(h.word,h.translation,h.context,h.title);
  for(const c of [...(S.current?.cues||[]),...(S.liveCues||[])])out.push(c.text,c.ru);
  for(const c of S.current?.ruCues||[])out.push(c.text);
  if(S.tip)out.push(S.tip.translation,S.tip.context);
  return out;
},()=>[S.episodes?.length,S.folders?.length,S.words?.length,S.history?.length,S.current?.id,S.current?.cues?.length,S.current?.ruCues?.length,S.liveCues?.length,S.tip?.translation].join('|'));
function renderState(){applyThemeFromSettings();const wanted=S.settings?.uiLanguage;if(wanted&&wanted!==LingoI18n.setting){LingoI18n.storeSetting(wanted);location.reload();return;}renderComponents();modelsStateChanged();const ver=$('app-version');if(ver&&S.version_)ver.textContent='v'+S.version_+' · '+({win32:'WINDOWS',linux:'LINUX',darwin:'MACOS'}[S.platform]||'');const note=$('isolation-note');if(note)note.textContent=S.enhancePolicy?.isolation?.label||'';
  $('episode-count').textContent=S.episodes.length;$('word-count').textContent=S.words.length;
  const model=S.modelState||{phase:'idle',label:'Модели выгружены'};$('connection').replaceChildren(el('i'),document.createTextNode(model.label));$('connection').title=model.label;$('connection').classList.toggle('model-busy',model.phase!=='idle');$('model-state-title').textContent=model.label;
  let active=0;for(const node of document.querySelectorAll('.model-flow>div')){if(!node.querySelector('.model-menu'))node.append(iconButton('Действия с моделью','more','model-menu',event=>contextMenu([{label:'Настройки моделей',icon:'settings',action:()=>page('settings')},{label:'Освободить модели приложения',icon:'cube',action:()=>call('release-models')}],event)));const working=node.dataset.model===model.kind&&model.phase!=='idle';node.classList.toggle('working',working);node.querySelector('.model-status').textContent=node.dataset.model==='enhancement'&&!working?'Готов':working?(model.phase==='loading'?'Загрузка':'Работает'):model.phase==='error'?'Проверить':model.phase==='unloading'?'Выгрузка':'Выгружена';if(working&&node.dataset.model!=='enhancement')active++;}$('model-count').textContent=active+' / 3';
  if(S.current){const e=S.episodes.find(e=>e.id===S.current.id);if(e){Object.assign(S.current,{state:e.state,progress:e.progress,error:e.error,folderId:e.folderId});$('episode-status').textContent=stages[e.state]||e.state;const busy=['queued','extracting','recognizing','aligning','translating'].includes(e.state);$('prepare').disabled=busy||!S.current.audio?.length;$('prepare').textContent=['partial','interrupted','cancelled','error'].includes(e.state)?'↻ Продолжить подготовку':'✦ Создать EN + RU';$('audio-track').disabled=busy||!!S.liveActive;$('cancel').hidden=!busy;$('job-progress').hidden=!busy&&!e.error;$('job-stage').textContent=e.error||stages[e.state];$('job-percent').textContent=busy?Math.round(e.progress||0)+'%':'';$('progress-bar').style.width=(e.progress||0)+'%';if(e.state!==S.lastJobState||e.progress!==S.lastJobProgress){S.lastJobState=e.state;S.lastJobProgress=e.progress;if(e.state==='translating'||['ready','partial','recognized'].includes(e.state))loadCues();}}}
  syncReadingControls();if(S.current)updateEpisodeHeading(S.current);
  if(S.page==='library')renderLibrary();if(S.page==='words')renderWords();if(S.page==='history')renderHistory();if(S.page==='enhance')renderEnhance();
}
let cueLoadPending=false;
async function loadCues(){if(!S.current||cueLoadPending)return;cueLoadPending=true;try{const e=await call('episode',{id:S.current.id});if(S.current?.id===e.id){S.current=e;S.timeline=new AL.Timeline(e.cues);S.ruTimeline=new AL.Timeline(e.ruCues||[]);$('cue-count').textContent=e.cues.length;for(const id of ['export-subs','translate-subs'])$(id).disabled=!e.cues.length;renderTranscript(true);renderCue(true);}}finally{cueLoadPending=false;}}
async function acceptImport(result){const episodes=result.episodes||[];if(episodes.length){await refresh();if(S.page==='enhance'){for(const e of episodes){S.selectedEnhance.add(e.id);(S.enhancePicked??=new Set()).add(e.id);}renderEnhance();}else if(S.page==='library'){renderLibrary();}else await selectEpisode(episodes[0].id);toast(`Добавлено серий: ${episodes.length}`);}if(result.errors?.length)toast(result.errors.map(e=>e.name+': '+e.error).join('\n'),true);}
async function openMedia(){await acceptImport(await call('pick-media',{currentId:S.current?.id,folderId:S.page==='library'?S.libraryFolder:undefined}));}
$('open-media').onclick=task(openMedia);$('empty-open').onclick=task(openMedia);$('enhance-add').onclick=task(openMedia);
async function selectEpisode(id){const request=S.openToken=(S.openToken||0)+1;if(S.liveActive)await stopLive();hideTip(false);closePhrase(false);video.pause();resetReading();const e=await call('episode',{id});if(request!==S.openToken)return;S.current=e;S.liveCues=e.liveCues||[];S.lastRendered='';S.lastJobState=null;S.lastTranscript='';page('watch');$('episode-title').textContent=e.title;$('episode-label').textContent='СЕЙЧАС СМОТРИШЬ';updateEpisodeHeading(e);$('player-empty').hidden=true;$('video-controls').hidden=!e.playable;$('prepare').disabled=false;$('start-live').disabled=!e.playable||!e.audio?.length;$('import-subs').disabled=false;$('export-subs').disabled=!e.cues.length;$('translate-subs').disabled=!e.cues.length;$('audio-track').replaceChildren();for(const a of e.audio||[]){const o=new Option(`${a.language.toUpperCase()} · ${a.title} · дорожка ${a.index}`,a.index);$('audio-track').add(o);}$('audio-track').value=e.audioIndex;S.timeline=new AL.Timeline(e.cues);S.ruTimeline=new AL.Timeline(e.ruCues||[]);if(e.playable){$('video-loading').hidden=false;$('video-loading').textContent='Готовлю видео и выбранную аудиодорожку…';try{await call('playback',{id:e.id,audioIndex:e.audioIndex});}catch(error){if(request===S.openToken)$('video-loading').hidden=true;throw error;}if(request!==S.openToken)return;video.src=e.mediaURL+'?track='+e.audioIndex;video.load();video.addEventListener('loadedmetadata',()=>{if(e.position>0&&e.position<video.duration-2)video.currentTime=e.position;},{once:true});}fillSubtitleTracks();renderState();renderTranscript(true);renderCue(true);}
function setMode(mode){S.mode=mode;$('mode-prepare').classList.toggle('selected',mode==='prepare');$('mode-live').classList.toggle('selected',mode==='live');$('prepare').hidden=mode!=='prepare';$('start-live').hidden=mode!=='live'||!!S.liveActive;$('stop-live').hidden=!S.liveActive;$('mode-hint').textContent=mode==='prepare'?'Подготовь серию один раз и смотри с готовыми субтитрами. Обработка может занять несколько минут.':'Речь обрабатывается фрагментами. При недостаточной скорости текст появляется после произнесённой реплики; задержка показывается на видео.';}
$('mode-prepare').onclick=()=>setMode('prepare');$('mode-live').onclick=()=>setMode('live');
$ ('audio-track').onchange=task(async()=>{if(!S.current?.playable)return;video.pause();const position=video.currentTime;$('video-loading').hidden=false;$('video-loading').textContent='Переключаю аудиодорожку…';await call('playback',{id:S.current.id,audioIndex:+$('audio-track').value});video.src=S.current.mediaURL+'?track='+$('audio-track').value;video.addEventListener('loadedmetadata',()=>video.currentTime=position,{once:true});S.current.audioIndex=+$('audio-track').value;await loadCues();toast('Аудиодорожка переключена. Для другой озвучки подготовь субтитры заново.');});
$('prepare').onclick=task(async()=>{if(!S.current)return;if(S.liveActive)await stopLive();video.pause();const plan=await call('recognition-plan',{id:S.current.id,audioIndex:+$('audio-track').value});if(plan.problem)throw Error(plan.problem);if(plan.recognition&&plan.device==='cpu'&&!confirm('Распознавание пойдёт на процессоре'+(plan.reason?' ('+plan.reason.replace(/\.$/,'')+')':'')+'.\n\nПримерное время: '+plan.estimateText+(plan.estimate.calibrated?' — по скорости прошлых запусков на этом компьютере.':' — это грубая оценка: на этом компьютере распознавание на процессоре ещё не измерялось.')+'\n\nПродолжить?'))return;await call('prepare',{id:S.current.id,audioIndex:+$('audio-track').value});toast('Подготовка началась. Можно следить за прогрессом.');});
$('cancel').onclick=task(()=>call('cancel',{id:S.current.id}));
$('translate-subs').onclick=task(()=>call('prepare',{id:S.current.id,translateOnly:true}));
$('import-subs').onclick=task(async()=>{await call('import-subs',{id:S.current.id,language:$('import-language').value});await loadCues();});
$('export-subs').onclick=task(()=>call('export-subs',{id:S.current.id,format:$('export-format').value,language:$('export-language').value,live:S.mode==='live'&&S.liveCues.length>0}));
function activeCues(){const cues=S.liveActive?S.liveCues:S.current?.cues||[];const t=video.currentTime-(S.settings.offset||0);const active=cues.filter(c=>c.start<=t&&c.end>t);if(active.length)return active;if(S.liveActive&&!video.paused&&S.lateCue&&Date.now()<S.lateUntil)return [S.lateCue];return [];}
function resetReading(){S.readingCache=null;S.readingSession?.reset();S.lastRendered='';}
function readingData(){
  const cues=S.liveActive?S.liveCues:S.current?.cues||EMPTY_CUES,ruCues=S.liveActive?EMPTY_CUES:S.current?.ruCues||EMPTY_CUES;
  const old=S.readingCache,size=S.settings.readingSize||5;
  if(!old||old.cues!==cues||old.ruCues!==ruCues||old.length!==cues.length||old.size!==size||old.translations!==S.translationVersion){
    const parts=LingoReading.build(cues,{size,translate:c=>c.ru||S.translations.get(c.text)||''});
    const previous=S.readingSession;
    S.readingCache={cues,ruCues,length:cues.length,size,translations:S.translationVersion,parts,ruParts:LingoReading.build(ruCues,{size})};
    S.readingSession=new LingoReading.Session(parts);
    if(old&&old.cues===cues&&old.size===size&&previous){
      const replacement=p=>p?parts.find(n=>n.id===p.id&&n.context===p.context&&n.start===p.start)||null:null;
      S.readingSession.previous=replacement(previous.previous);S.readingSession.pinned=replacement(previous.pinned);
      S.readingSession.lastTime=previous.lastTime;S.readingSession.stopped=new Set(previous.stopped);if(previous.pending){const part=replacement(previous.pending.part);if(part)S.readingSession.pending={part,at:previous.pending.at};}
    }
  }
  return S.readingCache;
}
function subtitleFrame(){
  const t=video.currentTime-(S.settings.offset||0);
  if(S.settings.readingMode){
    const data=readingData(),sample=S.readingSession.update(t,{playing:!video.paused,autoPause:!!S.settings.readingAutoPause,hold:!!S.settings.readingHold,seeking:video.seeking,pauseDelay:S.settings.readingPauseDelay||0});
    if(sample.pause){S.hoverPaused=false;video.pause();}
    const part=sample.part;
    if(!part)return {text:'',ru:'',cues:[],context:'',words:[]};
    const rt=sample.pinned?Math.min(t,part.end-.000001):t;
    const ruPart=data.ruCues.length?LingoReading.at(data.ruParts,rt,{hold:!!S.settings.readingHold}):null;
    const ru=data.ruCues.length?ruPart?.text||'':LingoReading.russian(part,rt);
    return {text:part.text,ru,ruContext:data.ruCues.length?ruPart?.context||'':part.translation,cues:[data.cues[part.cueIndex]],context:part.context,words:part.words,part,pinned:sample.pinned};
  }
  const cues=activeCues(),text=cues.map(c=>c.text).join('\n'),ru=S.current?.ruCues?.length&&!S.liveActive?S.ruTimeline.active(t).map(c=>c.text).join('\n'):cues.map(c=>c.ru||S.translations.get(c.text)||'').filter(Boolean).join('\n');
  const words=[];let offset=0;for(const c of cues){for(const w of c.words||[])words.push({...w,charStart:w.charStart+offset,charEnd:w.charEnd+offset});offset+=c.text.length+1;}
  return {text,ru,ruContext:ru,cues,context:text,words};
}
function renderCue(force=false){
  if(S.page!=='watch')return;
  const frame=subtitleFrame(),{text,ru,cues,context,words,part,pinned}=frame;S.readingFrame=frame;
  $('reading-actions').hidden=!part;$('reading-position').textContent=part?`${part.partIndex+1} / ${part.count}`:'';
  $('reading-continue').hidden=!pinned;$('reading-status').textContent=pinned?'Пауза для чтения · Space — дальше':part&&!part.precise?'Время слов приблизительное':'';
  $('reading-full').disabled=!context;$('reading-phrase-player').disabled=!context;
  const signature=JSON.stringify([text,ru,part?.id,part?.start]);
  if(!force&&signature===S.lastRendered){highlightWords();return;}
  S.lastRendered=signature;S.active=cues[0];$('subtitle-layer').hidden=S.subtitlesHidden||!text&&!ru;$('en-line').hidden=!text;$('ru-line').textContent=ru;$('ru-line').hidden=!ru;$('en-line').replaceChildren();
  let previous=0;const estimated=AL.tokens(text),t0=part?.start??cues[0]?.start??0,t1=part?.end??cues.at(-1)?.end??t0;
  for(const token of estimated){
    $('en-line').append(document.createTextNode(text.slice(previous,token.start)));
    const b=button(token.word,'',()=>showTip(token.word,context));
    const timing=words.find(w=>w.charStart<token.end&&w.charEnd>token.start);
    if(timing){b.dataset.wordStart=timing.start;b.dataset.wordEnd=timing.end;}
    else if(part){b.dataset.wordStart=t0+(t1-t0)*token.start/Math.max(1,text.length);b.dataset.wordEnd=t0+(t1-t0)*token.end/Math.max(1,text.length);b.dataset.estimated='true';}
    b.onpointerenter=()=>{clearTimeout(S.hoverTimer);if(S.settings.pauseOnHover&&!video.paused){S.hoverPaused=true;video.pause();}S.hoverTimer=setTimeout(()=>showTip(token.word,context).catch(e=>toast(e.message,true)),200);};
    b.onpointerleave=()=>{clearTimeout(S.hoverTimer);if($('word-tip').hidden&&S.hoverPaused){S.hoverPaused=false;video.play().catch(()=>{});}};
    $('en-line').append(b);previous=token.end;
  }
  $('en-line').append(document.createTextNode(text.slice(previous)));highlightWords();fitReading();
  $('live-lag').hidden=!S.liveActive||!S.lag;$('live-lag').textContent=`Распознавание во время просмотра · обработка ${Number(S.lag||0).toFixed(1)} с`;
  // Translation requests keep the entire original sentence as their source.
  // Merely changing presentation never retranslates an already translated cue.
  const missing=cues.find(c=>c.text&&!c.ru&&!S.translations.has(c.text));
  if(missing&&!S.current?.ruCues?.length&&!S.liveActive&&!S.translationPending?.has(missing.text)){
    S.translationPending??=new Set();S.translationPending.add(missing.text);
    call('translate',{text:missing.text}).then(r=>{S.translations.set(missing.text,r);S.translationVersion=(S.translationVersion||0)+1;renderCue();}).catch(e=>toast('Перевод реплики: '+e.message,true)).finally(()=>S.translationPending.delete(missing.text));
  }
  renderTranscript();
}
function syncReadingControls(){
  $('player').classList.toggle('reading-mode',!!S.settings.readingMode);
  $('reading-mode').value=S.settings.readingMode?'short':'full';$('reading-size').value=S.settings.readingSize||5;$('reading-size').disabled=!S.settings.readingMode;
  $('reading-auto').checked=!!S.settings.readingAutoPause;$('reading-auto').disabled=!S.settings.readingMode;
  $('reading-auto-player').disabled=!S.settings.readingMode;$('reading-auto-player').setAttribute('aria-pressed',String(!!S.settings.readingAutoPause));
}
async function configureReading(values){
  S.settings=await call('settings',values);resetReading();fillSettings();syncReadingControls();renderCue(true);
}
function fitReading(){
  if(!S.settings.readingMode)return;
  const player=$('player'),available=Math.max(100,player.clientWidth*.9-24),full=!!document.fullscreenElement;
  let englishSize=36;
  for(const [id,key,size] of [['en-line','--reading-en-size',full?Math.min(58,Math.max(26,player.clientWidth*.03)):S.settings.fontSize||36],['ru-line','--reading-ru-size',full?Math.min(38,Math.max(18,player.clientWidth*.02)):S.settings.ruSize||24]]){
    const node=$(id),base=id==='ru-line'?Math.min(size,englishSize*.75):size;player.style.setProperty(key,base+'px');
    const width=node.scrollWidth,actual=width>available?Math.max(8,base*available/width):base;
    player.style.setProperty(key,actual+'px');if(id==='en-line')englishSize=actual;
  }
}
$('reading-mode').onchange=task(()=>configureReading({readingMode:$('reading-mode').value==='short'}));
$('reading-size').onchange=task(()=>configureReading({readingSize:+$('reading-size').value}));
$('reading-auto').onchange=task(()=>configureReading({readingAutoPause:$('reading-auto').checked}));
function toggleReadingPause(){return configureReading({readingAutoPause:!S.settings.readingAutoPause});}
$('reading-auto-player').onclick=task(toggleReadingPause);
$('reading-repeat').onclick=()=>seekCue();$('reading-continue').onclick=()=>play();
function showPhrase(){
  const f=S.readingFrame;if(!f?.context)return;
  S.phraseResume=!video.paused;hideTip(false);video.pause();
  $('phrase-en').textContent=f.context;
  $('phrase-ru').textContent=f.ruContext||'';
  $('phrase-card').hidden=false;$('phrase-close').focus();
}
function closePhrase(resume=true){$('phrase-card').hidden=true;if(resume&&S.phraseResume){S.phraseResume=false;play();}else S.phraseResume=false;}
$('reading-full').onclick=showPhrase;$('reading-phrase-player').onclick=showPhrase;$('phrase-close').onclick=()=>closePhrase();
$('phrase-repeat').onclick=()=>{closePhrase(false);seekCue(0,true);};
new ResizeObserver(fitReading).observe($('player'));document.addEventListener('fullscreenchange',fitReading);

function highlightWords(){const t=video.currentTime-(S.settings.offset||0);for(const b of $('en-line').querySelectorAll('[data-word-start]'))b.classList.toggle('word-speaking',+b.dataset.wordStart<=t&&+b.dataset.wordEnd>t);}
function renderTranscript(force=false){
  const cues=S.liveActive?S.liveCues:S.current?.cues||[],t=video.currentTime-(S.settings.offset||0),index=cues.findIndex(c=>c.start<=t&&c.end>t);
  const signature=`${S.current?.id}:${cues.length}:${index}:${cues.filter(c=>c.ru).length}:${S.transcriptMode}`;if(!force&&signature===S.lastTranscript)return;S.lastTranscript=signature;
  $('cue-count').textContent=cues.length;const list=$('transcript');list.replaceChildren();
  if(!cues.length){const empty=el('div','transcript-empty');empty.append(icon('chat'),el('h4','','Реплики ещё не готовы'),el('p','','Подключи готовые субтитры или создай их из озвучки.'));empty.append(button('Субтитры из озвучки','secondary',openSubtitleTools));list.append(empty);return;}
  const start=Math.max(0,index-3);
  for(const [i,c] of cues.slice(start,start+100).entries()){
    const row=el('article','cue'+(start+i===index?' active':''));row.tabIndex=0;row.setAttribute('aria-label','Реплика '+time(c.start));
    const playCue=()=>{hideTip(false);video.currentTime=Math.max(0,c.start+(S.settings.offset||0));video.play().catch(()=>{});};
    row.onclick=playCue;row.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();playCue();}};
    const play=el('span','cue-play');play.append(icon('play'));row.append(play,el('div','cue-time',time(c.start)));
    const ru=c.ru||S.translations.get(c.text)||'';if(ru)row.append(el('div','cue-ru',ru));row.append(el('div','cue-en',c.text));
    row.append(button('…','cue-more',event=>{event.stopPropagation();contextMenu([{label:'Повторить реплику',icon:'repeat',action:playCue},{label:'Сохранить фразу',icon:'plus',action:()=>savePhrase(c)}],event);}));list.append(row);
  }
  if(index>=0)list.querySelector('.active')?.scrollIntoView({block:'nearest',behavior:force?'instant':'smooth'});
}
function appearance(settings=S.settings){document.body.classList.toggle('subtitle-classic',settings.subtitleStyle==='classic');syncReadingControls();fitReading();$('en-line').style.fontSize=settings.fontSize+'px';$('ru-line').style.fontSize=settings.ruSize+'px';$('subtitle-layer').style.bottom=settings.readingMode?`max(${settings.bottom}%,105px)`:settings.bottom+'%';for(const id of ['en-line','ru-line'])$(id).style.background=`rgba(5,11,20,${settings.opacity/100})`;}
async function showTip(word,context){clearTimeout(S.hoverTimer);const token=++S.tipToken;S.tip={word,context,translation:'',episodeId:S.current?.id,position:video.currentTime,ruContext:S.readingFrame?.ruContext||''};$('word-tip').hidden=false;$('tip-word').textContent=word;$('tip-meaning').textContent='Ищу перевод…';$('tip-source').textContent='Локальный словарь';$('tip-context').textContent=context;$('tip-save').textContent='＋ В слова';if(S.settings.pauseOnHover&&!video.paused){S.hoverPaused=true;video.pause();}const quick=await call('lookup',{word,context});if(token!==S.tipToken)return;S.tip.translation=quick.wordTranslation||'';S.tip.phonetic=quick.phonetic||'';$('tip-meaning').textContent=S.tip.translation||'Уточняю по контексту…';const result=await call('word-meaning',{word,context});if(token!==S.tipToken)return;S.tip.translation=result.wordTranslation;$('tip-meaning').textContent=result.wordTranslation||'Перевод не найден';$('tip-source').textContent=result.source||'Локальный словарь';}
function hideTip(resume=true){clearTimeout(S.hoverTimer);S.tipToken++;$('word-tip').hidden=true;if(S.hoverPaused){S.hoverPaused=false;if(resume)video.play().catch(()=>{});}}
$('tip-close').onclick=()=>hideTip();$('tip-save').onclick=task(async()=>{if(S.tip){await call('save-word',{...S.tip});$('tip-save').textContent='✓ Сохранено';}});$('tip-speak').onclick=task(()=>call('speak',{text:S.tip?.word||''}));
function play(){if(!S.current?.playable)return;hideTip(false);closePhrase(false);if(video.paused){S.readingSession?.resume();video.play().catch(e=>toast(e.message,true));}else video.pause();}
$('play').onclick=play;video.onclick=play;
function seekCue(direction=0,whole=false){
  const offset=S.settings.offset||0,t=video.currentTime-offset;
  const cues=S.settings.readingMode&&!whole?readingData().parts:(S.liveActive?S.liveCues:S.current?.cues||[]);
  if(!cues.length){video.currentTime=Math.max(0,video.currentTime-5);return;}
  const pinned=S.readingFrame?.part;
  let target=direction===0?(S.settings.readingMode&&!whole&&pinned?pinned:LingoReading.at(cues,t,{hold:true})):direction>0?cues.find(c=>c.start>t+.05):[...cues].reverse().find(c=>c.start<t-.15);
  if(target){hideTip(false);closePhrase(false);S.readingSession?.reset();video.currentTime=Math.max(0,target.start+offset);video.play().catch(()=>{});}
}
$('repeat').onclick=()=>seekCue();$('back').onclick=()=>seekCue(-1);$('next').onclick=()=>seekCue(1);
$('seek').oninput=()=>{if(Number.isFinite(video.duration))video.currentTime=+$('seek').value;};$('volume').oninput=()=>video.volume=+$('volume').value;video.volume=.8;$('speed').onchange=()=>video.playbackRate=+$('speed').value;
async function fullscreen(){if(document.fullscreenElement)await document.exitFullscreen();else await $('player').requestFullscreen();}$('fullscreen').onclick=task(fullscreen);
const PLAYER_IDLE_MS=2200;
function playerControlsPinned(){
  const controls=$('video-controls'),focused=document.activeElement;
  if(S.controlsDragging||S.controlsKeyboard&&controls.contains(focused))return true;
  // An open native speed menu must not disappear with its parent controls.
  try{return !!controls.querySelector('select:open');}catch{return false;}
}
function setPlayerControlsVisible(visible){
  const player=$('player');player.classList.toggle('controls-visible',visible);player.classList.toggle('controls-idle',!visible);
  $('video-controls').inert=!visible;
}
function hidePlayerControls(){
  clearTimeout(S.controlsTimer);
  if(video.paused||video.ended||!S.current?.playable){setPlayerControlsVisible(true);return;}
  if(playerControlsPinned()){S.controlsTimer=setTimeout(hidePlayerControls,400);return;}
  setPlayerControlsVisible(false);
}
function showPlayerControls(){
  clearTimeout(S.controlsTimer);setPlayerControlsVisible(true);
  if(!video.paused&&!video.ended&&S.current?.playable)S.controlsTimer=setTimeout(hidePlayerControls,PLAYER_IDLE_MS);
}
function initPlayerControls(){
  const player=$('player'),controls=$('video-controls');
  player.addEventListener('pointermove',()=>{S.controlsKeyboard=false;showPlayerControls();});
  player.addEventListener('pointerenter',showPlayerControls);
  player.addEventListener('pointerleave',hidePlayerControls);
  player.addEventListener('pointerdown',event=>{S.controlsKeyboard=false;if(event.target.closest?.('#video-controls input[type=range]'))S.controlsDragging=true;showPlayerControls();});
  const release=()=>{if(S.controlsDragging){S.controlsDragging=false;showPlayerControls();}};
  document.addEventListener('pointerup',release);document.addEventListener('pointercancel',release);
  controls.addEventListener('lostpointercapture',release);
  controls.addEventListener('focusin',showPlayerControls);
  controls.addEventListener('focusout',()=>{if(player.classList.contains('controls-visible'))showPlayerControls();});
  controls.addEventListener('input',showPlayerControls);controls.addEventListener('change',showPlayerControls);
  document.addEventListener('pointerdown',event=>{S.controlsKeyboard=false;if(!player.contains(event.target)&&!video.paused)hidePlayerControls();},true);
  document.addEventListener('keydown',event=>{
    if(S.page!=='watch'||document.querySelector('dialog[open]'))return;
    if(event.key==='Tab')S.controlsKeyboard=true;
    if(player.contains(event.target)||['Space','KeyR','KeyA','KeyT','KeyF','BracketLeft','BracketRight','ArrowLeft','ArrowRight'].includes(event.code))showPlayerControls();
  },true);
  video.addEventListener('ended',showPlayerControls);
  document.addEventListener('fullscreenchange',showPlayerControls);
  window.addEventListener?.('blur',()=>{S.controlsDragging=false;S.controlsKeyboard=false;hidePlayerControls();});
  showPlayerControls();
}
video.onplay=()=>{S.readingSession?.resume();S.hoverPaused=false;$('play').replaceChildren(icon('pause'));$('player').classList.remove('paused');showPlayerControls();};video.onpause=()=>{if(S.current&&video.readyState>0&&Number.isFinite(video.currentTime))call('position',{id:S.current.id,seconds:video.currentTime}).catch(()=>{});$('play').replaceChildren(icon('play'));$('player').classList.add('paused');showPlayerControls();};video.onloadedmetadata=()=>{$('seek').max=video.duration||100;$('video-loading').hidden=true;};video.onerror=()=>{if(video.getAttribute('src'))toast('Этот видеокодек не поддерживается встроенным плеером. Проверь файл и диагностику. Для MKV программа создаёт совместимую копию с выбранной озвучкой.',true);};
video.ontimeupdate=()=>{$('time').textContent=`${time(video.currentTime)} / ${time(video.duration)}`;if(document.activeElement!==$('seek'))$('seek').value=video.currentTime;paintRange($('seek'));renderCue();if(S.current&&Date.now()-(S.hintedPosition||0)>1000){S.hintedPosition=Date.now();call('position-hint',{id:S.current.id,seconds:video.currentTime}).catch(()=>{});}if(S.current&&Date.now()-(S.savedPosition||0)>10000){S.savedPosition=Date.now();call('position',{id:S.current.id,seconds:video.currentTime}).catch(()=>{});}};
video.onseeking=()=>{hideTip(false);closePhrase(false);S.readingSession?.reset();if(S.liveActive){S.version++;S.nextChunk=video.currentTime;S.lateCue=null;call('live-reset',{id:S.liveSessionId,version:S.version}).catch(()=>{});}renderCue(true);};
async function startLive(){if(!S.current?.playable)return;S.liveSessionId=S.current.id;await call('live-start',{id:S.liveSessionId});S.liveActive=true;S.liveCues=[];S.version=0;S.nextChunk=video.currentTime;S.lateCue=null;setMode('live');toast('Распознавание включено. Начни воспроизведение.');}
async function stopLive(){if(S.liveSessionId)await call('live-stop',{id:S.liveSessionId});S.liveActive=false;S.liveSessionId=null;S.lateCue=null;setMode(S.mode);renderCue(true);renderTranscript(true);}
$('start-live').onclick=task(startLive);$('stop-live').onclick=task(stopLive);
setInterval(async()=>{if(!S.liveActive||video.paused||S.chunkPending||video.currentTime+.5<S.nextChunk)return;const start=S.nextChunk,version=S.version;S.nextChunk=start+S.settings.chunkSeconds;S.chunkPending=true;try{const r=await call('local-chunk',{id:S.liveSessionId,start,version});if(r?.dropped)toast('Распознавание не успевает: часть звука пропущена. Попробуй подготовку заранее.',true);}catch(e){toast(e.message,true);}finally{S.chunkPending=false;}},500);
function empty(container,title,text,symbol){const box=el('div','empty-state');if(symbol)box.append(icon(symbol));box.append(el('h3','',title),el('p','',text));container.append(box);}

function renderWords(){
  const now=Date.now(),stats=LingoUI.wordStats(S.words,now);$('stat-words').textContent=stats.total;$('stat-week').textContent='↑ +'+stats.week+' на этой неделе';$('stat-learned').textContent=stats.learnedToday;$('stat-favorites').textContent=stats.favorites;$('stat-level').textContent=stats.level;
  const list=$('word-list'),words=LingoUI.filterWords(S.words,{query:$('word-search').value,filter:$('word-filter').value,sort:S.wordSort||'date',reverse:!!S.wordReverse});list.replaceChildren();S.visibleWords=words;S.selectedWords??=new Set();
  if(!words.length)empty(list,'Здесь будут твои слова','Наведи курсор на слово в субтитрах и добавь его в словарь.');
  for(const w of words){
    const row=el('article','word-card'+(w.learned?' learned':'')),check=el('input');check.type='checkbox';check.checked=S.selectedWords.has(w.id);check.setAttribute('aria-label','Выбрать '+w.word);check.onchange=()=>{if(check.checked)S.selectedWords.add(w.id);else S.selectedWords.delete(w.id);updateWordSelection();};row.append(check);
    const head=el('div','word-details'),name=el('div','word-name');name.append(el('span','word',w.word),iconButton('Произнести '+w.word,'volume','word-audio',()=>call('speak',{text:w.word})));head.append(name);if(w.phonetic)head.append(el('div','word-phonetic',w.phonetic));head.append(el('div','meaning',w.translation));row.append(head);
    const context=el('div','word-context'),episode=S.episodes.find(e=>e.id===w.episodeId)||{title:w.title||''},image=wordImage(w,episode);if(image)context.append(image);const copy=el('div');copy.append(highlightContext(w.context||'',w.word));if(w.ruContext)copy.append(el('p','context-ru',w.ruContext));if(episode.title)copy.append(el('p','context-origin',episode.title+(Number.isFinite(w.position)?' · '+time(w.position):'')));context.append(copy);row.append(context);
    const levels=el('div','word-levels');levels.append(button(w.level||'—','level'+(w.level?' level-'+w.level.toLowerCase():''),event=>wordMenu(w,event)));if(w.tag)levels.append(el('span','tag',w.tag));row.append(levels,el('time','word-date',new Date(w.created).toLocaleDateString(LingoI18n.locale,{day:'numeric',month:'short',year:'numeric'})));
    const actions=el('div','word-actions');actions.append(favoriteButton(w),iconButton('Действия со словом','more','',event=>wordMenu(w,event)));row.append(actions);list.append(row);
  }
  updateWordSelection();
}
$('word-search').oninput=renderWords;$('word-filter').onchange=renderWords;$('export-words').onclick=task(()=>call('export-words'));
function renderHistory(){
  const items=LingoUI.historyItems(S.history,S.words,S.episodes),now=Date.now(),saved=items.filter(h=>h.kind!=='watch');
  $('history-streak').textContent=LingoUI.streak(items,now);$('history-word-count').textContent=new Set(saved.filter(h=>h.kind==='word').map(h=>h.word+'\n'+h.context)).size;$('history-phrase-count').textContent=new Set(saved.filter(h=>h.kind==='phrase').map(h=>h.word+'\n'+h.context)).size;
  const week=$('history-week');week.replaceChildren();const monday=new Date(now);monday.setHours(12,0,0,0);monday.setDate(monday.getDate()-(monday.getDay()+6)%7);const days=new Set(items.map(h=>LingoUI.dayKey(h.date)));
  for(let i=0;i<7;i++){const day=new Date(monday);day.setDate(day.getDate()+i);const node=el('span','streak-day'+(days.has(LingoUI.dayKey(day))?' active':''));node.append(el('i'),el('span','',['Пн','Вт','Ср','Чт','Пт','Сб','Вс'][i]));week.append(node);}
  const filtered=LingoUI.filterHistory(items,{filter:S.historyFilter||'all',query:$('history-search').value});filtered.sort((a,b)=>LingoUI.dayKey(a.date)===LingoUI.dayKey(b.date)?(b.kind==='watch')-(a.kind==='watch')||(b.date-a.date):b.date-a.date);const list=$('history-list');list.replaceChildren();
  if(!filtered.length)empty(list,'Пока чистая страница','Сохраняй слова и фразы — они появятся здесь вместе с контекстом.');
  let previousDay='';for(const h of filtered){const day=LingoUI.dayKey(h.date);if(day!==previousDay){const heading=el('div','history-day'),d=new Date(h.date),today=LingoUI.dayKey(now),yesterday=new Date(now);yesterday.setDate(yesterday.getDate()-1);heading.append(el('span','',day===today?'Сегодня':day===LingoUI.dayKey(yesterday)?'Вчера':d.toLocaleDateString(LingoI18n.locale,{day:'numeric',month:'long'})),el('small','',d.toLocaleDateString(LingoI18n.locale,{day:'numeric',month:'long',year:'numeric'})));list.append(heading);previousDay=day;}
    const entry=el('article','history-entry'),label=el('div','history-entry-label'),symbol=h.kind==='watch'?'play':h.kind==='phrase'?'chat':'volume';label.append(icon(symbol),el('span','',h.kind==='watch'?'ПРОСМОТР СЕРИИ':h.kind==='phrase'?'СОХРАНЕНА ФРАЗА':'СОХРАНЕНО СЛОВО'),el('time','',new Date(h.date).toLocaleTimeString(LingoI18n.locale,{hour:'2-digit',minute:'2-digit'})));entry.append(label);const card=el('div','history-entry-card');
    if(h.kind==='watch'){
      card.classList.add('watch-entry');const e=S.episodes.find(e=>e.id===h.episodeId);const img=episodeImage(e||{title:h.title},'watch-cover');if(img)card.append(img);const body=el('div','watch-content');body.append(el('h3','',h.title),el('small','',`Позиция: ${time(h.position||0)}`));card.append(body);if(e)card.append(actionButton('Смотреть снова','play','secondary',()=>selectEpisode(e.id)));
    }else{
      const badge=el('span','history-symbol');badge.append(icon(symbol));const main=el('div','entry-main');main.append(badge,el('div','entry-word',h.word));card.append(main);const details=el('div','entry-details');details.append(el('p','entry-meaning',h.translation),el('p','entry-context',h.context));if(h.title)details.append(el('p','entry-source',h.title));card.append(details);const w=S.words.find(w=>w.id===h.savedId);if(w){details.append(favoriteButton(w));card.append(iconButton('Действия с записью','more','history-more',event=>wordMenu(w,event)));}
    }
    entry.append(card);list.append(entry);
  }
  const recent=$('recent-activity');recent.replaceChildren();for(const h of items.slice(0,5))recent.append(activityRow(h));if(!items.length)recent.append(el('p','empty-small','Активность появится после просмотра и сохранения слов.'));
  const favorites=S.words.filter(w=>w.favorite&&LingoUI.kind(w)==='phrase');$('favorite-phrase-count').textContent=favorites.length;const fav=$('favorite-phrases');fav.replaceChildren();for(const w of favorites.slice(0,4))fav.append(activityRow({kind:'phrase',word:w.word,title:w.title,episodeId:w.episodeId,position:w.position}));if(!favorites.length)fav.append(el('p','empty-small','Отмечай любимые фразы звёздочкой.'));
  const watched=$('recent-watched');watched.replaceChildren();for(const e of S.episodes.filter(e=>e.lastWatched).sort((a,b)=>b.lastWatched-a.lastWatched).slice(0,3))watched.append(activityRow({kind:'watch',title:e.title,episodeId:e.id,date:e.lastWatched}));if(!watched.children.length)watched.append(el('p','empty-small','Здесь появятся просмотренные серии.'));
}$('clear-history').onclick=task(()=>call('clear-history'));
function fillSettings(){const form=$('settings-form');for(const [key,value] of Object.entries(S.settings)){const input=form.elements.namedItem(key);if(!input)continue;if(input.type==='checkbox')input.checked=!!value;else input.value=value;}$('settings-reading-mode').value=S.settings.readingMode?'short':'full';preview();appearance();syncThemeUI();}
function preview(){
  const f=$('settings-form');$('font-output').textContent=f.fontSize.value+' px';$('ru-output').textContent=f.ruSize.value+' px';$('bottom-output').textContent=f.bottom.value+'%';$('opacity-output').textContent=f.opacity.value+'%';
  $('preview-en').style.fontSize=(+f.fontSize.value/36*22)+'px';$('preview-ru').style.fontSize=(+f.ruSize.value/24*15)+'px';for(const input of [f.fontSize,f.ruSize,f.bottom,f.opacity])paintRange(input);
}
$('settings-form').oninput=preview;$('settings-form').onsubmit=task(async event=>{event.preventDefault();const form=$('settings-form'),values=Object.fromEntries(new FormData(form));for(const key of ['gpu','pauseOnHover','readingMode','readingHold','readingAutoPause'])values[key]=form.elements.namedItem(key).checked;S.settings=await call('settings',values);resetReading();appearance();renderCue(true);toast('Настройки сохранены.');});
$('open-models').onclick=()=>page('models');
$('load-model').onclick=task(async()=>{$('load-model').disabled=true;$('load-model').textContent='Загружаю модель…';try{await call('load-model');toast('Переводчик проверен. Модель выгружена из памяти.');}finally{$('load-model').disabled=false;$('load-model').textContent='Проверить переводчик';}});
async function diagnostics(){
  $('run-diagnostics').disabled=true;$('header-diagnostics').disabled=true;
  try{const d=await call('diagnostics');S.diagnostics=d;renderDiagnostics(d);}catch(e){toast(e.message,true);}finally{$('run-diagnostics').disabled=false;$('header-diagnostics').disabled=false;}
}
$('run-diagnostics').onclick=diagnostics;
document.addEventListener('pointerdown',event=>{if(!$('word-tip').contains(event.target)&&!$('en-line').contains(event.target))S.hoverPaused=false;},true);
document.addEventListener('keydown',event=>{if(document.querySelector('dialog[open]'))return;if(/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||event.ctrlKey||event.metaKey||event.altKey)return;if(event.key==='Escape'){if(!$('subtitle-dialog').hidden)$('subtitle-dialog').hidden=true;else if(!$('word-menu').hidden)$('word-menu').hidden=true;else if(!$('phrase-card').hidden)closePhrase();else hideTip();return;}if(S.page!=='watch')return;const actions={Space:play,KeyR:()=>seekCue(),KeyA:()=>task(toggleReadingPause)(),KeyT:showPhrase,KeyF:()=>task(fullscreen)(),BracketLeft:()=>seekCue(-1),BracketRight:()=>seekCue(1),ArrowLeft:()=>video.currentTime=Math.max(0,video.currentTime-5),ArrowRight:()=>video.currentTime=Math.min(video.duration||Infinity,video.currentTime+5)};if(actions[event.code]){event.preventDefault();S.hoverPaused=false;actions[event.code]();}});
window.lingo.subscribe(event=>{if(event.type==='state'){const liveActive=S.liveActive;Object.assign(S,event.data);S.liveActive=liveActive;renderState();}if(event.type==='live-cue'&&S.liveActive&&event.data.id===S.liveSessionId&&event.data.version===S.version){const {cue,lag}=event.data;S.liveCues.push(cue);$('export-subs').disabled=false;S.lag=lag;if(cue.end<video.currentTime){S.lateCue=cue;S.lateUntil=Date.now()+Math.min(8000,Math.max(3000,cue.text.length*55));}renderCue(true);renderTranscript(true);}if(event.type==='live-error')toast(event.data.error,true);if(event.type==='open-media')task(openMedia)();if(event.type==='settings')page('settings');if(event.type==='enhance-page')page('enhance');});

function fillSubtitleTracks(){const select=$('subtitle-source');select.replaceChildren(new Option('Выбери встроенную дорожку или файл рядом…',''));for(const track of S.current?.subtitleTracks||[]){const option=new Option(`${track.type==='embedded'?'Встроенные':'Файл'} · ${track.label} · ${track.language}${track.text?'':' · графические'}`,track.id);option.disabled=!track.text;select.append(option);}$('select-subtitle-track').disabled=!S.current?.subtitleTracks?.some(t=>t.text);}
$('select-subtitle-track').onclick=task(async()=>{if(!$('subtitle-source').value)throw Error('Выбери текстовую дорожку');let language=$('import-language').value;if(language==='auto'){const track=S.current.subtitleTracks.find(t=>t.id===$('subtitle-source').value);language=/^(ru|rus)$/i.test(track?.language)?'ru':'en';}await call('select-subs',{id:S.current.id,trackId:$('subtitle-source').value,language});await loadCues();toast('Субтитры подключены.');});
let dragDepth=0;
document.addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();dragDepth++;$('drop-overlay').hidden=false;}});
document.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('drop-overlay').hidden=true;}});
document.addEventListener('drop',task(async event=>{event.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;if(event.dataTransfer?.files.length){const result=await window.lingo.addDropped([...event.dataTransfer.files],S.current?.id,S.page==='library'?S.libraryFolder:undefined);if(result.error)throw Error(result.error);await acceptImport(result.value);}}));
function selectedEnhanceIds(){return [...S.selectedEnhance].filter(id=>S.episodes.some(e=>e.id===id));}
function renderEnhance(){
  $('output-directory').textContent=S.settings.outputDirectory||'';
  const available=S.episodes.filter(e=>e.video);
  if(available.length&&!S.enhanceInitialized){S.enhanceInitialized=true;S.selectedEnhance.add(S.current?.id||available[0].id);}
  S.enhancePicked??=new Set(S.selectedEnhance);const picked=available.filter(e=>S.enhancePicked.has(e.id));
  const signature=JSON.stringify(picked.map(e=>[e.id,e.title,e.width,e.height,e.duration]));
  if(signature!==S.enhanceSourceSignature){S.enhanceSourceSignature=signature;const list=$('enhance-episodes');list.replaceChildren();if(!picked.length)empty(list,'Добавь первую серию','Здесь появятся видео из твоей библиотеки.');for(const e of picked){const label=el('label','enhance-select'),check=el('input');check.type='checkbox';check.checked=S.selectedEnhance.has(e.id);check.dataset.episode=e.id;check.onchange=()=>{if(check.checked)S.selectedEnhance.add(e.id);else S.selectedEnhance.delete(e.id);renderEnhance();};const image=episodeImage(e,'enhance-thumb');const info=el('span');info.append(el('strong','',e.title),el('small','',`${e.width}×${e.height} · ${time(e.duration)} · ${fps(e.frameRate)} FPS`));label.append(check);if(image)label.append(image);label.append(info,iconButton('Убрать из списка','close','enhance-remove',event=>{event.preventDefault();event.stopPropagation();S.enhancePicked.delete(e.id);S.selectedEnhance.delete(e.id);renderEnhance();}));list.append(label);}}
  const ids=selectedEnhanceIds(),recoveryError=S.enhancePolicy?.recoveryError;$('enhance-start-job').disabled=!ids.length||!!recoveryError;$('enhance-preview').disabled=!ids.length||!!recoveryError;const safetyStatus=$('enhance-safety-status');safetyStatus.dataset.defaultText??=safetyStatus.textContent;safetyStatus.textContent=recoveryError?'Защита не готова: '+recoveryError:safetyStatus.dataset.defaultText;
  $('enhance-queue-count').textContent=`${(S.enhancements||[]).filter(j=>['queued','working','cancelling'].includes(j.state)).length} в очереди`;
  $('enhance-stop-all').hidden=!(S.enhancements||[]).some(j=>['queued','working','cancelling'].includes(j.state));
  const jobs=S.enhancements||[],queueSignature=JSON.stringify(jobs.map(j=>[j.id,j.state,j.phase,j.done,Math.round(j.progress||0),j.error]));
  if(S.enhanceQueueSignature!==queueSignature){S.enhanceQueueSignature=queueSignature;const queue=$('enhance-queue');queue.replaceChildren();if(!jobs.length)empty(queue,'Очередь пуста','Добавь серии и выбери параметры, чтобы начать улучшение.','queue');for(const j of jobs){const card=el('article','panel enhance-job'),head=el('div','row spread'),left=el('div');left.append(el('h3','',j.title),el('small','',`${j.preview?'Пробный фрагмент':'Полная серия'} · ${j.scale}× · ${engineLabel(j)}`));const state=({queued:'Ожидает',working:({loading:'Загружаю модель',processing:'Улучшаю кадры',encoding:'Завершаю видео',verifying:'Проверяю результат'})[j.phase]||'Улучшаю кадры',ready:'Готово',error:'Ошибка',cancelled:'Отменено',cancelling:'Останавливаю',interrupted:'Прервано'})[j.state]||j.state;head.append(left,el('span','pill',state));card.append(head);if(j.state==='working'){const progress=el('div','progress-track'),bar=el('i');bar.style.width=(j.progress||0)+'%';progress.append(bar);card.append(progress,el('p','hint',`${j.done||0} / ${j.total||'?'} кадров · ${(j.fps||0).toFixed(1)} кадров/с · ${j.phase==='encoding'?'Сохраняю результат':Number.isFinite(j.eta)?'осталось примерно '+time(j.eta):'рассчитываю время…'}`));}if(j.error)card.append(el('p','capture-error',j.error));if(j.previewWarning)card.append(el('p','hint',j.previewWarning));if(j.fallback)card.append(el('p','hint',`Видеокарта не справилась, задача выполнена на процессоре. Причина: ${j.fallback.reason}`));const actions=el('div','row');if(['queued','working'].includes(j.state))actions.append(button('Отменить','secondary',()=>call('cancel',{id:j.id})));if(j.state==='ready'){if(!j.preview)actions.append(button('Смотреть результат','primary',async()=>{const e=await call('use-enhanced',{id:j.id});await refresh();await selectEpisode(e.id);}));actions.append(button(j.preview?'Показать сравнение':'Открыть папку','secondary',()=>j.preview?showComparison(j):call('reveal-enhanced',{id:j.id})));if(j.result)card.append(el('p','hint',`${j.result.width}×${j.result.height} · обработано за ${time(j.result.seconds)}`));}card.append(actions);queue.append(card);}}

}
function showComparison(job){S.comparisonId=job.id;$('enhance-comparison').hidden=false;const images=job.comparisonReady??true;$('comparison-before').parentElement.hidden=!images;$('comparison-after').parentElement.hidden=!images;if(images){$('comparison-before').src=`lingo-media://enhancement/${job.id}/before.jpg`;$('comparison-after').src=`lingo-media://enhancement/${job.id}/after.jpg`;}$('enhance-preview-video').pause();$('enhance-preview-video').removeAttribute('src');$('enhance-preview-video').hidden=true;$('enhance-preview-play').hidden=false;$('comparison-warning').hidden=!job.previewWarning;$('comparison-warning').textContent=job.previewWarning||'';$('comparison-info').textContent=`${job.engine==='cpu'?'Безопасный режим':job.engine==='anime4k'?'Anime4K · прежний результат':'Real-ESRGAN · прежний результат'} · ${job.scale}× · ${job.result?.width}×${job.result?.height}`;$('enhance-comparison').scrollIntoView({behavior:'smooth',block:'start'});}
$('enhance-preview-play').onclick=task(async()=>{if(!S.comparisonId)return;$('enhance-preview-video').src=`lingo-media://enhancement/${S.comparisonId}/video`;$('enhance-preview-video').hidden=false;$('enhance-preview-play').hidden=true;await $('enhance-preview-video').play();});
$('enhance-stop-all').onclick=task(async()=>{await call('cancel-enhancements');toast('Останавливаю очередь улучшения.');});

$('choose-output').onclick=task(async()=>{const dir=await call('pick-output');if(dir){S.settings.outputDirectory=dir;renderEnhance();}});
async function beginEnhancement(preview){const ids=selectedEnhanceIds();if(!ids.length)throw Error('Выбери серию');if($('enhance-engine').value!=='cpu'&&!confirm('GPU-режим не изолирован и на некоторых драйверах может подвесить систему. Работа идёт короткими отрезками; при сбое задача повторится на процессоре. Исходное видео не изменяется.\n\nПродолжить?'))return;if(S.liveActive)await stopLive();video.pause();const waiting=preview&&(S.enhancements||[]).some(j=>['queued','working','cancelling'].includes(j.state));const jobs=await call('enhance',{ids:preview?ids.slice(0,1):ids,scale:+$('enhance-scale').value,engine:$('enhance-engine').value,profile:$('enhance-profile').value,preview,start:+$('enhance-start').value,seconds:+$('enhance-seconds').value});toast(preview?(waiting?'Проба в очереди: сначала завершится текущая задача.':'Пробный фрагмент добавлен в очередь.'):`Добавлено задач улучшения: ${jobs.length}`);}
$('enhance-preview').onclick=task(()=>beginEnhancement(true));$('enhance-start-job').onclick=task(()=>beginEnhancement(false));

function icon(name){const node=el('span','svg-icon');if(/^[a-z]+$/.test(name))node.innerHTML=`<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;return node;}
function actionButton(label,symbol,cls,fn){const b=button('',cls,fn);b.append(icon(symbol),el('span','',label));return b;}
function iconButton(label,symbol,cls,fn){const b=button('','icon-button'+(cls?' '+cls:''),fn);b.title=label;b.setAttribute('aria-label',label);b.append(icon(symbol));return b;}
function meter(value){const node=el('div','meter'),bar=el('i');bar.style.width=Math.max(0,Math.min(100,+value||0))+'%';node.append(bar);return node;}
function paintRange(input){const min=+(input.min||input.getAttribute('min'))||0,max=+(input.max||input.getAttribute('max'))||100,percent=Math.max(0,Math.min(100,(+input.value-min)/Math.max(.001,max-min)*100));input.style.background=`linear-gradient(90deg,#80beff 0%,#72aaff ${percent}%,#2b3450 ${percent}%,#2b3450 100%)`;}
function episodeImage(episode,cls=''){const source=coverSource(episode);if(source){const img=el('img',cls);img.src=source;img.alt='Обложка '+episode.title;img.onerror=()=>img.remove();return img;}let file=LingoUI.art(episode);if(!file)return null;const img=el('img',cls);img.src='../assets/reference/'+file;img.alt='Обложка '+episode.title;return img;}
function libraryTitle(title){const node=el('h3'),parts=title.split(/ (?=\[English)/i);parts.forEach((part,i)=>{if(i)node.append(document.createElement('br'));node.append(document.createTextNode(part));});return node;}
function wordImage(word,episode){const name=String(word.word||'').toLowerCase();if(LingoUI.art(episode)==='fate-cover.png'&&['reactor','artificial','suitable','select','circuit','homunculi'].includes(name)){const img=el('img');img.src='../assets/reference/word-'+name+'.png';img.alt='Иллюстрация из референса';return img;}return episodeImage(episode);}
function updateEpisodeHeading(episode){const source=coverSource(episode),file=LingoUI.art(episode),img=$('episode-cover');img.hidden=!source&&!file;if(source||file)img.src=source||'../assets/reference/'+file;$('episode-meta').textContent=`${time(episode.duration)}  ·  ${episode.width||0}×${episode.height||0}  ·  ${fps(episode.frameRate)} FPS`;}
function openSubtitleTools(){video.pause();$('subtitle-dialog').hidden=false;$('subtitle-dialog-close').focus();}
function highlightContext(text,word){const node=el('p','context-en'),at=text.toLocaleLowerCase().indexOf(word.toLocaleLowerCase());if(at<0){node.textContent=text;return node;}node.append(document.createTextNode(text.slice(0,at)),el('mark','',text.slice(at,at+word.length)),document.createTextNode(text.slice(at+word.length)));return node;}
async function removeEpisode(id){await call('remove',{id});if(S.current?.id===id){video.pause();video.removeAttribute('src');video.load();S.current=null;resetReading();$('player-empty').hidden=false;$('video-controls').hidden=true;$('subtitle-layer').hidden=true;$('episode-cover').hidden=true;$('episode-title').textContent='Выбери, с чего начать';$('episode-meta').textContent='';}await refresh();}
function episodeMenu(episode,event){contextMenu([{label:'Открыть серию',icon:'play',action:()=>selectEpisode(episode.id)},{label:'Переместить в папку',icon:'folder',action:()=>openMoveDialog([episode.id])},{label:'Показать видео в файлах',icon:'folder',action:()=>call('reveal-episode',{id:episode.id})},{label:'Удалить из библиотеки',icon:'trash',action:()=>removeEpisode(episode.id)}],event);}
function contextMenu(items,event){
  const menu=$('word-menu');menu.replaceChildren();for(const item of items)menu.append(actionButton(item.label,item.icon,'',async()=>{menu.hidden=true;await item.action();}));
  const box=event?.currentTarget?.getBoundingClientRect?.()||{right:window.innerWidth-20,bottom:180};menu.style.left=Math.max(8,Math.min(window.innerWidth-246,box.right-215))+'px';menu.style.top=Math.max(40,Math.min(window.innerHeight-300,box.bottom+6))+'px';menu.hidden=false;
}
function wordMenu(word,event){
  contextMenu([{label:word.learned?'Вернуть к изучению':'Отметить выученным',icon:'check',action:()=>call('update-word',{id:word.id,action:'learned'})},{label:word.favorite?'Убрать из избранного':'В избранное',icon:'star',action:()=>call('update-word',{id:word.id,action:'favorite'})},{label:'Произнести',icon:'volume',action:()=>call('speak',{text:word.word})},{label:'Удалить слово',icon:'trash',action:()=>call('update-word',{id:word.id,action:'delete'})}],event);
  const menu=$('word-menu');menu.append(el('div','menu-label','УРОВЕНЬ СЛОВА'));const row=el('div','menu-levels');for(const level of LingoUI.levels)row.append(button(level,'',async()=>{await call('update-word',{id:word.id,action:'level',value:level});menu.hidden=true;}));menu.append(row);menu.append(button('Убрать уровень','',async()=>{await call('update-word',{id:word.id,action:'level',value:''});menu.hidden=true;}));
}
function favoriteButton(word){const b=button('','favorite'+(word.favorite?' active':''),async event=>{event.stopPropagation();await call('update-word',{id:word.id,action:'favorite'});});b.title=word.favorite?'Убрать из избранного':'В избранное';b.setAttribute('aria-label',b.title);b.setAttribute('aria-pressed',String(!!word.favorite));b.append(icon('star'));return b;}
function updateWordSelection(){S.selectedWords??=new Set();for(const id of S.selectedWords)if(!S.words.some(w=>w.id===id))S.selectedWords.delete(id);$('word-bulk').hidden=!S.selectedWords.size;$('word-selection-count').textContent='Выбрано: '+S.selectedWords.size;$('words-select-all').checked=!!S.visibleWords?.length&&S.visibleWords.every(w=>S.selectedWords.has(w.id));}
async function savePhrase(cue){if(!cue?.text)return;await call('save-word',{kind:'phrase',word:cue.text,context:cue.text,translation:cue.ru||S.translations.get(cue.text)||'',episodeId:S.current?.id,position:cue.start,ruContext:cue.ru||''});toast('Фраза сохранена.');}
function activityRow(item){const row=el('div','activity-item');row.append(icon(item.kind==='watch'?'film':item.kind==='phrase'?'quote':'book'));if(item.date)row.append(el('time','',new Date(item.date).toLocaleTimeString(LingoI18n.locale,{hour:'2-digit',minute:'2-digit'})));const copy=el('div'),title=item.kind==='watch'?item.title:item.word;copy.append(button(String(title||'').length>42?String(title).slice(0,41)+'…':title||'','',async()=>{if(item.episodeId&&S.episodes.some(e=>e.id===item.episodeId)){await selectEpisode(item.episodeId);if(Number.isFinite(item.position))video.currentTime=item.position;}else if(item.word)await call('speak',{text:item.word});}));copy.append(el('small','',item.kind==='watch'?'просмотр серии':item.kind==='phrase'?'новая фраза':'новое слово'));row.append(copy);return row;}
function gib(value){return Number.isFinite(value)?(value/1024**3).toFixed(1).replace(/\.0$/,'')+' GB':'—';}
function renderDiagnostics(d){
  const sys=d.system||{},gpu=sys.gpu?.[0],cpu=sys.cpu||{},memory=sys.memory||{},disk=sys.disk,models=d.items.filter(x=>/Qwen3-ASR|ForcedAligner|Модель улучшения/.test(x.name)),ok=d.items.every(x=>x.ok);
  $('diagnostic-title').replaceChildren(document.createTextNode(ok?'Компоненты ':''),el('span',ok?'accent':'',ok?'найдены':'Есть компоненты для проверки'));$('diagnostic-orb').classList.toggle('warning',!ok);
  $('diagnostic-description').textContent='Проверка файлов, компонентов и системных данных. Модели и GPU для проверки не запускались.';
  $('diagnostic-last').textContent='Последняя проверка: '+new Date(d.checked).toLocaleString(LingoI18n.locale);$('diagnostic-ready').textContent=ok?'Необходимые файлы найдены. Состояние моделей и обработки проверяется при запуске задачи.':'Открой подробный отчёт, чтобы узнать, какие компоненты не найдены.';
  const used=memory.total?100*memory.used/memory.total:0,cpuPercent=cpu.threads&&cpu.load?100*cpu.load[0]/cpu.threads:0;
  const cards=[
    {title:'GPU / Графика',symbol:'cpu',ok:!!gpu,status:gpu?'Обнаружена':'Не определена',device:gpu?.name||'Данные недоступны',detail:gpu?`Драйвер: ${gpu.driver||'—'} · PCI ${gpu.vendor}:${gpu.device}`:'GPU-пробы не выполнялись',resource:'Использование VRAM',value:gpu?.vramTotal?gib(gpu.vramUsed)+' / '+gib(gpu.vramTotal):'Не проверялось',percent:gpu?.vramTotal?100*gpu.vramUsed/gpu.vramTotal:0},
    {title:'CPU / Процессор',symbol:'cpu',ok:!!cpu.name,status:cpu.name?'Обнаружен':'Нет данных',device:cpu.name||'Нет данных',detail:(cpu.threads||'—')+' потоков'+(cpu.mhz?' · '+(cpu.mhz/1000).toFixed(2)+' GHz':''),resource:'Средняя нагрузка за 1 мин',value:cpu.load?cpu.load[0].toFixed(2):'—',percent:cpuPercent},
    {title:'Память (RAM)',symbol:'ram',ok:!!memory.total,status:memory.total?'Доступно':'Нет данных',device:gib(memory.total),detail:'Оперативная память системы',resource:'Используется '+gib(memory.used),value:memory.total?Math.round(used)+'%':'—',percent:used},
    {title:'Видео декодирование',symbol:'film',ok:!!sys.ffmpeg,status:sys.ffmpeg?'FFmpeg найден':'Не найден',device:'Встроенный плеер',detail:'Аппаратное ускорение не проверялось'},
    {title:'Модели ИИ',symbol:'cube',ok:models.length>0&&models.every(x=>x.ok),status:models.every(x=>x.ok)?'Файлы найдены':'Проверить',device:d.modelState?.phase==='idle'?'Модели выгружены':d.modelState?.label||'Нет активных задач',detail:'Распознавание речи · Перевод · Субтитры'},
    {title:'FFmpeg / Кодеки',symbol:'code',ok:!!sys.ffmpeg,status:sys.ffmpeg?'Найден':'Не найден',device:sys.ffmpeg?.match(/^ffmpeg version \S+/)?.[0]||'FFmpeg не найден',detail:'Без запуска декодирования видео'}
  ];
  const list=$('diagnostic-items');list.replaceChildren();for(const c of cards){const card=el('article','diagnostic-card'+(c.ok?'':' error')),head=el('div','diagnostic-card-head'),badge=el('span','stat-icon');badge.append(icon(c.symbol));const copy=el('div');copy.append(el('h3','',c.title),el('p','device',c.device),el('small','',c.detail));head.append(badge,copy);card.append(head,el('span','diagnostic-status',c.status));if(c.resource){const line=el('div','resource-detail');line.append(el('span','',c.resource),el('strong','',c.value));card.append(line,meter(c.percent));}list.append(card);}
  $('disk-detail').textContent=disk?'Доступно '+gib(disk.available)+' из '+gib(disk.total):'Нет данных';const percent=disk?Math.round(100*disk.used/disk.total):0;$('disk-meter').style.width=percent+'%';$('disk-percent').textContent=disk?percent+'%':'—';$('disk-model-path').textContent=sys.modelsPath||S.settings.asrModel||'';
  const stamp=new Date(d.checked).toLocaleTimeString(LingoI18n.locale),lines=[`${stamp}  [INFO] Система: ${sys.platform||'—'} ${sys.release||''} (${sys.arch||''})`];for(const item of d.items)lines.push(`${stamp}  [${item.ok?'OK':'ПРОВЕРИТЬ'}] ${item.name}: ${item.detail}`);lines.push(`${stamp}  [INFO] GPU-пробы, обработка видео и запуск моделей не выполнялись.`);if(d.lastError)lines.push(`${stamp}  [ПОСЛЕДНЯЯ ОШИБКА] ${d.lastError}`);$('diagnostic-report').textContent=lines.join('\n');
}
$('window-minimize').onclick=task(()=>call('window-minimize'));$('window-maximize').onclick=task(()=>call('window-maximize'));$('window-close').onclick=task(()=>call('window-close'));
$('subtitle-tools').onclick=openSubtitleTools;$('subtitle-dialog-close').onclick=()=>$('subtitle-dialog').hidden=true;$('subtitle-dialog').onclick=event=>{if(event.target===$('subtitle-dialog'))$('subtitle-dialog').hidden=true;};
$('reading-settings').onclick=()=>page('settings');$('model-settings').onclick=()=>page('settings');
$('models-tab').onclick=()=>{document.querySelector('.model-panel').scrollIntoView({block:'nearest',behavior:'smooth'});$('models-tab').classList.add('selected');$('queue-tab').classList.remove('selected');};
$('queue-tab').onclick=()=>{$('enhance-queue').scrollIntoView({block:'center',behavior:'smooth'});$('queue-tab').classList.add('selected');$('models-tab').classList.remove('selected');};
$('enhance-reset').onclick=()=>{$('enhance-engine').value='cpu';applyEnhanceEngines();$('enhance-profile').value='clarity';$('enhance-scale').value='1';$('enhance-start').value='0';$('enhance-seconds').value='3';$('enhance-engine-hint').textContent='Чёткость линий · CPU';};
$('enhance-profile').onchange=()=>{applyEnhanceEngines();};$('enhance-engine').onchange=applyEnhanceEngines;
$('transcript-subtitles').onclick=()=>{S.transcriptMode='subtitles';document.querySelector('.transcript-panel').classList.remove('translation-tab');$('transcript-subtitles').classList.add('selected');$('transcript-translation').classList.remove('selected');renderTranscript(true);};
$('transcript-translation').onclick=()=>{S.transcriptMode='translation';document.querySelector('.transcript-panel').classList.add('translation-tab');$('transcript-translation').classList.add('selected');$('transcript-subtitles').classList.remove('selected');renderTranscript(true);};
$('subtitles-toggle').onclick=()=>{S.subtitlesHidden=!S.subtitlesHidden;S.lastRendered='';renderCue(true);};$('mute').onclick=()=>{video.muted=!video.muted;$('mute').setAttribute('aria-pressed',String(video.muted));};
$('phrase-save').onclick=task(()=>savePhrase({text:S.readingFrame?.context,ru:S.readingFrame?.ruContext,start:S.active?.start??video.currentTime}));
$('words-select-all').onchange=()=>{S.selectedWords??=new Set();for(const w of S.visibleWords||[]){if($('words-select-all').checked)S.selectedWords.add(w.id);else S.selectedWords.delete(w.id);}renderWords();};
$('word-sort').onclick=()=>{S.wordReverse=S.wordSort==='word'?!S.wordReverse:false;S.wordSort='word';renderWords();};$('word-date-sort').onclick=()=>{S.wordReverse=S.wordSort==='date'?!S.wordReverse:false;S.wordSort='date';renderWords();};
$('word-bulk-learn').onclick=task(async()=>{for(const id of S.selectedWords||[])if(!S.words.find(w=>w.id===id)?.learned)await call('update-word',{id,action:'learned'});S.selectedWords.clear();await refresh();renderWords();});
$('word-bulk-delete').onclick=task(async()=>{for(const id of S.selectedWords||[])await call('update-word',{id,action:'delete'});S.selectedWords.clear();await refresh();renderWords();});
$('history-search').oninput=renderHistory;for(const b of document.querySelectorAll('[data-history]'))b.onclick=()=>{S.historyFilter=b.dataset.history;for(const n of document.querySelectorAll('[data-history]'))n.classList.toggle('selected',n===b);renderHistory();};
$('header-history-clear').onclick=()=>$('clear-history').click();$('header-diagnostics').onclick=diagnostics;$('reveal-models').onclick=task(()=>call('reveal-models'));$('copy-diagnostics').onclick=task(async event=>{event.preventDefault();event.stopPropagation();await call('copy-text',{text:$('diagnostic-report').textContent});toast('Отчёт скопирован.');});
$('settings-reading-mode').onchange=()=>{$('settings-form').elements.namedItem('readingMode').checked=$('settings-reading-mode').value==='short';};$('settings-form').elements.namedItem('readingMode').addEventListener('change',()=>{$('settings-reading-mode').value=$('settings-form').elements.namedItem('readingMode').checked?'short':'full';});
document.addEventListener('pointerdown',event=>{if(!$('word-menu').contains(event.target))$('word-menu').hidden=true;});
document.addEventListener('fullscreenchange',()=>{const tip=$('word-tip');if(document.fullscreenElement===$('player'))$('player').append(tip);else $('word-dock').append(tip);});
initLibrary();initThemeUI();initPlayerControls();task(refresh)();setTimeout(()=>task(()=>maybeStartWizard())(),700);setInterval(()=>{renderCue();},150);

if(video.requestVideoFrameCallback){const frame=()=>{renderCue();video.requestVideoFrameCallback(frame);};video.requestVideoFrameCallback(frame);}
