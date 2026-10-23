// Colour themes in a real (CPU) Chromium: swatches, custom RGB, depth, persistence and the first-paint switch. Fake IPC, no models.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import assert from 'node:assert/strict';
import {chromiumPath} from './browser-path.mjs';
const output=resolve('test-results/themes');await mkdir(output,{recursive:true});
const root=resolve('.'),types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const server=createServer(async(req,res)=>{try{const file=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://x').pathname));if(!file.startsWith(root+sep))throw Error('Path');res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
let settings={uiLanguage:'ru',firstRunDone:true,themePreset:'default',themeColor:'#ff6b6b',themeDepth:'normal',fontSize:36,ruSize:24,bottom:12,opacity:55,offset:0,readingMode:true,readingSize:5,subtitleStyle:'modern'};
const calls=[];
const called=async(test,what)=>{for(let i=0;i<50;i++){if(calls.some(test))return;await new Promise(r=>setTimeout(r,40));}assert.fail('IPC call not seen: '+what);};
const browser=await chromium.launch({executablePath:chromiumPath,headless:true,args:['--disable-gpu','--use-gl=disabled']});
// Hue (degrees) of the element's colour, read from the browser's own computed value.
const hueOf=(page,css,prop)=>page.evaluate(([css,prop])=>{
  const e=document.createElement('div');e.style.cssText=css;document.body.append(e);
  const v=getComputedStyle(e)[prop];e.remove();
  const m=v.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/)||v.match(/rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  let [r,g,b]=m.slice(1,4).map(Number);if(m[0].startsWith('rgb')){r/=255;g/=255;b/=255;}
  const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;
  if(d)h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;
  return {hue:(h*60+360)%360,sat:max?d/max:0,light:(max+min)/2,css:v};
},[css,prop]);
const diff=(a,b)=>Math.abs(((a-b+540)%360)-180);
try{
 const context=await browser.newContext({viewport:{width:1672,height:941}});await context.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
 await context.exposeBinding('__ipc',async(_,method,data={})=>{calls.push({method,data});if(method==='settings'){settings={...settings,...data};return {value:settings};}
   return {value:method==='snapshot'?{settings,episodes:[],folders:[],words:[],history:[],enhancements:[],components:{},tools:{ready:true},modelState:{phase:'idle',label:'x'},enhancePolicy:{isolation:{label:'x'}},live:[]}:{ok:true}};});
 await context.addInitScript(()=>{let l;window.__emit=d=>l?.({type:'state',data:d});window.lingo={subscribe:fn=>{l=fn;},call:(m,d)=>window.__ipc(m,d)};});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.stack));
 await page.goto(base+'/desktop/ui/index.html');await page.waitForFunction(()=>S.settings&&S.settings.firstRunDone===true);
 const ACCENT='color:var(--accent)';
 // default theme: the original stylesheets only
 const d0=await hueOf(page,ACCENT,'color');assert.ok(Math.abs(d0.hue-217)<3,'default accent is the original blue '+d0.hue);
 assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('link[data-themed]')].map(l=>l.media)),['not all','not all','not all']);
 await page.locator('.sidebar [data-page=settings]').click();await page.screenshot({path:output+'/settings-default.png',fullPage:true});
 assert.equal(await page.locator('.theme-swatch').count(),10,'9 presets + custom');
 // preset: red
 await page.getByRole('radio',{name:'Красный'}).first().click();await called(c=>c.method==='settings'&&c.data.themePreset==='red','red');
 await page.waitForFunction(()=>document.querySelector('link[data-themed]').media==='all');
 const red=await hueOf(page,ACCENT,'color');assert.ok(diff(red.hue,217+132)<4,'accent moved to red '+red.hue);
 const bg=await hueOf(page,'background:var(--bg)','backgroundColor');assert.ok(diff(bg.hue,222+132)<8||bg.sat<.05,'the background follows the theme');
 assert.equal(await page.locator('.theme-swatch.selected').getAttribute('aria-label'),'Красный');
 await page.locator('.sidebar [data-page=library]').click();await page.screenshot({path:output+'/library-red.png'});
 await page.locator('.sidebar [data-page=settings]').click();
 for(const [name,expected] of [['Изумрудный',217-70],['Фиолетовый',217+48],['Оранжевый',217-192]]){
   await page.getByRole('radio',{name}).first().click();await page.waitForTimeout(120);
   const h=await hueOf(page,ACCENT,'color');assert.ok(diff(h.hue,(expected+360)%360)<5,name+' '+h.hue);
   await page.screenshot({path:output+'/settings-'+name+'.png'});
 }
 await page.getByRole('radio',{name:'Графит'}).first().click();await page.waitForTimeout(120);
 const gray=await hueOf(page,ACCENT,'color');assert.ok(gray.sat<.2,'graphite is nearly colourless '+gray.sat);
 // custom RGB: drag the sliders (live preview), release saves
 await page.evaluate(()=>{for(const [id,v] of [['theme-r',20],['theme-g',200],['theme-b',60]]){const i=document.getElementById(id);i.value=v;i.dispatchEvent(new Event('input',{bubbles:true}));}});
 assert.equal(await page.locator('#theme-hex').innerText(),'#14c83c');
 const live=await hueOf(page,ACCENT,'color');assert.ok(Math.abs(live.hue-((140+(217-0))%360))<6||diff(live.hue,217+(((136-220)%360+540)%360-180))<6,'live preview follows the sliders '+live.hue);
 assert.ok(!calls.some(c=>c.method==='settings'&&c.data.themeColor==='#14c83c'),'dragging alone does not save');
 await page.evaluate(()=>document.getElementById('theme-b').dispatchEvent(new Event('change',{bubbles:true})));
 await called(c=>c.method==='settings'&&c.data.themePreset==='custom'&&c.data.themeColor==='#14c83c','custom saved');
 assert.equal(await page.locator('.theme-swatch.custom.selected').count(),1);await page.screenshot({path:output+'/settings-custom.png',fullPage:true});
 // depth
 const before=await hueOf(page,'background:var(--bg)','backgroundColor');
 await page.getByRole('radio',{name:'Светлее'}).click();await called(c=>c.data.themeDepth==='soft','soft');await page.waitForTimeout(100);
 const soft=await hueOf(page,'background:var(--bg)','backgroundColor');assert.ok(soft.light>before.light,'lighter background '+before.light+' → '+soft.light);
 await page.getByRole('radio',{name:'Глубже'}).click();await called(c=>c.data.themeDepth==='deep','deep');await page.waitForTimeout(100);
 const deep=await hueOf(page,'background:var(--bg)','backgroundColor');assert.ok(deep.light<before.light,'deeper background');
 const text=await hueOf(page,'color:var(--text)','color');assert.ok(text.light>.85,'text stays bright in a deep theme '+text.light);
 // persistence: a reload restores the theme before the first paint (early script + localStorage)
 await page.reload();
 assert.equal(await page.evaluate(()=>document.querySelector('link[data-themed]').media),'all','the themed sheet is on right after load');
 await page.waitForFunction(()=>S.settings&&S.settings.firstRunDone===true);
 // reset
 await page.locator('.sidebar [data-page=settings]').click();await page.locator('#theme-reset').click();await called(c=>c.data.themePreset==='default'&&c.data.themeDepth==='normal','reset');
 await page.waitForFunction(()=>document.querySelector('link[data-themed]').media==='not all');
 const back=await hueOf(page,ACCENT,'color');assert.ok(Math.abs(back.hue-217)<3,'reset returns the original blue');
 // every screen still fits the window in a themed state
 await page.getByRole('radio',{name:'Сакура'}).first().click();await page.waitForTimeout(120);
 for(const name of ['watch','library','enhance','words','history','settings','models','diagnostics']){await page.locator(`.sidebar [data-page=${name}]`).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name+' overflows');}
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:'themes: presets, custom RGB live preview + save, depth, persistence, reset, no overflow'}));
}finally{await browser.close();server.close();}
