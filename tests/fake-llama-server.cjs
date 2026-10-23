'use strict';
// Stand-in for llama-server used by tests: same flags, /health, bearer auth and /v1/chat/completions.
// FAKE_LLAMA_MODE: ok | slow-load | oom-with-gpu | hang-second | die-after-first
const http=require('node:http');
const fs=require('node:fs');
const args=process.argv.slice(2),flag=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const port=+flag('--port'),key=fs.readFileSync(flag('--api-key-file'),'utf8').trim(),ngl=+flag('-ngl'),mode=process.env.FAKE_LLAMA_MODE||'ok';
if(mode==='oom-with-gpu'&&ngl!==0){console.error('ggml_vulkan: ErrorOutOfDeviceMemory');process.exit(1);}
if(process.env.FAKE_LLAMA_LOG)fs.appendFileSync(process.env.FAKE_LLAMA_LOG,JSON.stringify({pid:process.pid,args})+'\n');
let requests=0,ready=false;
const server=http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.writeHead(ready?200:503);res.end(ready?'{"status":"ok"}':'{"error":"Loading model"}');return;}
  if(req.headers.authorization!=='Bearer '+key){res.writeHead(401);res.end('{"error":"Invalid API Key"}');return;}
  let body='';for await(const c of req)body+=c;
  requests++;
  if(mode==='hang-second'&&requests===2)return;
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({choices:[{message:{content:'перевод '+requests}}]}));
  if(mode==='die-after-first'&&requests===1)setTimeout(()=>process.exit(3),20);
});
server.listen(port,'127.0.0.1',()=>setTimeout(()=>{ready=true;},mode==='slow-load'?60000:100));
process.on('SIGTERM',()=>process.exit(0));
