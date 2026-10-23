/* Shared pure functions; also loaded by the Node test runner. */
(function(root) {
  'use strict';
  const MAX_BYTES = 4 * 1024 * 1024;
  function uuid() {
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function plain(text) {
    return String(text).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, '').replace(/\\N/g, '\n')
      .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, e) => {
        if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
        return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[e.toLowerCase()];
      }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  }
  function timestamp(s) {
    const m = String(s).match(/^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/);
    if (!m || +m[2] > 59 || +m[3] > 59) return NaN;
    return +(m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
  }
  function parseSubtitles(raw) {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_BYTES) throw Error('Файл больше 4 МиБ');
    const blocks = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (/^(NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$)|WEBVTT(?:\s|$))/.test(lines[0])) continue;
      const index = lines.findIndex(l => l.includes('-->'));
      if (index < 0 || index > 1) continue;
      const m = lines[index].trim().match(/^(\S+)\s+-->\s+(\S+)/);
      if (!m) continue;
      const start = timestamp(m[1]), end = timestamp(m[2]), text = plain(lines.slice(index + 1).join('\n'));
      if (Number.isFinite(start) && end > start && text && text.length <= 12000 && !/\.(jpg|jpeg|png|webp)(?:#xywh|\?)/i.test(text)) cues.push({start,end,text});
      if (cues.length > 40000) throw Error('Больше 40 000 реплик');
    }
    cues.sort((a,b) => a.start - b.start || a.end - b.end);
    if (!cues.length) throw Error('Не найдены текстовые реплики SRT / WebVTT');
    return cues;
  }
  class Timeline {
    constructor(cues) { this.cues = cues; this.maxEnd = []; let end=0; for (const c of cues) this.maxEnd.push(end=Math.max(end,c.end)); }
    active(time) {
      let lo=0, hi=this.cues.length;
      while(lo<hi) { const mid=(lo+hi)>>>1; if(this.cues[mid].start<=time)lo=mid+1;else hi=mid; }
      const result=[];
      for(let i=lo-1;i>=0&&this.maxEnd[i]>time;i--) if(this.cues[i].end>time) result.push(this.cues[i]);
      return result.reverse();
    }
  }
  function tokens(text) {
    return [...text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*(?:-[A-Za-z]+)*/g)].map(m=>({word:m[0],start:m.index,end:m.index+m[0].length}));
  }
  const irregular = {was:'be',were:'be',is:'be',are:'be',am:'be',been:'be',being:'be',has:'have',had:'have',did:'do',done:'do',does:'do',went:'go',gone:'go',said:'say',saw:'see',seen:'see',took:'take',taken:'take',made:'make',got:'get',given:'give',gave:'give',knew:'know',known:'know',thought:'think',bought:'buy',brought:'bring',fought:'fight',felt:'feel',left:'leave',found:'find',told:'tell',stood:'stand',wrote:'write',written:'write',ran:'run',men:'man',women:'woman',children:'child',feet:'foot',teeth:'tooth',better:'good',best:'good',worse:'bad',worst:'bad',"don't":'do',"can't":'cannot',"won't":'will',"i'm":'be',"you're":'be',"it's":'be'};
  function lemmas(word) {
    const w=word.toLowerCase().replace(/’/g,"'"); const out=[w];
    if(irregular[w])out.push(irregular[w]);
    if(w.endsWith("'s"))out.push(w.slice(0,-2));
    if(w.endsWith('ies'))out.push(w.slice(0,-3)+'y');
    for(const suffix of ['ing','ed','es','s'])if(w.length>suffix.length+2&&w.endsWith(suffix)) {
      const stem=w.slice(0,-suffix.length);out.push(stem,stem+'e');
      if(stem.at(-1)===stem.at(-2))out.push(stem.slice(0,-1));
      if(suffix==='ed'&&stem.endsWith('i'))out.push(stem.slice(0,-1)+'y');
    }
    return [...new Set(out)];
  }
  const senses = [
    ['bank',/river|shore|water|stream/i,'берег'],['bank',/money|account|loan|cash|deposit/i,'банк'],
    ['light',/heavy|weight|carry|bag/i,'лёгкий'],['light',/dark|sun|shine|lamp|room/i,'свет'],
    ['right',/turn|left|direction|side/i,'правый; направо'],['right',/you.are|correct|answer|wrong/i,'прав; верно'],
    ['like',/would\s+like|i\s+like|you\s+like|don.t\s+like/i,'нравиться; хотеть'],['like',/looks?\s+like|just\s+like|like\s+(a|an|the)/i,'как; похожий на'],
    ['watch',/time|wrist|clock/i,'часы'],['watch',/watch\s+(out|your)/i,'следить; остерегаться'],
    ['well',/water|deep|bucket/i,'колодец'],['well',/feel|doing|very|quite/i,'хорошо'],
    ['spring',/season|winter|summer|flowers/i,'весна'],['spring',/water|mountain/i,'родник'],
    ['lie',/truth|liar|lying|believe/i,'лгать; ложь'],['lie',/bed|down|floor/i,'лежать'],
    ['leave',/alone|behind|stay|home|here/i,'оставить; уйти'],['mean',/what|does|word|that/i,'значить; иметь в виду'],
    ['fair',/unfair|justice|rules|fight/i,'справедливый'],['cold',/caught|catch|sick/i,'простуда']
  ];
  // Authored learner-friendly defaults for high-frequency words whose dictionary
  // entries otherwise start with an uncommon homograph or omit grammatical use.
  const common={
    the:['определённый артикль','/ðə/'],a:['неопределённый артикль; один','/ə/'],an:['неопределённый артикль','/ən/'],
    be:['быть; являться','/biː/'],is:['есть; является','/ɪz/'],are:['есть; являетесь','/ɑːr/'],am:['есть; являюсь','/æm/'],was:['был; была; было','/wɒz/'],were:['были; был','/wɜːr/'],
    i:['я','/aɪ/'],you:['ты; вы','/juː/'],he:['он','/hiː/'],she:['она','/ʃiː/'],it:['это; он; она','/ɪt/'],we:['мы','/wiː/'],they:['они','/ðeɪ/'],me:['меня; мне','/miː/'],him:['его; ему','/hɪm/'],her:['её; ей','/hɜːr/'],us:['нас; нам','/ʌs/'],them:['их; им','/ðem/'],my:['мой','/maɪ/'],your:['твой; ваш','/jɔːr/'],our:['наш','/aʊər/'],their:['их','/ðeər/'],his:['его','/hɪz/'],
    can:['мочь; уметь; банка','/kæn/'],cannot:['не мочь','/ˈkænɒt/'],could:['мог; мог бы','/kʊd/'],will:['буду; будет; воля','/wɪl/'],would:['бы; хотел бы','/wʊd/'],should:['следует; должен бы','/ʃʊd/'],must:['должен; необходимо','/mʌst/'],may:['мочь; возможно','/meɪ/'],might:['мог бы; возможно','/maɪt/'],
    have:['иметь; вспомогательный глагол','/hæv/'],do:['делать; вспомогательный глагол','/duː/'],go:['идти; уходить; ехать','/ɡəʊ/'],get:['получать; становиться; добираться','/ɡet/'],take:['брать; принимать','/teɪk/'],make:['делать; создавать; заставлять','/meɪk/'],see:['видеть; понимать','/siː/'],know:['знать','/nəʊ/'],think:['думать; считать','/θɪŋk/'],say:['сказать; говорить','/seɪ/'],tell:['рассказывать; говорить кому-либо','/tel/'],come:['приходить; приезжать','/kʌm/'],want:['хотеть','/wɒnt/'],need:['нуждаться; необходимость','/niːd/'],let:['позволять; давай','/let/'],look:['смотреть; выглядеть','/lʊk/'],
    not:['не','/nɒt/'],no:['нет; никакой','/nəʊ/'],yes:['да','/jes/'],and:['и; а','/ænd/'],or:['или','/ɔːr/'],but:['но; кроме','/bʌt/'],if:['если','/ɪf/'],because:['потому что','/bɪˈkɒz/'],so:['так; поэтому','/səʊ/'],than:['чем','/ðæn/'],then:['тогда; затем','/ðen/'],that:['тот; что','/ðæt/'],this:['этот; это','/ðɪs/'],these:['эти','/ðiːz/'],those:['те','/ðəʊz/'],there:['там; в конструкции there is — есть','/ðeər/'],here:['здесь; сюда','/hɪər/'],what:['что; какой','/wɒt/'],who:['кто','/huː/'],why:['почему; зачем','/waɪ/'],how:['как','/haʊ/'],when:['когда','/wen/'],where:['где; куда','/weər/'],which:['который; какой','/wɪtʃ/'],
    to:['к; в; частица инфинитива','/tuː/'],of:['из; родительный падеж','/əv/'],in:['в; внутри','/ɪn/'],on:['на','/ɒn/'],at:['у; в; на','/æt/'],by:['рядом с; посредством; к сроку','/baɪ/'],for:['для; за; в течение','/fɔːr/'],from:['из; от','/frɒm/'],with:['с; вместе с','/wɪð/'],without:['без','/wɪˈðaʊt/'],as:['как; в качестве','/æz/'],all:['все; весь','/ɔːl/'],just:['просто; только что; справедливый','/dʒʌst/'],now:['сейчас','/naʊ/'],still:['всё ещё; неподвижный','/stɪl/'],only:['только; единственный','/ˈəʊnli/']
  };
  function lookup(dictionary, word, context) {
    const forms=lemmas(word);
    const rule=senses.find(([base,re])=>forms.includes(base)&&re.test(context));
    const key=forms.find(w=>Object.hasOwn(common,w)||Object.hasOwn(dictionary,w));
    const entry=key ? dictionary[key] : null, basic=common[key];
    return {wordTranslation:rule?.[2] || basic?.[0] || entry?.t?.slice(0,4).join('; ') || '', ipa:basic?.[1]||entry?.p || '', lemma:key || forms[0], contextual:!!rule, source:rule?'Локальный словарь · правило контекста':basic?'Локальный учебный словарь':'FreeDict · словарные значения',sentenceTranslation:''};
  }
  function isSubtitleResponse(url, type='') {
    return /(?:\.vtt|\.srt)(?:[?#]|$)/i.test(url) || /(?:text\/vtt|application\/x-subrip|text\/srt)/i.test(type);
  }
  function localEndpoint(value) {
    const u=new URL(value);
    if(u.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw Error('Разрешён только HTTP API на localhost / 127.0.0.1 / [::1]');
    return u.href.replace(/\/$/,'');
  }
  const defaults={enabled:true,pauseOnHover:true,fontSize:26,bottom:12,hoverDelay:100,provider:'local',endpoint:'http://127.0.0.1:1234/v1',model:'',offset:0,voice:''};
  const api={MAX_BYTES,uuid,plain,timestamp,parseSubtitles,Timeline,tokens,lemmas,lookup,isSubtitleResponse,localEndpoint,defaults};
  root.AL=api;
  if(typeof module!=='undefined')module.exports=api;
})(globalThis);
