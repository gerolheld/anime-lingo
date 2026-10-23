'use strict';
// One heavy model at a time, first come first served. The translator is a child process (llama-server):
// loading = starting it, unloading = ending it, so "unloaded" always means the process is really gone.
class ModelManager {
  constructor({settings,onState=()=>{},llama,enabled=true}={}){this.settings=settings;this.onState=onState;this.llama=llama;this.enabled=enabled&&!!llama;this.tail=Promise.resolve();this.waiting=0;this.state={kind:null,phase:'idle',label:'Модели выгружены',waiting:0};}
  report(kind,phase,label){this.state={kind,phase,label,waiting:this.waiting};this.onState(this.state);}
  // Where translation requests go. Without a managed server (tests, ANIME_LINGO_MOCK_MODELS) the settings endpoint is used.
  target(){
    if(this.enabled)return this.llama.running?{endpoint:this.llama.endpoint,headers:this.llama.headers()}:null;
    const endpoint=this.settings().endpoint;return endpoint?{endpoint,headers:{}}:null;
  }
  // Inside a translation lease a missing server means it died: the request path restarts it.
  canRecover(){return this.enabled&&this.state.kind==='translation';}
  async unload(){if(!this.enabled)return;if(this.llama.running||this.llama.child){this.report(null,'unloading','Выгружаю Hy-MT2');await this.llama.stop();}if(this.llama.running)throw Error('Движок перевода не остановился. Следующая модель не запущена.');}
  async loadTranslation(signal){if(!this.enabled)return;this.report('translation','loading','Загружаю Hy-MT2');await this.llama.start({signal});}
  async recoverTranslation(signal){if(signal?.aborted)throw Error('Отменено');this.report('translation','loading','Перезапускаю движок перевода');await this.unload();await this.loadTranslation(signal);if(signal?.aborted)throw Error('Отменено');this.report('translation','working','Hy-MT2 продолжает перевод');}
  with(kind,fn,signal){this.waiting++;this.onState({...this.state,waiting:this.waiting});const task=async()=>{this.waiting--;if(signal?.aborted)throw Error('Отменено');let failed;try{if(kind==='translation')await this.loadTranslation(signal);else await this.unload();if(signal?.aborted)throw Error('Отменено');if(kind!=='release')this.report(kind,'working',({speech:'Qwen3-ASR распознаёт речь',alignment:'ForcedAligner синхронизирует слова',translation:'Hy-MT2 переводит текст',enhancement:'Улучшение видео · безопасный режим'})[kind]||kind);return await fn();}catch(e){failed=e;throw e;}finally{try{await this.unload();this.report(null,'idle','Модели выгружены');}catch(e){this.report(null,'error','Не удалось выгрузить модель: '+e.message);if(!failed)throw e;}}};const next=this.tail.catch(()=>{}).then(task);this.tail=next;return next;}
  release(){return this.with('release',async()=>{});}
}
module.exports={ModelManager};
