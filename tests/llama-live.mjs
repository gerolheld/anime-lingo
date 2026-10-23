// REAL run of the embedded llama-server with the real Hy-MT2 model. Needs explicit user consent.
// Usage: node tests/llama-live.mjs <cpu|vulkan>   (runtime in .desktop-test/live-runtime, library in a temp folder)
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const device=process.argv[2]||'cpu';
process.env.ANIME_LINGO_RUNTIME=resolve('.desktop-test/live-runtime');
const require=createRequire(import.meta.url);
const {Backend}=require('../desktop/backend.cjs');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const t0=Date.now(),lap=l=>console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${l}`);
await mkdir(process.env.ANIME_LINGO_RUNTIME,{recursive:true});
const b=await new Backend(await mkdtemp(join(tmpdir(),'lingo-live-'))).init();
await b.configure({translationDevice:device,translationQuant:'Q8_0'});
let st=await b.componentsStatus();
lap(`engine=${JSON.stringify(st.translatorEngine)} importable=${st.importable.map(i=>i.quant)}`);
if(!st.translatorEngine.installed){lap('installing engine');const r=await b.installComponent('translator-engine');lap('engine: '+JSON.stringify(r));}
if(!st.translatorModels.find(m=>m.quant==='Q8_0').installed){lap('importing Q8_0 (SHA-256 of 8 GB)');const r=await b.installComponent('translator-import',{quant:'Q8_0'});lap('import: '+JSON.stringify(r));}
st=await b.componentsStatus();if(!st.translatorEngine.installed||!st.translatorModels.find(m=>m.quant==='Q8_0').installed)throw Error('not installed: '+b.lastError);
let pid;
const out=await b.models.with('translation',async()=>{
  pid=b.llama.child.pid;lap('loaded: '+JSON.stringify(b.llama.status()));
  const a=await b.translateRaw('Nothing changes in this world.','');lap('RU: '+a);
  const c=await b.translateRaw('We sat down by the river bank.','');lap('RU: '+c);
  return [a,c];
});
lap('after lease: running='+b.llama.running+' pidAlive='+alive(pid));
if(b.llama.running||alive(pid))throw Error('translator was not unloaded');
await b.close();lap('DONE '+JSON.stringify(out));
