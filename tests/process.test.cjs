'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {run}=require('../desktop/process.cjs');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const until=async(check,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await new Promise(r=>setTimeout(r,50));}return false;};
const parent=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('CHILD '+c.pid);setInterval(()=>{},1000);`;

test('cancelling a stage stops the whole process tree and waits for the real exit',async()=>{
  const abort=new AbortController();let grandchild=0,spawned;
  const job=run(process.execPath,['-e',parent],{signal:abort.signal,onSpawn:c=>{spawned=c.pid;},onStdout:text=>{const m=text.match(/CHILD (\d+)/);if(m)grandchild=+m[1];}});
  assert.ok(await until(()=>grandchild),'grandchild started');assert.ok(alive(grandchild));
  abort.abort();
  await assert.rejects(job,/Отменено/);
  assert.ok(await until(()=>!alive(grandchild)),'grandchild was killed with its parent');
  assert.ok(!alive(spawned));
});
test('timeout kills the tree and reports it',async()=>{
  await assert.rejects(run(process.execPath,['-e',parent],{timeout:400}),/превышено время ожидания/);
});
test('environment overrides are passed and a missing ffmpeg gives an actionable message',async()=>{
  const r=await run(process.execPath,['-e','console.log(process.env.LINGO_X)'],{env:{LINGO_X:'привет'}});
  assert.equal(r.output.trim(),'привет');
  await assert.rejects(run(path.join(__dirname,'no-such','ffmpeg'),['-version']),e=>e.code==='ENOENT'&&/установите компонент FFmpeg/.test(e.message));
});
