'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Backend}=require('../desktop/backend.cjs'),{decodeCover}=require('../desktop/folders.cjs'),UI=require('../desktop/ui/presentation.js');
const models={state:{phase:'idle'},with(){throw Error('Models forbidden in folder tests');}};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-folders-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const b=await new Backend(root,{modelManager:models}).init();return b;}
test('old libraries gain folders without rewriting subtitles, word times or progress',async t=>{
 const b=await fixture(t),episode={id:'e',title:'Amagi - Episode 01',position:125,duration:1440,cues:[{start:1,end:2,text:'All right.',ru:'Хорошо.',words:[{text:'All',start:1,end:1.5}]}],ruCues:[]};
 b.db.episodes=[episode];delete b.db.folders;await b.save();const next=await new Backend(b.root,{modelManager:models}).init();assert.deepEqual(next.db.folders,[]);assert.deepEqual(next.episode('e'),episode);
});
test('folder creation, rename, moves and deletion persist while media and learning records survive',async t=>{
 const b=await fixture(t),media=path.join(b.root,'original.mp4');await fs.writeFile(media,'not a video; no decoder is run');b.db.episodes=[{id:'e',title:'Episode',position:100,duration:200,filePath:media,cues:[{text:'Hello.',ru:'Привет.'}],ruCues:[]}];b.db.words=[{id:'w',episodeId:'e',word:'Hello'}];b.db.history=[{episodeId:'e',date:1}];const preserved=structuredClone(b.episode('e'));
 const f=await b.saveFolder({name:'  Amagi Brilliant Park  '});assert.equal(f.name,'Amagi Brilliant Park');await b.moveEpisodes(['e','e'],f.id);assert.equal(b.episode('e').folderId,f.id);assert.equal(b.episode('e').position,100);
 await b.saveFolder({id:f.id,name:'Амаги'});const next=await new Backend(b.root,{modelManager:models}).init();assert.equal(next.db.folders[0].name,'Амаги');assert.equal(next.episode('e').folderId,f.id);await next.removeFolder(f.id);assert.equal(next.episode('e').folderId,null);const after={...next.episode('e')};delete after.folderId;assert.deepEqual(after,preserved);assert.equal(await fs.readFile(media,'utf8'),'not a video; no decoder is run');assert.equal(next.db.words.length,1);assert.equal(next.db.history.length,1);
});
test('bulk movement validates every episode and folder before changing any record',async t=>{
 const b=await fixture(t);b.db.episodes=[{id:'e',cues:[],ruCues:[]}];const f=await b.saveFolder({name:'Anime'});
 await assert.rejects(b.moveEpisodes(['e','missing'],f.id),/Серия не найдена/);assert.equal(b.episode('e').folderId,undefined);await assert.rejects(b.moveEpisodes(['e'],'missing'),/Папка не найдена/);await assert.rejects(b.moveEpisodes([],f.id),/Выбери/);await b.moveEpisodes(['e'],f.id);await b.moveEpisodes(['e'],null);assert.equal(b.episode('e').folderId,null);
 await assert.rejects(b.addFiles(['/not/read'],null,'missing'),/Папка не найдена/);
});
test('folder names are unique and checked; concurrent duplicate creation cannot race',async t=>{
 const b=await fixture(t);await assert.rejects(b.saveFolder({name:'  '}),/Название/);await assert.rejects(b.saveFolder({name:'a\nname'}),/Название/);await assert.rejects(b.saveFolder({name:'x'.repeat(141)}),/Название/);
 const results=await Promise.allSettled([b.saveFolder({name:'Fate'}),b.saveFolder({name:'fate'})]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(b.db.folders.length,1);await assert.rejects(b.saveFolder({id:'missing',name:'Other'}),/Папка не найдена/);
});
test('raster covers are copied locally, replacement cleans old cover and snapshots conceal file paths',async t=>{
 const b=await fixture(t),bytes=await fs.readFile(path.join(__dirname,'../desktop/assets/reference/fate-cover.png')),data='data:image/png;base64,'+bytes.toString('base64'),f=await b.saveFolder({name:'Fate',cover:data});
 const old=b.coverPath(f.id);assert.deepEqual(await fs.readFile(old),bytes);if(process.platform!=='win32')assert.equal((await fs.stat(old)).mode&0o777,0o600);assert.ok(f.coverURL.startsWith('lingo-media://cover/'));assert.equal('coverFile' in b.snapshot().folders[0],false);
 const changed=await b.saveFolder({id:f.id,name:'Fate 2',cover:data});assert.notEqual(changed.coverURL,f.coverURL);await assert.rejects(fs.access(old));const current=b.coverPath(f.id);await b.saveFolder({id:f.id,name:'Fate 2',cover:null});assert.equal(b.coverPath(f.id),null);await assert.rejects(fs.access(current));
 assert.throws(()=>decodeCover('data:image/svg+xml;base64,PHN2Zz4='),/поддерживаются/);assert.throws(()=>decodeCover('data:image/png;base64,aGVsbG8='),/Содержимое/);assert.throws(()=>decodeCover('data:image/png;base64,'+Buffer.alloc(5*1024*1024+1).toString('base64')),/размер/);
});
test('import into a folder attaches existing sidecar subtitles and retains folder on duplicate import',async t=>{
 const b=await fixture(t),file=path.join(b.root,'Episode 01.mp4');await fs.writeFile(file,'mock media');await fs.writeFile(path.join(b.root,'Episode 01.en.vtt'),'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello.');
 b.probe=async()=>({duration:20,audio:[{index:1,language:'eng'}],subtitleTracks:[],video:true,videoCodec:'h264',width:1920,height:1080});const f=await b.saveFolder({name:'Anime'}),result=await b.addFiles([file],null,f.id);assert.deepEqual(result.errors,[]);assert.equal(result.episodes[0].folderId,f.id);assert.equal(result.episodes[0].cues[0].text,'Hello.');await b.addFiles([file],null,f.id);assert.equal(b.db.episodes.length,1);
});
test('library filters hide grouped episodes at root, search inside folders and use natural episode order',()=>{
 const folders=[{id:'f',name:'Amagi'}],episodes=[{id:'10',title:'Episode 10',folderId:'f'},{id:'2',title:'Episode 2',folderId:'f'},{id:'1',title:'Episode 1',folderId:'deleted'}];
 assert.deepEqual(UI.libraryItems(episodes,folders).map(e=>e.id),['1']);assert.deepEqual(UI.libraryItems(episodes,folders,{folderId:'f'}).map(e=>e.id),['2','10']);assert.deepEqual(UI.libraryItems(episodes,folders,{query:'amagi'}).map(e=>e.id),['2','10']);assert.equal(UI.counted(3,'серия','серии','серий'),'3 серии');assert.equal(UI.counted(11,'серия','серии','серий'),'11 серий');assert.equal(UI.seriesName('Amagi Brilliant Park - Episode 01 [English Dub]'),'Amagi Brilliant Park');assert.deepEqual(UI.folderStats([{duration:100,position:50,state:'ready'},{duration:100,position:500,state:'new'}]),{count:2,ready:1,percent:75});
});
