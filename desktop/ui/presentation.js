(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.LingoUI=factory();})(globalThis,function(){
  'use strict';
  const levels=['A1','A2','B1','B2','C1','C2'];
  function dayKey(value){const d=new Date(value);return Number.isFinite(+d)?[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'):'';}
  function kind(word){return word.kind||(/\s/.test(word.word||'')?'phrase':'word');}
  function wordStats(words,now=Date.now()){
    const today=dayKey(now),week=now-7*86400000,known=words.map(w=>levels.indexOf(w.level)).filter(n=>n>=0);
    return {total:words.length,week:words.filter(w=>w.created>=week&&w.created<=now).length,learnedToday:words.filter(w=>w.learned&&dayKey(w.learnedAt)===today).length,favorites:words.filter(w=>w.favorite).length,level:known.length?levels[Math.round(known.reduce((a,b)=>a+b,0)/known.length)]:'—'};
  }
  function filterWords(words,{query='',filter='all',sort='date',reverse=false}={}){
    const result=words.filter(w=>(filter==='all'||filter==='favorite'&&w.favorite||filter==='learned'&&w.learned||filter==='new'&&!w.learned)&&`${w.word} ${w.translation}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    result.sort((a,b)=>sort==='word'?String(a.word).localeCompare(String(b.word),'en'):(b.created||0)-(a.created||0));if(reverse)result.reverse();return result;
  }
  function historyItems(history,words,episodes){
    const result=history.map((h,index)=>{const w=words.find(w=>w.word===h.word&&w.context===h.context);return {...h,id:h.id||`history-${index}`,kind:h.kind||kind(h),savedId:w?.id,favorite:!!w?.favorite,episodeId:h.episodeId||w?.episodeId,title:h.title||episodes.find(e=>e.id===(h.episodeId||w?.episodeId))?.title||'',position:h.position??w?.position};});
    for(const e of episodes)if(e.lastWatched&&!result.some(h=>h.kind==='watch'&&h.episodeId===e.id&&dayKey(h.date)===dayKey(e.lastWatched)))result.push({id:'watch-'+e.id,kind:'watch',date:e.lastWatched,episodeId:e.id,title:e.title,position:e.position||0,duration:e.duration});
    return result.sort((a,b)=>(b.date||0)-(a.date||0));
  }
  function filterHistory(items,{filter='all',query=''}={}){return items.filter(h=>(filter==='all'||filter==='favorite'&&h.favorite||h.kind===filter)&&`${h.word||''} ${h.translation||''} ${h.context||''} ${h.title||''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));}
  function streak(items,now=Date.now()){
    const days=new Set(items.map(h=>dayKey(h.date))),date=new Date(now);date.setHours(12,0,0,0);if(!days.has(dayKey(date)))date.setDate(date.getDate()-1);
    let count=0;while(days.has(dayKey(date))&&count<36500){count++;date.setDate(date.getDate()-1);}return count;
  }
  function art(episode){const title=episode?.title||'';return /fate.*apocrypha/i.test(title)?'fate-cover.png':/steins.?gate/i.test(title)?'steins-cover.png':/re.?zero/i.test(title)?'rezero-cover.png':null;}
  function seriesName(title){return String(title||'').replace(/\s*\[(?:English|EN|Dub|Sub)[^\]]*\]/gi,'').replace(/\s*[-–—]?\s*(?:episode|ep\.?|серия|s\d+e)\s*\d+.*$/i,'').trim();}
  function libraryItems(episodes,folders,{folderId=null,query=''}={}){
    const q=query.trim().toLocaleLowerCase(),known=new Set(folders.map(f=>f.id));
    return episodes.filter(e=>folderId?e.folderId===folderId:q||!known.has(e.folderId)).filter(e=>!q||`${e.title} ${folders.find(f=>f.id===e.folderId)?.name||''}`.toLocaleLowerCase().includes(q)).sort((a,b)=>a.title.localeCompare(b.title,'ru',{numeric:true,sensitivity:'base'}));
  }
  function folderStats(episodes){const duration=episodes.reduce((n,e)=>n+(e.duration||0),0),position=episodes.reduce((n,e)=>n+Math.max(0,Math.min(e.duration||0,e.position||0)),0);return {count:episodes.length,ready:episodes.filter(e=>e.state==='ready').length,percent:duration?Math.round(position/duration*100):0};}
  function counted(n,one,few,many){const I=typeof self!=='undefined'?self.LingoI18n:undefined;if(I&&I.language==='en')return `${n} ${n===1?one:many}`;const last=Math.abs(n)%100;return `${n} ${last>=11&&last<=14?many:last%10===1?one:last%10>=2&&last%10<=4?few:many}`;}
  return {levels,dayKey,kind,wordStats,filterWords,historyItems,filterHistory,streak,art,seriesName,libraryItems,folderStats,counted};
});
