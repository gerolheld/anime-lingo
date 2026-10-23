'use strict';
// Settings → Appearance: colour swatches, a custom RGB colour and the background depth. Everything applies at once and is saved at once.
let themeSignature='';
const themeSettings=()=>({themePreset:S.settings.themePreset||'default',themeColor:S.settings.themeColor||'#ff6b6b',themeDepth:S.settings.themeDepth||'normal'});
function applyThemeFromSettings(){
  const t=themeSettings(),signature=JSON.stringify(t);
  if(signature===themeSignature)return;themeSignature=signature;LingoTheme.apply(t);
}
async function saveTheme(patch){
  S.settings=await call('settings',patch);themeSignature='';applyThemeFromSettings();syncThemeUI();
}
const DEPTH_LABELS=[['deep','Глубже'],['normal','Обычный'],['soft','Светлее']];
function syncThemeUI(){
  const box=$('theme-swatches');if(!box)return;
  const t=themeSettings(),form=$('settings-form');
  for(const [name,value] of Object.entries(t)){const input=form.elements.namedItem(name);if(input)input.value=value;}
  box.replaceChildren();
  for(const preset of LingoTheme.PRESETS){
    const b=el('button','theme-swatch'+(t.themePreset===preset.id?' selected':''));b.type='button';b.style.setProperty('--swatch',preset.swatch);
    b.setAttribute('role','radio');b.setAttribute('aria-checked',String(t.themePreset===preset.id));b.setAttribute('aria-label',preset.name);b.title=preset.name;
    b.onclick=task(()=>saveTheme({themePreset:preset.id}));box.append(b);
  }
  const custom=el('button','theme-swatch custom'+(t.themePreset==='custom'?' selected':''));custom.type='button';custom.style.setProperty('--swatch',t.themeColor);
  custom.setAttribute('role','radio');custom.setAttribute('aria-checked',String(t.themePreset==='custom'));custom.setAttribute('aria-label','Свой цвет');custom.title='Свой цвет';
  custom.onclick=task(()=>saveTheme({themePreset:'custom',themeColor:t.themeColor}));box.append(custom);
  const rgb=LingoTheme.hexToRgb(t.themeColor)||{r:255,g:107,b:107};
  for(const [key,value] of [['r',rgb.r],['g',rgb.g],['b',rgb.b]]){$('theme-'+key).value=value;$('theme-'+key+'-out').textContent=value;}
  $('theme-hex').textContent=t.themeColor;
  const depth=$('theme-depth');depth.replaceChildren();
  for(const [id,label] of DEPTH_LABELS){const b=el('button',t.themeDepth===id?'selected':'',label);b.type='button';b.setAttribute('role','radio');b.setAttribute('aria-checked',String(t.themeDepth===id));b.onclick=task(()=>saveTheme({themeDepth:id}));depth.append(b);}
}
function initThemeUI(){
  const read=()=>LingoTheme.rgbToHex({r:+$('theme-r').value,g:+$('theme-g').value,b:+$('theme-b').value});
  for(const key of ['r','g','b']){
    const input=$('theme-'+key);
    // Dragging previews the colour at once; releasing saves it.
    input.oninput=()=>{const hex=read();$('theme-'+key+'-out').textContent=input.value;$('theme-hex').textContent=hex;themeSignature='';LingoTheme.apply({...themeSettings(),themePreset:'custom',themeColor:hex});};
    input.onchange=task(()=>saveTheme({themePreset:'custom',themeColor:read()}));
  }
  $('theme-reset').onclick=task(()=>saveTheme({themePreset:'default',themeDepth:'normal'}));
  syncThemeUI();
}
