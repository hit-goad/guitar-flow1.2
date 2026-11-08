import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
const png = PNG.sync.read(readFileSync('tmpimg/sample1.png'));
const w = png.width, h = png.height, data = new Uint8Array(w*h);
for (let i=0,p=0;i<data.length;i++,p+=4) data[i] = (png.data[p]*299 + png.data[p+1]*587 + png.data[p+2]*114)/1000;
let hist=new Uint32Array(256); for (const v of data) hist[v]++;
let total=data.length, sum=0; for(let i=0;i<256;i++) sum+=i*hist[i];
let sumB=0,wB=0,best=0,thr=128;
for(let t=0;t<256;t++){wB+=hist[t]; if(!wB)continue; const wF=total-wB; if(!wF)break; sumB+=t*hist[t]; const mB=sumB/wB, mF=(sum-sumB)/wF; const b=wB*wF*(mB-mF)**2; if(b>best){best=b;thr=t;}}
const bin=new Uint8Array(w*h); for(let i=0;i<data.length;i++) bin[i]= data[i]<thr?1:0;
// rows with long runs
const minRun=Math.max(40, Math.floor(w*0.28)); const rows=[];
for(let y=0;y<h;y++){let run=0,b=0; const base=y*w; for(let x=0;x<w;x++){ if(bin[base+x]){run++; if(run>b)b=run;} else run=0;} if(b>=minRun) rows.push(y);}
const merged=[]; for(const y of rows){const last=merged[merged.length-1]; if(last!==undefined&&y-last<=3)continue; merged.push(y);}
console.log('threshold',thr,'line rows',rows.length,'merged',merged.length);
console.log('first lines', merged.slice(0,14));
console.log('gaps', merged.slice(1,14).map((y,i)=>y-merged[i]));
