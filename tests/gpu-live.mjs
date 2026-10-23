// REAL GPU video test (needs consent): encoder probes + a 2-second Real-ESRGAN preview + a 2-second hardware-encode preview.
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {stat} from 'node:fs/promises';
const require=createRequire(import.meta.url),{Backend}=require('../desktop/backend.cjs'),tools=require('../desktop/tools.cjs');
const t0=Date.now(),lap=l=>console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${l}`);
await tools.resolve();
const root=await mkdtemp(join(tmpdir(),'lingo-gpu-')),b=await new Backend(root,{manageModels:false}).init();
await b.configure({videoGpu:{enabled:true,acknowledged:true,allowIntelXe:true}});
let st=await b.videoGpuStatus();lap('gate='+JSON.stringify(st.gate.allowed)+' encoders='+st.encoders.map(e=>e.id+':'+e.available).join(',')+' esrgan='+JSON.stringify(st.esrgan));
for(const e of st.encoders.filter(e=>e.available)){lap('probe '+e.id+' …');try{lap('probe '+e.id+' → '+JSON.stringify(await b.probeVideoEncoder(e.id)));}catch(error){lap('probe '+e.id+' error '+error.message);}}
const clip=resolve('.desktop-test/qwen-anime-sample.mp4'),e=await b.addFile(clip);lap(`clip ${e.width}x${e.height} ${e.frameRate} ${e.duration}s`);
const run=async(engine,scale)=>{lap('enhance '+engine+' …');const ids=await b.enhance([e.id],{engine,scale,preview:true,start:3,seconds:2});await b.queue;const j=b.enhancement(ids[0].id);
  let size=0;try{size=(await stat(j.outputFile)).size;}catch{}
  lap(engine+' → state='+j.state+' engine='+j.engine+' fallback='+JSON.stringify(j.fallback||null)+' error='+(j.error||'')+' result='+JSON.stringify(j.result&&{enc:j.result.encoder,w:j.result.width,h:j.result.height,s:j.result.seconds,f:j.result.frames})+' bytes='+size);return j;};
try{await run('gpu-esrgan',2);}catch(error){lap('gpu-esrgan threw: '+error.message);}
st=await b.videoGpuStatus();
if(st.encoders.some(x=>x.probe?.ok)){try{await run('gpu-encode',1);}catch(error){lap('gpu-encode threw: '+error.message);}}else lap('no encoder passed its test; gpu-encode skipped');
await b.close();lap('DONE');
