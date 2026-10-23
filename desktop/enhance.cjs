'use strict';
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
class PNGFrames {
  constructor(){this.buffer=Buffer.alloc(0);this.offset=8;}
  push(chunk){this.buffer=Buffer.concat([this.buffer,chunk]);}
  next(){if(this.buffer.length<8)return null;if(!this.buffer.subarray(0,8).equals(PNG_SIGNATURE))throw Error('Декодер вернул неверный PNG');while(this.buffer.length>=this.offset+12){const size=this.buffer.readUInt32BE(this.offset);if(size>128*1024*1024)throw Error('Слишком большой кадр');if(this.buffer.length<this.offset+12+size)return null;const type=this.buffer.toString('ascii',this.offset+4,this.offset+8);this.offset+=12+size;if(type==='IEND'){const image=this.buffer.subarray(0,this.offset);this.buffer=this.buffer.subarray(this.offset);this.offset=8;return image;}}return null;}
}
function rate(value){const m=String(value).match(/^(\d+)(?:\/(\d+))?$/);if(!m||!+m[1]||m[2]==='0')return {fps:24,text:'24/1'};const fps=+m[1]/+(m[2]||1);if(fps<1||fps>120)throw Error('Поддерживается частота кадров от 1 до 120 FPS');return {fps,text:`${m[1]}/${m[2]||1}`};}
class FrameProgress {
  constructor(total,now=()=>Date.now()){this.total=total;this.now=now;this.points=[{done:0,time:now()}];}
  update(done){
    const time=this.now();this.points.push({done,time});
    while(this.points.length>2&&this.points[1].time<time-10000)this.points.shift();
    const first=this.points[0],elapsed=(time-first.time)/1000;
    const fps=elapsed>0?(done-first.done)/elapsed:0;
    return {done,total:this.total,progress:Math.min(99,100*done/Math.max(1,this.total)),fps,eta:done>=8&&elapsed>=2&&fps>0?Math.max(0,(this.total-done)/fps):null};
  }
}
async function enhanceVideo(options){
  if(options.engine&&options.engine!=='cpu')throw Error('GPU-улучшение отключено после зависаний Intel Xe. Выбери безопасный режим (процессор).');
  return require('./enhance-cpu.cjs').enhanceCPU(options);
}

module.exports={PNGFrames,FrameProgress,rate,enhanceVideo};
