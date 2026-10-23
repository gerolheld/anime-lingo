'use strict';
const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('lingo',{
  addDropped:(files,currentId,folderId)=>ipcRenderer.invoke('lingo','add-media',{currentId,folderId,files:Array.from(files).map(file=>webUtils.getPathForFile(file)).filter(Boolean)}),
  call:(method,data)=>ipcRenderer.invoke('lingo',method,data),
  subscribe:callback=>{const fn=(_,event)=>callback(event);ipcRenderer.on('lingo-event',fn);return()=>ipcRenderer.removeListener('lingo-event',fn);}
});
