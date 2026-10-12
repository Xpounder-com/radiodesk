import {BiquadFilter,biquadCoefficients} from '../dsp/filters.ts';

/** Streaming low-pass and linear fractional resampling for the 0–3 kHz receive passband. */
export class PcmResampler {
  private inputRate:number;
  readonly outputRate:number;
  private filters:BiquadFilter[];
  private previous=0;
  private index=0;
  private next=0;
  constructor(inputRate:number,outputRate=12000){
    if(!Number.isFinite(inputRate)||inputRate<8000||inputRate>768000||!Number.isFinite(outputRate)||outputRate<8000||outputRate>48000)throw new RangeError('Unsupported receive sample rate.');
    this.inputRate=inputRate;this.outputRate=outputRate;
    const cutoff=Math.min(3600,inputRate*.4,outputRate*.4);
    this.filters=[.5411961,1.3065630].map(q=>new BiquadFilter(biquadCoefficients('lowpass',cutoff,inputRate,q)));
  }
  process(samples:Float32Array):Float32Array{
    const out:number[]=[];const step=this.inputRate/this.outputRate;
    for(let i=0;i<samples.length;i++,this.index++){
      let value=Number.isFinite(samples[i])?samples[i]:0;for(const filter of this.filters)value=filter.process(value);
      if(this.index===0){this.previous=value;}
      while(this.next<=this.index){
        const t=Math.max(0,Math.min(1,this.next-(this.index-1)));
        out.push(this.previous+(value-this.previous)*t);this.next+=step;
      }
      this.previous=value;
    }
    return Float32Array.from(out);
  }
}
