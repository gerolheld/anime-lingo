'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {writeAtomic,readJsonWithBackup,withTimeout}=require('../desktop/store.cjs');
const {Backend}=require('../desktop/backend.cjs');
const temp=async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;};
const episode=(id,state='ready')=>({id,title:id,filePath:'/x/'+id+'.mp4',audio:[],cues:[],ruCues:[],subtitleTracks:[],state,duration:100});

test('atomic write keeps the previous good copy and leaves no temp files',async t=>{
  const dir=await temp(t),file=path.join(dir,'library.json');
  await writeAtomic(file,'{"a":1}');await writeAtomic(file,'{"a":2}');
  assert.equal(await fs.readFile(file,'utf8'),'{"a":2}');assert.equal(await fs.readFile(file+'.bak','utf8'),'{"a":1}');
  assert.deepEqual((await fs.readdir(dir)).sort(),['library.json','library.json.bak']);
});
test('damaged library falls back to the backup and keeps the damaged file aside',async t=>{
  const dir=await temp(t),file=path.join(dir,'library.json');
  await writeAtomic(file,'{"a":1}');await writeAtomic(file,'{"a":2}');await fs.writeFile(file,'{"a":');
  const r=await readJsonWithBackup(file);
  assert.equal(r.source,'backup');assert.equal(r.data.a,1);
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).a,1);
  assert.ok((await fs.readdir(dir)).some(n=>n.startsWith('library.json.damaged-')));
});
test('unreadable library with no usable backup is reported and never overwritten',async t=>{
  const dir=await temp(t),file=path.join(dir,'library.json');await fs.writeFile(file,'garbage');
  await assert.rejects(()=>readJsonWithBackup(file));
  await assert.rejects(()=>new Backend(dir,{manageModels:false}).init(),/Не удалось прочитать библиотеку/);
  assert.equal(await fs.readFile(file,'utf8'),'garbage');
  assert.deepEqual(await readJsonWithBackup(path.join(dir,'none.json')),{data:null,source:null});
});
test('Backend recovers from a damaged library and reports it',async t=>{
  const dir=await temp(t),a=await new Backend(dir,{manageModels:false}).init();
  a.db.episodes.push(episode('one'));await a.save();a.db.episodes.push(episode('two'));await a.save();
  await fs.writeFile(path.join(dir,'library.json'),'{"settings":');
  const b=await new Backend(dir,{manageModels:false}).init();
  assert.equal(b.db.episodes.length,1);assert.match(b.lastError,/повреждён/);
});
test('position hint stays in memory and is written when the backend closes',async t=>{
  const dir=await temp(t),b=await new Backend(dir,{manageModels:false}).init();
  b.db.episodes.push(episode('one'));await b.save();b.hintPosition('one',42.5);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'library.json'),'utf8')).episodes[0].position,undefined);
  await b.close();
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'library.json'),'utf8')).episodes[0].position,42.5);
});
test('remove waits for a running task to stop instead of failing, and skips the wait for queued ones',async t=>{
  const dir=await temp(t),b=await new Backend(dir,{manageModels:false}).init();
  b.db.episodes.push(episode('run','recognizing'),episode('wait','queued'));
  const abort=new AbortController();abort.signal.addEventListener('abort',()=>setTimeout(()=>b.tasks.delete('run'),120));b.tasks.set('run',abort);
  b.tasks.set('wait',new AbortController());
  const started=Date.now();await b.remove('run');
  assert.ok(Date.now()-started>=100);assert.ok(abort.signal.aborted);
  await b.remove('wait');
  assert.deepEqual(b.db.episodes,[]);
});
test('close does not hang when a task or the model release never finishes',async t=>{
  const dir=await temp(t),b=await new Backend(dir,{manageModels:false,modelManager:{state:{},release:()=>new Promise(()=>{})}}).init();
  b.closeTimeout=200;b.queue=new Promise(()=>{});
  const result=await Promise.race([b.close().then(()=>'closed'),new Promise(r=>setTimeout(()=>r('hung'),5000))]);
  assert.equal(result,'closed');
});
test('withTimeout resolves undefined when the promise stays pending',async()=>{
  assert.equal(await withTimeout(new Promise(()=>{}),30),undefined);assert.equal(await withTimeout(Promise.resolve(5),30),5);
});
