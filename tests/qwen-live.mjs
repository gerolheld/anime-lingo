import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{Backend,exportSubs}=require('../desktop/backend.cjs');
// Translator engine and GGUF live in the isolated runtime of tests/llama-live.mjs; Qwen uses the already installed environment and weights.
process.env.ANIME_LINGO_RUNTIME=process.env.ANIME_LINGO_RUNTIME||resolve('.desktop-test/live-runtime');
const root=await mkdtemp(join(tmpdir(),'anime-lingo-qwen-live-')),b=await new Backend(root).init(),phases=[],checks=[];
const installed=join(homedir(),'.local/share/anime-lingo');
await b.configure({qwenPython:join(installed,'qwen-env/bin/python'),asrModel:join(installed,'models/Qwen3-ASR-1.7B'),alignerModel:join(installed,'models/Qwen3-ForcedAligner-0.6B'),translationQuant:'Q8_0'});
await mkdir('.desktop-test',{recursive:true});await mkdir('test-results',{recursive:true});
const input=process.env.ANIME_LINGO_TEST_VIDEO||join(homedir(),'Videos/Anime Lingo/Fate Apocrypha - Episode 01 [English Dub].mp4');
const clip=resolve('.desktop-test/qwen-anime-sample.mp4');
if(existsSync(input))execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-i',input,'-t','35','-map','0:v:0','-map','0:a:0','-c','copy',clip]);
let last='';b.on('change',snapshot=>{const current=snapshot.modelState.kind+':'+snapshot.modelState.phase;if(current!==last){last=current;phases.push({kind:snapshot.modelState.kind,phase:snapshot.modelState.phase,time:Date.now()});console.log(snapshot.modelState.label);}});
const started=Date.now();
try{
  const e=await b.addFile(clip);await b.prepare(e.id);await b.queue;
  assert.equal(e.state,'ready',e.error);assert.equal(e.pipeline,'qwen3');assert.match(e.enSource,/Qwen3-ASR-1.7B/);assert.equal(e.wordTimeSource,'Qwen3-ForcedAligner-0.6B');
  assert.match(e.cues.map(c=>c.text).join(' '),/world|morning|past|time/i);
  assert.ok(e.cues.every(c=>c.words.length&&/[а-яё]/i.test(c.ru)));
  const words=e.cues.flatMap(c=>c.words);assert.ok(words.length>20);
  for(const c of e.cues)for(const w of c.words){assert.ok(w.start>=0&&w.end>=w.start&&w.end<e.duration+.5);assert.equal(c.text.slice(w.charStart,w.charEnd),w.text);}
  const working=phases.filter(p=>p.phase==='working').map(p=>p.kind);assert.deepEqual(working.slice(0,3),['speech','alignment','translation']);
  assert.equal(b.llama.running,false,'translator process is gone');
  checks.push({name:'actual English anime audio → Qwen3-ASR → separate ForcedAligner → Hy-MT2 → all models unloaded',seconds:(Date.now()-started)/1000,cues:e.cues.length,words:words.length,device:e.computeDevice,firstCues:e.cues.slice(0,4),phases});
  await writeFile('test-results/qwen-sample.en.vtt',exportSubs(e.cues,{language:'en'}));await writeFile('test-results/qwen-sample.ru.vtt',exportSubs(e.cues,{language:'ru'}));
  const saved=JSON.parse(await readFile(join(root,'library.json'),'utf8'));assert.deepEqual(saved.episodes[0].cues[0].words,e.cues[0].words);checks.push({name:'word timings survive local database storage and subtitles export in both languages'});
  await writeFile('test-results/qwen-live.json',JSON.stringify({date:new Date().toISOString(),checks,errors:[]},null,2));console.log(JSON.stringify(checks,null,2));
}catch(error){await writeFile('test-results/qwen-live.json',JSON.stringify({checks,phases,errors:[error.stack]},null,2));throw error;}
finally{await b.close();await rm(root,{recursive:true,force:true});}
