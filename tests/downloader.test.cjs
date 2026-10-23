'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const http=require('node:http');
const crypto=require('node:crypto');
const path=require('node:path');
const os=require('node:os');
const {download,isVerified}=require('../desktop/downloader.cjs');
const {unsafe}=require('../desktop/extract.cjs');
const manifest=require('../desktop/manifest.json');

const data=crypto.randomBytes(600000),sha=crypto.createHash('sha256').update(data).digest('hex');
async function serve(t,{slow=false,ignoreRange=false}={}){
  const hits=[];
  const server=http.createServer(async(req,res)=>{
    hits.push(req.headers.range||'');
    const m=!ignoreRange&&(req.headers.range||'').match(/^bytes=(\d+)-$/),start=m?+m[1]:0;
    res.writeHead(m?206:200,{'Content-Length':data.length-start,...(m?{'Content-Range':`bytes ${start}-${data.length-1}/${data.length}`}:{})});
    if(!slow){res.end(data.subarray(start));return;}
    res.write(data.subarray(start,start+200000));// then stall until the client goes away
    await new Promise(r=>res.on('close',r));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections?.();server.close();});
  return {url:`http://127.0.0.1:${server.address().port}/f.bin`,hits};
}
const temp=async t=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-dl-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;};

test('download verifies SHA-256, reports progress and does not fetch a good file twice',async t=>{
  const dir=await temp(t),{url,hits}=await serve(t),dest=path.join(dir,'a','f.bin'),events=[];
  const r=await download({url,dest,sha256:sha,size:data.length,onProgress:p=>events.push(p.phase)});
  assert.equal(r.skipped,false);assert.deepEqual(await fs.readFile(dest),data);assert.ok(events.includes('ready'));
  const again=await download({url,dest,sha256:sha,size:data.length});
  assert.equal(again.skipped,true);assert.equal(hits.length,1);
  assert.equal(await isVerified(dest,'0'.repeat(64)),false);
});
test('wrong hash removes the partial file and reports SHA_MISMATCH',async t=>{
  const dir=await temp(t),{url}=await serve(t),dest=path.join(dir,'f.bin');
  await assert.rejects(download({url,dest,sha256:'1'.repeat(64),size:data.length}),e=>e.code==='SHA_MISMATCH');
  assert.deepEqual(await fs.readdir(dir),[]);
});
test('pause keeps the partial file and resume continues with a Range request',async t=>{
  const dir=await temp(t),{url,hits}=await serve(t,{slow:true}),dest=path.join(dir,'f.bin'),abort=new AbortController();
  const first=download({url,dest,sha256:sha,size:data.length,signal:abort.signal});
  setTimeout(()=>abort.abort(),500);
  await assert.rejects(first,e=>e.code==='PAUSED');
  const have=(await fs.stat(dest+'.part')).size;assert.ok(have>0&&have<data.length);
  // Second server answers the rest at once.
  const fast=await serve(t);
  await download({url:fast.url,dest,sha256:sha,size:data.length});
  assert.match(fast.hits[0],new RegExp(`^bytes=${have}-$`));assert.deepEqual(await fs.readFile(dest),data);
});
test('a server that ignores Range restarts cleanly and still verifies',async t=>{
  const dir=await temp(t),{url}=await serve(t,{ignoreRange:true}),dest=path.join(dir,'f.bin');
  await fs.writeFile(dest+'.part',data.subarray(0,1000));
  await download({url,dest,sha256:sha,size:data.length});assert.deepEqual(await fs.readFile(dest),data);
});
test('plain http to a remote host and missing hash are refused',async t=>{
  const dir=await temp(t);
  await assert.rejects(download({url:'http://example.com/x',dest:path.join(dir,'x'),sha256:sha}),e=>e.code==='BAD_URL');
  await assert.rejects(download({url:'https://example.com/x',dest:path.join(dir,'x')}),e=>e.code==='NO_HASH');
});
test('archive entries that escape the target folder are rejected',()=>{
  for(const bad of ['../x','a/../../x','/etc/passwd','C:\\Windows\\x','..\\x'])assert.ok(unsafe(bad),bad);
  for(const ok of ['bin/ffmpeg.exe','ffmpeg-n9/bin/','a/./b'])assert.equal(unsafe(ok),false,ok);
});
test('manifest pins every component with a SHA-256 and https URL',()=>{
  const entries=[...Object.values(manifest.llama.assets),...Object.values(manifest.uv.assets),manifest.ffmpeg['win-x64'].archive,manifest.ffmpeg['linux-x64'].ffmpeg,manifest.ffmpeg['linux-x64'].ffprobe,...Object.values(manifest.hymt.files)];
  assert.match(manifest.llama.tag,/^b\d+$/);
  for(const e of entries){assert.match(e.sha256,/^[a-f0-9]{64}$/);assert.match(e.url,/^https:\/\//);}
  assert.ok(manifest.llama.assets['win-vulkan-x64']&&manifest.llama.assets['linux-vulkan-x64']&&manifest.llama.assets['win-cuda-12.4-x64']);
});
