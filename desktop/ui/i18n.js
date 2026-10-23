'use strict';
// Interface language. Russian is the source language of every text in the program; English is produced by a phrase
// dictionary (i18n-en.js) applied to the page. The engine is pure (translate) plus a thin DOM layer (install).
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.LingoI18n=factory();})(typeof self!=='undefined'?self:this,function(){
const CYRILLIC=/[А-Яа-яЁё]/;
const escapeRegex=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const ATTRIBUTES=['title','placeholder','aria-label','alt'];
const SKIP_TAGS=new Set(['SCRIPT','STYLE','TEXTAREA','INPUT']);

function createTranslator(pairs){
  const map=new Map(pairs);
  // Longest phrase first, so a sentence wins over the words inside it. Phrases never start or end inside a Russian word.
  const keys=[...map.keys()].sort((a,b)=>b.length-a.length);
  // The word-boundary guard applies only on the side where the phrase begins or ends with a Russian letter.
  const guarded=key=>(CYRILLIC.test(key[0])?'(?<![А-Яа-яЁё])':'')+escapeRegex(key)+(CYRILLIC.test(key[key.length-1])?'(?![А-Яа-яЁё])':'');
  const pattern=new RegExp(keys.map(guarded).join('|'),'g');
  function translate(text){
    if(typeof text!=='string'||!CYRILLIC.test(text))return text;
    const exact=map.get(text);if(exact!==undefined)return exact;
    const trimmed=text.trim();
    if(trimmed!==text&&map.has(trimmed))return text.replace(trimmed,map.get(trimmed));
    return text.replace(pattern,match=>map.get(match));
  }
  return {translate,map,size:map.size};
}
// 'auto' follows the system: Russian-speaking systems get Russian, everything else English.
function resolveLanguage(setting,navigatorLanguage=''){
  if(setting==='ru'||setting==='en')return setting;
  return /^(ru|uk|be|kk)\b/i.test(navigatorLanguage)?'ru':'en';
}

const state={version:null,versionFn:null,setting:'auto',language:'ru',locale:'ru-RU',translator:null,provider:null,content:new Set(),contentAt:0,contentText:'',observer:null};
function readStored(){try{return (typeof localStorage!=='undefined'&&localStorage.getItem('lingo-lang'))||'auto';}catch{return 'auto';}}
function storeSetting(value){try{localStorage.setItem('lingo-lang',value);}catch{}}

function setSetting(setting,navigatorLanguage=(typeof navigator!=='undefined'?navigator.language:'')){
  state.setting=setting;state.language=resolveLanguage(setting,navigatorLanguage);state.locale=state.language==='en'?'en-US':'ru-RU';
  if(typeof document!=='undefined'&&document.documentElement)document.documentElement.lang=state.language;
  return state.language;
}
// User content (titles, subtitles, saved words and their Russian translations) must never be translated.
function refreshContent(force=false){
  // Rebuilt only when the cheap version key changes, so a text node that appears right after new content arrives is never judged by stale data.
  const version=state.versionFn?state.versionFn():null;
  if(!force&&version!==null&&version===state.version)return;
  if(!force&&version===null&&Date.now()-state.contentAt<1000)return;
  state.version=version;state.contentAt=Date.now();
  const strings=state.provider?state.provider():[];
  state.content=new Set(strings.filter(Boolean));state.contentText='\n'+[...state.content].filter(s=>s.length>=12).join('\n')+'\n';
}
function isContent(text){
  if(!state.provider)return false;refreshContent();
  const t=text.trim();
  return state.content.has(t)||(t.length>=12&&state.contentText.includes(t));
}
function translate(text){
  if(state.language!=='en'||!state.translator)return text;
  return state.translator.translate(text);
}

function insideContent(node){
  for(let el=node.nodeType===1?node:node.parentElement;el;el=el.parentElement){
    if(el.getAttribute?.('translate')==='no'||el.getAttribute?.('lang')==='ru')return true;
  }
  return false;
}
function translateTextNode(node){
  const value=node.nodeValue;if(!value||!CYRILLIC.test(value)||insideContent(node)||isContent(value))return;
  const next=translate(value);if(next!==value)node.nodeValue=next;
}
function translateAttributes(el){
  for(const name of ATTRIBUTES){
    const value=el.getAttribute(name);if(value&&CYRILLIC.test(value)&&!insideContent(el)){const next=translate(value);if(next!==value)el.setAttribute(name,next);}
  }
}
function walk(node){
  if(node.nodeType===3){translateTextNode(node);return;}
  if(node.nodeType!==1)return;
  if(node.getAttribute('translate')==='no'||node.getAttribute('lang')==='ru')return;
  translateAttributes(node);  // placeholders and titles of inputs are translated too
  if(SKIP_TAGS.has(node.tagName))return;
  for(const child of node.childNodes)walk(child);
}
function install(doc=document){
  if(state.language!=='en'||!state.translator)return;
  walk(doc.body||doc.documentElement);
  state.observer=new MutationObserver(records=>{
    for(const r of records){
      if(r.type==='childList'){for(const n of r.addedNodes)walk(n);}
      else if(r.type==='characterData')translateTextNode(r.target);
      else if(r.type==='attributes'&&r.target.nodeType===1)translateAttributes(r.target);
    }
  });
  state.observer.observe(doc.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:ATTRIBUTES});
}
// For tests and diagnostics: Russian interface text that is still on the page (user content excluded).
function findUntranslated(rootNode=document.body){
  const found=[];refreshContent(true);
  const visit=node=>{
    if(node.nodeType===3){const v=node.nodeValue;if(v&&CYRILLIC.test(v)&&!insideContent(node)&&!isContent(v))found.push(v.trim());return;}
    if(node.nodeType!==1)return;
    if(node.getAttribute('translate')==='no'||node.getAttribute('lang')==='ru')return;
    for(const a of ATTRIBUTES){const v=node.getAttribute(a);if(v&&CYRILLIC.test(v)&&!insideContent(node))found.push(a+'='+v);}
    if(SKIP_TAGS.has(node.tagName))return;
    for(const c of node.childNodes)visit(c);
  };
  visit(rootNode);return found;
}
// Native dialogs are not part of the DOM.
function wrapDialogs(win=window){
  for(const name of ['confirm','alert']){const original=win[name].bind(win);win[name]=text=>original(translate(String(text)));}
}
// Singular/plural for counted nouns: Russian has three forms, English two.
function plural(n,one,few,many){
  if(state.language==='en')return n===1?one:many;
  const last=Math.abs(n)%100;return last>=11&&last<=14?many:last%10===1?one:last%10>=2&&last%10<=4?few:many;
}
function init(pairs,provider){
  state.translator=createTranslator(pairs);state.provider=provider||null;
  setSetting(readStored());
  return state.language;
}
return {createTranslator,resolveLanguage,init,install,wrapDialogs,translate,plural,findUntranslated,setSetting,storeSetting,
  setProvider(fn,versionFn){state.provider=fn;state.versionFn=versionFn||null;state.version=null;},get language(){return state.language;},get locale(){return state.locale;},get setting(){return state.setting;}};
});
