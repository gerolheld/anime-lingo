'use strict';
const os=require('node:os');
const path=require('node:path');

const isWindows=()=>process.platform==='win32';
function electronApp(){try{const {app}=require('electron');return app&&typeof app.getPath==='function'?app:null;}catch{return null;}}
function electronPath(name){try{return electronApp()?.getPath(name)||'';}catch{return '';}}

// Library, covers, jobs and previews. Linux keeps the 2.x location so existing libraries need no migration.
function dataRoot(){
  if(process.env.ANIME_LINGO_DATA)return process.env.ANIME_LINGO_DATA;
  const base=electronPath('appData')||(isWindows()?process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming'):process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'));
  return path.join(base,'anime-lingo-desktop');
}
// Large downloadable components: Python environment, model weights, llama.cpp, ffmpeg.
function runtimeRoot(){
  if(process.env.ANIME_LINGO_RUNTIME)return process.env.ANIME_LINGO_RUNTIME;
  if(isWindows())return path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'AnimeLingo');
  return path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'),'anime-lingo');
}
function videosDirectory(){return path.join(electronPath('videos')||path.join(os.homedir(),'Videos'),'Anime Lingo');}
const exe=name=>isWindows()?name+'.exe':name;
const pythonIn=environment=>isWindows()?path.join(environment,'Scripts','python.exe'):path.join(environment,'bin','python');
const binDirectory=runtime=>path.join(runtime,'bin');

module.exports={isWindows,dataRoot,runtimeRoot,videosDirectory,exe,pythonIn,binDirectory};
