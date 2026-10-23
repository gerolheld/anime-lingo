'use strict';
const fsp=require('node:fs/promises');
const fs=require('node:fs');
const path=require('node:path');
const zlib=require('node:zlib');
const {pipeline}=require('node:stream/promises');
const {run}=require('./process.cjs');

// On Windows a GNU tar from Git for Windows can shadow bsdtar and mishandle drive letters; use the system one.
const tarBinary=()=>process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'):'tar';

// zip and tar.gz are unpacked with the system `tar` (bsdtar ships with Windows 10+; GNU tar on Linux handles tar.gz).
// Entries that would escape the target folder are refused before anything is written.
async function listEntries(archive,execute=run){
  const r=await execute(tarBinary(),['-tf',archive],{timeout:120000});
  return r.output.split(/\r?\n/).filter(Boolean);
}
function unsafe(entry){
  const normal=path.posix.normalize(entry.replace(/\\/g,'/'));
  return path.posix.isAbsolute(normal)||/^[A-Za-z]:/.test(normal)||normal==='..'||normal.startsWith('../');
}
async function extractArchive(archive,target,{execute=run,signal}={}){
  const entries=await listEntries(archive,execute);
  if(!entries.length)throw Error('Архив пуст');
  const bad=entries.find(unsafe);if(bad)throw Error('Небезопасный путь в архиве: '+bad);
  await fsp.mkdir(target,{recursive:true});
  await execute(tarBinary(),['-xf',archive,'-C',target],{timeout:600000,signal});
  return entries;
}
async function gunzipTo(source,dest){
  const part=dest+'.part';
  await pipeline(fs.createReadStream(source),zlib.createGunzip(),fs.createWriteStream(part,{mode:0o755}));
  await fsp.rename(part,dest);
}
async function findFile(root,name,depth=4){
  const entries=await fsp.readdir(root,{withFileTypes:true}).catch(()=>[]);
  for(const e of entries)if(e.isFile()&&e.name.toLowerCase()===name.toLowerCase())return path.join(root,e.name);
  if(depth>0)for(const e of entries)if(e.isDirectory()){const hit=await findFile(path.join(root,e.name),name,depth-1);if(hit)return hit;}
  return null;
}
module.exports={extractArchive,gunzipTo,findFile,unsafe};
