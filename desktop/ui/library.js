'use strict';
function seriesCount(n){return LingoUI.counted(n,'серия','серии','серий');}
function folderCount(n){return LingoUI.counted(n,'папка','папки','папок');}
function openLibraryFolder(id){
  S.libraryFolder=id;S.selectedLibrary.clear();$('library-search').value='';page('library');window.scrollTo({top:0});
}
function coverSource(episode){const folder=S.folders.find(f=>f.id===episode?.folderId);return folder?.coverURL||null;}
function folderArtwork(folder,cls=''){
  const image=folder.coverURL?el('img',cls):episodeImage(S.episodes.find(e=>e.folderId===folder.id)||{title:folder.name},cls);
  if(image){if(folder.coverURL){image.src=folder.coverURL;image.alt='Обложка '+folder.name;}image.loading='lazy';image.onerror=()=>image.replaceWith(folderPlaceholder(folder.name));return image;}
  return folderPlaceholder(folder.name);
}
function folderPlaceholder(name){const node=el('div','folder-placeholder');node.append(icon('folder'),el('span','',String(name||LingoI18n.translate('Аниме')).slice(0,1).toLocaleUpperCase()));return node;}
// The folder on disk: every sub-folder is an anime, every video inside it an episode.
function renderLibraryRoot(){
  const box=$('library-root');if(!box)return;
  const root=S.settings.libraryRoot,scan=S.libraryScan||{},hidden=S.ignoredCount||0;
  const pick=el('button','secondary compact',root?'Сменить…':'Выбрать папку…');pick.type='button';pick.onclick=task(async()=>{const dir=await call('pick-library-root');if(dir)toast('Папка с аниме выбрана. Ищу серии…');});
  const text=el('div','library-root-text');
  if(!root){
    text.append(el('strong','','Папка с аниме не выбрана'),el('small','','Выберите папку на диске: каждая подпапка станет аниме, а каждое видео внутри — серией. «+ Папка» будет создавать подпапки там же. Видео остаются на своих местах и никогда не удаляются.'));
    box.replaceChildren(text,pick);return;
  }
  const status=scan.running?'Проверяю новые серии…':scan.errors?.length?`Проверка завершена, ошибок: ${scan.errors.length}`:scan.added?`Добавлено серий: ${scan.added}`:'Новых серий нет';
  text.append(el('strong','','Папка с аниме'),el('small','library-root-path',root),el('small','library-root-status',status));
  if(scan.errors?.length)text.lastChild.title=scan.errors.join('\n');
  const refresh=el('button','secondary compact','Обновить');refresh.type='button';refresh.disabled=!!scan.running;refresh.onclick=task(async()=>{await call('scan-library',{});});
  const open=el('button','secondary compact','Открыть');open.type='button';open.onclick=task(()=>call('reveal-library'));
  const actions=el('div','library-root-actions');actions.append(refresh,open,pick);
  if(hidden){const back=el('button','link',`Вернуть скрытые (${hidden})`);back.type='button';back.onclick=task(async()=>{if(!confirm('Вернуть в библиотеку серии и папки, которые вы убрали из неё? Файлы на диске не менялись.'))return;await call('scan-library',{restore:true});});actions.append(back);}
  box.replaceChildren(text,actions);
}
let lastLibraryScan=0;
// Opening the library looks for new files, at most every 15 seconds.
function scanLibraryIfDue(){if(!S.settings.libraryRoot||Date.now()-lastLibraryScan<15000)return;lastLibraryScan=Date.now();call('scan-library',{}).catch(()=>{});}
function renderLibrary(){
  renderLibraryRoot();
  if(S.libraryFolder&&!S.folders.some(f=>f.id===S.libraryFolder)){S.libraryFolder=null;S.selectedLibrary.clear();}
  const folder=S.folders.find(f=>f.id===S.libraryFolder),query=$('library-search').value.trim(),grid=$('library-grid'),folders=$('folder-grid'),hero=$('folder-hero'),crumb=$('library-breadcrumb');
  for(const id of S.selectedLibrary)if(!S.episodes.some(e=>e.id===id))S.selectedLibrary.delete(id);
  grid.replaceChildren();folders.replaceChildren();hero.replaceChildren();crumb.replaceChildren();
  $('library-title').textContent=folder?folder.name:'Твои аниме';$('library-description').textContent=folder?'Все серии этой истории — в одном месте.':'У каждой истории — своя папка. Серии, субтитры и прогресс вместе.';
  $('edit-folder').hidden=!folder;hero.hidden=!folder;$('new-folder').hidden=!!folder;
  if(folder){crumb.append(button('Библиотека','link',()=>openLibraryFolder(null)),icon('arrow'),el('span','',folder.name));const image=el('div','folder-hero-art');image.append(folderArtwork(folder));const copy=el('div','folder-hero-copy'),members=S.episodes.filter(e=>e.folderId===folder.id),stats=LingoUI.folderStats(members);copy.append(el('span','eyebrow','ТВОЯ ИСТОРИЯ'),el('h3','',folder.name),el('p','',`${seriesCount(stats.count)} · EN + RU готовы: ${stats.ready}`));const progress=el('div','episode-progress');progress.append(meter(stats.percent),el('span','',stats.percent+'% просмотрено'));copy.append(progress);hero.append(image,copy);if(members.length){const recent=[...members].sort((a,b)=>(b.lastWatched||0)-(a.lastWatched||0))[0],first=LingoUI.libraryItems(S.episodes,S.folders,{folderId:folder.id})[0],episode=recent.lastWatched?recent:first;hero.append(actionButton(episode.position>0?'Продолжить просмотр':'Смотреть первую серию','play','primary',()=>selectEpisode(episode.id)));}}
  else if(!query){for(const f of [...S.folders].sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true})))renderFolderCard(f,folders);}
  if(!folder&&query){for(const f of S.folders.filter(f=>f.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())))renderFolderCard(f,folders);}
  const episodes=LingoUI.libraryItems(S.episodes,S.folders,{folderId:S.libraryFolder,query});S.visibleLibrary=episodes;
  $('library-summary').textContent=folder?seriesCount(episodes.length):`${folderCount(S.folders.length)} · ${seriesCount(S.episodes.length)}`;
  $('library-episodes-label').textContent=query?'Найденные серии':folder?'Серии по порядку':'Серии без папки';$('library-select-label').hidden=!episodes.length;
  document.querySelector('.library-section-heading').hidden=!episodes.length&&!folder;
  for(const e of episodes)renderEpisodeCard(e,grid,!!query&&!folder);
  if(!episodes.length&&(folder||query||!S.folders.length)){
    empty(grid,query?'Ничего не найдено':folder?'Здесь будут серии':'Начни с папки для аниме',query?'Попробуй другое название.':folder?'Добавь видео через «Серии и субтитры» или перенеси серии из библиотеки.':'Нажми «+ Папка», укажи название и выбери обложку. Видео можно добавить в любой момент.','folder');
    if(!query){const box=grid.lastElementChild;box.append(actionButton(folder?'Добавить серии':'Создать папку','plus','primary',()=>folder?openMedia():openFolderEditor()));}
  }
  updateLibrarySelection();
}
function renderFolderCard(folder,container){
  const episodes=S.episodes.filter(e=>e.folderId===folder.id),stats=LingoUI.folderStats(episodes),card=el('article','folder-card');card.dataset.folderId=folder.id;
  const open=button('','folder-open',()=>openLibraryFolder(folder.id)),art=el('div','folder-art');art.append(folderArtwork(folder),el('span','folder-count',seriesCount(stats.count)));const copy=el('div','folder-card-copy');copy.append(el('h3','',folder.name),el('p','',stats.ready?`EN + RU готовы: ${stats.ready}`:episodes.length?'Добавлены видео':'Добавь первую серию'));if(episodes.some(e=>e.position>0)){copy.append(meter(stats.percent),el('small','',stats.percent+'% просмотрено'));}open.append(art,copy);card.append(open,iconButton('Действия с папкой '+folder.name,'more','folder-menu',event=>folderMenu(folder,event)));container.append(card);
}
function renderEpisodeCard(e,container,showFolder){
  const selected=S.selectedLibrary.has(e.id),card=el('article','episode-card'+(selected?' library-selected':''));card.dataset.episodeId=e.id;
  const art=button('','episode-art',()=>selectEpisode(e.id));art.setAttribute('aria-label','Смотреть '+e.title);const image=episodeImage(e,'library-cover');if(image)art.append(image);else art.append(folderPlaceholder(LingoUI.seriesName(e.title)));const play=el('span','art-play');play.append(icon('play'));art.append(play,el('span','duration-tag',time(e.duration)));
  const select=el('label','episode-select'),check=el('input');check.type='checkbox';check.checked=selected;check.setAttribute('aria-label','Выбрать '+e.title);check.onchange=()=>{if(check.checked)S.selectedLibrary.add(e.id);else S.selectedLibrary.delete(e.id);card.classList.toggle('library-selected',check.checked);updateLibrarySelection();};select.append(check);
  const body=el('div','card-body');body.append(el('h3','',e.title),iconButton('Действия с серией','more','card-menu',event=>episodeMenu(e,event)));
  if(showFolder&&e.folderId){const folder=S.folders.find(f=>f.id===e.folderId);if(folder)body.append(button(folder.name,'episode-folder-link link',()=>openLibraryFolder(folder.id)));}
  const meta=el('div','card-meta');meta.append(el('span','',`${time(e.duration)} · ${e.width||0}×${e.height||0}`));body.append(meta);
  const percent=Math.min(100,Math.max(0,100*(e.position||0)/Math.max(1,e.duration))),progress=el('div','episode-progress');progress.append(meter(percent),el('span','',Math.round(percent)+'%'));body.append(progress);
  const status=el('div','episode-status-row');status.append(el('span','subtitle-status '+(e.state==='ready'?'ready':''),e.state==='ready'?'EN + RU готовы':stages[e.state]||'Субтитры не подготовлены'));if(e.position>0)status.append(el('small','',time(e.position)+' просмотрено'));body.append(status);
  const actions=el('div','card-actions');actions.append(actionButton(e.position>0?'Продолжить':'Смотреть','play','primary',()=>selectEpisode(e.id)));body.append(actions);if(e.error)body.append(el('small','capture-error',e.error));card.append(art,select,body);container.append(card);
}
function updateLibrarySelection(){
  const count=S.selectedLibrary.size,visible=S.visibleLibrary||[];$('library-bulk').hidden=!count;$('library-selection-count').textContent='Выбрано серий: '+count;
  $('library-select-all').checked=!!visible.length&&visible.every(e=>S.selectedLibrary.has(e.id));$('library-select-all').indeterminate=visible.some(e=>S.selectedLibrary.has(e.id))&&!$('library-select-all').checked;
}
function folderMenu(folder,event){contextMenu([{label:'Открыть папку',icon:'folder',action:()=>openLibraryFolder(folder.id)},{label:'Название и обложка',icon:'edit',action:()=>openFolderEditor(folder)},{label:'Добавить серии',icon:'plus',action:async()=>{openLibraryFolder(folder.id);await openMedia();}},{label:'Удалить папку',icon:'trash',action:()=>confirmFolderDelete(folder)}],event);}
function openFolderEditor(folder=null,ids=[...S.selectedLibrary]){
  S.editFolder=folder;S.folderAssignIds=folder?[]:ids.filter(id=>S.episodes.some(e=>e.id===id));S.folderCoverDraft=undefined;S.coverReadToken=(S.coverReadToken||0)+1;$('folder-save').disabled=false;
  $('folder-name').value=folder?.name||(S.folderAssignIds.length?LingoUI.seriesName(S.episodes.find(e=>e.id===S.folderAssignIds[0]).title):'');$('folder-cover-file').value='';$('folder-error').textContent='';
  $('folder-dialog-title').textContent=folder?'Название и обложка':'Новая папка';$('folder-save').textContent=folder?'Сохранить':'Создать папку';$('folder-disk-hint').textContent=!folder&&S.settings.libraryRoot?'На диске будет создана подпапка с этим названием в папке с аниме.':'';$('folder-assign-hint').textContent=S.folderAssignIds.length?`В папку будут перенесены выбранные серии: ${S.folderAssignIds.length}.`:'';paintFolderDraft();$('folder-dialog').showModal();$('folder-name').focus();
}
function paintFolderDraft(){const preview=$('folder-cover-preview');preview.replaceChildren();const source=S.folderCoverDraft===undefined?S.editFolder?.coverURL:S.folderCoverDraft;if(source){const img=el('img');img.src=source;img.alt='Обложка папки';preview.append(img);}else preview.append(folderPlaceholder($('folder-name').value));$('folder-cover-clear').hidden=!source;}
function openMoveDialog(ids){
  S.moveIds=ids.filter(id=>S.episodes.some(e=>e.id===id));if(!S.moveIds.length)return;
  const select=$('move-target');select.replaceChildren(new Option('Без папки',''));for(const f of [...S.folders].sort((a,b)=>a.name.localeCompare(b.name)))select.append(new Option(f.name,f.id));
  const current=S.episodes.find(e=>e.id===S.moveIds[0])?.folderId;select.value=S.folders.find(f=>f.id!==current)?.id||'';$('move-description').textContent='Выбрано серий: '+S.moveIds.length;$('move-error').textContent='';$('move-dialog').showModal();
}
function confirmFolderDelete(folder){S.deleteFolderId=folder.id;$('delete-folder-description').textContent=folder.name;$('delete-folder-dialog').showModal();}
function initLibrary(){
  $('new-folder').onclick=()=>openFolderEditor();$('edit-folder').onclick=()=>openFolderEditor(S.folders.find(f=>f.id===S.libraryFolder));$('library-search').oninput=()=>{S.selectedLibrary.clear();renderLibrary();};
  $('library-select-all').onchange=()=>{for(const e of S.visibleLibrary||[]){if($('library-select-all').checked)S.selectedLibrary.add(e.id);else S.selectedLibrary.delete(e.id);}renderLibrary();};
  $('library-move').onclick=()=>openMoveDialog([...S.selectedLibrary]);$('library-selection-clear').onclick=()=>{S.selectedLibrary.clear();renderLibrary();};
  for(const id of ['folder-dialog-close','folder-cancel'])$(id).onclick=()=>$('folder-dialog').close();$('move-cancel').onclick=()=>$('move-dialog').close();$('delete-folder-cancel').onclick=()=>$('delete-folder-dialog').close();
  $('folder-cover-pick').onclick=()=>$('folder-cover-file').click();$('folder-cover-clear').onclick=()=>{S.coverReadToken++;$('folder-save').disabled=false;S.folderCoverDraft=null;$('folder-cover-file').value='';paintFolderDraft();};$('folder-name').oninput=()=>{if(!S.folderCoverDraft&&!S.editFolder?.coverURL)paintFolderDraft();};
  $('folder-cover-file').onchange=async()=>{
    const file=$('folder-cover-file').files[0],token=++S.coverReadToken;$('folder-error').textContent='';if(!file)return;$('folder-save').disabled=true;
    try{if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024)throw Error('Выбери PNG, JPEG или WebP до 5 МиБ');const source=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Не удалось прочитать обложку'));reader.readAsDataURL(file);});const image=new Image();image.src=source;await image.decode();if(token!==S.coverReadToken)return;S.folderCoverDraft=source;paintFolderDraft();}catch(error){if(token===S.coverReadToken)$('folder-error').textContent=error.message;}finally{if(token===S.coverReadToken)$('folder-save').disabled=false;}
  };
  $('folder-form').onsubmit=async event=>{event.preventDefault();$('folder-save').disabled=true;$('folder-error').textContent='';try{const data={id:S.editFolder?.id,name:$('folder-name').value};if(S.folderCoverDraft!==undefined)data.cover=S.folderCoverDraft;const folder=await call('save-folder',data);if(S.folderAssignIds.length)await call('move-episodes',{ids:S.folderAssignIds,folderId:folder.id});$('folder-dialog').close();await refresh();openLibraryFolder(folder.id);toast(S.editFolder?'Папка обновлена.':'Папка создана.');}catch(error){$('folder-error').textContent=error.message;}finally{$('folder-save').disabled=false;}};
  $('move-form').onsubmit=async event=>{event.preventDefault();$('move-submit').disabled=true;try{await call('move-episodes',{ids:S.moveIds,folderId:$('move-target').value||null});$('move-dialog').close();S.selectedLibrary.clear();await refresh();toast('Серии перемещены.');}catch(error){$('move-error').textContent=error.message;}finally{$('move-submit').disabled=false;}};
  $('move-new-folder').onclick=()=>{$('move-dialog').close();openFolderEditor(null,S.moveIds);};
  $('delete-folder-confirm').onclick=task(async()=>{await call('remove-folder',{id:S.deleteFolderId});$('delete-folder-dialog').close();await refresh();toast('Папка удалена. Серии сохранены.');});
  for(const dialog of document.querySelectorAll('.library-dialog'))dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
}
