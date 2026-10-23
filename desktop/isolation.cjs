'use strict';
const paths=require('./paths.cjs');
// One place chooses the resource-protection implementation. Linux keeps systemd + bubblewrap;
// everything else gets the watchdog and says so plainly.
function pick(platform=process.platform){
  if(platform==='linux'){
    const impl=require('./enhance-limits.cjs');
    return {...impl,mode:'systemd-bwrap',full:true,label:'Изоляция systemd и bubblewrap: лимиты памяти и процессов, без сети и доступа к чужим файлам. Обязательна. При нехватке ресурсов или отсутствии прогресса очередь останавливается без автоматического повтора.'};
  }
  const impl=require('./enhance-limits-win.cjs');
  return {...impl,mode:'watchdog',full:false,label:'Упрощённая защита, не изоляция: пониженный приоритет, наблюдение за памятью и диском каждые 2 секунды, остановка при зависании. Файлы и сеть не изолируются. При нехватке ресурсов очередь останавливается без автоматического повтора.'};
}
// GPU modes need /dev/dri and the display driver, which the bubblewrap sandbox hides, so they always use the watchdog.
const watchdog=()=>require('./enhance-limits-win.cjs');
module.exports={pick,...pick(),watchdog,isWindows:paths.isWindows};
