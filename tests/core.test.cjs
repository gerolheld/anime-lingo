const {test}=require('node:test');
const assert=require('node:assert/strict');
const AL=require('../extension/core.js');
test('UUID generation works in insecure page contexts without crypto.randomUUID',()=>{
  const vm=require('node:vm'),fs=require('node:fs');
  const sandbox={crypto:{getRandomValues:globalThis.crypto.getRandomValues.bind(globalThis.crypto)},TextEncoder,URL};
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/core.js'),'utf8'),sandbox);
  const values=Array.from({length:20},()=>sandbox.AL.uuid());
  assert.equal(new Set(values).size,20);
  assert.ok(values.every(v=>/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(v)));
});
test('SRT: BOM, CRLF, numbers, multiline, malformed and inverted cues',()=>{
  const cues=AL.parseSubtitles('\ufeff1\r\n00:00:01,200 --> 00:00:03,000\r\nHello,\r\nworld!\r\n\r\n2\r\n00:00:04,000 --> 00:00:02,000\r\nBad\r\n\r\n3\r\n00:00:05,000 --> 00:00:06,000\r\nAgain.');
  assert.deepEqual(cues,[{start:1.2,end:3,text:'Hello,\nworld!'},{start:5,end:6,text:'Again.'}]);
});
test('VTT: header, metadata, voice/ruby tags, NOTE, STYLE, settings, entities',()=>{
  const cues=AL.parseSubtitles('WEBVTT\nKind: captions\n\nSTYLE\n::cue { color: red }\n\nNOTE ignore\n00:00:00.000 --> 00:00:09.000\nnot a cue\n\nintro\n00:01.000 --> 00:02.500 line:90%\n<v Alice><i>Hello</i> &amp; &#x1F642;</v>\n\n00:03.000 --> 00:04.000\n<b>Good</b><br>day');
  assert.equal(cues.length,2);assert.equal(cues[0].text,'Hello & 🙂');assert.equal(cues[1].text,'Good\nday');
});
test('timeline: overlapping cues, half-open boundaries, seeking backwards and gaps',()=>{
  const t=new AL.Timeline([{start:0,end:100,text:'long'},{start:1,end:2,text:'short'},{start:3,end:4,text:'three'}]);
  assert.deepEqual(t.active(3.5).map(c=>c.text),['long','three']);assert.deepEqual(t.active(2).map(c=>c.text),['long']);assert.equal(t.active(100).length,0);assert.equal(t.active(1).length,2);assert.equal(t.active(-1).length,0);
});
test('tokens preserve contractions, hyphens, Unicode apostrophe and repeated-word offsets',()=>{
  const text="Don't let go, don't! You're well-known.";const tokens=AL.tokens(text);
  assert.deepEqual(tokens.map(t=>t.word),["Don't",'let','go',"don't","You're",'well-known']);
  for(const t of tokens)assert.equal(text.slice(t.start,t.end),t.word);
});
test('morphology and contextual dictionary disambiguate the same word',()=>{
  const d={bank:{t:['банк','берег'],p:'/bæŋk/'},fight:{t:['сражаться']}};
  assert.equal(AL.lookup(d,'bank','We sat by the river bank.').wordTranslation,'берег');
  assert.equal(AL.lookup(d,'bank','Deposit money at the bank.').wordTranslation,'банк');
  assert.equal(AL.lookup(d,'fought','They fought.').lemma,'fight');assert.ok(AL.lemmas('running').includes('run'));
});
test('reject invalid or oversized subtitles and thumbnail VTT',()=>{
  for(const raw of ['', 'WEBVTT\n\n00:00.000 --> 00:01.000\nthumb.jpg#xywh=0,0,1,1','x'.repeat(AL.MAX_BYTES+1)])assert.throws(()=>AL.parseSubtitles(raw));
  assert.ok(Number.isNaN(AL.timestamp('00:70:01.000')));
});
test('only loopback HTTP translator endpoints, no credential or redirect destinations',()=>{
  for(const url of ['http://127.0.0.1:1234/v1','http://localhost:5000','http://[::1]:1234/v1'])assert.ok(AL.localEndpoint(url));
  for(const url of ['https://example.com','http://127.0.0.1.evil.test','http://user:secret@localhost:1234','file:///etc/passwd','http://localhost:1234/?token=1'])assert.throws(()=>AL.localEndpoint(url));
});
test('subtitle detection distinguishes scripts from VTT MIME and extension paths',()=>{
  assert.equal(AL.isSubtitleResponse('https://test/captions?id=1','text/vtt; charset=utf-8'),true);
  assert.equal(AL.isSubtitleResponse('https://test/en.srt?token=a'),true);
  assert.equal(AL.isSubtitleResponse('https://test/polyfills.webvtt.js'),false);
});
