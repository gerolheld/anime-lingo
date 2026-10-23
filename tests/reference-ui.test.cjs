'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const UI=require('../desktop/ui/presentation.js'),{Backend}=require('../desktop/backend.cjs'),R=require('../desktop/ui/reading.js');
test('word statistics use stored facts and do not invent CEFR levels or learned dates',()=>{
 const now=new Date(2026,9,22,15).getTime(),words=[{word:'one',created:now,learned:true},{word:'two',created:now-86400000,favorite:true,level:'B1',learned:true,learnedAt:now},{word:'three',created:now-9*86400000,level:'B2'}];
 assert.deepEqual(UI.wordStats(words,now),{total:3,week:2,learnedToday:1,favorites:1,level:'B2'});assert.equal(UI.wordStats([],now).level,'—');
});
test('word filters and sorting preserve saved data and distinguish favorites from learned',()=>{
 const words=[{id:'1',word:'reactor',translation:'реактор',favorite:true,created:1},{id:'2',word:'artificial',translation:'искусственный',learned:true,created:2}];
 assert.deepEqual(UI.filterWords(words,{filter:'favorite'}).map(w=>w.id),['1']);assert.deepEqual(UI.filterWords(words,{filter:'learned'}).map(w=>w.id),['2']);assert.deepEqual(UI.filterWords(words,{query:'реак'}).map(w=>w.id),['1']);assert.deepEqual(UI.filterWords(words,{sort:'word'}).map(w=>w.id),['2','1']);assert.equal(words[0].id,'1');assert.equal(UI.filterWords([{word:'suitable',translation:'подходящий',context:'reactor core'}],{query:'reactor'}).length,0);
});
test('history joins saved favorites, includes known viewing events and filters phrases accurately',()=>{
 const now=new Date(2026,9,22,15).getTime(),words=[{id:'a',word:'a phrase',context:'a phrase',favorite:true,episodeId:'e'}],episodes=[{id:'e',title:'Episode',position:12,lastWatched:now}],items=UI.historyItems([{word:'a phrase',context:'a phrase',date:now-10}],words,episodes);
 assert.equal(items.length,2);assert.equal(items[0].kind,'watch');assert.equal(items[1].kind,'phrase');assert.equal(items[1].favorite,true);assert.equal(items[1].title,'Episode');assert.equal(UI.filterHistory(items,{filter:'favorite'}).length,1);assert.equal(UI.filterHistory(items,{filter:'watch'}).length,1);assert.equal(UI.filterHistory(items,{query:'absent'}).length,0);
 assert.equal(UI.historyItems([],[],[{id:'e',title:'Unwatched',position:0}]).length,0);
});
test('streak counts local calendar days once, accepts yesterday and stops across gaps',()=>{
 const now=new Date(2026,9,22,15),previous=new Date(2026,9,21,23),older=new Date(2026,9,20,1);
 assert.equal(UI.streak([{date:+now},{date:+now-100},{date:+previous},{date:+older}],+now),3);assert.equal(UI.streak([{date:+previous},{date:+older}],+now),2);assert.equal(UI.streak([{date:+older}],+now),0);
});
test('favorites, level, learned date and phrase context persist without calling any models',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'lingo-reference-')),models={state:{phase:'idle'},with(){throw Error('Model execution forbidden');}};
 try{const b=await new Backend(root,{modelManager:models}).init();b.db.episodes.push({id:'e',title:'Episode',duration:60,cues:[],ruCues:[]});const word=await b.saveWord({word:'reactor',context:'A reactor core.',translation:'реактор',episodeId:'e',position:12,ruContext:'Ядро реактора.',phonetic:'[r]'});
 await b.updateWord(word.id,'favorite');await b.updateWord(word.id,'level','B2');await b.updateWord(word.id,'learned');assert.equal(word.favorite,true);assert.equal(word.level,'B2');assert.ok(word.learnedAt);assert.equal(word.episodeId,'e');assert.equal(word.position,12);
 const phrase=await b.saveWord({kind:'phrase',word:'A reactor core.',context:'A reactor core.',translation:'Ядро реактора.'});assert.equal(phrase.kind,'phrase');assert.equal(b.db.history[0].kind,'phrase');await assert.rejects(b.updateWord(word.id,'level','B9'),/уровень/);await assert.rejects(b.updateWord(word.id,'unknown'),/Неизвестное/);
 await b.configure({subtitleStyle:'classic',readingPauseDelay:.5});const next=await new Backend(root,{modelManager:models}).init();assert.equal(next.db.settings.subtitleStyle,'classic');assert.equal(next.db.settings.readingPauseDelay,.5);assert.equal(next.db.words.find(w=>w.id===word.id).favorite,true);await assert.rejects(next.configure({subtitleStyle:'unrecognized'}),/стиль/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('optional pause delay pins the completed part once and is cancelled on seek or resume',()=>{
 const parts=[{id:'a',start:1,end:2},{id:'b',start:2,end:3}],s=new R.Session(parts);
 s.update(1.9,{playing:true,autoPause:true,pauseDelay:.5});assert.equal(s.update(2.1,{playing:true,autoPause:true,pauseDelay:.5}).pause,false);assert.equal(s.update(2.4,{playing:true,autoPause:true,pauseDelay:.5}).pause,false);const pause=s.update(2.5,{playing:true,autoPause:true,pauseDelay:.5});assert.equal(pause.pause,true);assert.equal(pause.part.id,'a');s.resume();assert.equal(s.update(2.6,{playing:true,autoPause:true,pauseDelay:.5}).pause,false);s.reset();s.update(1.9,{playing:true,autoPause:true,pauseDelay:.5});s.update(2.1,{playing:true,autoPause:true,pauseDelay:.5});assert.equal(s.update(1.3,{playing:true,autoPause:true,seeking:true,pauseDelay:.5}).part.id,'a');assert.equal(s.pending,null);
});
