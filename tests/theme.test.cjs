'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Theme=require('../desktop/ui/theme.js');
const CYR=/[А-Яа-яЁё]/;

test('presets, custom colour and depth turn into hue shift, saturation and lightness factors',()=>{
  assert.deepEqual(Theme.compute({}),{active:false,th:0,ts:1,tl:1});
  assert.deepEqual(Theme.compute({themePreset:'default',themeDepth:'normal'}),{active:false,th:0,ts:1,tl:1});
  assert.deepEqual(Theme.compute({themePreset:'default',themeDepth:'deep'}),{active:true,th:0,ts:1,tl:.72});
  const red=Theme.compute({themePreset:'red'});assert.deepEqual([red.active,red.th,red.ts],[true,132,1]);
  assert.equal(Theme.compute({themePreset:'green'}).th,-70);
  assert.ok(Theme.compute({themePreset:'graphite'}).ts<.15,'graphite removes colour');
  const custom=Theme.compute({themePreset:'custom',themeColor:'#ff0000',themeDepth:'soft'});
  assert.deepEqual([custom.active,custom.th,custom.tl],[true,140,1.32]);assert.ok(custom.ts>.95);
  const muted=Theme.compute({themePreset:'custom',themeColor:'#7a8a99'});assert.ok(muted.ts<.3,'a washed-out colour gives a washed-out theme');
  assert.equal(Theme.compute({themePreset:'custom',themeColor:'not-a-colour'}).active,false,'an invalid custom colour never breaks the theme');
  assert.equal(Theme.compute({themePreset:'unknown'}).active,false);
  for(const p of Theme.PRESETS){const t=Theme.compute({themePreset:p.id});assert.ok(t.th>=-180&&t.th<=180,p.id);}
});
test('colour conversions round-trip',()=>{
  for(const hex of ['#86b5ff','#050c1c','#ff0000','#00ff7f','#123456'])assert.equal(Theme.rgbToHex(Theme.hexToRgb(hex)),hex);
  assert.equal(Math.round(Theme.rgbToHsl(Theme.hexToRgb('#ff0000')).h),0);assert.equal(Math.round(Theme.rgbToHsl(Theme.hexToRgb('#00ff00')).h),120);
  assert.equal(Theme.hexToRgb('#12345'),null);assert.equal(Theme.rgbToHex({r:300,g:-5,b:12.4}),'#ff000c');
});
test('stylesheet transformation changes colours only: not selectors, urls, strings or media queries',()=>{
  const css=`#cab,.x:hover{color:#fff;background:linear-gradient(#10204420,#0a1429),url('../a/#abc.png');border:1px solid rgba(10,20,30,.5);content:"#abc";width:12px}
@media(max-width:1500px){#add{box-shadow:0 0 4px #ABCDEF}:root{--line:#547fd85c}}`;
  const out=Theme.recolorCss(css);
  assert.ok(out.startsWith('#cab,.x:hover{'),'selectors are untouched');assert.ok(out.includes('@media(max-width:1500px){#add{'));
  assert.ok(out.includes("url('../a/#abc.png')"),'urls are untouched');assert.ok(out.includes('content:"#abc"'),'strings are untouched');assert.ok(out.includes('width:12px'));
  assert.equal((out.match(/hsl\(from /g)||[]).length,6,'all six blue or neutral colours are recoloured');
  assert.ok(out.includes('hsl(from #fff calc(h + var(--th))'));assert.ok(out.includes('hsl(from rgba(10,20,30,.5) calc('));assert.ok(out.includes('--line:hsl(from #547fd85c'));
  assert.ok(!Theme.recolorCss('a{color:red}').includes('hsl'),'named colours are left alone');
  // meaning colours keep their hue in every theme; blue-family and neutral tones follow it
  for(const keep of ['#8de7b9','#62e8bb40','#ffb86b','#ffdae0','#ff9db0','rgba(255,120,140,.5)'])assert.equal(Theme.recolorCss('a{color:'+keep+'}'),'a{color:'+keep+'}',keep+' must stay');
  for(const follow of ['#86b5ff','#050c1c','#547fd85c','#9dc8ff','#c1d7ff','#808080','#fff'])assert.ok(Theme.recolorCss('a{color:'+follow+'}').includes('hsl(from'),follow+' must follow the theme');
});
test('the generated *.themed.css twins are up to date and every colour in them is relative',async()=>{
  const {render,SHEETS}=await import('../tools/build-theme-css.mjs');
  for(const name of SHEETS){
    const expected=await render(name),actual=fs.readFileSync(path.join(__dirname,`../desktop/ui/${name}.themed.css`),'utf8');
    assert.ok(actual===expected,`${name}.themed.css is stale: run node tools/build-theme-css.mjs`);
    // After removing the relative-colour wrappers, no raw colour may remain in a declaration value.
    const stripped=actual.replace(/hsl\(from (?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)) calc\(h/g,'hsl(from X calc(h');
    for(const m of stripped.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}]*)(?=[;}])/g)){
      const value=m[2].replace(/url\([^)]*\)|"[^"]*"|'[^']*'/g,'');
      for(const raw of value.match(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g)||[])assert.equal(Theme.recolorValue(raw),raw,name+': a theme colour was left unconverted in '+m[0].slice(0,100));
    }
  }
});
test('the page loads the themed twins disabled and the early script switches them on before first paint',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../desktop/ui/index.html'),'utf8');
  for(const n of ['app','library','models'])assert.ok(html.includes(`href="${n}.themed.css" data-themed media="not all"`),n);
  assert.ok(html.indexOf('theme-early.js')<html.indexOf('<body'),'the early script runs in <head>');
  const store={'lingo-theme':JSON.stringify({active:true,th:132,ts:1,tl:1})},links=[{media:'not all'},{media:'not all'}],set={};
  const context={localStorage:{getItem:k=>store[k]},document:{documentElement:{style:{setProperty:(k,v)=>{set[k]=v;}}},querySelectorAll:()=>links}};
  new Function('localStorage','document',fs.readFileSync(path.join(__dirname,'../desktop/ui/theme-early.js'),'utf8'))(context.localStorage,context.document);
  assert.deepEqual(set,{'--th':'132','--ts':'1','--tl':'1'});assert.deepEqual(links.map(l=>l.media),['all','all']);
  const off=[{media:'not all'}];store['lingo-theme']=JSON.stringify({active:false,th:0,ts:1,tl:1});
  new Function('localStorage','document',fs.readFileSync(path.join(__dirname,'../desktop/ui/theme-early.js'),'utf8'))(context.localStorage,{...context.document,querySelectorAll:()=>off});
  assert.equal(off[0].media,'not all','the default theme keeps the original stylesheets only');
});
test('theme names are translated and the backend validates theme settings',async()=>{
  const I=require('../desktop/ui/i18n.js'),tr=I.createTranslator(require('../desktop/ui/i18n-en.js')).translate;
  for(const p of Theme.PRESETS)assert.ok(!CYR.test(tr(p.name)),p.name);
  const os=require('node:os'),{Backend}=require('../desktop/backend.cjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lingo-theme-')),b=await new Backend(dir,{manageModels:false}).init();
  await assert.rejects(b.configure({themePreset:'rainbow'}),/цветовая тема/);await assert.rejects(b.configure({themeColor:'red'}),/#rrggbb/);await assert.rejects(b.configure({themeDepth:'dark'}),/глубина/);
  await b.configure({themePreset:'custom',themeColor:'#12ab34',themeDepth:'deep'});
  assert.deepEqual([b.db.settings.themePreset,b.db.settings.themeColor,b.db.settings.themeDepth],['custom','#12ab34','deep']);
  await b.close();fs.rmSync(dir,{recursive:true,force:true});
});
