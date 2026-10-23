'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const acorn=require('acorn');
const I=require('../desktop/ui/i18n.js');
const PAIRS=require('../desktop/ui/i18n-en.js');
const CYR=/[А-Яа-яЁё]/;
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

const UI_SCRIPTS=['desktop/ui/app.js','desktop/ui/library.js','desktop/ui/models.js','desktop/ui/presentation.js','desktop/ui/theme.js','desktop/ui/theme-ui.js'];
const BACKEND=fs.readdirSync(path.join(root,'desktop')).filter(f=>f.endsWith('.cjs')).map(f=>'desktop/'+f);
// Russian that is data or code, not text shown to the user: regular expressions, word lists, language detection.
const IGNORED=[/^[\s\S]*\[а-яё\]/i,/^[а-яё]+$/i.source&&/^\(\?:/];

function pieces(file){
  const ast=acorn.parse(read(file),{ecmaVersion:'latest',sourceType:'script',allowHashBang:true});
  const out=[];
  (function walk(n){
    if(!n||typeof n.type!=='string')return;
    if(n.type==='Literal'&&typeof n.value==='string'&&CYR.test(n.value))out.push(n.value);
    if(n.type==='TemplateElement'&&CYR.test(n.value.cooked||''))out.push(n.value.cooked);
    if(n.type==='Literal'&&n.regex)return;
    for(const k of Object.keys(n)){const v=n[k];if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v.type==='string')walk(v);}
  })(ast);
  return out;
}
function htmlPieces(){
  const html=read('desktop/ui/index.html'),out=new Set();
  for(const m of html.matchAll(/>([^<>]*[А-Яа-яЁё][^<>]*)</g))out.add(m[1].replace(/\s+/g,' ').trim());
  for(const m of html.matchAll(/(?:title|placeholder|aria-label|alt)="([^"]*[А-Яа-яЁё][^"]*)"/g))out.add(m[1].trim());
  return [...out];
}
const tr=I.createTranslator(PAIRS).translate;

test('the dictionary is well formed: no duplicate or empty keys, English has no Russian letters',()=>{
  const seen=new Set();
  for(const [ru,en] of PAIRS){
    assert.ok(ru&&en,'empty entry '+ru);assert.ok(!seen.has(ru),'duplicate key '+ru);seen.add(ru);
    assert.ok(!CYR.test(en),'Russian left in the English text of '+ru);
  }
});
test('every Russian text in the interface HTML is translated',()=>{
  const missing=htmlPieces().filter(t=>CYR.test(tr(t)));
  assert.deepEqual(missing,[]);
});
test('every Russian text in the interface scripts is translated',()=>{
  const missing=[];
  for(const f of UI_SCRIPTS)for(const p of pieces(f)){const t=p.trim();if(t&&CYR.test(tr(t)))missing.push(f.split('/').pop()+': '+t);}
  assert.deepEqual([...new Set(missing)],[]);
});
test('every Russian message produced by the backend is translated',()=>{
  const missing=[];
  for(const f of BACKEND)for(const p of pieces(f)){const t=p.trim();if(t&&CYR.test(tr(t)))missing.push(f.split('/').pop()+': '+t);}
  assert.deepEqual([...new Set(missing)],[]);
});
test('every Russian message of the Python recognition worker is translated',()=>{
  const source=read('desktop/qwen_worker.py'),missing=[];
  for(const m of source.matchAll(/'([^'\n]*[А-Яа-яЁё][^'\n]*)'/g))if(CYR.test(tr(m[1])))missing.push(m[1]);
  assert.deepEqual(missing,[]);
});
test('translation keeps numbers and names, never touches the middle of a Russian word and leaves user content alone',()=>{
  I.setSetting('en');I.init(PAIRS,()=>['Сегодня мы идём на берег','берег']);I.setSetting('en');
  assert.equal(I.translate('Добавлено серий: 3'),'Episodes added: 3');
  assert.equal(I.translate('Папкам'),'Папкам','a key inside a longer Russian word is not replaced');
  assert.equal(I.translate('5 с'),'5 s');assert.equal(I.translate('Fate/Apocrypha'),'Fate/Apocrypha');
  assert.equal(I.translate('Сегодня'),'Today');
  I.setSetting('ru');assert.equal(I.translate('Сегодня'),'Сегодня','Russian mode never changes text');
});
test('language choice: explicit wins, automatic follows the system',()=>{
  assert.equal(I.resolveLanguage('ru','en-US'),'ru');assert.equal(I.resolveLanguage('en','ru-RU'),'en');
  assert.equal(I.resolveLanguage('auto','ru-RU'),'ru');assert.equal(I.resolveLanguage('auto','uk'),'ru');
  assert.equal(I.resolveLanguage('auto','en-GB'),'en');assert.equal(I.resolveLanguage('auto','de-DE'),'en');assert.equal(I.resolveLanguage('auto',''),'en');
});
test('plural forms: three in Russian, two in English',()=>{
  I.setSetting('ru');assert.deepEqual([1,2,5,11,21].map(n=>I.plural(n,'серия','серии','серий')),['серия','серии','серий','серий','серия']);
  I.setSetting('en');assert.deepEqual([0,1,2,21].map(n=>I.plural(n,'episode','episodes','episodes')),['episodes','episode','episodes','episodes']);
});
