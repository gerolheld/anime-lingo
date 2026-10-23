'use strict';
// "Models" screen: devices, downloads (pause / resume / remove), what is in memory.
const M={status:null,seen:{},busy:false,tab:'devices'};
const MODEL_TABS=[['devices','Устройства'],['recognition','Распознавание'],['translation','Перевод'],['video','Видео'],['system','Система']];
function setModelsTab(name){M.tab=name;renderModels();}
const GB=1024**3;
const sizeText=bytes=>bytes>=GB?(bytes/GB).toFixed(1).replace('.',LingoI18n.language==='en'?'.':',')+' ГБ':Math.round(bytes/1024**2)+' МБ';
const JOB_LABEL={downloading:'скачивается',extracting:'распаковка',verifying:'проверка',copying:'копирование',installing:'установка',paused:'пауза',error:'ошибка',ready:'готово'};
const RECOGNITION_LABEL={auto:'Автоматически',cpu:'Процессор (CPU)',cuda:'NVIDIA · CUDA',xpu:'Intel · XPU',rocm:'AMD · ROCm (Linux)'};
const TRANSLATION_LABEL={auto:'Автоматически',cpu:'Процессор (CPU)',cuda:'NVIDIA · CUDA',vulkan:'Vulkan (AMD, Intel, NVIDIA)',sycl:'Intel · SYCL (вручную)',hip:'AMD · HIP / ROCm (вручную)'};

function jobOf(name){return S.components?.[name]||null;}
function badge(text,kind=''){return el('span','model-badge '+kind,text);}
function progressBar(job){
  const bar=el('div','meter model-meter'),fill=document.createElement('i');
  fill.style.width=(job.percent??0)+'%';bar.append(fill);
  if(job.percent==null)bar.classList.add('indeterminate');
  return bar;
}
function jobLine(job){
  if(!job)return null;
  const parts=[JOB_LABEL[job.state]||job.state];
  if(job.percent!=null&&['downloading','extracting','verifying','copying'].includes(job.state))parts.push(job.percent+'%');
  if(job.speed>0)parts.push(sizeText(job.speed)+'/с');
  if(job.eta>0&&job.eta<86400)parts.push('осталось '+(job.eta<90?Math.round(job.eta)+' с':Math.round(job.eta/60)+' мин'));
  if(job.message)parts.push(job.message);
  return parts.join(' · ');
}
function modelButton(text,handler,cls='secondary compact',disabled=false){
  const b=el('button',cls,text);b.type='button';b.disabled=disabled;b.onclick=task(handler);return b;
}
function row(title,detail,{state,actions=[],job,note}={}){
  const left=el('div','model-info');left.append(el('strong','',title));
  if(detail)left.append(el('small','',detail));
  if(note)left.append(el('small','model-note',note));
  const mid=el('div','model-state');
  if(state)mid.append(badge(state.text,state.kind));
  const line=jobLine(job);
  if(job&&['downloading','extracting','verifying','copying','installing'].includes(job.state)){mid.append(progressBar(job));}
  if(line&&job.state!=='ready')mid.append(el('small',job.state==='error'?'model-error':'',job.state==='error'?(job.error||line):line));
  const right=el('div','model-actions');right.append(...actions);
  return buildRow(left,mid,right);
}
function buildRow(left,mid,right){const r=el('div','model-row');r.append(left,mid,right);return r;}
function card(title,subtitle,icon,rows){
  const heading=el('div','setting-heading'),round=el('span','round-icon');
  round.innerHTML=`<svg class="icon" aria-hidden="true"><use href="#i-${icon}"></use></svg>`;
  const text=el('div');text.append(el('h2','',title));if(subtitle)text.append(el('p','',subtitle));
  heading.append(round,text);
  const panel=el('div','panel model-card');panel.append(heading,...rows);return panel;
}
const isBusy=job=>job&&['downloading','extracting','verifying','copying','installing'].includes(job.state);
async function act(name,options){await call('install-component',{name,options});await refreshModels();}
async function pause(name){await call('pause-component',{name});await refreshModels();}
async function removeComponent(name,options,what){
  if(!confirm('Удалить '+what+'? Скачать можно будет снова.'))return;
  await call('remove-component',{name,options});toast('Удалено: '+what+'.');await refreshModels();
}
function installActions(name,job,{ready,label,options,removeOptions,removeLabel,size}){
  const out=[];
  if(isBusy(job))out.push(modelButton('Пауза',()=>pause(name)));
  else{
    if(!ready)out.push(modelButton(job?.state==='paused'?'Продолжить':job?.state==='error'?'Повторить':'Скачать'+(size?' · '+sizeText(size):''),()=>act(name,options),'primary compact'));
    if(ready&&removeOptions!==null)out.push(modelButton('Удалить',()=>removeComponent(name,removeOptions||{},removeLabel||label),'secondary compact'));
  }
  return out;
}

function deviceSelect(key,options,labels,current){
  const select=document.createElement('select');
  const auto=new Option(labels.auto,'auto');select.append(auto);
  for(const o of options){
    const text=labels[o.id]+(o.device&&o.id!=='cpu'&&o.available?' — '+o.device:'');
    const opt=new Option(o.available?text:text+' — недоступно',o.id);opt.disabled=!o.available&&o.id!==current;opt.title=o.reason||'';select.append(opt);
  }
  select.value=current||'auto';
  select.onchange=task(async()=>{S.settings=await call('settings',{[key]:select.value});toast('Устройство сохранено.');await refreshModels();});
  return select;
}
function deviceCard(st){
  const caps=st.capabilities,s=S.settings;
  const gpuText=(st.gpus||[]).length?st.gpus.map(g=>`${g.name}${g.vramTotal?' · '+sizeText(g.vramTotal):''}${g.driver?' · драйвер '+g.driver:''}`).join('; '):'Видеокарта не обнаружена — всё работает на процессоре.';
  const field=(label,select,note)=>{const w=el('label','model-field');w.append(el('span','',label),select);if(note)w.append(el('small','model-note',note));return w;};
  const recognition=caps.recognition.find(o=>o.id===s.qwenDevice),translation=caps.translation.find(o=>o.id===s.translationDevice);
  const first=el('div','model-row single'),info=el('div','model-info');
  info.append(el('strong','','Видеокарты'),el('small','',gpuText));const wiz=el('div','model-actions');wiz.append(modelButton('Мастер настройки',()=>maybeStartWizard(true)));first.classList.remove('single');first.style.gridTemplateColumns='1fr auto';first.append(info,wiz);
  const grid=el('div','model-fields');
  grid.append(
    field('Распознавание речи',deviceSelect('qwenDevice',caps.recognition,RECOGNITION_LABEL,s.qwenDevice),recognition&&!recognition.available?recognition.reason:'Автоматически: NVIDIA, затем Intel Arc; иначе процессор. Radeon подключается только вручную.'),
    field('Перевод Hy-MT2',deviceSelect('translationDevice',caps.translation,TRANSLATION_LABEL,s.translationDevice),translation&&!translation.available?translation.reason:'Автоматически: NVIDIA CUDA, иначе Vulkan (подходит AMD, Intel и NVIDIA), иначе процессор.'),
    field('Видео',(()=>{const s=document.createElement('select');s.append(new Option('Процессор (безопасный режим по умолчанию)'));s.disabled=true;return s;})(),'GPU-режим включается отдельно ниже, в карточке «Улучшение видео на видеокарте».'),
  );
  const quant=document.createElement('select');
  for(const [value,label] of [['auto','Автоматически по видеопамяти'],['Q8_0','Q8_0 — лучшее качество (7,6 ГБ)'],['Q6_K','Q6_K — баланс (5,9 ГБ)'],['Q4_K_M','Q4_K_M — компактная (4,4 ГБ)']])quant.append(new Option(label,value));
  quant.value=s.translationQuant||'auto';
  quant.onchange=task(async()=>{S.settings=await call('settings',{translationQuant:quant.value});await refreshModels();});
  grid.append(field('Квантизация перевода',quant,st.activeQuant?'Сейчас будет использована: '+st.activeQuant:''));
  return card('Устройства','Для каждой задачи — автоматический или ручной выбор. Недоступное устройство не подменяется молча.','cpu',[first,grid]);
}
function recognitionCard(st){
  const env=st.recognitionEnv,models=st.recognitionModels,jobEnv=jobOf('qwen-env'),jobModels=jobOf('qwen-models');
  const envDetail=env.exists?`Python · PyTorch ${env.torchVersion||'?'} (${env.torchBackend||'?'})${env.qwenAsr?' · qwen-asr':' · qwen-asr не найден'}`:'Python 3.12 и PyTorch устанавливаются программой в свою папку.';
  const wanted=env.wantedBackend;
  const envRow=row('Окружение распознавания',envDetail,{
    state:env.ready?{text:env.mismatch?'не подходит':'готово',kind:env.mismatch?'warn':'ok'}:{text:'не установлено'},job:jobEnv,
    note:env.mismatch?`Для вашей видеокарты нужна сборка «${wanted}», а установлена «${env.torchBackend}». Переустановите окружение.`:(!env.ready&&wanted?`Будет установлена сборка PyTorch «${wanted}»${wanted==='cpu'?' (на процессоре распознавание заметно медленнее)':''}.`:''),
    actions:isBusy(jobEnv)?[modelButton('Пауза',()=>pause('qwen-env'))]:[
      ...(env.ready&&!env.mismatch?[]:[modelButton(jobEnv?.state==='error'?'Повторить':env.mismatch?'Переустановить':'Установить',()=>act('qwen-env',{force:env.mismatch}),'primary compact')]),
      ...(env.exists?[modelButton('Удалить',()=>removeComponent('qwen-env',{},'окружение распознавания'))]:[]),
    ]});
  const modelsReady=models.asr.complete&&models.aligner.complete;
  const modelsRow=row('Модели Qwen3-ASR и ForcedAligner',`ASR: ${models.asr.complete?'готова':models.asr.reason||'—'} · выравнивание: ${models.aligner.complete?'готова':models.aligner.reason||'—'}`,{
    state:{text:modelsReady?'готово':'не скачаны',kind:modelsReady?'ok':''},job:jobModels,
    actions:installActions('qwen-models',jobModels,{ready:modelsReady,label:'модели распознавания',size:Math.round(6.2*GB),removeLabel:'модели распознавания'})});
  return card('Распознавание речи','Qwen3-ASR и ForcedAligner работают локально в отдельных процессах и выгружаются после этапа.','wave',[envRow,modelsRow]);
}
function translationCard(st){
  const rows=[];
  if(st.translatorEngine){
    const e=st.translatorEngine,job=jobOf('translator-engine');
    rows.push(row('Движок перевода (llama.cpp '+e.tag+')',`Бэкенд: ${e.backend}${e.device&&e.backend!=='cpu'?' · '+e.device:''}`,{state:e.installed?{text:'готово',kind:'ok'}:{text:'не скачан'},job,
      actions:installActions('translator-engine',job,{ready:e.installed,label:'движок перевода',size:e.downloadBytes})}));
    const job2=jobOf('translator-model');
    const jobFor=m=>job2&&(!job2.quant||job2.quant===m.quant)?job2:null;
    for(const m of st.translatorModels){
      rows.push(row('Hy-MT2-7B · '+m.quant,sizeText(m.size)+(m.recommended?' · рекомендуется для вашей видеопамяти':''),{state:m.installed?{text:st.activeQuant===m.quant?'используется':'готова',kind:'ok'}:{text:'не скачана'},job:['downloading','extracting','verifying','copying','installing','error','paused'].includes(jobFor(m)?.state)?jobFor(m):null,
        actions:installActions('translator-model',jobFor(m),{ready:m.installed,label:'модель '+m.quant,options:{quant:m.quant},removeOptions:{quant:m.quant},size:m.size})}));
    }
    for(const f of st.importable||[]){
      if(st.translatorModels.find(m=>m.quant===f.quant)?.installed)continue;
      const jobI=jobOf('translator-import');const jobIf=jobI&&(!jobI.quant||jobI.quant===f.quant)?jobI:null;
      rows.push(row('Найдена модель в LM Studio · '+(f.quant||f.name),f.file,{state:{text:'можно импортировать'},job:jobIf,note:'Проверка SHA-256 и жёсткая ссылка без копирования, если файл на том же диске. Исходный файл не изменяется.',
        actions:isBusy(jobIf)?[modelButton('Пауза',()=>pause('translator-import'))]:[modelButton('Импортировать',()=>act('translator-import',{quant:f.quant}),'primary compact')]}));
    }
  }else rows.push(row('Перевод',st.translatorError||'',{state:{text:'недоступен',kind:'warn'}}));
  return card('Перевод Hy-MT2','Встроенный llama-server на 127.0.0.1 со случайным портом и ключом. LM Studio не нужна.','cube',rows);
}
function systemCard(st){
  const f=st.ffmpeg,job=jobOf('ffmpeg'),loaded=st.loaded?.translator;
  const rows=[
    row('FFmpeg',f.ready?`${f.ffmpeg}${f.source==='own'?' (скачан программой)':f.source==='system'?' (системный)':''}`:'Нужен для видео, звука и субтитров.',{state:f.ready?{text:'готово',kind:'ok'}:{text:'не найден',kind:'warn'},job,
      actions:f.ready?[]:installActions('ffmpeg',job,{ready:false,label:'FFmpeg',size:null})}),
    row('В памяти сейчас',loaded?.running?`Hy-MT2 · ${loaded.backend}${loaded.device?' · '+loaded.device:''} · ${loaded.quant} · слоёв на видеокарте: ${loaded.layers>=999?'все слои':loaded.layers}`:'Ничего не загружено. Модель загружается на время задачи и выгружается после неё.',{state:loaded?.running?{text:'в памяти',kind:'ok'}:{text:'выгружено'},
      actions:loaded?.running?[modelButton('Выгрузить',async()=>{await call('release-models');await refreshModels();})]:[]}),
  ];
  const place=el('div','model-info');place.append(el('strong','','Папка моделей'),el('small','',st.modelsDirectory),el('small','model-note',`Свободно: ${st.disk.modelsFree?sizeText(st.disk.modelsFree):'—'}. Новые загрузки идут в эту папку; уже скачанные файлы не переносятся.`));
  const r=buildRow(place,el('div','model-state'),Object.assign(el('div','model-actions'),{}));
  r.lastChild.append(modelButton('Выбрать папку…',async()=>{const dir=await call('pick-models-directory');if(dir){toast('Папка моделей изменена.');await refreshModels();}}),modelButton('Показать',()=>call('reveal-models')));
  rows.push(r);
  return card('Система и хранилище','Компоненты, память и место на диске.','drive',rows);
}
function checkRow(label,checked,onchange,note,disabled=false){
  const wrap=el('label','model-check'),input=document.createElement('input');input.type='checkbox';input.checked=!!checked;input.disabled=disabled;
  input.onchange=task(()=>onchange(input.checked));
  const text=el('span','',label);wrap.append(input,text);if(note)wrap.append(el('small','model-note',note));return wrap;
}
async function saveVideoGpu(patch){S.settings=await call('settings',{videoGpu:patch});await refreshModels();}
function videoCard(st,vg){
  if(!vg||!vg.gate)return card('Улучшение видео на видеокарте','','film',[row('Недоступно','Не удалось проверить видеокарты.',{state:{text:'ошибка',kind:'warn'}})]);
  const cfg=vg.settings,gate=vg.gate,rows=[];
  const warn=el('div','model-warning');warn.append(el('strong','','Осторожно'),el('span','',gate.warning));rows.push(warn);
  rows.push(checkRow('Включить GPU-режим улучшения видео',cfg.enabled,v=>saveVideoGpu({enabled:v}),'По умолчанию выключен: безопасный режим на процессоре остаётся основным.'));
  if(cfg.enabled)rows.push(checkRow('Я прочитал(а) предупреждение и принимаю риск',cfg.acknowledged,v=>saveVideoGpu({acknowledged:v})));
  if(cfg.enabled&&gate.xe)rows.push(checkRow('Разрешить на Intel Xe в Linux',cfg.allowIntelXe,v=>saveVideoGpu({allowIntelXe:v}),'Именно на этой связке длительная обработка уже зависала всю систему. Включайте, только если готовы к перезагрузке.'));
  const grid=el('div','model-fields');
  const select=document.createElement('select');select.append(new Option('Автоматически — только проверенный тестом','auto'),new Option('Процессор (libx264)','cpu'));
  for(const e of vg.encoders)if(e.available&&e.probe?.ok)select.append(new Option(e.label+' — '+e.device,e.id));
  select.value=cfg.encoder;select.onchange=task(()=>saveVideoGpu({encoder:select.value}));
  const f1=el('label','model-field');f1.append(el('span','','Кодировщик'),select,el('small','model-note','Кодировщик выбирается только после настоящего короткого теста, а не по названию видеокарты.'));
  const minutes=document.createElement('input');minutes.type='number';minutes.min=10;minutes.max=600;minutes.value=cfg.maxMinutes;minutes.onchange=task(()=>saveVideoGpu({maxMinutes:+minutes.value}));
  const f2=el('label','model-field');f2.append(el('span','','Лимит времени GPU-задачи, мин'),minutes,el('small','model-note','При превышении или зависании задача автоматически повторяется на процессоре.'));
  grid.append(f1,f2);rows.push(grid);
  if(!vg.encoders.length)rows.push(row('Аппаратные кодировщики','Для вашей видеокарты и ОС кодировщики не найдены.',{state:{text:'нет'}}));
  for(const e of vg.encoders){
    const p=e.probe;
    rows.push(row(e.label,`${e.device} · ${e.codec}${e.reason?' · '+e.reason:''}`,{state:!e.available?{text:'недоступен',kind:'warn'}:p?.ok?{text:'проверен · '+Math.round(p.ms)+' мс',kind:'ok'}:p?{text:'тест не пройден',kind:'warn'}:{text:'не проверен'},note:p&&!p.ok?p.error:'',
      actions:[modelButton(p?'Проверить снова':'Проверить кодировщик',async()=>{if(!confirm('Короткий тест кодирует 1 секунду тестового видео и использует видеокарту. Продолжить?'))return;await call('probe-video-encoder',{id:e.id});toast('Тест кодировщика завершён.');await refreshModels();},'secondary compact',!gate.allowed||!e.available)]}));
  }
  const jobE=jobOf('video-esrgan'),esr=vg.esrgan;
  rows.push(row('Real-ESRGAN (realesr-animevideov3, Vulkan)',esr.installed?(esr.verified?'Установлен программой, SHA-256 проверен.':'Найдена прежняя установка (SHA-256 не проверялся).'):'Нейросетевое увеличение 2×–4× на видеокарте. Скачивается отдельно.',{state:esr.installed?{text:'готово',kind:'ok'}:{text:'не скачан'},job:jobE,
    actions:installActions('video-esrgan',jobE,{ready:esr.installed&&esr.verified,label:'Real-ESRGAN',size:M.status?.videoEsrgan?.downloadBytes,removeLabel:'Real-ESRGAN'})}));
  if(!gate.allowed)rows.push(el('p','model-note',gate.reason));
  return card('Улучшение видео на видеокарте','Отдельный режим с предупреждением: аппаратное кодирование и Real-ESRGAN, с автоматическим откатом на процессор.','film',rows);
}
function renderModels(){
  const root=$('models-root');if(!root)return;
  if(!M.status){root.replaceChildren(el('p','hint','Проверяю компоненты…'));return;}
  const bar=el('div','segments models-tabs');bar.setAttribute('role','tablist');
  for(const [id,label] of MODEL_TABS){const b=el('button',id===M.tab?'selected':'',label);b.type='button';b.setAttribute('role','tab');b.onclick=()=>setModelsTab(id);bar.append(b);}
  const card={devices:()=>deviceCard(M.status),recognition:()=>recognitionCard(M.status),translation:()=>translationCard(M.status),video:()=>videoCard(M.status,M.video),system:()=>systemCard(M.status)}[M.tab]();
  root.replaceChildren(bar,card);
}
async function refreshModels(){
  // A refresh requested while another is running is not lost: it runs again right after.
  if(M.busy){M.again=true;return;}
  M.busy=true;
  try{do{M.again=false;M.status=await call('components-status');M.video=await call('video-gpu-status').catch(()=>null);renderModels();}while(M.again);}
  catch(error){toast(error.message,true);}finally{M.busy=false;}
}
// Called on every state event: redraw progress, and reload the full report when a download finishes or fails.
function modelsStateChanged(){
  if($('wizard')&&!$('wizard').hidden&&W.step===2)renderWizardProgress();
  if(S.page!=='models')return;
  let reload=false;
  for(const [name,job] of Object.entries(S.components||{})){
    if(job&&M.seen[name]!==job.state&&['ready','error','paused'].includes(job.state))reload=true;
    M.seen[name]=job?.state;
  }
  if(reload)refreshModels();else renderModels();
}
// ---- first-run wizard: detect hardware -> propose what to download -> download -> optional short check (only with consent) ----
const W={step:0,items:[],running:false,paused:false,consent:false};
function wizardItems(st){
  const items=[];
  if(!st.ffmpeg.ready)items.push({id:'ffmpeg',title:'FFmpeg',detail:'Нужен для видео, звука и субтитров.',size:null,on:true});
  const env=st.recognitionEnv;
  if(!env.ready||env.mismatch)items.push({id:'qwen-env',title:'Окружение распознавания (Python + PyTorch «'+(env.wantedBackend||'cpu')+'»)',detail:'Устанавливается в папку программы, занимает несколько ГБ.'+(env.wantedBackend==='cpu'?' Видеокарта для распознавания не подходит — будет работать процессор, это заметно медленнее.':''),size:null,on:true,options:{force:!!env.mismatch}});
  if(!st.recognitionModels.asr.complete||!st.recognitionModels.aligner.complete)items.push({id:'qwen-models',title:'Модели Qwen3-ASR и ForcedAligner',detail:'Распознавание английской речи и точные времена слов.',size:Math.round(6.2*GB),on:true});
  if(st.translatorEngine&&!st.translatorEngine.installed)items.push({id:'translator-engine',title:'Движок перевода (llama.cpp, '+st.translatorEngine.backend+')',detail:'Встроенный сервер, LM Studio не нужна.',size:st.translatorEngine.downloadBytes,on:true});
  if(st.translatorModels&&!st.translatorModels.some(m=>m.installed)){
    const rec=st.translatorModels.find(m=>m.recommended)||st.translatorModels.at(-1),imp=(st.importable||[])[0];
    if(imp)items.push({id:'translator-import',title:'Импорт модели Hy-MT2 '+imp.quant+' из LM Studio',detail:'Проверка SHA-256 и ссылка без копирования, если файл на том же диске. Скачивать заново не нужно.',size:0,on:true,options:{quant:imp.quant}});
    else items.push({id:'translator-model',title:'Модель перевода Hy-MT2 '+rec.quant,detail:'Подобрана по видеопамяти.',size:rec.size,on:true,options:{quant:rec.quant}});
  }
  return items;
}
function wizardModal(){
  let m=$('wizard');if(!m){m=el('div','modal');m.id='wizard';m.setAttribute('role','dialog');m.setAttribute('aria-modal','true');document.body.append(m);}return m;
}
function closeWizard(){const m=$('wizard');if(m)m.hidden=true;}
async function finishWizard(){await call('settings',{firstRunDone:true}).then(s=>{S.settings=s;}).catch(()=>{});closeWizard();refreshModels();}
function renderWizard(){
  const m=wizardModal(),st=M.status;m.hidden=false;
  const card=el('div','modal-card wizard-card'),title=el('h2','',['Добро пожаловать в Anime Lingo','Что скачать','Скачиваю','Короткая проверка'][W.step]);
  const body=el('div','wizard-body'),actions=el('div','row wizard-actions');
  if(W.step===0){
    const gpus=(st.gpus||[]);
    body.append(el('p','','Все модели работают на этом компьютере. Сначала посмотрим, какие у вас видеокарты — это определяется без нагрузки на них.'),
      el('div','wizard-box',gpus.length?gpus.map(g=>g.name+(g.vramTotal?' · '+sizeText(g.vramTotal):'')+(g.driver?' · драйвер '+g.driver:'')).join('\n'):'Видеокарта не найдена. Всё будет работать на процессоре — медленнее, но работает.'));
    const caps=st.capabilities;
    if(caps){const rec=caps.recognition.find(o=>o.id===(S.settings.qwenDevice==='auto'?(caps.recognition.find(x=>x.available&&['cuda','xpu'].includes(x.id))?.id||'cpu'):S.settings.qwenDevice)),tr=caps.translation.find(o=>o.available&&['cuda','vulkan'].includes(o.id))||caps.translation.find(o=>o.id==='cpu');
      body.append(el('p','hint','Распознавание речи: '+(RECOGNITION_LABEL[rec?.id||'cpu'])+'. Перевод: '+(TRANSLATION_LABEL[tr.id])+'. Изменить можно в разделе «Модели».'));}
    actions.append(modelButton('Позже',finishWizard,'secondary'),modelButton('Дальше',()=>{W.step=1;W.items=wizardItems(st);renderWizard();},'primary'));
  }else if(W.step===1){
    if(!W.items.length)body.append(el('p','','Всё необходимое уже установлено.'));
    for(const item of W.items){
      const label=el('label','model-check'),input=document.createElement('input');input.type='checkbox';input.checked=item.on;input.onchange=()=>{item.on=input.checked;renderWizardTotals();};
      label.append(input,el('span','',item.title+(item.size?' · '+sizeText(item.size):'')),el('small','model-note',item.detail));body.append(label);
    }
    body.append(el('p','hint wizard-total'));
    actions.append(modelButton('Назад',()=>{W.step=0;renderWizard();},'secondary'),modelButton(W.items.length?'Скачать выбранное':'Дальше',()=>{W.step=W.items.some(i=>i.on)?2:3;renderWizard();if(W.step===2)runWizard();},'primary'));
  }else if(W.step===2){
    const list=el('div','wizard-progress');list.id='wizard-progress';body.append(list);
    actions.append(modelButton(W.running?'Пауза':'Продолжить',async()=>{if(W.running){W.paused=true;for(const i of W.items)if(i.on)await call('pause-component',{name:i.id}).catch(()=>{});}else runWizard();},'secondary'),modelButton('Закрыть (загрузка остановится)',async()=>{W.paused=true;closeWizard();},'secondary'));
    renderWizardProgress();
  }else{
    body.append(el('p','','Установка завершена. Можно сразу проверить переводчик: он загрузится на видеокарту, переведёт одно предложение и выгрузится.'));
    const label=el('label','model-check'),input=document.createElement('input');input.type='checkbox';input.checked=W.consent;input.onchange=()=>{W.consent=input.checked;renderWizard();};
    label.append(input,el('span','','Я согласен(на) запустить модель для проверки'),el('small','model-note','Проверка использует видеокарту несколько секунд. Без согласия она не запускается.'));body.append(label);
    body.append(el('p','hint',W.result||''));
    actions.append(modelButton('Проверить переводчик',async()=>{W.result='Проверяю…';renderWizard();try{await call('load-model');W.result='Переводчик отвечает. Модель выгружена из памяти.';}catch(error){W.result='Проверка не удалась: '+error.message;}renderWizard();},'secondary',!W.consent),modelButton('Готово',finishWizard,'primary'));
  }
  card.append(title,body,actions);m.replaceChildren(card);
  if(W.step===1)renderWizardTotals();
}
function renderWizardTotals(){
  const t=document.querySelector('.wizard-total');if(!t)return;
  const total=W.items.filter(i=>i.on).reduce((s,i)=>s+(i.size||0),0),free=M.status?.disk?.modelsFree;
  t.textContent='Известный объём загрузки: '+(total?sizeText(total):'—')+' (окружение Python добавляет ещё несколько ГБ). Свободно на диске: '+(free?sizeText(free):'—')+'.';
}
function renderWizardProgress(){
  const list=$('wizard-progress');if(!list)return;list.replaceChildren();
  for(const item of W.items.filter(i=>i.on)){
    const job=jobOf(item.id),status=W.done?.has(item.id)?'готово':job?jobLine(job):'ожидает';
    const line=el('div','wizard-line');line.append(el('strong','',item.title),el('small',job?.state==='error'?'model-error':'',job?.state==='error'?job.error:status));
    if(job&&isBusy(job))line.append(progressBar(job));list.append(line);
  }
}
async function runWizard(){
  if(W.running)return;W.running=true;W.paused=false;W.done??=new Set();
  try{
    for(const item of W.items.filter(i=>i.on)){
      if(W.done.has(item.id))continue;if(W.paused)break;
      const result=await call('install-component',{name:item.id,options:item.options||{}});
      if(result?.state!=='ready'){if(result?.state==='error')toast(item.title+': '+(result.error||'ошибка'),true);W.paused=true;break;}
      W.done.add(item.id);
    }
  }finally{W.running=false;}
  await refreshModels();
  if(W.items.filter(i=>i.on).every(i=>W.done.has(i.id))&&!$('wizard').hidden){W.step=3;renderWizard();}else if(!$('wizard').hidden)renderWizard();
}
async function maybeStartWizard(force=false){
  if(!force&&S.settings.firstRunDone)return;
  await refreshModels();if(!M.status)return;
  if(!force&&S.settings.firstRunDone)return; // settings may have changed while the report was loading
  if(!force&&wizardItems(M.status).length===0){await call('settings',{firstRunDone:true}).then(s=>{S.settings=s;}).catch(()=>{});return;}
  Object.assign(W,{step:0,items:[],running:false,paused:false,consent:false,done:new Set(),result:''});renderWizard();
}
function engineLabel(j){return ({cpu:'Безопасный режим','gpu-esrgan':'Нейросеть Real-ESRGAN','gpu-encode':'Фильтры + кодирование на видеокарте',anime4k:'Anime4K · старый результат'})[j.engine]||'Real-ESRGAN · старый результат';}
// Enhancement engine selector: the GPU modes stay listed but disabled (with the reason) until they are enabled, confirmed and ready.
async function refreshEnhanceEngines(){try{M.video=await call('video-gpu-status');}catch{M.video=null;}applyEnhanceEngines();}
function applyEnhanceEngines(){
  const select=$('enhance-engine'),scale=$('enhance-scale'),hint=$('enhance-engine-hint');if(!select)return;
  const vg=M.video&&M.video.gate?M.video:null,allowed=!!vg?.gate.allowed,esr=allowed&&vg.esrgan.installed,enc=allowed&&vg.encoders.some(e=>e.available&&e.probe?.ok);
  const current=select.value||'cpu';
  const why=!vg?'Не удалось проверить видеокарты.':!allowed?vg.gate.reason:'';
  select.replaceChildren(new Option('Безопасный режим (процессор) — по умолчанию','cpu'),
    Object.assign(new Option('Нейросеть Real-ESRGAN (видеокарта, с предупреждением)','gpu-esrgan'),{disabled:!esr,title:esr?'':(why||'Real-ESRGAN не установлен: «Модели» → «Видео».')}),
    Object.assign(new Option('Фильтры на процессоре + кодирование на видеокарте (с предупреждением)','gpu-encode'),{disabled:!enc,title:enc?'':(why||'Нет кодировщика, прошедшего тест: «Модели» → «Видео».')}));
  select.value=[...select.options].some(o=>o.value===current&&!o.disabled)?current:'cpu';
  const keep=scale.value,options=select.value==='gpu-esrgan'?[['2','2× · максимум 3840×2160'],['3','3× · максимум 3840×2160'],['4','4× · максимум 3840×2160']]:[['1','1× · исходный размер'],['2','2× · максимум 3840×2160']];
  scale.replaceChildren(...options.map(([v,t])=>new Option(t,v)));scale.value=options.some(([v])=>v===keep)?keep:options[0][0];
  $('enhance-profile').disabled=select.value==='gpu-esrgan';
  hint.textContent=select.value==='gpu-esrgan'?'Нейросеть увеличивает кадры на видеокарте короткими отрезками; при сбое задача повторится на процессоре.':select.value==='gpu-encode'?'Резкость на процессоре, быстрое кодирование на видеокарте; при сбое задача повторится на процессоре.':$('enhance-profile').value==='clean'?'Мягкое шумоподавление на процессоре. Не нейросеть, зато безопасно.':'Резкость линий на процессоре. Не нейросеть, зато безопасно.';
  if(why&&select.value==='cpu')hint.title=why;else hint.removeAttribute('title');
}
function initModels(){}
