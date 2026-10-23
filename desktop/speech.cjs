'use strict';
const {run}=require('./process.cjs');
// The sentence travels in an environment variable, never inside the PowerShell script text.
const WINDOWS_SCRIPT="Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;try{$s.SelectVoiceByHints('NotSet','NotSet',0,[System.Globalization.CultureInfo]::GetCultureInfo('en-US'))}catch{};$s.Speak($env:LINGO_SPEAK_TEXT)";
function speakCommand(text,platform=process.platform){
  const clean=String(text||'').slice(0,2000);if(!clean.trim())return null;
  if(platform==='win32')return {binary:'powershell.exe',args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',WINDOWS_SCRIPT],env:{LINGO_SPEAK_TEXT:clean}};
  return {binary:'espeak-ng',args:['-v','en-us','-s','155','--',clean],env:undefined};
}
async function speak(text,{execute=run,platform=process.platform}={}){
  const c=speakCommand(text,platform);if(!c)return;
  try{return await execute(c.binary,c.args,{timeout:30000,env:c.env});}
  catch(error){
    if(error.code==='ENOENT')throw Error(platform==='win32'?'Не найден встроенный синтезатор речи Windows.':'Не найден espeak-ng. Установите пакет espeak-ng, чтобы слышать произношение.');
    throw error;
  }
}
module.exports={speakCommand,speak};
