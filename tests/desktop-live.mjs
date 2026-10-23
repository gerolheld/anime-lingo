import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
await mkdir('.desktop-test',{recursive:true});execFileSync('ffmpeg',['-loglevel','error','-y','-i','tests/clip.mp4','-i',resolve('tests/speech.wav'),'-c:v','copy','-c:a','aac','-shortest','.desktop-test/sample.mp4']);
const require=createRequire(import.meta.url),{Backend}=require('../desktop/backend.cjs');
const root=await mkdtemp(join(tmpdir(),'anime-lingo-models-')),b=await new Backend(root).init();const checks=[],errors=[],phases=[];
b.on('change',s=>{const m=s.modelState;if(m.phase==='working'&&m.kind!==phases.at(-1)?.kind)phases.push({kind:m.kind,time:Date.now()});});
try{
const e=await b.addFile(resolve('.desktop-test/sample.mp4')),start=Date.now();await b.prepare(e.id);await b.queue;assert.equal(e.state,'ready',e.error);assert.match(e.cues.map(c=>c.text).join(' '),/ask not what your country can do for you/i);assert.ok(e.cues.every(c=>/[а-яё]/i.test(c.ru)));assert.equal((await b.models.loaded()).filter(m=>m.identifier==='anime-lingo-hy').length,0);checks.push({name:'Qwen3-ASR exits before ForcedAligner, then Hy-MT2; all models exit after preparation',seconds:(Date.now()-start)/1000,cues:e.cues,phases:[...phases]});
b.startLive(e.id);await b.localChunk(e.id,0);await b.queue;const s=b.live.get(e.id);assert.ok(s.cues.length,s.error);assert.match(s.cues[0].text,/Americans/i);assert.match(s.cues[0].ru,/[а-яё]/i);assert.equal((await b.models.loaded()).filter(m=>m.identifier==='anime-lingo-hy').length,0);checks.push({name:'local-file playback mode also releases both models after each fragment',lag:s.lag,cues:s.cues});b.stopLive(e.id);
const meaning=await b.wordMeaning('bank','We sat down by the river bank.');assert.match(meaning.wordTranslation,/берег/i);assert.equal((await b.models.loaded()).filter(m=>m.identifier==='anime-lingo-hy').length,0);checks.push({name:'contextual word translation loads on demand and unloads after lookup',result:meaning.wordTranslation});
await b.prepare(e.id);const deadline=Date.now()+120000;while(Date.now()<deadline&&!(b.models.state.kind==='translation'&&b.models.state.phase==='loading'))await new Promise(r=>setTimeout(r,100));b.cancel(e.id);await b.queue;assert.equal(e.state,'cancelled',e.error);assert.equal((await b.models.loaded()).filter(m=>m.identifier==='anime-lingo-hy').length,0);checks.push({name:'cancellation during model loading waits for cleanup and leaves Hy-MT2 unloaded'});
} catch(e){errors.push(e.stack);process.exitCode=1;} finally{await b.close();await mkdir('test-results',{recursive:true});await writeFile('test-results/desktop-live.json',JSON.stringify({date:new Date().toISOString(),checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));await rm(root,{recursive:true,force:true});}
