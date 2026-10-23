'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {run}=require('./process.cjs');
const gpu=require('./gpu.cjs');

function alignedCues(words,offset=0){
  const cues=[];let cue;
  const flush=()=>{if(cue){cue.end=Math.max(cue.start+.01,cue.end);cues.push(cue);cue=null;}};
  for(const word of words){
    if(typeof word.text!=='string'||!word.text.trim()||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<0||word.end<word.start)throw Error('Некорректные таймкоды ForcedAligner');
    const start=word.start+offset,end=word.end+offset,text=word.text.trim();
    if(cue&&(start-cue.end>1.5||cue.text.length+text.length>95||end-cue.start>7.5))flush();
    cue??={start,end,text:'',ru:'',words:[]};
    const charStart=cue.text.length+(cue.text?' '.length:0);
    cue.text+=(cue.text?' ':'')+text;
    cue.words.push({text,start,end,charStart,charEnd:cue.text.length});cue.end=Math.max(cue.end,end);
    if(/[.!?…]["'”’\])]*$/.test(text)&&! /^(?:Mr|Mrs|Ms|Dr|St|Prof|vs|etc)\.$/i.test(text.replace(/^["'“‘(\[]+/,'')))flush();
  }
  flush();return cues;
}

async function worker(settings,stage,wav,directory,signal,onProgress){
  try{await fs.access(settings.qwenPython);}catch{throw Error('Окружение распознавания не установлено. Откройте «Модели» и установите его.');}
  const script=path.join(__dirname,'qwen_worker.py').replace(path.sep+'app.asar'+path.sep,path.sep+'app.asar.unpacked'+path.sep);
  // An explicitly chosen device that this computer cannot offer is an error, never a silent fallback.
  // "auto" is resolved by the worker itself from what the installed PyTorch build can really use.
  const choice=settings.gpu===false?'cpu':(settings.qwenDevice||'auto');
  let device=choice;
  if(choice!=='auto'&&choice!=='cpu')device=gpu.resolveChoice('recognition',choice,await gpu.detect()).id;
  const args=[script,'--stage',stage,'--device',device];
  if(stage!=='probe')args.push('--audio',wav,'--directory',directory,'--chunk-seconds',String(settings.asrChunkSeconds||30));
  if(stage==='asr'||stage==='align')args.push('--model',stage==='asr'?settings.asrModel:settings.alignerModel);
  let buffer='',lastError='';
  try{return await run(settings.qwenPython,args,{signal,timeout:stage==='probe'?45000:0,env:{PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'},onStdout:text=>{
    buffer+=text;const lines=buffer.split('\n');buffer=lines.pop();if(buffer.length>64000)buffer=buffer.slice(-64000);
    for(const line of lines){if(!line.startsWith('LINGO '))continue;try{const data=JSON.parse(line.slice(6));if(data.event==='error')lastError=data.message;onProgress?.(data);}catch{}}
  }});}catch(error){if(lastError&&!signal?.aborted)throw Error('Qwen: '+lastError);throw error;}
}

async function recognize({settings,wav,directory,models,signal,offset=0,onProgress=()=>{}}){
  await validateModel(settings.asrModel);await validateModel(settings.alignerModel);
  await worker(settings,'plan',wav,directory,signal);
  onProgress({event:'progress',stage:'asr',percent:0});
  await models.with('speech',()=>worker(settings,'asr',wav,directory,signal,onProgress),signal);
  onProgress({event:'progress',stage:'align',percent:0});
  await models.with('alignment',()=>worker(settings,'align',wav,directory,signal,onProgress),signal);
  const data=JSON.parse(await fs.readFile(path.join(directory,'alignment.json'),'utf8'));
  const cues=alignedCues(data.chunks.flatMap(c=>c.words),offset);
  if(!cues.length)throw Error('Английская речь не обнаружена. Проверь выбранную дорожку DUB.');
  return cues;
}
async function validateModel(directory){
  try{await fs.access(path.join(directory,'config.json'));}catch{throw Object.assign(Error('Модель не скачана: '+directory+'. Откройте «Модели» и скачайте её.'),{code:'ENOENT'});}
  let files=['model.safetensors'];
  try{const index=JSON.parse(await fs.readFile(path.join(directory,'model.safetensors.index.json'),'utf8'));files=[...new Set(Object.values(index.weight_map))];}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!files.length)throw Error('В папке нет весов модели');
  for(const file of files){if(path.basename(file)!==file)throw Error('Некорректный индекс весов');const stat=await fs.stat(path.join(directory,file));if(stat.size<1024*1024)throw Error('Неполный файл весов: '+file);}
  return files;
}
module.exports={alignedCues,recognize,worker,validateModel};
