'use strict';
const fsp=require('node:fs/promises');
const path=require('node:path');
const paths=require('./paths.cjs');
const manifest=require('./manifest.json');
const {download}=require('./downloader.cjs');
const {extractArchive,gunzipTo,findFile}=require('./extract.cjs');
const tools=require('./tools.cjs');

// Installs the pinned ffmpeg/ffprobe into <runtime>/bin. The system ffmpeg is never touched.
async function installFfmpeg({runtime=paths.runtimeRoot(),signal,onProgress=()=>{},platform=process.platform,downloadFile=download,extract=extractArchive}={}){
  const bin=paths.binDirectory(runtime),cache=path.join(runtime,'downloads');
  await fsp.mkdir(bin,{recursive:true});
  if(platform==='win32'){
    const entry=manifest.ffmpeg['win-x64'].archive,archive=path.join(cache,entry.name);
    await downloadFile({url:entry.url,dest:archive,sha256:entry.sha256,size:entry.size,signal,onProgress});
    const work=path.join(cache,'ffmpeg-unpack');await fsp.rm(work,{recursive:true,force:true});
    onProgress({phase:'extracting',percent:99});
    await extract(archive,work,{signal});
    for(const name of ['ffmpeg.exe','ffprobe.exe']){
      const found=await findFile(work,name);if(!found)throw Error('В архиве FFmpeg нет '+name);
      await fsp.copyFile(found,path.join(bin,name));
    }
    await fsp.rm(work,{recursive:true,force:true});
  }else{
    for(const name of ['ffmpeg','ffprobe']){
      const entry=manifest.ffmpeg['linux-x64'][name],archive=path.join(cache,entry.name);
      await downloadFile({url:entry.url,dest:archive,sha256:entry.sha256,size:entry.size,signal,onProgress:p=>onProgress({...p,component:name})});
      await gunzipTo(archive,path.join(bin,name));
    }
  }
  return tools.resolve({runtime});
}
module.exports={installFfmpeg,manifest};
