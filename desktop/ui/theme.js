'use strict';
// Colour themes. The stylesheets are written in the default blue. For any other theme a generated twin of each stylesheet
// (*.themed.css, produced by tools/build-theme-css.mjs) is switched on: every colour in it is expressed relative to the original
// as hsl(from <original> hue+shift, saturation*s, lightness*l). Pictures, covers and video keep their own colours.
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.LingoTheme=factory();})(typeof self!=='undefined'?self:this,function(){
const BASE_HUE=220;                      // hue of the blue the stylesheets were drawn in
const PRESETS=Object.freeze([
  {id:'default',name:'Синий (по умолчанию)',hue:null,swatch:'#86b5ff'},
  {id:'red',name:'Красный',hue:352,swatch:'#ff8a96'},
  {id:'orange',name:'Оранжевый',hue:28,swatch:'#ffae6b'},
  {id:'gold',name:'Золотой',hue:46,swatch:'#ffd36b',sat:.9},
  {id:'green',name:'Изумрудный',hue:150,swatch:'#6be3a5'},
  {id:'teal',name:'Бирюзовый',hue:180,swatch:'#6be0e0'},
  {id:'violet',name:'Фиолетовый',hue:268,swatch:'#b79bff'},
  {id:'pink',name:'Сакура',hue:330,swatch:'#ff9fd0'},
  {id:'graphite',name:'Графит',hue:0,swatch:'#c4c9d6',sat:.08},
]);
const DEPTHS=Object.freeze({deep:.72,normal:1,soft:1.32});
const COLOR=/^#[0-9a-fA-F]{6}$/;

function hexToRgb(hex){const m=COLOR.exec(hex||'');if(!m)return null;const n=parseInt(hex.slice(1),16);return {r:n>>16&255,g:n>>8&255,b:n&255};}
function rgbToHex({r,g,b}){return '#'+[r,g,b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');}
function rgbToHsl({r,g,b}){
  r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min,l=(max+min)/2;
  let h=0,s=0;
  if(d){s=d/(1-Math.abs(2*l-1));h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;h=(h*60+360)%360;}
  return {h,s:s*100,l:l*100};
}
// -> {active, th (hue shift, degrees), ts (saturation factor), tl (lightness factor for dark tones)}
function compute(settings={}){
  const preset=PRESETS.find(p=>p.id===settings.themePreset)||null,custom=settings.themePreset==='custom',depth=DEPTHS[settings.themeDepth]??1;
  let hue=BASE_HUE,sat=1;
  if(custom){const rgb=hexToRgb(settings.themeColor);if(rgb){const hsl=rgbToHsl(rgb);hue=hsl.h;sat=Math.max(.08,Math.min(1.15,hsl.s/100));}}
  else if(preset&&preset.hue!==null){hue=preset.hue;sat=preset.sat??1;}
  const th=Math.round((((hue-BASE_HUE)%360)+540)%360-180);
  const active=custom&&hexToRgb(settings.themeColor)||(preset&&preset.id!=='default')||depth!==1;
  return {active:!!active,th,ts:+sat.toFixed(3),tl:depth};
}

// ---- stylesheet transformation (pure, used by the generator and the tests) ----
const RELATIVE=color=>`hsl(from ${color} calc(h + var(--th)) calc(s * var(--ts)) calc(l * (1 + (var(--tl) - 1) * (1 - l / 100) * (1 - l / 100))) / alpha)`;
const TOKEN=/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\)|#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])|rgba?\([^)]*\))/g;
// Meaning colours (green = ready, amber = warning, red/pink = error) keep their hue in every theme: only the blue family and
// near-neutral tones belong to the theme.
function parseColor(token){
  if(token[0]==='#'){
    let h=token.slice(1);if(h.length<=4)h=h.split('').map(c=>c+c).join('');
    return {r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16)};
  }
  const n=token.match(/[\d.]+/g);return n&&n.length>=3?{r:+n[0],g:+n[1],b:+n[2]}:null;
}
function belongsToTheme(token){
  const rgb=parseColor(token);if(!rgb)return true;
  const {h,s}=rgbToHsl(rgb);
  return s<22||(h>=185&&h<=275);
}
function recolorValue(value){
  return value.replace(TOKEN,token=>token[0]==='"'||token[0]==="'"||token.startsWith('url(')||!belongsToTheme(token)?token:RELATIVE(token));
}
function recolorCss(css){
  return css.replace(/([a-zA-Z-]+)(\s*:\s*)([^;{}]*)(?=[;}])/g,(whole,prop,colon,value)=>prop+colon+recolorValue(value));
}

// ---- DOM ----
const STORAGE='lingo-theme';
function applyComputed(t,doc=document){
  const style=doc.documentElement.style;
  style.setProperty('--th',String(t.th));style.setProperty('--ts',String(t.ts));style.setProperty('--tl',String(t.tl));
  for(const link of doc.querySelectorAll('link[data-themed]'))link.media=t.active?'all':'not all';
  try{localStorage.setItem(STORAGE,JSON.stringify(t));}catch{}
}
function apply(settings,doc=document){const t=compute(settings);applyComputed(t,doc);return t;}
return {PRESETS,DEPTHS,BASE_HUE,compute,recolorCss,recolorValue,hexToRgb,rgbToHex,rgbToHsl,apply,applyComputed,STORAGE};
});
