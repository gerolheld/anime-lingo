'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {FrameProgress}=require('../desktop/enhance.cjs');
const {Backend}=require('../desktop/backend.cjs');

test('enhancement ETA waits for useful samples and follows recent throughput',()=>{
  let now=0;const meter=new FrameProgress(1000,()=>now);
  now=500;assert.equal(meter.update(1).eta,null);
  now=1500;assert.equal(meter.update(7).eta,null);
  now=2000;const first=meter.update(10);assert.equal(first.fps,5);assert.equal(first.eta,198);
  for(let i=1;i<=40;i++){now+=500;meter.update(10+i*5);}
  const recent=meter.update(210);assert.equal(recent.fps,10);assert.equal(recent.eta,79);
  assert.ok(meter.points.length<=24,'progress samples remain bounded');
});

test('old enhancement settings migrate to the streaming worker without changing saved subtitles',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-enhance-migrate-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const episode={id:'saved',title:'My anime',state:'ready',cues:[{start:1,end:2,text:'Hello.',ru:'Привет.'}]};
  await fs.writeFile(path.join(root,'library.json'),JSON.stringify({settings:{enhanceBinary:'/local/realesrgan-ncnn-vulkan',enhanceTile:128},episodes:[episode],words:[{id:'word',word:'hello'}]}));
  const b=await new Backend(root,{manageModels:false}).init();
  assert.equal(b.db.settings.enhanceBinary,path.join('/local','anime-lingo-enhance'));assert.equal(b.db.settings.enhanceTile,0);
  assert.deepEqual(b.db.episodes,[episode]);assert.equal(b.db.words[0].word,'hello');
  await b.configure({enhanceTile:512});await b.close();
  const again=await new Backend(root,{manageModels:false}).init();assert.equal(again.db.settings.enhanceTile,512);await again.close();
});

test('automatic tile is accepted, invalid tiles and changes during model work are rejected',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-enhance-settings-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const b=await new Backend(root,{manageModels:false}).init();await b.configure({enhanceTile:0});
  for(const value of [-1,8,32.5,2049,'wrong'])await assert.rejects(b.configure({enhanceTile:value}),/Размер плитки/);
  b.tasks.set('active',new AbortController());await assert.rejects(b.configure({enhanceTile:256}),/Дождитесь/);b.tasks.clear();await b.close();
});
