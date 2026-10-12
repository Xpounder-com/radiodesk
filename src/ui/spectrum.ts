import { icon } from './icons.ts';
import type { SignalFrame } from '../audio/engine.ts';
export function spectrumPanel(source: string, running: boolean, large=false):string {
  return `<section class="panel spectrum-panel"><div class="panel-head"><h2>${large?'Audio spectrum & waterfall':'Spectrum & waterfall'}</h2><div class="spectrum-tools"><span class="small muted source-label">Source</span><select id="source-select" aria-label="Signal source"><option value="demo" ${source.includes('Synthetic')?'selected':''}>Synthetic signal</option><option value="microphone" ${source==='Microphone'?'selected':''}>Microphone / USB audio</option><option value="wav" ${source==='WAV playback'?'selected':''}>Imported WAV</option></select><button class="btn ${running?'':'primary'}" data-action="signal-toggle">${icon(running?'pause':'play')}${running?'Pause':'Run'}</button><select id="spectrum-range" aria-label="Spectrum frequency range">${[3000,6000,12000,24000].map(n=>`<option value="${n}" ${range===n?'selected':''}>${n/1000} kHz view</option>`).join('')}</select></div></div><div class="canvas-wrap"><canvas id="spectrum" class="spectrum-canvas" aria-label="FFT spectrum in decibels relative to full scale"></canvas><canvas id="waterfall" class="waterfall-canvas" aria-label="Audio waterfall; newest samples at the top"></canvas><div class="axis" id="spectrum-axis">${[0,500,1000,1500,2000,2500,3000].map(n=>`<span>${n}${n===3000?' Hz':''}</span>`).join('')}</div><div class="signal-stats"><span>PEAK <b id="peak-value">— Hz</b></span><span>NOISE <b id="noise-value">— dBFS</b></span><span>FFT <b>2048 · Hann</b></span><span>SOURCE <b id="source-value">${source}</b></span><span>DROPPED <b id="drop-value">0</b></span></div></div>${large?'<div class="source-description">Receiver audio shows the audio passband. A panoramic RF spectrum requires IQ samples from a supported SDR. Newest samples appear at the top; levels are dBFS, not calibrated S-units.</div>':''}</section>`;
}
const history: SignalFrame[]=[];
let range=3000;
let lastFrame:SignalFrame|null=null;
export function setSpectrumRange(value:number):void { range=value; redrawSpectrum(); }
export function clearSpectrumHistory():void { history.length=0;lastFrame=null; }
export function receiveFrame(frame:SignalFrame):void {lastFrame=frame;history.unshift(frame);if(history.length>180)history.pop();redrawSpectrum();}
function prepare(canvas:HTMLCanvasElement):{ctx:CanvasRenderingContext2D;width:number;height:number}|null {
  const rect=canvas.getBoundingClientRect();if(!rect.width)return null;const ratio=Math.min(devicePixelRatio||1,2);
  if(canvas.width!==Math.round(rect.width*ratio)||canvas.height!==Math.round(rect.height*ratio)){canvas.width=Math.round(rect.width*ratio);canvas.height=Math.round(rect.height*ratio);}
  const ctx=canvas.getContext('2d');if(!ctx)return null;ctx.setTransform(ratio,0,0,ratio,0,0);return {ctx,width:rect.width,height:rect.height};
}
function color(db:number):[number,number,number] {
  const n=Math.max(0,Math.min(1,(db+92)/70));
  const stops=[[5,13,35],[18,27,113],[27,51,191],[21,137,184],[76,219,193],[175,245,127],[254,237,125]];
  const f=n*(stops.length-1),i=Math.min(stops.length-2,Math.floor(f)),t=f-i;
  return stops[i].map((v,j)=>Math.round(v+(stops[i+1][j]-v)*t)) as [number,number,number];
}
export function redrawSpectrum():void {
  const spectrum=document.querySelector<HTMLCanvasElement>('#spectrum'),waterfall=document.querySelector<HTMLCanvasElement>('#waterfall');
  if(!spectrum||!waterfall)return;
  const a=prepare(spectrum);if(!a)return;const {ctx,width:w,height:h}=a;
  const left=36,bottom=8,plotW=w-left,plotH=h-bottom,maxHz=Math.min(range,(lastFrame?.sampleRate??48000)/2);
  ctx.fillStyle='#12191b';ctx.fillRect(0,0,w,h);ctx.font='9px ui-monospace,monospace';ctx.strokeStyle='#273336';ctx.lineWidth=1;
  for(let i=0;i<=5;i++){const y=8+i*(plotH-12)/5;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(w,y);ctx.stroke();ctx.fillStyle='#81969e';ctx.fillText(String(-20-i*20),3,y+3);}
  for(let i=0;i<=6;i++){const x=left+plotW*i/6;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
  
  if(lastFrame){const bins=lastFrame.bins;ctx.beginPath();for(let x=0;x<plotW;x++){const index=Math.round(x/plotW*maxHz*lastFrame.fftSize/lastFrame.sampleRate),db=bins[Math.min(index,bins.length-1)];const y=Math.max(0,Math.min(plotH,8+(-20-db)/100*(plotH-12)));if(x===0)ctx.moveTo(left+x,y);else ctx.lineTo(left+x,y);}ctx.strokeStyle='#abf173';ctx.lineWidth=1.2;ctx.stroke();}
  const b=prepare(waterfall);if(b){const dpr=Math.min(devicePixelRatio||1,2);const pw=waterfall.width,ph=waterfall.height,pxLeft=Math.round(left*dpr);const image=b.ctx.createImageData(pw,ph);for(let y=0;y<ph;y++){const frame=history[Math.floor(y/ph*180)];for(let x=0;x<pw;x++){let c:[number,number,number]=[13,20,25];if(frame&&x>=pxLeft){const idx=Math.floor((x-pxLeft)/(pw-pxLeft)*maxHz*frame.fftSize/frame.sampleRate);c=color(frame.bins[Math.min(idx,frame.bins.length-1)]);}const p=(y*pw+x)*4;image.data[p]=c[0];image.data[p+1]=c[1];image.data[p+2]=c[2];image.data[p+3]=255;}}b.ctx.putImageData(image,0,0);}
  const axis=document.querySelector('#spectrum-axis');if(axis)axis.innerHTML=Array.from({length:7},(_,i)=>`<span>${Math.round(maxHz*i/6)}${i===6?' Hz':''}</span>`).join('');
  if(lastFrame){const peak=document.querySelector('#peak-value'),noise=document.querySelector('#noise-value');if(peak)peak.textContent=`${lastFrame.peakHz.toFixed(0)} Hz`;if(noise)noise.textContent=`${lastFrame.noiseDb.toFixed(1)} dBFS`;}
}
