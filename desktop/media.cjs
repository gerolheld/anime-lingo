'use strict';
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const {Readable}=require('node:stream');
const path=require('node:path');
async function mediaResponse(file,request){
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
  const stat=await fsp.stat(file),size=stat.size;let start=0,end=size-1,status=200;
  const range=request.headers.get('range');
  if(range){const m=range.match(/^bytes=(\d*)-(\d*)$/);if(!m||(!m[1]&&!m[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});if(!m[1])start=Math.max(0,size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}if(start>end||start>=size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});status=206;}
  const types={'.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp','.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.mkv':'video/x-matroska','.mov':'video/quicktime','.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.ogg':'audio/ogg','.flac':'audio/flac'};
  const headers={'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream','Accept-Ranges':'bytes','Content-Length':String(Math.max(0,end-start+1)),'Cache-Control':'no-store'};if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  const body=request.method==='HEAD'||!size?null:Readable.toWeb(fs.createReadStream(file,{start,end}));return new Response(body,{status,headers});
}
module.exports={mediaResponse};
