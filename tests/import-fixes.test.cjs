'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {Backend,expandPaths,samePath,playbackName}=require('../desktop/backend.cjs');
const {safeFileName,writeAtomic}=require('../desktop/store.cjs');
const temp=async t=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-imp-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;};

test('a dropped folder is searched for media and subtitles in natural order; other files are reported, not imported',async t=>{
  const dir=await temp(t);
  await fs.mkdir(path.join(dir,'Show','Season 1','extras','deep','deeper'),{recursive:true});
  for(const n of ['Show/E10.mkv','Show/E2.mkv','Show/E2.en.srt','Show/notes.txt','Show/Season 1/E1.mp4','Show/.hidden.mkv','Show/Season 1/extras/deep/deeper/too-deep.mkv'])await fs.writeFile(path.join(dir,n),'x');
  const r=await expandPaths([path.join(dir,'Show')]);
  assert.deepEqual(r.files.map(f=>path.relative(dir,f).split(path.sep).join('/')),['Show/E2.en.srt','Show/E2.mkv','Show/E10.mkv','Show/Season 1/E1.mp4']);
  const single=await expandPaths([path.join(dir,'Show','notes.txt'),path.join(dir,'missing.mkv')]);
  assert.equal(single.files.length,0);assert.equal(single.skipped.length,2);assert.match(single.skipped[0].error,/Неподдерживаемый/);
  const many=await expandPaths([dir],{limit:2});assert.equal(many.files.length,2);
});
test('Backend.addFiles takes folders and reports unsupported files with a clear message',async t=>{
  const dir=await temp(t),media=path.join(dir,'media');await fs.mkdir(media);
  await fs.writeFile(path.join(media,'a.mp4'),'x');await fs.writeFile(path.join(media,'readme.txt'),'x');
  const b=await new Backend(path.join(dir,'data'),{manageModels:false}).init();
  b.probe=async()=>({duration:60,audio:[{index:1,language:'eng',title:'x'}],subtitleTracks:[],video:true,videoCodec:'h264',width:640,height:360,frameRate:'24/1'});
  const r=await b.addFiles([media,path.join(media,'readme.txt')]);
  assert.equal(r.episodes.length,1);assert.equal(r.episodes[0].title,'a');assert.ok(r.errors.some(e=>/Неподдерживаемый/.test(e.error)));
  const again=await b.addFiles([path.join(media,'a.mp4')]);assert.equal(again.episodes[0].id,r.episodes[0].id,'same file is not added twice');assert.equal(b.db.episodes.length,1);
});
test('paths differing only by case are the same file on Windows and macOS, different on Linux',()=>{
  const win=process.platform==='win32'||process.platform==='darwin';
  assert.equal(samePath('/A/Video.mp4','/a/video.MP4'),win);assert.equal(samePath('/a/x.mp4','/a/x.mp4'),true);
});
test('export file names are legal everywhere',()=>{
  assert.equal(safeFileName('Fate/Apocrypha: Episode 01?'),'Fate_Apocrypha_ Episode 01_');
  assert.equal(safeFileName('CON'),'anime-lingo-CON');assert.equal(safeFileName('nul.txt'),'anime-lingo-nul.txt');assert.equal(safeFileName('   '),'anime-lingo-file');assert.equal(safeFileName('name. . '),'name');
  assert.equal(safeFileName('a'.repeat(300)).length,120);
});
test('exports are written atomically and leave no temp or backup files next to them',async t=>{
  const dir=await temp(t),file=path.join(dir,'words.json');
  await writeAtomic(file,'[1]',{mode:0o644,backup:false});await writeAtomic(file,'[1,2]',{mode:0o644,backup:false});
  assert.equal(await fs.readFile(file,'utf8'),'[1,2]');assert.deepEqual(await fs.readdir(dir),['words.json']);
});
test('the compatible playback copy is tied to the source file so a changed source is converted again',()=>{
  const e={id:'e1',modified:1000,size:5};
  const first=playbackName(e,1);
  assert.equal(playbackName(e,1),first);assert.notEqual(playbackName({...e,modified:2000},1),first);assert.notEqual(playbackName({...e,size:6},1),first);assert.notEqual(playbackName(e,2),first);
  assert.ok(first.startsWith('e1-1-'),'remove() still finds it by the episode id prefix');
});
test('the error report names the system and component state but not personal paths or library content',async t=>{
  const dir=await temp(t),b=await new Backend(path.join(dir,'data'),{manageModels:false,gpuDetect:async()=>({gpus:[{name:'Test GPU',vramTotal:8*1024**3,driver:'xe'}]})}).init();
  b.db.episodes.push({id:'e',title:'Secret Series',cues:[{text:'private words'}],state:'new'});b.db.words.push({word:'secret'});
  b.lastError='Нет файла '+os.homedir()+'/Videos/x.mp4';
  const report=await b.errorReport('Ошибка в '+os.homedir()+'/Videos');
  assert.match(report,/Anime Lingo 0\.1\./);assert.match(report,/Test GPU 8 ГБ драйвер xe/);assert.match(report,/Защита обработки:/);
  assert.ok(!report.includes(os.homedir()),'home directory is shortened');assert.match(report,/~\/Videos/);
  assert.ok(!/Secret Series|private words|secret/.test(report),'no library content');
});
