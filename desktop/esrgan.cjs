'use strict';
const fsp=require('node:fs/promises');
const path=require('node:path');
const paths=require('./paths.cjs');
const manifest=require('./manifest.json');
const {download}=require('./downloader.cjs');
const {extractArchive,findFile}=require('./extract.cjs');

const directory=(runtime=paths.runtimeRoot())=>path.join(runtime,'realesrgan-ncnn');
async function modelsNextTo(binary){
  for(const dir of [path.join(path.dirname(binary),'models')]){try{const names=await fsp.readdir(dir);if(names.some(n=>/^realesr-animevideov3-x\d\.param$/.test(n)))return dir;}catch{}}
  return null;
}
// The copy installed by the program (SHA-256 checked) wins; an older manual install from 2.x is accepted but marked unverified.
async function locate(runtime=paths.runtimeRoot()){
  for(const [dir,source] of [[directory(runtime),'own'],[path.join(runtime,'realesrgan'),'legacy']]){
    const binary=await findFile(dir,paths.exe('realesrgan-ncnn-vulkan'),3);if(!binary)continue;
    const models=await modelsNextTo(binary);if(models)return {binary,models,source,verified:source==='own'};
  }
  return null;
}
async function install({runtime=paths.runtimeRoot(),platform=process.platform,signal,onProgress=()=>{},downloadFile=download,extract=extractArchive}={}){
  const entry=manifest.realesrgan.assets[platform==='win32'?'win-x64':'linux-x64'],archive=path.join(runtime,'downloads',entry.name);
  await downloadFile({url:entry.url,dest:archive,sha256:entry.sha256,size:entry.size,signal,onProgress});
  onProgress({phase:'extracting',percent:99});
  const target=directory(runtime);await fsp.rm(target,{recursive:true,force:true});await extract(archive,target,{signal});
  const found=await locate(runtime);if(!found||found.source!=='own')throw Object.assign(Error('В архиве Real-ESRGAN нет программы или моделей animevideov3'),{code:'NO_BINARY'});
  if(platform!=='win32')await fsp.chmod(found.binary,0o755);
  return found;
}
module.exports={locate,install,directory};
