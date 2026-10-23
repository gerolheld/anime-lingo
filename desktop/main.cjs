'use strict';
const {app,BrowserWindow,ipcMain,dialog,protocol,shell,Menu,screen,clipboard,nativeTheme}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {Backend,exportSubs,run}=require('./backend.cjs');
const {writeAtomic,safeFileName}=require('./store.cjs');
const {mediaResponse}=require('./media.cjs');
const {stopOrphanedEnhancements}=require('./isolation.cjs');
const paths=require('./paths.cjs');
const i18n=require('./i18n-main.cjs');
const {tr}=i18n;
const tools=require('./tools.cjs');
const {speak}=require('./speech.cjs');
const ROOT=paths.dataRoot();
protocol.registerSchemesAsPrivileged([{scheme:'lingo-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
let win,backend,closing=false;const appURL=pathToFileURL(path.join(__dirname,'ui/index.html')).href;
if(!process.env.ANIME_LINGO_TEST&&!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',async(_,args)=>{if(win){win.show();win.focus();const files=args.filter(a=>path.isAbsolute(a)&&/\.(mp4|mkv|webm|mov|m4v|avi|srt|vtt)$/i.test(a));if(files.length)await backend.addFiles(files);}});
function buildMenu(){Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Anime Lingo',submenu:[{label:tr('Добавить серии и субтитры'),accelerator:'CmdOrCtrl+O',click:()=>emit('open-media')},{label:tr('Улучшение видео'),accelerator:'CmdOrCtrl+E',click:()=>emit('enhance-page')},{label:tr('Настройки'),accelerator:'CmdOrCtrl+,',click:()=>emit('settings')},{type:'separator'},{role:'quit',label:tr('Выйти')}]},{label:tr('Вид'),submenu:[{role:'togglefullscreen',label:tr('Полный экран')},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}]));}
function emit(type,data){if(win&&!win.isDestroyed())win.webContents.send('lingo-event',{type,data});}
function trusted(event){if(event.sender!==win?.webContents||event.senderFrame?.url!==appURL)throw Error('Запрос от неизвестного окна');}
async function action(method,data={}){switch(method){
  case 'window-minimize':win.minimize();return {ok:true};
  case 'window-maximize':if(win.isMaximized())win.unmaximize();else win.maximize();return {maximized:win.isMaximized()};
  case 'window-close':win.close();return {ok:true};
  case 'reveal-episode':shell.showItemInFolder(backend.episode(data.id).filePath);return {ok:true};
  case 'reveal-models':{const dir=backend.db.settings.modelsDirectory||path.join(paths.runtimeRoot(),'models');await fs.mkdir(dir,{recursive:true});const error=await shell.openPath(dir);if(error)throw Error(error);return {ok:true};}
  case 'copy-text':clipboard.writeText(String(data.text||'').slice(0,200000));return {ok:true};
  case 'snapshot':return backend.snapshot();
  case 'save-folder':return backend.saveFolder(data);
  case 'remove-folder':return backend.removeFolder(data.id);
  case 'move-episodes':return backend.moveEpisodes(data.ids,data.folderId??null);
  case 'pick-media':{const r=await dialog.showOpenDialog(win,{title:tr('Добавить серии и субтитры'),properties:['openFile','multiSelections'],filters:[{name:tr('Видео, аудио и субтитры'),extensions:['mp4','mkv','webm','mov','m4v','avi','mp3','m4a','wav','flac','ogg','srt','vtt']},{name:tr('Все файлы'),extensions:['*']}]});return backend.addFiles(r.filePaths,data.currentId,data.folderId);}
  case 'add-media':return backend.addFiles(data.files,data.currentId,data.folderId);
  case 'episode':{const e=backend.episode(data.id);return {...e,filePath:undefined,playbackPath:undefined,subtitleTracks:(e.subtitleTracks||[]).map(t=>({...t,file:undefined})),mediaURL:`lingo-media://local/${e.id}`,playable:!!e.filePath};}
  case 'playback':return backend.playback(data.id,data.audioIndex);
  case 'prepare':return backend.prepare(data.id,data);
  case 'cancel':backend.cancel(data.id);return {ok:true};
  case 'remove':return backend.remove(data.id);
  case 'position':return backend.position(data.id,data.seconds);
  case 'install-component':return backend.installComponent(data.name,data.options||{});
  case 'pause-component':return backend.pauseComponent(data.name);
  case 'remove-component':return backend.removeComponent(data.name,data.options||{});
  case 'video-gpu-status':return backend.videoGpuStatus();
  case 'probe-video-encoder':return backend.probeVideoEncoder(data.id);
  case 'error-report':return backend.errorReport(String(data.message||'').slice(0,4000));
  case 'pick-library-root':{const r=await dialog.showOpenDialog(win,{title:tr('Папка с аниме'),properties:['openDirectory','createDirectory']});if(r.canceled)return null;await backend.configure({libraryRoot:r.filePaths[0]});backend.scanLibrary().catch(()=>{});return r.filePaths[0];}
  case 'scan-library':return backend.scanLibrary({restore:!!data.restore});
  case 'reveal-library':{const root=backend.db.settings.libraryRoot;if(!root)throw Error('Папка библиотеки не выбрана');const error=await shell.openPath(root);if(error)throw Error(error);return {ok:true};}
  case 'components-status':return backend.componentsStatus();
  case 'recognition-plan':return backend.recognitionPlan(data.id,data.audioIndex);
  case 'pick-models-directory':{const r=await dialog.showOpenDialog(win,{title:tr('Папка для моделей'),properties:['openDirectory','createDirectory']});if(r.canceled)return null;await backend.configure({modelsDirectory:r.filePaths[0]});return r.filePaths[0];}
  case 'position-hint':backend.hintPosition(data.id,data.seconds);return {ok:true};
  case 'settings':{const before=backend.db.settings.uiLanguage,result=await backend.configure(data);if(result.uiLanguage!==before){i18n.setLanguage(result.uiLanguage,app.getLocale());buildMenu();}return result;}
  case 'diagnostics':return backend.diagnostics();
  case 'load-model':return backend.ensureModel();
  case 'release-models':await backend.models.release();return {ok:true};
  case 'translate':return backend.translate(data.text,data.context||'');
  case 'lookup':return backend.lookup(String(data.word||'').slice(0,150),String(data.context||'').slice(0,12000));
  case 'word-meaning':return backend.wordMeaning(String(data.word||'').slice(0,150),String(data.context||'').slice(0,12000));
  case 'save-word':return backend.saveWord(data);
  case 'update-word':return backend.updateWord(data.id,data.action,data.value);
  case 'clear-history':backend.db.history=[];for(const episode of backend.db.episodes)delete episode.lastWatched;await backend.save();backend.notify();return {ok:true};
  case 'speak':return speak(data.text);
  case 'import-subs':{const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:tr('Субтитры'),extensions:['srt','vtt']}]});if(r.canceled)return;return backend.attachSubtitles(data.id,await backend.readSubtitleFile(r.filePaths[0]),data.language||'auto');}
  case 'select-subs':return backend.selectSubtitles(data.id,data.trackId,data.language||'en');
  case 'export-subs':{const e=backend.episode(data.id),format=data.format==='srt'?'srt':'vtt';const r=await dialog.showSaveDialog(win,{defaultPath:safeFileName(e.title)+'.'+format,filters:[{name:format.toUpperCase(),extensions:[format]}]});if(!r.canceled)await writeAtomic(r.filePath,exportSubs(data.live?(backend.live.get(e.id)?.cues||e.liveCues||[]):e.cues,{format,language:data.language||'both'}),{mode:0o644,backup:false});return {ok:!r.canceled};}
  case 'export-words':{const r=await dialog.showSaveDialog(win,{defaultPath:'anime-lingo-words.json'});if(!r.canceled)await writeAtomic(r.filePath,JSON.stringify(backend.db.words,null,2),{mode:0o644,backup:false});return {ok:!r.canceled};}
  case 'live-start':return backend.startLive(data.id);
  case 'local-chunk':return backend.localChunk(data.id,data.start,data.version);
  case 'live-stop':backend.stopLive(data.id);return {ok:true};
  case 'live-reset':backend.resetLive(data.id,data.version);return {ok:true};
  case 'enhance':return backend.enhance(data.ids,data);
  case 'cancel-enhancements':return backend.cancelEnhancements();
  case 'use-enhanced':return {id:(await backend.useEnhanced(data.id)).id};
  case 'reveal-enhanced':{const j=backend.enhancement(data.id);if(j.state!=='ready')throw Error('Задача ещё не готова');shell.showItemInFolder(j.outputFile);return {ok:true};}
  case 'pick-output':{const r=await dialog.showOpenDialog(win,{title:tr('Куда сохранять улучшенные серии'),properties:['openDirectory','createDirectory']});if(!r.canceled)await backend.configure({outputDirectory:r.filePaths[0]});return r.filePaths[0]||null;}
  default:throw Error('Неизвестная команда');
}}
app.whenReady().then(async()=>{
  await tools.resolve();backend=await new Backend(ROOT,{manageModels:process.env.ANIME_LINGO_MOCK_MODELS!=='1'}).init();i18n.setLanguage(backend.db.settings.uiLanguage,app.getLocale());backend.scanLibrary().catch(()=>{});
  try{await stopOrphanedEnhancements();await backend.cleanupEnhancementWorkspaces();}catch(error){backend.enhanceRecoveryError=error.message;backend.lastError='Защита улучшения: '+error.message;}
  await backend.models.release();
  protocol.handle('lingo-media',async request=>{try{const u=new URL(request.url);let file;if(u.hostname==='local'){const e=backend.episode(u.pathname.slice(1));file=e.playbackPath||e.filePath;}else if(u.hostname==='cover'){file=backend.coverPath(u.pathname.slice(1));}else if(u.hostname==='enhancement'){const [id,kind]=u.pathname.slice(1).split('/'),j=backend.enhancement(id);if(j.state!=='ready')return new Response('',{status:404});file=kind==='before.jpg'?j.beforeImage:kind==='after.jpg'?j.afterImage:kind==='video'?j.outputFile:null;}if(!file)return new Response('',{status:404});return await mediaResponse(file,request);}catch{return new Response('',{status:404});}});
  // Native dialogs and menus follow the OS theme; the app's own interface keeps the 2.4 dark design in both themes.
  nativeTheme.themeSource='system';
  // workAreaSize is in DIP, so 125-150 % Windows scaling is already accounted for.
  const work=screen.getPrimaryDisplay().workAreaSize;
  win=new BrowserWindow({width:Math.min(1672,work.width),height:Math.min(941,work.height),minWidth:Math.min(900,work.width),minHeight:Math.min(640,work.height),frame:false,show:false,title:'Anime Lingo',backgroundColor:'#090e18',icon:path.join(__dirname,'assets/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  buildMenu();win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(event,url)=>{if(url!==appURL)event.preventDefault();});win.webContents.session.setPermissionRequestHandler((contents,permission,callback)=>callback(contents===win.webContents&&permission==='fullscreen'));
  ipcMain.handle('lingo',async(event,method,data)=>{try{trusted(event);return {value:await action(method,data)};}catch(e){return {error:e.message};}});
  backend.on('change',data=>emit('state',data));backend.on('live-cue',data=>emit('live-cue',data));backend.on('live-error',data=>emit('live-error',data));
  await win.loadFile(path.join(__dirname,'ui/index.html'));win.show();if(process.env.ANIME_LINGO_TEST)global.__lingoTest={backend,action};
  else{const files=process.argv.slice(app.isPackaged?1:2).filter(a=>path.isAbsolute(a)&&/\.(mp4|mkv|webm|mov|m4v|avi|srt|vtt)$/i.test(a));if(files.length)await backend.addFiles(files);}
}).catch(e=>{console.error(e);dialog.showErrorBox('Anime Lingo',e.message);app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(closing||!backend)return;event.preventDefault();closing=true;setTimeout(()=>app.exit(0),30000).unref();backend.close().catch(console.error).finally(()=>app.quit());});
