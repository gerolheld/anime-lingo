'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {alignedCues}=require('../desktop/qwen.cjs');
const {requestTranslation}=require('../desktop/translation.cjs');
const {Backend,exportSubs}=require('../desktop/backend.cjs');

async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));return `http://127.0.0.1:${s.address().port}`;}
test('Python worker handles mislabeled ending songs and SDK tokenization without losing word timings',()=>{
  execFileSync(process.env.ANIME_LINGO_TEST_PYTHON||(process.platform==='win32'?'python':'python3'),['-m','unittest','discover','-s',path.join(__dirname),'-p','qwen_worker_test.py'],{encoding:'utf8',stdio:'pipe'});
});
test('aligned words preserve actual speech times, punctuation, repeated words and character offsets',()=>{
  const words=[{text:'"Mr.',start:1,end:1.3},{text:'Roko,',start:1.4,end:1.9},{text:'no,',start:2,end:2.2},{text:'no!"',start:2.3,end:2.5},{text:'Wake',start:5,end:5.3},{text:'up.',start:5.3,end:5.6}];
  const cues=alignedCues(words,10);
  assert.equal(cues.length,2);assert.equal(cues[0].text,'"Mr. Roko, no, no!"');assert.equal(cues[0].start,11);assert.equal(cues[1].end,15.6);
  for(const c of cues)for(const w of c.words)assert.equal(c.text.slice(w.charStart,w.charEnd),w.text);
  assert.equal(cues[0].words[2].start,12);assert.equal(cues[0].words[3].start,12.3);
  assert.match(exportSubs(cues,{language:'en'}),/00:00:11\.000 --> 00:00:12\.500/);
  assert.throws(()=>alignedCues([{text:'wrong',start:4,end:2}]),/таймкоды/);
});
test('a dead or frozen translator is restarted at once and the same request is retried',async t=>{
  const requests=[];let recovered=0,mode='down';
  const endpoint=await server(t,async(req,res)=>{let body='';for await(const part of req)body+=part;requests.push(JSON.parse(body));if(mode==='hang'&&requests.length===1)return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'Проснись.'}}]}));});
  // Frozen server: no answer within the timeout, then a restart, then success.
  mode='hang';
  const value=await requestTranslation({endpoint,model:'hy-mt2',prompt:'Wake up.',maxTokens:250,timeout:300,recover:async()=>recovered++});
  assert.equal(value,'Проснись.');assert.equal(recovered,1);assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
  // Dead server: connection refused until recover() brings it back.
  const dead=await new Promise(r=>{const s=http.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>r(port));});});
  // The restart brings a server back on the very same port, as llama-server would after a crash.
  const r2=await requestTranslation({endpoint:`http://127.0.0.1:${dead}/v1`,model:'m',prompt:'x',maxTokens:10,recover:async()=>{const s=http.createServer((_,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'ok'}}]}));});await new Promise(r=>s.listen(dead,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));}});
  assert.equal(r2,'ok');
});
test('temporary HTTP 503 while the model loads is retried; a final failure is reported',async t=>{
  let count=0;
  const endpoint=await server(t,(_,res)=>{count++;if(count<3){res.writeHead(503);res.end('Loading model');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'готово'}}]}));});
  assert.equal(await requestTranslation({endpoint,model:'m',prompt:'x',maxTokens:10,recover:async()=>{}}),'готово');assert.equal(count,3);
  const always=await server(t,(_,res)=>{res.writeHead(500);res.end('boom');});
  await assert.rejects(requestTranslation({endpoint:always,model:'m',prompt:'x',maxTokens:10}),/HTTP 500/);
});
test('a pause inside an unfinished sentence keeps its translation context together',()=>{
  const cues=alignedCues([{text:'Ask',start:0,end:.5},{text:'not',start:.7,end:1},{text:'what',start:2.1,end:2.4},{text:'your',start:2.5,end:2.8},{text:'country',start:2.8,end:3.1},{text:'can',start:3.2,end:3.4},{text:'do.',start:3.5,end:4}]);
  assert.equal(cues.length,1);assert.equal(cues[0].text,'Ask not what your country can do.');assert.equal(cues[0].words[2].start,2.1);
});
test('invalid context and cancelled requests are not retried as engine failures',async t=>{
  let count=0;
  const endpoint=await server(t,(_,res)=>{count++;res.writeHead(400);res.end('request exceeds available context size');});
  await assert.rejects(requestTranslation({endpoint,model:'m',prompt:'x',maxTokens:10}),/context size/);assert.equal(count,1);
  const abort=new AbortController();abort.abort();await assert.rejects(requestTranslation({endpoint,model:'m',prompt:'x',maxTokens:10,signal:abort.signal}),/Отменено/);assert.equal(count,1);
});
test('partial translations resume from saved word timings after restart and retain completed Russian cues',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-qwen-resume-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const received=[];let failing=true;
  const endpoint=await server(t,async(req,res)=>{let body='';for await(const p of req)body+=p;const d=JSON.parse(body);received.push(d.messages[0].content);res.setHeader('Content-Type','application/json');if(failing&&received.length===2){res.statusCode=400;res.end('invalid context for test');}else res.end(JSON.stringify({choices:[{message:{content:received.at(-1).endsWith('Wake up.')?'Проснись.':'Идём.'}}]}));});
  const b=await new Backend(root,{manageModels:false}).init();await b.configure({endpoint});
  const e={id:'test-episode',filePath:'/local/episode.mp4',size:1,modified:1,audioIndex:1,audio:[{index:1}],duration:20,state:'recognized',pipeline:'qwen3',cues:alignedCues([{text:'Wake',start:1,end:1.4},{text:'up.',start:1.4,end:2},{text:'Come',start:4,end:4.4},{text:'on.',start:4.4,end:5}]),ruCues:[]};e.recognitionKey=b.recognitionKey(e);b.db.episodes.push(e);
  await b.prepare(e.id,{translateOnly:true});await b.queue;assert.equal(e.state,'partial');assert.equal(e.cues[0].ru,'Проснись.');assert.equal(e.cues[1].ru,'');
  failing=false;const restarted=await new Backend(root,{manageModels:false}).init();restarted.recognize=async()=>{throw Error('ASR should not run again');};
  await restarted.prepare(e.id);await restarted.queue;const result=restarted.episode(e.id);assert.equal(result.state,'ready',result.error);assert.equal(result.cues[0].ru,'Проснись.');assert.equal(result.cues[1].ru,'Идём.');assert.equal(received.length,3);assert.deepEqual(result.cues[0].words,e.cues[0].words);await restarted.close();await b.close();
});
test('audio extraction preserves a delayed track on the video timeline before alignment',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-qwen-delay-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'delayed.mp4');
  execFileSync('ffmpeg',['-loglevel','error','-y','-f','lavfi','-i','color=c=black:s=64x64:r=10:d=2','-itsoffset','0.75','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=1','-c:v','libx264','-c:a','aac',file]);
  const b=await new Backend(path.join(root,'library'),{manageModels:false}).init();const e=await b.addFile(file);let checked=false;
  b.recognize=async wav=>{
    const pcm=execFileSync('ffmpeg',['-loglevel','error','-i',wav,'-f','s16le','-acodec','pcm_s16le','pipe:1']);let first=0;
    while(first<pcm.length/2&&Math.abs(pcm.readInt16LE(first*2))<50)first++;
    assert.ok(Math.abs(first/16000-.75)<.06,`First sound at ${first/16000}s`);checked=true;
    return [{start:.75,end:1.75,text:'Test.',ru:'Тест.',words:[{start:.75,end:1.75,text:'Test.',charStart:0,charEnd:5}]}];
  };
  await b.prepare(e.id);await b.queue;assert.equal(e.state,'ready',e.error);assert.ok(checked);await b.close();
});
