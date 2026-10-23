(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.LingoReading=factory();
})(typeof globalThis==='undefined'?this:globalThis,function(){
  'use strict';
  const tokens=text=>[...String(text).matchAll(/\S+/gu)].map(m=>({text:m[0],start:m.index,end:m.index+m[0].length}));
  const ending=/[.!?…]["'”’»)]*$/u,clause=/[,;:—]["'”’»)]*$/u;
  const weakEnd=/^(?:a|an|the|to|of|in|on|at|for|with|and|or|but|that|my|your|his|her|our|their|really|very|quite|already|и|а|но|в|на|к|с|из|за|от|для|что|чтобы)$/iu;
  function boundaryCost(words,end){
    if(end===words.length)return 0;
    const word=words[end-1].text;
    return ending.test(word)?-5:clause.test(word)?-3:weakEnd.test(word)?5:0;
  }
  // A small dynamic programme chooses punctuation and breathing pauses, without
  // rewriting either language or pretending to perform bilingual word alignment.
  function split(text,{size=5,maxChars=42,words:aligned=[]}={}){
    text=String(text||'');const ws=tokens(text),n=ws.length;if(!n)return [];
    size=Math.max(3,Math.min(6,+size||5));const maxWords=Math.min(6,size+1),dp=Array(n+1).fill(Infinity),back=Array(n+1);dp[0]=0;
    for(let end=1;end<=n;end++)for(let start=Math.max(0,end-maxWords);start<end;start++){
      const count=end-start,chars=ws[end-1].end-ws[start].start;
      if(chars>maxChars&&count>1)continue;
      const left=aligned.find(w=>w.charEnd>=ws[end-1].end),right=aligned.find(w=>w.charStart>=ws[end-1].end);
      const gap=left&&right?right.start-left.end:0;
      const score=dp[start]+Math.pow(count-size,2)+3+(count===1&&n>1?5:0)+boundaryCost(ws,end)-(gap>=.35?3:0);
      if(score<dp[end]){dp[end]=score;back[end]=start;}
    }
    const out=[];let end=n;
    while(end>0){const start=back[end];out.unshift({text:text.slice(ws[start].start,ws[end-1].end),charStart:ws[start].start,charEnd:ws[end-1].end});end=start;}
    return out;
  }
  // Russian is an existing complete translation. Its presentation chunks have
  // approximate times inside that sentence; they are never dictionary glosses.
  function translatedParts(text,parts,start,end){
    const pieces=split(text,{size:5,maxChars:48});if(!pieces.length)return [];
    const total=Math.max(1,String(text).length),span=Math.max(.01,end-start);
    return pieces.map((p,i)=>({...p,start:pieces.length===parts.length?parts[i].start:start+span*p.charStart/total,end:i+1<pieces.length?(pieces.length===parts.length?parts[i+1].start:start+span*pieces[i+1].charStart/total):end}));
  }
  function cueParts(cue,{size=5,index=0,translation=cue.ru||''}={}){
    const start=+cue.start,end=+cue.end;
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||!cue.text)return [];
    const aligned=(cue.words||[]).filter(w=>Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.end>=w.start&&Number.isInteger(w.charStart)&&Number.isInteger(w.charEnd)&&w.charEnd>w.charStart&&w.charStart>=0&&w.charEnd<=cue.text.length);
    const pieces=split(cue.text,{size,words:aligned});
    const total=Math.max(1,cue.text.length),span=end-start;
    const parts=pieces.map((p,i)=>{
      const matches=aligned.filter(w=>w.charStart<p.charEnd&&w.charEnd>p.charStart);
      const a=matches.length?matches[0].start:start+span*p.charStart/total;
      const b=matches.length?matches.at(-1).end:start+span*(pieces[i+1]?.charStart??total)/total;
      return {...p,id:`${index}:${i}`,cueIndex:index,partIndex:i,count:pieces.length,start:Math.max(start,Math.min(end-.001,a)),end:Math.max(start+.001,Math.min(end,b)),context:cue.text,translation,precise:matches.length>0,
        words:matches.map(w=>({...w,charStart:w.charStart-p.charStart,charEnd:w.charEnd-p.charStart}))};
    });
    // Keep starts monotonic even if an imported aligner supplied overlapping words.
    for(let i=1;i<parts.length;i++){parts[i].start=Math.max(parts[i-1].start+.00001,parts[i].start);parts[i-1].end=Math.min(parts[i-1].end,parts[i].start);}
    for(const p of parts)p.end=Math.max(p.start+.000001,p.end);
    const ru=translatedParts(translation,parts,start,end);
    for(const p of parts)p.ruParts=ru;
    return parts;
  }
  function build(cues,{size=5,translate=c=>c.ru||''}={}){
    return (cues||[]).flatMap((cue,index)=>cueParts(cue,{size,index,translation:translate(cue)})).sort((a,b)=>a.start-b.start||a.cueIndex-b.cueIndex);
  }
  function at(parts,time,{hold=true}={}){
    let lo=0,hi=parts.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(parts[mid].start<=time)lo=mid+1;else hi=mid;}
    const part=parts[lo-1];return part&&(hold||time<part.end)?part:null;
  }
  function russian(part,time){
    return part?at(part.ruParts,Math.max(part.ruParts[0]?.start??time,time),{hold:true})?.text||'':'';
  }
  class Session {
    constructor(parts=[]){this.parts=parts;this.reset();}
    reset(){this.previous=null;this.lastTime=null;this.pinned=null;this.pending=null;this.stopped=new Set();}
    resume(){this.pinned=null;this.pending=null;this.previous=null;this.lastTime=null;}
    update(time,{playing=false,autoPause=false,hold=true,seeking=false,pauseDelay=0}={}){
      if(seeking||this.lastTime!==null&&time<this.lastTime-.05)this.reset();
      if(!autoPause){this.pinned=null;this.pending=null;}
      if(this.pinned){this.lastTime=time;return {part:this.pinned,pause:false,pinned:true};}
      if(this.pending&&playing&&time>=this.pending.at){this.pinned=this.pending.part;this.pending=null;this.lastTime=time;return {part:this.pinned,pause:true,pinned:true};}
      const part=at(this.parts,time,{hold}),previous=this.previous;
      const crossed=previous&&this.lastTime!==null&&this.lastTime<previous.end&&time>=previous.end;
      if(playing&&!seeking&&autoPause&&crossed&&!this.pending&&!this.stopped.has(previous.id)){
        const delay=Math.max(0,Math.min(3,+pauseDelay||0));
        if(delay>0&&time<previous.end+delay){this.pending={part:previous,at:previous.end+delay};this.stopped.add(previous.id);this.previous=part;this.lastTime=time;return {part,pause:false,pinned:false};}
        this.stopped.add(previous.id);this.pinned=previous;this.lastTime=time;
        return {part:previous,pause:true,pinned:true};
      }
      this.previous=part;this.lastTime=time;return {part,pause:false,pinned:false};
    }
  }
  return {tokens,split,cueParts,build,at,russian,Session};
});
