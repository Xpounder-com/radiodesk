export interface AudioSink {context:AudioContext;source:AudioBufferSourceNode;gain:GainNode;}
export type RoutableAudioContext=AudioContext&{setSinkId?:(id:string)=>Promise<void>};
export interface TransmitAudioOutputOptions {createContext?:()=>RoutableAudioContext;}
/** A dedicated, explicitly chosen transmit audio route; nothing plays during preparation. */
export class TransmitAudioOutput {
  private active:AudioSink|null=null;
  private preparing=new Set<RoutableAudioContext>();
  private generation=0;
  private sinkId='';
  private silentPrepared=false;
  private started=false;
  private createContext:(()=>RoutableAudioContext)|undefined;
  constructor(options:TransmitAudioOutputOptions={}){this.createContext=options.createContext;}
  async prepare(samples:Float32Array,sampleRate:number,outputId:string,confirmDefault=false,silent=false):Promise<void>{
    this.stop();
    if(!samples.length||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>192000)throw new Error('Invalid transmit PCM.');
    if(samples.length/sampleRate>30)throw new Error('Transmit audio exceeds the 30-second software limit.');
    for(const sample of samples)if(!Number.isFinite(sample)||Math.abs(sample)>1)throw new Error('Transmit PCM samples must be finite and within full scale.');
    if(silent){this.silentPrepared=true;this.sinkId='Simulator · no physical audio';return;}
    if(!this.createContext&&typeof AudioContext==='undefined')throw new Error('Web Audio output is unavailable.');
    if((!outputId||outputId==='default')&&!confirmDefault)throw new Error('Select the radio audio output or explicitly confirm its system-default routing.');
    const generation=this.generation;
    const context=this.createContext?this.createContext():new AudioContext({latencyHint:'interactive'}) as RoutableAudioContext;
    this.preparing.add(context);
    try{
      if(outputId&&outputId!=='default'){if(!context.setSinkId)throw new Error('This browser cannot route Web Audio to a selected output. Use a supporting browser or explicitly configured system-default radio output.');await context.setSinkId(outputId);}
      if(generation!==this.generation)throw new Error('Transmit audio preparation canceled.');
      await context.resume();if(generation!==this.generation)throw new Error('Transmit audio preparation canceled.');
      const buffer=context.createBuffer(1,samples.length,sampleRate);buffer.copyToChannel(new Float32Array(samples),0);
      const source=context.createBufferSource();source.buffer=buffer;const gain=context.createGain();gain.gain.value=1;source.connect(gain);gain.connect(context.destination);
      this.active={context,source,gain};this.sinkId=outputId;source.onended=()=>{if(generation===this.generation&&this.active?.source===source)this.stop();};
    }catch(error){await context.close().catch(()=>{});throw error;}finally{this.preparing.delete(context);}
  }
  get ready():boolean{return this.active!==null||this.silentPrepared;}
  get route():string{return this.sinkId||'System default';}
  start():void{if(this.started)throw new Error('Transmit audio is a one-shot source and has already started.');if(this.silentPrepared){this.started=true;return;}if(!this.active)throw new Error('Prepare the selected transmit audio output first.');if(this.active.context.state!=='running')throw new Error('Audio output is suspended; transmission canceled.');this.active.source.start();this.started=true;}
  stop():void{
    this.generation++;this.silentPrepared=false;this.started=false;this.sinkId='';for(const context of this.preparing)void context.close().catch(()=>{});this.preparing.clear();const active=this.active;this.active=null;if(!active)return;
    active.source.onended=null;active.gain.gain.value=0;try{active.source.stop();}catch{}active.source.disconnect();active.gain.disconnect();void active.context.close().catch(()=>{});
  }
}
