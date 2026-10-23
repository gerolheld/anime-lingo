'use strict';
const fsp=require('node:fs/promises');
const path=require('node:path');
const paths=require('./paths.cjs');

// ffmpeg/ffprobe: Linux prefers the system build (it has VAAPI/QSV), the downloaded one is the fallback.
// Windows uses the downloaded full build and falls back to anything on PATH.
const state={ffmpeg:null,ffprobe:null,source:'',runtime:null};
async function isFile(file){try{return (await fsp.stat(file)).isFile();}catch{return false;}}
async function onPath(name,env=process.env){
  for(const dir of (env.PATH||env.Path||'').split(path.delimiter).filter(Boolean)){const file=path.join(dir,paths.exe(name));if(await isFile(file))return file;}
  return null;
}
async function locate(name,{runtime=paths.runtimeRoot(),env=process.env,platform=process.platform}={}){
  const override=env['ANIME_LINGO_'+name.toUpperCase()];
  if(override&&await isFile(override))return {file:override,source:'env'};
  const own=path.join(paths.binDirectory(runtime),platform==='win32'?name+'.exe':name);
  const order=platform==='win32'?['own','system']:['system','own'];
  for(const kind of order){
    const file=kind==='own'?(await isFile(own)?own:null):await onPath(name,env);
    if(file)return {file,source:kind};
  }
  return null;
}
async function resolve(options={}){
  const ffmpeg=await locate('ffmpeg',options),ffprobe=await locate('ffprobe',options);
  state.ffmpeg=ffmpeg?.file||null;state.ffprobe=ffprobe?.file||null;state.source=ffmpeg&&ffprobe?(ffmpeg.source===ffprobe.source?ffmpeg.source:'mixed'):'';
  return {...state};
}
// Absolute path once resolved, otherwise the bare name so tests and PATH-only setups still work.
const ffmpeg=()=>state.ffmpeg||'ffmpeg';
const ffprobe=()=>state.ffprobe||'ffprobe';
const status=()=>({ffmpeg:state.ffmpeg,ffprobe:state.ffprobe,source:state.source,ready:!!(state.ffmpeg&&state.ffprobe)});
module.exports={resolve,locate,ffmpeg,ffprobe,status,onPath};
