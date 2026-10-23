'use strict';
// Covers are local raster files. Names never become filesystem paths.
function decodeCover(value){
  if(typeof value!=='string'||value.length>8*1024*1024)throw Error('Обложка: выбери PNG, JPEG или WebP до 5 МиБ');
  const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if(!match)throw Error('Обложка: поддерживаются PNG, JPEG и WebP');
  const bytes=Buffer.from(match[2],'base64');
  if(bytes.length>5*1024*1024||bytes.toString('base64')!==match[2])throw Error('Некорректная обложка или размер больше 5 МиБ');
  const type=match[1],valid=type==='png'?bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):type==='jpeg'?bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!valid)throw Error('Содержимое файла не соответствует формату обложки');
  return {bytes,extension:type==='jpeg'?'jpg':type};
}
function folderView(folder){return {id:folder.id,name:folder.name,dirName:folder.dirName||null,created:folder.created,updated:folder.updated,coverURL:folder.coverFile?`lingo-media://cover/${folder.id}?v=${folder.coverFile}`:null};}
module.exports={decodeCover,folderView};
