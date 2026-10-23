'use strict';
// Execute the real renderer in a tiny in-memory DOM and a fake media clock.
// No browser, GPU, video decoder, subprocess or AI model is launched.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const R=require('../desktop/ui/reading.js');
const AL=require('../extension/core.js');
const LingoUI=require('../desktop/ui/presentation.js');
const settings={fontSize:36,ruSize:24,bottom:12,opacity:55,offset:0,pauseOnHover:true,readingMode:true,readingSize:5,readingHold:true,readingAutoPause:false};
const text='All you can really do is remember the past and dream of it.';
const cue={start:10,end:16.5,text,ru:'Всё, что мы действительно можем делать, — это вспоминать прошлое и мечтать о нём.',words:R.tokens(text).map((w,i)=>({text:w.text,start:10+i*.5,end:10+(i+1)*.5,charStart:w.start,charEnd:w.end}))};
class Node {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.hidden=false;this.disabled=false;this.style={setProperty:(k,v)=>this.style[k]=v};this.value='';this.checked=false;this.className='';this.clientWidth=640;this._text='';this.classList={toggle:(name,on)=>{const set=new Set(this.className.split(/\s+/).filter(Boolean));if(on??!set.has(name))set.add(name);else set.delete(name);this.className=[...set].join(' ');},contains:name=>this.className.split(/\s+/).includes(name),add:name=>this.classList.toggle(name,true),remove:name=>this.classList.toggle(name,false)};}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  set textContent(value){this.children=[];this._text=String(value);}
  append(...nodes){for(const n of nodes){const child=typeof n==='string'?Object.assign(new Node('#text'),{textContent:n}):n;child.parent=this;this.children.push(child);}}
  replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
  setAttribute(k,v){this.attributes[k]=String(v);}
  getAttribute(k){return this.attributes[k]??null;}
  querySelectorAll(selector){const all=this.children.flatMap(c=>[c,...c.querySelectorAll('*')]);if(selector==='*')return all;if(selector==='[data-word-start]')return all.filter(n=>n.dataset.wordStart!==undefined);if(selector.startsWith('.'))return all.filter(n=>n.classList.contains(selector.slice(1)));return [];}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  contains(node){return node===this||this.querySelectorAll('*').includes(node);}
  get scrollWidth(){return 20+this.textContent.length*18;}
  focus(){this.focused=true;}
  scrollIntoView(){}
  addEventListener(){}
}
async function renderer(){
  const html=fs.readFileSync(path.join(__dirname,'../desktop/ui/index.html'),'utf8'),nodes=new Map(),fields=new Map(),listeners={},calls=[];
  for(const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)){
    const attrs=Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]]));
    if(!attrs.id&&!attrs.name)continue;
    const node=new Node(match[1]);Object.assign(node,{type:attrs.type||'',value:attrs.value||'',className:attrs.class||'',hidden:/\bhidden\b/.test(match[2])});
    node.checked=/\bchecked\b/.test(match[2]);node.attributes=attrs;
    if(attrs.id)nodes.set(attrs.id,node);if(attrs.name)fields.set(attrs.name,node);
  }
  const form=nodes.get('settings-form');form.elements={namedItem:name=>fields.get(name)};for(const [k,n]of fields)form[k]=n;
  const video=nodes.get('video');video._time=0;video.paused=true;video.seeking=false;video.duration=60;
  Object.defineProperty(video,'currentTime',{get:()=>video._time,set:t=>{video._time=t;video.seeking=true;video.onseeking?.();video.seeking=false;}});
  video.pause=()=>{const was=video.paused;video.paused=true;if(!was)video.onpause?.();};video.play=()=>{video.paused=false;video.onplay?.();return Promise.resolve();};video.load=()=>{};
  const document={body:new Node('body'),getElementById:id=>{if(!nodes.has(id))throw Error('Unknown UI id: '+id);return nodes.get(id);},createElement:t=>new Node(t),createTextNode:text=>Object.assign(new Node('#text'),{textContent:text}),querySelectorAll:()=>[],addEventListener:(name,fn)=>{listeners[name]=fn;},activeElement:null,fullscreenElement:null};
  const snapshot={settings:{...settings},episodes:[],words:[],history:[],enhancements:[],modelState:{phase:'idle',label:'Модели выгружены'}};
  const context=vm.createContext({document,window:{lingo:{subscribe(){},async call(method,data){calls.push({method,data});if(method==='snapshot')return {value:snapshot};if(method==='settings'){Object.assign(snapshot.settings,data);return {value:{...snapshot.settings}};}if(method==='lookup'||method==='word-meaning')return {value:{wordTranslation:'вспоминать',source:'mock'}};throw Error('Unexpected IPC: '+method);}}},AL,LingoUI,LingoReading:R,ResizeObserver:class{observe(){}},setInterval(){},setTimeout(){return 1;},clearTimeout(){},console});
  for(const f of ['theme.js','i18n-en.js','i18n.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../desktop/ui/'+f),'utf8'),context);
  vm.runInContext('LingoI18n.init(LingoI18nEN)',context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../desktop/ui/library.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../desktop/ui/models.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../desktop/ui/theme-ui.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../desktop/ui/app.js'),'utf8'),context);
  for(let i=0;i<5;i++)await Promise.resolve();
  context.fixture=JSON.parse(JSON.stringify(cue));
  vm.runInContext("S.current={id:'episode',playable:true,cues:[fixture],ruCues:[]};S.ruTimeline=new AL.Timeline([]);resetReading();",context);
  const run=code=>vm.runInContext(code,context),tick=t=>{video._time=t;run('renderCue();');};
  return {nodes,video,run,tick,calls,listeners,context};
}
test('renderer shows compact bilingual text and highlights actual aligner word times',async()=>{
  const {nodes,run,tick}=await renderer();tick(10.1);
  assert.equal(nodes.get('subtitle-layer').hidden,false);assert.ok(R.tokens(nodes.get('en-line').textContent).length<=6);assert.ok(nodes.get('ru-line').textContent.length<=48);
  assert.equal(nodes.get('en-line').querySelector('.word-speaking').textContent,'All');
  tick(13.2);assert.ok(nodes.get('en-line').textContent.includes('remember'));
  assert.equal(run('S.readingFrame.context'),text);assert.equal(nodes.get('reading-actions').hidden,false);
});
test('renderer holds text through silence, seeks backwards and repeats only current part',async()=>{
  const {nodes,video,run,tick}=await renderer();tick(18);assert.ok(nodes.get('en-line').textContent.includes('dream'));
  video.currentTime=10.2;assert.ok(nodes.get('en-line').textContent.includes('All'));
  tick(13.2);const start=run('S.readingFrame.part.start');run('seekCue()');assert.equal(video.currentTime,start);assert.equal(video.paused,false);
  run('S.settings.offset=2;resetReading();');tick(15.2);const withOffset=run('S.readingFrame.part.start');run('seekCue()');assert.equal(video.currentTime,withOffset+2);
});
test('renderer auto pause retains previous text and Space continues without another immediate stop',async()=>{
  const {nodes,video,run,tick}=await renderer();run('S.settings.readingAutoPause=true;');video.play();tick(10.2);
  const end=run('S.readingFrame.part.end'),before=nodes.get('en-line').textContent;tick(end+.01);
  assert.equal(video.paused,true);assert.equal(nodes.get('en-line').textContent,before);assert.equal(nodes.get('reading-continue').hidden,false);
  run('play()');tick(end+.02);assert.equal(video.paused,false);assert.equal(nodes.get('reading-continue').hidden,true);
});
test('whole phrase opens original EN/RU, pauses and can repeat the original sentence',async()=>{
  const {nodes,video,run,tick}=await renderer();video.play();tick(13.2);run('showPhrase()');
  assert.equal(video.paused,true);assert.equal(nodes.get('phrase-card').hidden,false);assert.equal(nodes.get('phrase-en').textContent,cue.text);assert.equal(nodes.get('phrase-ru').textContent,cue.ru);
  nodes.get('phrase-repeat').onclick();assert.equal(video.currentTime,cue.start);assert.equal(video.paused,false);assert.equal(nodes.get('phrase-card').hidden,true);
});
test('hover requests use original full context and never retranslate stored Russian',async()=>{
  const {video,run,tick,calls}=await renderer();video.play();tick(13.2);await run("showTip('remember',S.readingFrame.context)");
  assert.equal(video.paused,true);assert.equal(calls.find(c=>c.method==='word-meaning').data.context,cue.text);
  assert.equal(calls.filter(c=>c.method==='translate').length,0);
  run('hideTip()');assert.equal(video.paused,false);
});
test('quick controls persist reading settings and whole-line mode restores original text',async()=>{
  const {nodes,run,tick}=await renderer();tick(10.1);await run('configureReading({readingMode:false,readingSize:3,readingAutoPause:true})');
  assert.equal(nodes.get('en-line').textContent,cue.text);assert.equal(nodes.get('ru-line').textContent,cue.ru);assert.equal(nodes.get('reading-actions').hidden,true);
  assert.equal(nodes.get('reading-mode').value,'full');assert.equal(nodes.get('reading-size').disabled,true);
  await run('configureReading({readingMode:true})');assert.ok(R.tokens(nodes.get('en-line').textContent).length<=4);
});
test('live track cache persists across clock ticks and rebuilds on a newly received caption',async()=>{
  const {run,tick}=await renderer();run('S.liveActive=true;S.liveCues=[fixture];resetReading();');tick(10.1);
  const before=run('S.readingSession');tick(10.2);assert.equal(run('S.readingSession'),before);
  run("S.liveCues.push({...fixture,start:25,end:31.5});");tick(25.1);assert.notEqual(run('S.readingSession'),before);
});
test('a newly received live caption keeps an existing reading auto pause pinned',async()=>{
  const {video,run,tick}=await renderer();run('S.liveActive=true;S.liveCues=[fixture];S.settings.readingAutoPause=true;resetReading();');video.play();tick(10.1);
  const end=run('S.readingFrame.part.end');tick(end+.01);assert.equal(video.paused,true);
  const previous=run('S.readingFrame.part.text');run("S.liveCues.push({...fixture,start:25,end:31.5});");tick(end+.01);
  assert.equal(run('S.readingFrame.pinned'),true);assert.equal(run('S.readingFrame.part.text'),previous);
});
test('resize fitting preserves a smaller Russian line in window and fullscreen layouts',async()=>{
  const {nodes,run,tick,context}=await renderer();tick(13.2);
  for(const full of [false,true])for(const width of [360,640,1920]){
    nodes.get('player').clientWidth=width;context.document.fullscreenElement=full?nodes.get('player'):null;run('fitReading();');
    const style=nodes.get('player').style;assert.ok(parseFloat(style['--reading-ru-size'])<parseFloat(style['--reading-en-size']));
  }
});
test('separately imported Russian keeps its own times and full text remains accessible in gaps',async()=>{
  const {nodes,run,tick}=await renderer();
  run("S.current.ruCues=[{start:10.8,end:17,text:'Отдельная русская дорожка со своими временами.'}];S.ruTimeline=new AL.Timeline(S.current.ruCues);resetReading();");
  tick(10.2);assert.equal(nodes.get('ru-line').hidden,true);
  tick(11);assert.equal(nodes.get('ru-line').hidden,false);
  tick(19);run('showPhrase()');assert.equal(nodes.get('phrase-ru').textContent,'Отдельная русская дорожка со своими временами.');
});
