'use strict';
// Text, clock and mock-only checks: never launch FFmpeg, Electron or a model.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const R=require('../desktop/ui/reading.js');
const {Backend}=require('../desktop/backend.cjs');
const normalize=text=>text.replace(/\s+/gu,' ').trim();
function cue(text='I thought you had already left.',ru='Я думал, ты уже ушёл.'){
  const words=R.tokens(text).map((w,i)=>({text:w.text,start:10+i*.5,end:10+(i+1)*.5,charStart:w.start,charEnd:w.end}));
  return {start:10,end:10+words.length*.5,text,ru,words};
}
test('compact parts preserve words, contractions, punctuation and full hover context',()=>{
  const c=cue("Don't go, because I thought you had already left for the river bank.",'Не уходи, ведь я думал, что ты уже ушёл к берегу реки.');
  const before=JSON.stringify(c),parts=R.cueParts(c);
  assert.ok(parts.length>1);assert.equal(normalize(parts.map(p=>p.text).join(' ')),c.text);
  assert.equal(normalize(parts[0].ruParts.map(p=>p.text).join(' ')),c.ru);
  for(const p of parts){assert.ok(R.tokens(p.text).length<=6);assert.ok(p.text.length<=42);assert.equal(p.context,c.text);assert.equal(p.translation,c.ru);}
  assert.equal(JSON.stringify(c),before);
});
test('real aligner times are retained and word offsets are local to each part',()=>{
  const c=cue('All you can really do is remember the past and dream of it.');
  const parts=R.cueParts(c);
  for(const p of parts){assert.equal(p.precise,true);for(const w of p.words){assert.equal(p.text.slice(w.charStart,w.charEnd),w.text);assert.ok(w.start>=p.start);assert.ok(w.end<=p.end);}assert.ok(p.end>p.start);}
  assert.equal(parts[0].start,c.start);assert.equal(parts.at(-1).end,c.end);
});
test('word count and character limits survive a long monologue and odd whitespace',()=>{
  const text='During the Third Grail War,\n with sufficient assistance from the German Army, a master seized the grail. '.repeat(12);
  for(const size of [3,5,6]){const parts=R.split(text,{size});assert.equal(normalize(parts.map(p=>p.text).join(' ')),normalize(text));for(const p of parts){assert.ok(R.tokens(p.text).length<=6);assert.ok(p.text.length<=42);}}
});
test('SRT/VTT without word times uses bounded estimates and reports approximate timing',()=>{
  const c={start:2,end:8,text:'This imported subtitle has no word timestamps but still fits into short pieces.',ru:'Здесь нет точных времён отдельных слов.'};
  const parts=R.cueParts(c);assert.ok(parts.length>1);
  for(const p of parts){assert.equal(p.precise,false);assert.ok(p.start>=2&&p.end<=8&&p.end>p.start);assert.equal(p.words.length,0);}
  assert.equal(R.cueParts({start:5,end:4,text:'bad'}).length,0);
  assert.equal(R.cueParts({start:0,end:1,text:'   '}).length,0);
});
test('empty text, one long word, Unicode and degenerate alignment do not hang',()=>{
  assert.deepEqual(R.split(''),[]);assert.equal(R.split('x'.repeat(300)).length,1);
  const c=cue('Hello hello hello hello hello hello hello hello.','«Здравствуй», — сказал он.');
  c.words[3].end=c.words[3].start;c.words.push({text:'bad',start:NaN,end:10,charStart:0,charEnd:3});
  for(const p of R.cueParts(c)){assert.ok(Number.isFinite(p.start)&&Number.isFinite(p.end)&&p.end>p.start);}
  assert.equal(normalize(R.split(c.ru).map(p=>p.text).join(' ')),c.ru);
});
test('reading holds through silence until the next part; disabling hold clears text',()=>{
  const a={id:'a',start:1,end:2},b={id:'b',start:6,end:7},parts=[a,b];
  assert.equal(R.at(parts,.9),null);assert.equal(R.at(parts,1),a);assert.equal(R.at(parts,4),a);assert.equal(R.at(parts,4,{hold:false}),null);assert.equal(R.at(parts,6),b);assert.equal(R.at(parts,100),b);
  assert.equal(R.at(parts,7,{hold:false}),null);assert.equal(R.at([],100),null);
});
test('auto pause pins previous text at a boundary, resume advances once without a loop',()=>{
  const a={id:'a',start:1,end:2},b={id:'b',start:2,end:3},s=new R.Session([a,b]);
  s.update(1.9,{playing:true,autoPause:true});
  const stopped=s.update(2.01,{playing:true,autoPause:true});assert.equal(stopped.pause,true);assert.equal(stopped.part,a);assert.equal(stopped.pinned,true);
  assert.equal(s.update(2.01,{autoPause:true}).part,a);
  s.resume();assert.equal(s.update(2.01,{playing:true,autoPause:true}).part,b);
  assert.equal(s.update(2.1,{playing:true,autoPause:true}).pause,false);
  assert.equal(s.update(3.01,{playing:true,autoPause:true}).pause,true);
});
test('auto pause during a gap does not repeatedly pause after continuing',()=>{
  const a={id:'a',start:1,end:2},b={id:'b',start:5,end:6},s=new R.Session([a,b]);
  s.update(1.8,{playing:true,autoPause:true});assert.equal(s.update(2.1,{playing:true,autoPause:true}).pause,true);
  s.resume();assert.equal(s.update(2.2,{playing:true,autoPause:true}).pause,false);assert.equal(s.update(4.8,{playing:true,autoPause:true}).pause,false);assert.equal(s.update(5.5,{playing:true,autoPause:true}).part,b);
});
test('seeking in both directions clears pins and permits repeating the same part',()=>{
  const parts=[{id:'a',start:1,end:2},{id:'b',start:2,end:3}],s=new R.Session(parts);
  s.update(1.8,{playing:true,autoPause:true});s.update(2.1,{playing:true,autoPause:true});
  assert.equal(s.update(2.7,{seeking:true,playing:true,autoPause:true}).part,parts[1]);
  assert.equal(s.update(1.2,{seeking:true,playing:true,autoPause:true}).part,parts[0]);
  assert.equal(s.update(2.01,{playing:true,autoPause:true}).pause,true);
});
test('manual pause, disabled auto pause and backward time do not trigger unwanted pauses',()=>{
  const parts=[{id:'a',start:1,end:2},{id:'b',start:2,end:3}],s=new R.Session(parts);
  s.update(1.9,{playing:true});assert.equal(s.update(2.1,{playing:true}).pause,false);
  assert.equal(s.update(1.5,{playing:false,autoPause:true}).pause,false);
  assert.equal(s.update(2.1,{playing:false,autoPause:true}).pause,false);
  s.reset();s.update(1.9,{playing:true,autoPause:true});s.update(2.1,{playing:true,autoPause:true});
  assert.equal(s.update(2.2,{playing:false,autoPause:false}).part,parts[1]);
});
test('Russian presentation preserves full translation and advances only within its sentence',()=>{
  const c=cue('All you can really do is remember the past and dream of it.','Всё, что мы действительно можем делать, — это вспоминать прошлое и мечтать о нём.');
  const parts=R.cueParts(c),ru=parts[0].ruParts;
  assert.equal(normalize(ru.map(p=>p.text).join(' ')),c.ru);
  assert.equal(R.russian(parts[0],c.start),ru[0].text);assert.equal(R.russian(parts.at(-1),c.end+50),ru.at(-1).text);
  for(const p of ru){assert.ok(p.start>=c.start&&p.end<=c.end);assert.ok(p.end>p.start);}
});
test('track rebuild supports late live captions and updated cached sentence translations',()=>{
  const c=cue(),cues=[c],first=R.build(cues);cues.push({...cue('Here comes another line.'),start:20,end:23});
  const second=R.build(cues);assert.ok(second.length>first.length);assert.equal(R.at(second,21).context,cues[1].text);
  const untranslated={start:0,end:4,text:'This is one sentence.',ru:''};
  assert.equal(R.build([untranslated],{translate:()=> 'Это одна реплика.'})[0].translation,'Это одна реплика.');
});
test('reading settings migrate once and persist without modifying subtitles or loading models',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-reading-'));
  const original=cue();const modelManager={state:{phase:'idle'},with(){throw Error('A model must never run in this test');}};
  try{
    await fs.writeFile(path.join(root,'library.json'),JSON.stringify({settings:{pauseOnHover:false},episodes:[{id:'test',cues:[original],ruCues:[]}],words:[],history:[],enhancements:[]}));
    const b=await new Backend(root,{modelManager}).init();assert.equal(b.db.settings.readingMode,true);assert.equal(b.db.settings.pauseOnHover,true);assert.equal(b.db.settings.readingAutoPause,false);
    assert.deepEqual(b.db.episodes[0].cues,[original]);
    await b.configure({readingMode:false,readingHold:false,readingAutoPause:true,readingSize:3,pauseOnHover:false});
    const next=await new Backend(root,{modelManager}).init();assert.equal(next.db.settings.readingMode,false);assert.equal(next.db.settings.pauseOnHover,false);assert.equal(next.db.settings.readingSize,3);assert.equal(next.db.settings.readingAutoPause,true);
    assert.deepEqual(next.db.episodes[0].cues,[original]);await assert.rejects(next.configure({readingSize:50}),/3, 5 или 6/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
