'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {Backend}=require('../desktop/backend.cjs');
const temp=async t=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-root-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;};
const probe=async()=>({duration:60,audio:[{index:1,language:'eng',title:'English'}],subtitleTracks:[],video:true,videoCodec:'h264',width:640,height:360,frameRate:'24/1'});
async function setup(t){
  const dir=await temp(t),root=path.join(dir,'anime');await fs.mkdir(root);
  const b=await new Backend(path.join(dir,'data'),{manageModels:false}).init();b.probe=probe;
  return {b,root,dir};
}
const touch=async(root,...parts)=>{const f=path.join(root,...parts);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,'x'+parts.join('/'));return f;};
const sub=`1\n00:00:01,000 --> 00:00:02,000\nHello there.\n`;

test('the library folder must be an existing absolute directory',async t=>{
  const {b,root,dir}=await setup(t);
  await assert.rejects(b.configure({libraryRoot:'relative/path'}),/полный путь/);
  await assert.rejects(b.configure({libraryRoot:path.join(dir,'missing')}),/не найдена/);
  const file=await touch(dir,'file.txt');await assert.rejects(b.configure({libraryRoot:file}),/Это не папка/);
  await b.configure({libraryRoot:root});assert.equal(b.db.settings.libraryRoot,root);
  await b.configure({libraryRoot:''});assert.equal(b.db.settings.libraryRoot,'');
});
test('"+ Folder" creates a real sub-folder in the library folder, with safe unique names, and reuses an existing one',async t=>{
  const {b,root}=await setup(t);await b.configure({libraryRoot:root});
  const a=await b.saveFolder({name:'Клинок, рассекающий демонов'});
  assert.equal(a.dirName,'Клинок, рассекающий демонов');assert.ok((await fs.stat(path.join(root,a.dirName))).isDirectory());
  const bad=await b.saveFolder({name:'Re:Zero / Season 2?'});assert.equal(bad.dirName,'Re_Zero _ Season 2_');
  await fs.mkdir(path.join(root,'Steins;Gate'));const sg=await b.saveFolder({name:'Steins;Gate'});assert.equal(sg.dirName,'Steins;Gate','an existing directory is reused');
  const clash=await b.saveFolder({name:'steins;gate!'});assert.notEqual(clash.dirName.toLowerCase(),'steins;gate');
  // without a library folder nothing is created on disk
  await b.configure({libraryRoot:''});const virtual=await b.saveFolder({name:'Only in the app'});assert.equal(virtual.dirName,null);assert.deepEqual((await fs.readdir(root)).includes('Only in the app'),false);
});
test('scan turns sub-folders into anime and videos into episodes with their subtitles; nothing is added twice',async t=>{
  const {b,root}=await setup(t);await b.configure({libraryRoot:root});
  await touch(root,'Show A','E02.mp4');await touch(root,'Show A','E10.mp4');await touch(root,'Show A','E02.en.srt');
  await fs.writeFile(path.join(root,'Show A','E02.en.srt'),sub);
  await fs.mkdir(path.join(root,'Show B'));await touch(root,'loose.mp4');await touch(root,'Show A','notes.txt');await touch(root,'.hidden','x.mp4');
  const r=await b.scanLibrary();
  assert.equal(r.added,3);assert.equal(r.folders,2);
  const names=b.db.folders.map(f=>f.name).sort();assert.deepEqual(names,['Show A','Show B']);
  const a=b.db.folders.find(f=>f.name==='Show A'),inA=b.db.episodes.filter(e=>e.folderId===a.id).map(e=>e.title).sort();
  assert.deepEqual(inA,['E02','E10']);
  const e2=b.db.episodes.find(e=>e.title==='E02');assert.ok(e2.cues.length>0,'the sidecar subtitle file was attached');
  assert.equal(b.db.episodes.find(e=>e.title==='loose').folderId==null,true);
  assert.equal((await b.scanLibrary()).added,0,'a second scan adds nothing');assert.equal(b.db.episodes.length,3);
  await touch(root,'Show B','new.mkv');assert.equal((await b.scanLibrary()).added,1);
  assert.equal(b.db.episodes.find(e=>e.title==='new').folderId,b.db.folders.find(f=>f.name==='Show B').id);
});
test('a folder created in the app and a directory of the same name become one anime; manual moves survive rescans',async t=>{
  const {b,root}=await setup(t);
  const virtual=await b.saveFolder({name:'Show A',cover:null});await b.configure({libraryRoot:root});
  await touch(root,'show a','E01.mp4');await b.scanLibrary();
  assert.equal(b.db.folders.length,1);assert.equal(b.db.folders[0].id,virtual.id);assert.equal(b.db.folders[0].dirName,'show a');
  const other=await b.saveFolder({name:'Other'});const ep=b.db.episodes[0];await b.moveEpisodes([ep.id],other.id);
  await b.scanLibrary();assert.equal(b.db.episodes.length,1);assert.equal(ep.folderId,other.id,'the scan does not undo a move');
});
test('removing an episode or a folder never deletes files and the scan does not bring them back until restored',async t=>{
  const {b,root}=await setup(t);await b.configure({libraryRoot:root});
  const video=await touch(root,'Show A','E01.mp4');await touch(root,'Show A','E02.mp4');await touch(root,'Show C','E01.mp4');await b.scanLibrary();
  const one=b.db.episodes.find(e=>e.filePath===video);await b.remove(one.id);
  assert.equal((await fs.stat(video)).isFile(),true,'the video stays on disk');
  await b.scanLibrary();assert.equal(b.db.episodes.some(e=>e.filePath===video),false);assert.equal(b.db.episodes.length,2);
  const c=b.db.folders.find(f=>f.name==='Show C');await b.removeFolder(c.id);
  assert.equal((await fs.stat(path.join(root,'Show C','E01.mp4'))).isFile(),true);
  await b.scanLibrary();assert.equal(b.db.folders.some(f=>f.name==='Show C'),false);assert.equal(b.snapshot().ignoredCount,2);
  const back=await b.scanLibrary({restore:true});assert.equal(back.added,1,'only the removed episode returns; the other one never left the library');assert.ok(b.db.folders.some(f=>f.name==='Show C'));assert.equal(b.snapshot().ignoredCount,0);
});
test('an unavailable library folder is reported instead of crashing, and no root means no scan',async t=>{
  const {b,root}=await setup(t);assert.deepEqual(await b.scanLibrary(),{added:0,folders:0});
  await b.configure({libraryRoot:root});await fs.rm(root,{recursive:true});
  const r=await b.scanLibrary();assert.ok(r.error);assert.match(b.snapshot().libraryScan.errors[0],/недоступна/);
});
test('a failing file is reported but does not stop the rest of the scan',async t=>{
  const {b,root}=await setup(t);await b.configure({libraryRoot:root});
  await touch(root,'Show','bad.mp4');await touch(root,'Show','good.mp4');
  b.probe=async f=>{if(f.endsWith('bad.mp4'))throw Error('повреждённый файл');return probe();};
  const r=await b.scanLibrary();assert.equal(r.added,1);assert.equal(b.db.episodes[0].title,'good');assert.match(b.snapshot().libraryScan.errors.join(' '),/bad\.mp4/);
});
