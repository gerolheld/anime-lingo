// Library folder bar and the "+ Folder" hint against a fake IPC (no disk access, no models). CPU-only Chromium.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import assert from 'node:assert/strict';
import {chromiumPath} from './browser-path.mjs';
const LANG=process.env.LINGO_UI_LANG||'ru',output=resolve(LANG==='en'?'test-results/library-root-en':'test-results/library-root');await mkdir(output,{recursive:true});
const root=resolve('.'),types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const server=createServer(async(req,res)=>{try{const file=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://x').pathname));if(!file.startsWith(root+sep))throw Error('Path');res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const state=over=>({settings:{uiLanguage:LANG,firstRunDone:true,libraryRoot:'',fontSize:36,ruSize:24,bottom:12,opacity:55,offset:0,readingMode:true,readingSize:5,subtitleStyle:'modern'},episodes:[],folders:[],words:[],history:[],enhancements:[],components:{},tools:{ready:true},modelState:{phase:'idle',label:'x'},enhancePolicy:{isolation:{label:'x'}},live:[],libraryScan:{running:false,added:0,errors:[]},ignoredCount:0,...over});
let current=state();const calls=[];
const called=async(test,what)=>{for(let i=0;i<50;i++){if(calls.some(test))return;await new Promise(r=>setTimeout(r,40));}assert.fail('IPC call not seen: '+what);};
const browser=await chromium.launch({executablePath:chromiumPath,headless:true,args:['--disable-gpu','--use-gl=disabled']});
try{
 const context=await browser.newContext({locale:'ru-RU',viewport:{width:1672,height:941}});await context.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
 await context.exposeBinding('__ipc',async(_,method,data={})=>{calls.push({method,data});return {value:method==='snapshot'?current:method==='pick-library-root'?'/media/anime':{added:0,folders:0}};});
 await context.addInitScript(lang=>{try{localStorage.setItem('lingo-lang',lang);}catch{}let l;window.__emit=d=>l?.({type:'state',data:d});window.lingo={subscribe:fn=>{l=fn;},call:(m,d)=>window.__ipc(m,d)};},LANG);
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.stack));
 await page.goto(base+'/desktop/ui/index.html');await page.waitForFunction(()=>S.settings&&S.settings.firstRunDone===true);
 await page.locator('.sidebar [data-page=library]').click();
 const bar=page.locator('#library-root');
 assert.match(await bar.innerText(),LANG==='en'?/Anime folder not chosen/:/Папка с аниме не выбрана/);
 await bar.getByRole('button',{name:LANG==='en'?'Choose folder…':'Выбрать папку…'}).click();await called(c=>c.method==='pick-library-root','pick');
 await page.screenshot({path:output+'/no-root.png'});
 // a chosen folder: status, buttons and hidden count
 current=state({settings:{...state().settings,libraryRoot:'/media/anime'},ignoredCount:2,libraryScan:{running:false,added:3,errors:[]}});
 await page.evaluate(d=>window.__emit(d),current);await page.evaluate(()=>renderLibrary());
 const text=await bar.innerText();assert.match(text,/\/media\/anime/);assert.match(text,LANG==='en'?/Episodes added: 3/:/Добавлено серий: 3/);
 await bar.getByRole('button',{name:LANG==='en'?'Refresh':'Обновить'}).click();await called(c=>c.method==='scan-library'&&!c.data.restore,'refresh');
 await bar.getByRole('button',{name:LANG==='en'?'Open':'Открыть'}).click();await called(c=>c.method==='reveal-library','reveal');
 page.once('dialog',d=>d.dismiss());await bar.getByRole('button',{name:/Restore hidden|Вернуть скрытые/}).click();await page.waitForTimeout(150);assert.ok(!calls.some(c=>c.data?.restore),'dismissed = nothing restored');
 page.once('dialog',d=>d.accept());await bar.getByRole('button',{name:/Restore hidden|Вернуть скрытые/}).click();await called(c=>c.method==='scan-library'&&c.data.restore===true,'restore');
 // scanning state disables refresh
 await page.evaluate(d=>window.__emit(d),state({settings:current.settings,libraryScan:{running:true,added:1,errors:[]}}));await page.evaluate(()=>renderLibrary());
 assert.equal(await bar.getByRole('button',{name:LANG==='en'?'Refresh':'Обновить'}).isDisabled(),true);
 // new folder dialog explains that a real folder is created
 await page.evaluate(d=>window.__emit(d),current);await page.locator('#new-folder').click();
 assert.match(await page.locator('#folder-disk-hint').innerText(),LANG==='en'?/sub-folder.*created on disk/:/создана подпапка/);
 await page.screenshot({path:output+'/folder-dialog.png'});await page.keyboard.press('Escape');
 await page.evaluate(()=>renderLibrary());await page.screenshot({path:output+'/with-root.png'});
 if(LANG==='en')assert.deepEqual(await page.evaluate(()=>LingoI18n.findUntranslated()),[],'Russian text left in English mode');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:'library folder bar: states, actions, confirmation, folder dialog hint'}));
}finally{await browser.close();server.close();}
