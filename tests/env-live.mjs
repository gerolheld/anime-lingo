// REAL install of the Python environment and Qwen weights into .desktop-test/live-runtime (needs consent; network, many GB, no GPU).
import {createRequire} from 'node:module';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
process.env.ANIME_LINGO_RUNTIME=resolve('.desktop-test/live-runtime');
const require=createRequire(import.meta.url);
const {Backend}=require('../desktop/backend.cjs');
const t0=Date.now(),lap=l=>console.log(`[${((Date.now()-t0)/1000).toFixed(0)}s] ${l}`);
await mkdir(process.env.ANIME_LINGO_RUNTIME,{recursive:true});
const b=await new Backend(await mkdtemp(join(tmpdir(),'lingo-env-'))).init();
// the settings of a fresh install point into the live runtime
let last='';b.components.onChange=()=>{const s=JSON.stringify(b.components.state);if(s!==last&&Date.now()%2===0){last=s;}};
const tick=setInterval(()=>lap(JSON.stringify(b.components.state)),30000);
const st0=await b.componentsStatus();lap('env before: '+JSON.stringify(st0.recognitionEnv)+' wanted='+st0.recognitionEnv.wantedBackend);
let r=await b.installComponent('qwen-env');lap('qwen-env: '+JSON.stringify(r));
r=await b.installComponent('qwen-models');lap('qwen-models: '+JSON.stringify(r));
clearInterval(tick);
const st=await b.componentsStatus();lap('env after: '+JSON.stringify(st.recognitionEnv));lap('models after: '+JSON.stringify(st.recognitionModels));
if(!st.recognitionEnv.ready||!st.recognitionModels.asr.complete||!st.recognitionModels.aligner.complete)throw Error('install incomplete: '+b.lastError);
await b.close();lap('DONE');
