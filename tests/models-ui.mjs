// "Models" screen against a fake IPC: no downloads, no processes, no models, no GPU. CPU-only Chromium.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import assert from 'node:assert/strict';
import {chromiumPath} from './browser-path.mjs';
const LANG=process.env.LINGO_UI_LANG||'ru';
const output=resolve(LANG==='en'?'test-results/models-en':'test-results/models');await mkdir(output,{recursive:true});
const root=resolve('.'),types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const server=createServer(async(req,res)=>{try{const file=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://x').pathname));if(!file.startsWith(root+sep))throw Error('Path');res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
import {createRequire} from 'node:module';
const realWarning=createRequire(import.meta.url)('../desktop/video-gpu.cjs').gate({settings:{},gpus:[]}).warning;
const GB=1024**3;
const caps={recognition:[{id:'cuda',available:false,reason:'Видеокарта NVIDIA не найдена.'},{id:'xpu',available:true,device:'Intel Arc B580'},{id:'rocm',available:false,reason:'Видеокарта AMD не найдена.'},{id:'cpu',available:true,device:'CPU'}],translation:[{id:'cuda',available:false,reason:'Видеокарта NVIDIA не найдена.'},{id:'vulkan',available:true,device:'Intel Arc B580'},{id:'sycl',available:false,reason:'Для SYCL на Linux нужна установленная среда Intel oneAPI. Используйте Vulkan.'},{id:'hip',available:false,reason:'Видеокарта AMD не найдена.'},{id:'cpu',available:true,device:'CPU'}]};
const status=over=>({platform:'linux',runtime:'/data/runtime',modelsDirectory:'/data/runtime/models',jobs:{},gpus:[{name:'Intel Arc B580',vramTotal:12*GB,driver:'xe'}],capabilities:caps,ffmpeg:{ready:true,ffmpeg:'/usr/bin/ffmpeg',source:'system'},
 translatorEngine:{backend:'vulkan',device:'Intel Arc B580',installed:false,tag:'b11375',downloadBytes:35*1024**2},
 translatorModels:[{quant:'Q8_0',name:'HY-MT2-7B-Q8_0.gguf',size:7981928896,installed:false,recommended:true},{quant:'Q6_K',name:'x',size:6163000000,installed:false,recommended:false},{quant:'Q4_K_M',name:'y',size:4624000000,installed:true,recommended:false}],
 importable:[{name:'HY-MT2-7B-Q8_0.gguf',file:'/home/user/.lmstudio/models/tencent/Hy-MT2-7B-GGUF/HY-MT2-7B-Q8_0.gguf',quant:'Q8_0',size:7981928896}],activeQuant:'Q4_K_M',
 recognitionEnv:{exists:true,ready:true,torchVersion:'2.14.1',torchBackend:'xpu',qwenAsr:true,wantedBackend:'xpu',mismatch:false},recognitionModels:{asr:{complete:true},aligner:{complete:true}},
 loaded:{translator:{running:false}},disk:{modelsFree:141*GB,runtimeFree:141*GB},...over});
const video=over=>({settings:{enabled:false,acknowledged:false,allowIntelXe:false,encoder:'auto',maxMinutes:120,probes:{}},gate:{allowed:false,reason:'GPU-режим выключен. Включите его в разделе «Модели» → «Видео».',warning:realWarning,xe:true},encoders:[{id:'qsv',codec:'h264_qsv',label:'Intel Quick Sync',device:'Intel Arc B580',available:true,reason:'',probe:null},{id:'vaapi',codec:'h264_vaapi',label:'VAAPI',device:'Intel Arc B580',available:false,reason:'Не найдено устройство /dev/dri/renderD*.',probe:null}],esrgan:{installed:true,source:'legacy',verified:false},gpus:[],...over});
globalThis.__video=video();
const calls=[],errors=[];let browser;
const called=async(test,what)=>{for(let i=0;i<50;i++){if(calls.some(test))return;await new Promise(r=>setTimeout(r,40));}assert.fail('IPC call not seen: '+what);};
try{
 browser=await chromium.launch({executablePath:chromiumPath,headless:true,args:['--disable-gpu','--use-gl=disabled','--disable-features=Vulkan,WebGPU']});
 const context=await browser.newContext({locale:'ru-RU',viewport:{width:1672,height:941}});await context.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
 await context.exposeBinding('__ipc',async(_,method,data={})=>{calls.push({method,data});return {value:method==='install-component'?{state:'ready'}:method==='snapshot'?globalThis.__snapshot:method==='video-gpu-status'?globalThis.__video:method==='components-status'?globalThis.__status:method==='settings'?{...globalThis.__settings,...data}:{ok:true}};});
 await context.exposeFunction('__setStatus',s=>{globalThis.__status=s;});
 globalThis.__status=status();globalThis.__snapshot={settings:{uiLanguage:LANG,firstRunDone:true,fontSize:36,ruSize:24,bottom:12,opacity:55,offset:0,readingMode:true,readingSize:5,subtitleStyle:'modern'},episodes:[],folders:[],words:[],history:[],enhancements:[],components:{},tools:{ready:true},modelState:{phase:'idle',label:'x'},enhancePolicy:{isolation:{label:'x'}},live:[]};globalThis.__settings={uiLanguage:LANG,firstRunDone:true,qwenDevice:'auto',translationDevice:'auto',translationQuant:'auto',gpu:true,fontSize:36,ruSize:24,bottom:12,opacity:55,offset:0,readingMode:true,readingSize:5,subtitleStyle:'modern'};
 await context.addInitScript(lang=>{try{localStorage.setItem('lingo-lang',lang);}catch{}},LANG);
 await context.addInitScript(()=>{let listener;window.__emit=data=>listener?.({type:'state',data});window.lingo={subscribe:fn=>{listener=fn;},async call(method,data){return window.__ipc(method,data);}};});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.stack));
 await page.route('**/__never',r=>r.abort());
 await page.goto(base+'/desktop/ui/index.html');
 await page.evaluate(settings=>{window.__emit({settings,episodes:[],folders:[],words:[],history:[],enhancements:[],components:{},tools:{ready:true},platform:'linux',version_:'0.1.0',modelState:{phase:'idle',label:'Модели выгружены'},enhancePolicy:{isolation:{label:'x'}},live:[]});},globalThis.__settings);
 await page.locator('.sidebar [data-page=models]').click();
 await page.waitForSelector('.model-card');
 if(LANG==='en'){
  // English mode: every tab and the wizard must be free of Russian interface text.
  const names=await page.locator('.models-tabs button').allTextContents();assert.deepEqual(names,['Devices','Speech recognition','Translation','Video','System']);
  for(let i=0;i<5;i++){await page.locator('.models-tabs button').nth(i).click();const left=await page.evaluate(()=>LingoI18n.findUntranslated());assert.deepEqual(left,[],'Russian text left on tab '+names[i]);await page.screenshot({path:output+'/tab-'+i+'.png',fullPage:true});}
  await page.locator('.models-tabs button').nth(0).click();await page.getByRole('button',{name:'Setup wizard'}).click();await page.waitForSelector('#wizard .wizard-card');
  for(let step=0;step<2;step++){const left=await page.evaluate(()=>LingoI18n.findUntranslated(document.getElementById('wizard')));assert.deepEqual(left,[],'Russian text left in the wizard');await page.screenshot({path:output+'/wizard-'+step+'.png'});if(step===0)await page.locator('#wizard').getByRole('button',{name:'Next'}).click();}
  console.log(JSON.stringify({ok:true,checks:'English models screen and wizard have no Russian interface text'}));await browser.close();server.close();process.exit(0);
 }
 assert.equal(await page.locator('.model-card').count(),1,'one section at a time');
 const tab=async n=>{await page.getByRole('tab',{name:n}).click();};
 let text='';for(const n of ['Устройства','Распознавание','Перевод','Видео','Система']){await tab(n);text+=await page.locator('#models-root').innerText();}
 await tab('Устройства');
 assert.match(text,/Intel Arc B580/);assert.match(text,/llama\.cpp b11375/);assert.match(text,/рекомендуется для вашей видеопамяти/);assert.match(text,/Найдена модель в LM Studio/);assert.doesNotMatch(text,/:1234|anime-lingo-hy|\blms\b/i);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:output+'/models.png',fullPage:true});
 // unavailable devices are listed but cannot be selected
 const disabled=await page.locator('select option:disabled').allTextContents();assert.ok(disabled.some(t=>/CUDA/.test(t)&&/недоступно/.test(t)));
 // choosing a device saves it; the explicit unavailable choice is impossible from the UI
 await page.locator('.model-field select').first().selectOption('xpu');await page.waitForFunction(()=>true);
 await called(c=>c.method==='settings'&&c.data.qwenDevice==='xpu','settings xpu');
 // downloads: start, progress, pause
 await tab('Перевод');
 await page.locator('.model-row',{hasText:'Hy-MT2-7B · Q8_0'}).getByRole('button',{name:/Скачать/}).click();
 await called(c=>c.method==='install-component'&&c.data.name==='translator-model'&&c.data.options.quant==='Q8_0','install Q8_0');
 await page.evaluate(()=>window.__emit({components:{'translator-model':{quant:'Q8_0',state:'downloading',percent:42,speed:52428800,eta:75}}}));
 const row=page.locator('.model-row',{hasText:'Hy-MT2-7B · Q8_0'});await row.locator('.model-meter').waitFor();
 assert.match(await row.innerText(),/42%/);assert.match(await row.innerText(),/50 МБ\/с/);
 await page.screenshot({path:output+'/models-progress.png',fullPage:true});
 await row.getByRole('button',{name:'Пауза'}).click();await called(c=>c.method==='pause-component'&&c.data.name==='translator-model','pause');
 // import from LM Studio
 await page.locator('.model-row',{hasText:'Найдена модель'}).getByRole('button',{name:'Импортировать'}).click();
 await called(c=>c.method==='install-component'&&c.data.name==='translator-import','import');
 // removal asks first
 page.once('dialog',d=>d.dismiss());await page.locator('.model-row',{hasText:'Q4_K_M'}).getByRole('button',{name:'Удалить'}).click();
 assert.ok(!calls.some(c=>c.method==='remove-component'));
 page.once('dialog',d=>d.accept());await page.locator('.model-row',{hasText:'Q4_K_M'}).getByRole('button',{name:'Удалить'}).click();
 await called(c=>c.method==='remove-component'&&c.data.name==='translator-model'&&c.data.options.quant==='Q4_K_M','remove');
 // an environment built for another device is flagged
 await tab('Распознавание');
 globalThis.__status=status({recognitionEnv:{exists:true,ready:true,torchVersion:'2.14.1',torchBackend:'cpu',qwenAsr:true,wantedBackend:'xpu',mismatch:true}});
 await page.evaluate(()=>window.__emit({components:{'qwen-env':{state:'ready'}}}));await page.waitForFunction(()=>/нужна сборка/.test(document.getElementById('models-root').innerText),null,{timeout:5000});
 assert.match(await page.locator('#models-root').innerText(),/нужна сборка «xpu», а установлена «cpu»/);
 // video GPU card: off by default, confirmations unlock step by step, probe asks first
 await tab('Видео');
 assert.match(await page.locator('#models-root').innerText(),/GPU-режим не изолирован/);
 const enable=page.locator('.model-check',{hasText:'Включить GPU-режим'}).locator('input');assert.equal(await enable.isChecked(),false);
 assert.equal(await page.locator('.model-check',{hasText:'Я прочитал'}).count(),0);
 await enable.check();await called(c=>c.method==='settings'&&c.data.videoGpu?.enabled===true,'enable video gpu');
 globalThis.__video=video({settings:{enabled:true,acknowledged:false,allowIntelXe:false,encoder:'auto',maxMinutes:120,probes:{}}});await page.evaluate(()=>window.__emit({components:{'x':{state:'ready'}}}));await page.evaluate(()=>refreshModels());await page.waitForSelector('.model-check:has-text("Я прочитал")');
 assert.ok(await page.locator('.model-check',{hasText:'Intel Xe'}).count(),'Xe confirmation is separate');
 assert.equal(await page.getByRole('button',{name:'Проверить кодировщик'}).first().isDisabled(),true,'probe disabled until confirmed');
 globalThis.__video=video({gate:{allowed:true,warning:'w',xe:false},settings:{enabled:true,acknowledged:true,allowIntelXe:false,encoder:'auto',maxMinutes:120,probes:{}}});await page.evaluate(()=>refreshModels());await page.waitForTimeout(150);
 page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Проверить кодировщик'}).first().click();await page.waitForTimeout(150);assert.ok(!calls.some(c=>c.method==='probe-video-encoder'),'dismissed warning = no GPU work');
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Проверить кодировщик'}).first().click();await called(c=>c.method==='probe-video-encoder'&&c.data.id==='qsv','probe qsv');
 await page.screenshot({path:output+'/models-video.png',fullPage:true});
 // enhance page offers GPU engines only when allowed
 await page.locator('.sidebar [data-page=enhance]').click();await page.waitForTimeout(250);
 assert.deepEqual(await page.locator('#enhance-engine option:not([disabled])').evaluateAll(o=>o.map(x=>x.value)),['cpu','gpu-esrgan'],'esrgan installed + allowed; encode needs a passed test');
 await page.locator('#enhance-engine').selectOption('gpu-esrgan');assert.deepEqual(await page.locator('#enhance-scale option').evaluateAll(o=>o.map(x=>x.value)),['2','3','4']);
 await page.locator('#enhance-engine').selectOption('cpu');assert.deepEqual(await page.locator('#enhance-scale option').evaluateAll(o=>o.map(x=>x.value)),['1','2']);
 await page.locator('.sidebar [data-page=models]').click();
 // first-run wizard
 globalThis.__status=status({ffmpeg:{ready:false},recognitionEnv:{exists:false,ready:false,wantedBackend:'xpu',mismatch:false},recognitionModels:{asr:{complete:false,reason:'не скачана'},aligner:{complete:false,reason:'не скачана'}},translatorModels:[{quant:'Q8_0',name:'a',size:7981928896,installed:false,recommended:true},{quant:'Q6_K',name:'b',size:6163000000,installed:false,recommended:false},{quant:'Q4_K_M',name:'c',size:4624000000,installed:false,recommended:false}]});
 calls.length=0;
 await tab('Устройства');
 await page.locator('.sidebar [data-page=models]').click();await page.getByRole('button',{name:'Мастер настройки'}).click();
 await page.waitForSelector('#wizard .wizard-card');assert.match(await page.locator('#wizard').innerText(),/Intel Arc B580/);
 assert.match(await page.locator('#wizard').innerText(),/без нагрузки/);await page.screenshot({path:output+'/wizard-1.png'});
 await page.locator('#wizard').getByRole('button',{name:'Дальше'}).click();
 const items=await page.locator('#wizard .model-check span').allTextContents();assert.ok(items.some(t=>/FFmpeg/.test(t)));assert.ok(items.some(t=>/Импорт модели Hy-MT2 Q8_0 из LM Studio/.test(t)),'existing file is imported, not downloaded');assert.ok(!items.some(t=>/Модель перевода Hy-MT2/.test(t)));
 assert.match(await page.locator('.wizard-total').innerText(),/Свободно на диске/);await page.screenshot({path:output+'/wizard-2.png'});
 await page.locator('#wizard .model-check',{hasText:'FFmpeg'}).locator('input').uncheck();
 await page.locator('#wizard').getByRole('button',{name:'Скачать выбранное'}).click();
 await page.waitForFunction(()=>/Короткая проверка/.test(document.querySelector('#wizard h2').textContent),null,{timeout:8000});
 assert.deepEqual(calls.filter(c=>c.method==='install-component').map(c=>c.data.name),['qwen-env','qwen-models','translator-engine','translator-import'],'installed one after another, ffmpeg skipped');
 const check=page.locator('#wizard').getByRole('button',{name:'Проверить переводчик'});assert.equal(await check.isDisabled(),true,'no model run without consent');
 await page.locator('#wizard .model-check input').check();assert.equal(await check.isDisabled(),false);assert.ok(!calls.some(c=>c.method==='load-model'));
 await check.click();await called(c=>c.method==='load-model','load-model after consent');await page.waitForFunction(()=>/Переводчик отвечает/.test(document.getElementById('wizard').innerText));
 await page.locator('#wizard').getByRole('button',{name:'Готово'}).click();await called(c=>c.method==='settings'&&c.data.firstRunDone===true,'first run done');assert.equal(await page.locator('#wizard').isHidden(),true);
 // narrow window
 await page.setViewportSize({width:910,height:700});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:output+'/models-narrow.png',fullPage:true});
 // settings no longer mention LM Studio
 await page.locator('.sidebar [data-page=settings]').click();assert.doesNotMatch(await page.locator('#page-settings').innerText(),/LM Studio|1234|anime-lingo-hy/);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:'models screen: render, device lock, progress, pause, import, remove confirm, mismatch warning, narrow window, no LM Studio text'},null,1));
}finally{await browser?.close();server.close();}
