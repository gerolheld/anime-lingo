'use strict';
// Language for the parts the page cannot translate: the application menu and native dialogs.
const I=require('./ui/i18n.js');
const translator=I.createTranslator(require('./ui/i18n-en.js'));
let language='ru';
const setLanguage=(setting,locale='')=>{language=I.resolveLanguage(setting,locale);return language;};
const tr=text=>language==='en'?translator.translate(text):text;
module.exports={setLanguage,tr,get language(){return language;}};
