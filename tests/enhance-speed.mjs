// Real GPU comparison on an identical 1080p fragment; run separately from AI jobs.
import {createRequire} from 'node:module';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{Backend,run}=require('../desktop/backend.cjs');
const {enhanceVideo}=require('../desktop/enhance.cjs');
const root=resolve('.desktop-test/enhancement-speed');await mkdir(root,{recursive:true});
const b=await new Backend(join(root,'library')).init(),measurements=[];
try{
  const input=process.env.ANIME_LINGO_TEST_VIDEO||join(homedir(),'Videos/Anime Lingo/Fate Apocrypha - Episode 01 [English Dub].mp4');
  const source=await b.probe(input),start=120,seconds=1;
  const baseline=process.env.ANIME_LINGO_ENHANCE_BASELINE;
  const variants=[];let previousReport;
  if(baseline){
    if(process.env.ANIME_LINGO_ENHANCE_REUSE_BASELINE==='1'){
      const previous=previousReport=JSON.parse(await readFile('test-results/enhancement-speed.json','utf8'));
      assert.deepEqual(previous.source,{width:source.width,height:source.height,start,seconds});
      const saved=previous.measurements.find(x=>x.name==='legacy');assert.ok(saved);measurements.push(saved);
    }else variants.push(['legacy',require(resolve(baseline)).enhanceVideo,128,join(homedir(),'.local/share/anime-lingo/realesrgan/realesrgan-ncnn-vulkan')]);
  }
  variants.push(['stream-128',enhanceVideo,128,b.db.settings.enhanceBinary],['stream-auto',enhanceVideo,0,b.db.settings.enhanceBinary],['anime4k-fast',enhanceVideo,0,b.db.settings.enhanceBinary]);
  for(const [name,fn,tile,binary] of variants){
    if(name.startsWith('stream')&&process.env.ANIME_LINGO_ENHANCE_REUSE_NATIVE==='1'){const saved=previousReport?.measurements.find(x=>x.name===name);assert.ok(saved);measurements.push(saved);continue;}
    console.log('Starting',name);const output=join(root,name+'.mkv');
    const result=await b.models.with('enhancement',()=>fn({engine:name==='anime4k-fast'?'anime4k':'realesrgan',input,output,tempRoot:root,binary,modelDir:b.db.settings.enhanceModels,scale:2,tile,source,preview:true,start,seconds,onProgress:p=>{if(p.done)console.log(name,p.done,'frames',p.fps?.toFixed(2),'fps');}}));
    const meta=await b.probe(output);assert.equal(meta.width,source.width*2);assert.equal(meta.height,source.height*2);assert.equal(meta.audio.length,source.audio.length);
    assert.ok(result.frames>=23&&result.frames<=25);
    if(name.startsWith('stream'))assert.equal(result.modelLoads,1);
    measurements.push({name,result,output,duration:meta.duration});console.log(name,JSON.stringify(result));
  }
  const comparisons=[];
  if(baseline)for(const entry of measurements.slice(1)){
    const old=measurements[0];if(entry.name.startsWith('stream'))assert.equal(entry.result.frames,old.result.frames);else assert.ok(Math.abs(entry.result.frames-old.result.frames)<=1);
    const score=await run('ffmpeg',['-hide_banner','-i',old.output,'-i',entry.output,'-lavfi','[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim','-an','-f','null','-']);
    const similarity=Number(score.errors.match(/All:([\d.]+)/)?.[1]);if(entry.name.startsWith('stream'))assert.ok(similarity>.98,'Unexpected change in the enhanced picture: SSIM '+similarity);
    comparisons.push({name:entry.name,speedup:(old.result.seconds/old.result.frames)/(entry.result.seconds/entry.result.frames),ssim:similarity});
  }
  await writeFile('test-results/enhancement-speed.json',JSON.stringify({date:new Date().toISOString(),source:{width:source.width,height:source.height,start,seconds},measurements,comparisons,errors:[]},null,2));
  console.log(JSON.stringify({measurements,comparisons},null,2));
}finally{await b.close();}
