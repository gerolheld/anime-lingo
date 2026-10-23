'use strict';
// Runs in <head>, before the first paint: restores the last theme so there is no flash of the default colours.
(function(){
  try{
    const t=JSON.parse(localStorage.getItem('lingo-theme')||'null');if(!t)return;
    const s=document.documentElement.style;s.setProperty('--th',String(t.th));s.setProperty('--ts',String(t.ts));s.setProperty('--tl',String(t.tl));
    if(t.active)for(const link of document.querySelectorAll('link[data-themed]'))link.media='all';
  }catch{}
})();
