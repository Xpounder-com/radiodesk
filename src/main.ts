import { RadioController } from './radio/controller.ts';
import { SignalEngine } from './audio/engine.ts';
import { LocalDatabase } from './storage/database.ts';
import { ModuleRegistry } from './core/registry.ts';
import { EventBus } from './core/events.ts';
import { MutationQueue } from './core/queue.ts';
import { portableHtml } from './ui/export.ts';
import { frequency } from './ui/views.ts';
import { bandForFrequency } from './logging/qsos.ts';
import { validateQso,contactIdentity,BANDS,type Qso } from './logging/qsos.ts';
import { exportAdif,parseAdif } from './logging/adif.ts';
import { discoverAudioDevices,discoverAuthorizedSerialDevices,detectCapabilities } from './devices/discovery.ts';
import { shell,stationView,signalView,logbookView,devicesView,qsoRows,escape,NAV,type Workspace,type Settings,type ViewContext } from './ui/views.ts';
import { receiveFrame,redrawSpectrum,setSpectrumRange,clearSpectrumHistory } from './ui/spectrum.ts';
import { renderEngineering,bindEngineering } from './ui/engineering.ts';
import { renderPropagation,bindPropagation } from './ui/propagation.ts';
import { renderDigital,bindDigital,stopDigitalPractice } from './ui/digital.ts';
import { SdrController } from './sdr/index.ts';
import { renderSdr,bindSdr } from './ui/sdr.ts';
import { createFtxModem } from './digital/ftx/index.ts';
import { FtxSession } from './operating/ftx-session.ts';
import { TransmitController } from './transmit/controller.ts';
import { TransmitAudioOutput } from './audio/output.ts';
import { renderTransmit,updateTransmitUi,bindTransmitHold,openArmDialog,transmitRoute } from './ui/transmit.ts';
import { renderFtx,bindFtx } from './ui/ftx.ts';
import { decodeWav } from './audio/wav.ts';
import { icon } from './ui/icons.ts';

const app=document.querySelector<HTMLDivElement>('#app')!;
const radio=new RadioController();
const audio=new SignalEngine();
const sdr=new SdrController();
const ftx=new FtxSession(createFtxModem);
const transmit=new TransmitController(radio);
const transmitAudio=new TransmitAudioOutput();
let cleanupWorkspace:()=>void=()=>{};
let cleanupHold:()=>void=()=>{};
let receiveIdentity='';
let wasTransmitting=false;
let workspaceRevision=0;
let audibleInputPending=false;
let playbackRevision=0;
let transmitArmRevision=0;
let previouslyArmed=false;
let audioSendEpoch=0;
let audioSendPending=false;
const database=new LocalDatabase();
const registry=new ModuleRegistry();
const events=new EventBus<{workspace:Workspace;contact:Qso;error:string}>();
const defaults:Settings={call:'',grid:'',name:'',audioDevice:'',baudRate:38400,step:1000};
let settings:Settings={...defaults};
let qsos:Qso[]=[];
let deletedQsos:Qso[]=[];
let workspace:Workspace='station';
let recording=false;
let search='';
let scanTimer:ReturnType<typeof setInterval>|null=null;
let priorFocus:HTMLElement|null=null;
let toastTimer:ReturnType<typeof setTimeout>|null=null;
let latestSource='';
const digitalDrafts=new Map<string,{value:string;checked:boolean}>();
const digitalResults=new Map<string,string>();
let lastError='';
let radioIdentity='';
let audioGain=1,audioLow=20,audioHigh=3000;
const logQueue=new MutationQueue();
async function transactLog(work:()=>Promise<void>):Promise<void>{
  const execute=()=>logQueue.run(async()=>{const current=await database.get<{qsos:Qso[];deletedQsos:Qso[]}>('logbook',{qsos,deletedQsos});qsos=current.qsos.map(validateQso);deletedQsos=current.deletedQsos.map(validateQso);await work();});
  if(navigator.locks)await navigator.locks.request('radiodesk-logbook',execute);else await execute();
}
async function mutateLog(update:(existing:Qso[])=>Qso[]):Promise<void>{await transactLog(async()=>{const next=update(qsos);await database.put('logbook',{qsos:next,deletedQsos});qsos=next;});}
function finishRecording():void {if(recording){const blob=audio.stopRecording();if(blob)download(blob,`radiodesk-${Date.now()}.wav`);recording=false;}}

function context():ViewContext {return {state:radio.getState(),capabilities:radio.getCapabilities(),qsos,settings,source:audio.source,recording,storage:database.mode,audioGain,audioLow,audioHigh,recordingActive:audio.isRecording};}
function notify(message:string,error=false):void {
  document.querySelector('.toast')?.remove();if(toastTimer)clearTimeout(toastTimer);
  const toast=document.createElement('div');toast.className=`toast${error?' error':''}`;toast.setAttribute('role',error?'alert':'status');toast.textContent=message;document.body.append(toast);
  toastTimer=setTimeout(()=>toast.remove(),error?9000:5000);if(error)events.emit('error',message);
}
async function safely(action:()=>Promise<void>|void):Promise<void> {try{await action();}catch(error){notify(error instanceof Error?error.message:String(error),true);}}
function download(content:Blob|string,name:string,type='text/plain'):void {
  const blob=typeof content==='string'?new Blob([content],{type}):content;const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function closeDialog():void {document.querySelector('.dialog-backdrop')?.remove();priorFocus?.focus();priorFocus=null;}
function dialog(title:string,body:string,options:{palette?:boolean}={}):HTMLElement {
  closeDialog();priorFocus=document.activeElement as HTMLElement;
  const backdrop=document.createElement('div');backdrop.className='dialog-backdrop';
  backdrop.innerHTML=`<section class="dialog ${options.palette?'palette':''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="btn ghost" data-close-dialog aria-label="Close dialog">${icon('close')}</button></div><div class="dialog-body">${body}</div></section>`;
  document.body.append(backdrop);backdrop.addEventListener('click',event=>{if(event.target===backdrop||(event.target as HTMLElement).closest('[data-close-dialog]'))closeDialog();});
  const first=backdrop.querySelector<HTMLElement>('input,select,textarea,button:not([data-close-dialog])');first?.focus();
  backdrop.addEventListener('keydown',event=>{if(event.key!=='Tab')return;const focusable=Array.from(backdrop.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,a[href]'));if(!focusable.length)return;const first=focusable[0],last=focusable[focusable.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}});
  return backdrop;
}
function updateClock():void {const clock=document.querySelector('#utc-clock');if(clock){const now=new Date();clock.innerHTML=`${now.toISOString().slice(11,19)} UTC<br><span class="subtle">${now.toLocaleDateString('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric',year:'numeric'})}</span>`;}}
function render():void {
  document.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('#digital-workbench input:not([type=file]),#digital-workbench textarea,#digital-workbench select').forEach(input=>digitalDrafts.set(input.id,{value:input.value,checked:input instanceof HTMLInputElement&&input.checked}));
  document.querySelectorAll<HTMLElement>('#cw-result,#rtty-result').forEach(result=>digitalResults.set(result.id,result.textContent??''));
  cleanupWorkspace();cleanupHold();stopDigitalPractice();
  const c=context();let body='';
  switch(workspace){case 'station':body=renderTransmit(transmit.getState())+stationView(c);break;case 'signal':body=renderTransmit(transmit.getState())+signalView(c);break;case 'sdr':body=renderSdr();break;case 'digital':body=renderFtx(settings,ftx.getState());break;case 'logbook':body=logbookView(c,search);break;case 'devices':body=devicesView(c);break;case 'engineering':body=renderEngineering();break;case 'propagation':body=renderPropagation(settings.grid);break;}
  app.innerHTML=shell(workspace,c,body);updateClock();
  cleanupWorkspace=()=>{};cleanupHold=bindTransmitHold(transmit,notify);
  if(workspace==='sdr')cleanupWorkspace=bindSdr(sdr,notify,()=>!transmitBusy());
  if(workspace==='digital')cleanupWorkspace=bindFtx({session:ftx,radio,transmit,output:transmitAudio,settings:()=>settings,notify,arm:armTransmit,isTransmitting:transmitBusy});
  if(workspace==='engineering')bindEngineering();
  if(workspace==='propagation')bindPropagation();
  if(workspace==='signal'){const digital=document.querySelector('#digital-workbench');if(digital){digital.innerHTML=renderDigital();bindDigital(notify,sendAudioOnce);digitalDrafts.forEach((draft,id)=>{const input=document.getElementById(id) as HTMLInputElement|null;if(input){input.value=draft.value;if(input.type==='checkbox')input.checked=draft.checked;}});digitalResults.forEach((text,id)=>{const output=document.getElementById(id);if(output)output.textContent=text;});}}
  if(workspace==='station'||workspace==='signal'){redrawSpectrum();latestSource=audio.source;}
  if(workspace==='devices')void safely(refreshDevices);
  updateTransmitUi(transmit.getState(),radio);updateLegacyTransmitButtons();
}
function navigate(next:Workspace):void {workspaceRevision++;const cancel=transmit.getState().armed||transmitBusy();if(cancel){transmitAudio.stop();void safely(()=>transmit.disarm('Workspace changed. Arm again before transmitting.'));}workspace=next;search='';closeDialog();render();events.emit('workspace',next);window.scrollTo({top:0});if(cancel)notify('Transmit plan canceled by navigation. Review RX status before rearming.');}
async function saveSettings():Promise<void>{await database.put('settings',settings);}
async function saveContact(qso:Qso):Promise<void>{const valid=validateQso(qso);await mutateLog(existing=>[valid,...existing]);events.emit('contact',valid);render();notify(`Logged ${valid.call} · ${valid.mode}`);}
function createContact(values:Partial<Qso>):Qso{return {id:crypto.randomUUID(),call:'',timestamp:new Date().toISOString(),frequency:radio.getState().frequency,mode:radio.getState().mode,rstSent:'59',rstReceived:'59',grid:'',name:'',comment:'',stationCall:settings.call,...values};}
function newContactDialog():void {
  const utc=new Date().toISOString().slice(0,16),qsoMode=workspace==='digital'?ftx.getState().mode:radio.getState().mode,digitalReport=qsoMode==='FT8'||qsoMode==='FT4';
  const modal=dialog('Log a contact',`<form id="qso-form"><div class="field-grid"><div class="field"><label for="qso-call">Callsign</label><input id="qso-call" name="call" required placeholder="K1ABC" maxlength="20" style="text-transform:uppercase"></div><div class="field"><label for="qso-time">Date & time · UTC</label><input id="qso-time" name="time" type="datetime-local" value="${utc}" required></div><div class="field"><label for="qso-freq">Frequency · MHz</label><input id="qso-freq" name="frequency" type="number" step="0.000001" min="0.001" value="${radio.getState().frequency/1e6}" required></div><div class="field"><label for="qso-mode">Mode</label><select id="qso-mode" name="mode">${['USB','LSB','CW','AM','FM','RTTY','PSK31','FT8','FT4','SSB','MFSK','DIGITAL'].map(m=>`<option ${qsoMode===m?'selected':''}>${m}</option>`).join('')}</select></div><div class="field"><label for="qso-sent">${digitalReport?'Report sent':'RST sent'}</label><input id="qso-sent" name="sent" value="${digitalReport?'':'59'}" placeholder="${digitalReport?'Operator entered, e.g. -10':'59'}" maxlength="5"></div><div class="field"><label for="qso-received">${digitalReport?'Report received':'RST received'}</label><input id="qso-received" name="received" value="${digitalReport?'':'59'}" placeholder="${digitalReport?'Operator entered, e.g. -10':'59'}" maxlength="5"></div><div class="field"><label for="qso-grid">Their grid locator</label><input id="qso-grid" name="grid" placeholder="FN31pr" maxlength="8"></div><div class="field"><label for="qso-name">Name</label><input id="qso-name" name="name" maxlength="80"></div><div class="field full"><label for="qso-comment">Comment</label><textarea id="qso-comment" name="comment" rows="2" maxlength="500"></textarea></div></div><div class="dialog-actions"><button type="button" class="btn" data-close-dialog>Cancel</button><button type="submit" class="btn primary">Save contact</button></div></form>`);
  modal.querySelector('#qso-form')?.addEventListener('submit',event=>{event.preventDefault();void safely(async()=>{const data=new FormData(event.target as HTMLFormElement);const qso=createContact({call:String(data.get('call')),timestamp:new Date(`${data.get('time')}:00Z`).toISOString(),frequency:Number(data.get('frequency'))*1e6,mode:String(data.get('mode')),rstSent:String(data.get('sent')),rstReceived:String(data.get('received')),grid:String(data.get('grid')),name:String(data.get('name')),comment:String(data.get('comment'))});await saveContact(qso);closeDialog();});});
}
function frequencyDialog():void {
  const modal=dialog('Set receiver frequency',`<form id="freq-form"><label for="freq-input">Frequency · MHz</label><input id="freq-input" type="number" min="${radio.getCapabilities().minFrequency/1e6}" max="${radio.getCapabilities().maxFrequency/1e6}" step="0.000001" value="${radio.getState().frequency/1e6}" required><p class="footnote">${radio.getCapabilities().simulated?'Changes the simulated receiver.':'The selected receiver determines its valid tuning range. CAT changes require a confirmed readback.'}</p><div class="dialog-actions"><button class="btn" type="button" data-close-dialog>Cancel</button><button class="btn primary" type="submit">Tune receiver</button></div></form>`);
  modal.querySelector('#freq-form')?.addEventListener('submit',event=>{event.preventDefault();void safely(async()=>{await radio.setFrequency(Math.round(Number(modal.querySelector<HTMLInputElement>('#freq-input')!.value)*1e6));closeDialog();});});
}
function connectDialog():void {
  const serial=detectCapabilities().find(c=>c.id==='serial')!.supported;
  const modal=dialog('Connect your radio',`<form id="connect-form"><div class="field"><label for="connect-driver">Connection</label><select id="connect-driver"><option value="ft891">Yaesu FT-891 · direct serial</option><option value="hamlib" ${serial?'':'selected'}>Hamlib · local radio bridge</option></select></div><div id="connect-serial" style="margin-top:18px"><p class="small muted">Select the FT-891 CAT interface, not the PTT interface. Match the radio's CAT rate. The driver checks the FT-891 identity before enabling control.</p><div class="field"><label for="connect-baud">Serial speed · baud</label><select id="connect-baud">${[4800,9600,19200,38400].map(rate=>`<option value="${rate}" ${settings.baudRate===rate?'selected':''}>${rate}</option>`).join('')}</select></div><p class="footnote">${serial?'The browser will ask you to choose a port. RTS and DTR are deasserted; OS behavior during port opening still needs physical validation.':'Web Serial is unavailable in this browser. Use the Hamlib bridge, or a supporting browser on localhost or HTTPS.'}</p></div><div id="connect-hamlib" hidden style="margin-top:18px"><p class="small muted">Start Hamlib's rigctld for your radio model, then the RadioDesk local bridge. The configured model and supported controls will appear after connection.</p><div class="field"><label for="connect-endpoint">Local bridge endpoint</label><input id="connect-endpoint" type="text" placeholder="ws://127.0.0.1:8766/radio?token=…" autocomplete="off" spellcheck="false" maxlength="2048"></div><p class="footnote">Paste the complete endpoint printed by the bridge. It stays in memory and is omitted from backups and HTML downloads. <a href="https://github.com/Xpounder-com/radiodesk/blob/main/docs/hamlib.md" target="_blank" rel="noopener">Hamlib setup guide</a></p></div><div class="note">Transmit starts disarmed. Hamlib reports its configured backend and capabilities; it does not prove the attached physical model. Physical validation is pending for every hardware path.</div><p id="connect-error" class="error-inline" role="alert"></p><div class="dialog-actions"><button class="btn" type="button" id="connect-demo">Use simulator</button><button class="btn primary" type="submit">${icon('link')}Connect</button></div></form>`);
  const driverSelect=modal.querySelector<HTMLSelectElement>('#connect-driver')!,button=modal.querySelector<HTMLButtonElement>('[type=submit]')!;
  let pending=false,completed=false,canceled=false;
  const updateChoice=()=>{modal.querySelector<HTMLButtonElement>('#connect-demo')!.disabled=pending;const hamlib=driverSelect.value==='hamlib';modal.querySelector<HTMLElement>('#connect-serial')!.hidden=hamlib;modal.querySelector<HTMLElement>('#connect-hamlib')!.hidden=!hamlib;modal.querySelector<HTMLInputElement>('#connect-endpoint')!.required=hamlib;button.disabled=pending||(!hamlib&&!serial);button.textContent=hamlib?'Connect local bridge':'Choose CAT port';};
  driverSelect.addEventListener('change',updateChoice);updateChoice();
  const cancel=()=>{if(completed||canceled)return;canceled=true;observer.disconnect();if(pending)void radio.disconnect().catch(()=>{});};
  const observer=new MutationObserver(()=>{if(!modal.isConnected)cancel();});observer.observe(document.body,{childList:true,subtree:true});
  modal.addEventListener('keydown',event=>{if(event.key==='Escape')cancel();});modal.addEventListener('click',event=>{if(event.target===modal||(event.target as HTMLElement).closest('[data-close-dialog]'))cancel();});
  modal.querySelector('#connect-demo')?.addEventListener('click',()=>{if(pending||canceled)return;pending=true;driverSelect.disabled=true;updateChoice();void safely(async()=>{try{stopScan();transmitAudio.stop();await transmit.disarm();if(canceled)return;await radio.connectSimulator();if(canceled||!modal.isConnected){cancel();return;}completed=true;observer.disconnect();closeDialog();render();notify('Simulated receiver connected');}finally{pending=false;driverSelect.disabled=false;updateChoice();}});});
  modal.querySelector('#connect-form')?.addEventListener('submit',event=>{event.preventDefault();if(pending||canceled)return;pending=true;updateChoice();driverSelect.disabled=true;button.textContent='Connecting & reading capabilities…';void(async()=>{try{stopScan();transmitAudio.stop();await transmit.disarm();await radio.disconnect();if(canceled)throw new Error('Connection canceled.');const hamlib=driverSelect.value==='hamlib',baud=Number(modal.querySelector<HTMLSelectElement>('#connect-baud')!.value);if(hamlib)await radio.connectHamlib(modal.querySelector<HTMLInputElement>('#connect-endpoint')!.value.trim());else await radio.connectSerial('ft891',baud);if(canceled||!modal.isConnected){cancel();return;}if(!hamlib){settings.baudRate=baud;await saveSettings();}if(canceled||!modal.isConnected){cancel();return;}completed=true;observer.disconnect();closeDialog();render();notify(`${radio.getState().driver} connected · ${hamlib?'configured backend readback':'model identity checked'} · transmit disarmed`);}catch(error){if(canceled||!modal.isConnected)return;const message=error instanceof Error?error.message:String(error);modal.querySelector('#connect-error')!.textContent=message;}finally{pending=false;driverSelect.disabled=false;updateChoice();}})();});
}
function settingsDialog():void {
  const modal=dialog('Station settings',`<form id="settings-form"><div class="field-grid"><div class="field"><label for="settings-call">Your callsign</label><input id="settings-call" name="call" value="${escape(settings.call)}" maxlength="20" placeholder="e.g. W9ABC"></div><div class="field"><label for="settings-grid">Your Maidenhead locator</label><input id="settings-grid" name="grid" value="${escape(settings.grid)}" maxlength="8" placeholder="Optional, e.g. EN61ev"></div><div class="field"><label for="settings-name">Operator name</label><input id="settings-name" name="name" value="${escape(settings.name)}" maxlength="80"></div><div class="field"><label for="settings-step">Default tuning step</label><select id="settings-step" name="step">${[10,100,1000,10000,100000].map(n=>`<option value="${n}" ${settings.step===n?'selected':''}>${n<1000?n+' Hz':n/1000+' kHz'}</option>`).join('')}</select></div></div><p class="footnote">Station profile and contacts stay on this device. You enter the station location. The application does not request location access. ${database.mode==='memory'?'Persistent browser storage is unavailable. Export a backup before closing.':'Storage: '+database.mode+'. Export a backup to preserve your station outside this browser.'}</p><div class="button-row"><button type="button" class="btn" data-action="export-backup">${icon('download')}Export backup</button><button type="button" class="btn" data-action="import-backup">${icon('upload')}Merge backup</button><button type="button" class="btn" data-action="download-html">Download HTML</button></div><div class="dialog-actions"><button class="btn" type="button" data-close-dialog>Cancel</button><button class="btn primary" type="submit">Save settings</button></div></form>`);
  modal.querySelector('#settings-form')?.addEventListener('submit',event=>{event.preventDefault();void safely(async()=>{const data=new FormData(event.target as HTMLFormElement);const grid=String(data.get('grid')).trim().toUpperCase();if(grid&&!/^[A-R]{2}\d{2}([A-X]{2})?(\d{2})?$/.test(grid))throw new Error('Enter a valid 4, 6, or 8 character grid locator.');settings={...settings,call:String(data.get('call')).trim().toUpperCase(),grid,name:String(data.get('name')).trim(),step:Number(data.get('step'))};await saveSettings();closeDialog();render();notify('Station settings saved locally');});});
}
function aboutDialog():void {
  dialog('About RadioDesk',`<h3 class="about-title">One file. A whole radio desk.</h3><p class="small muted">A modular, MIT-licensed amateur radio workbench. Built for offline engineering, local logging, receiver audio analysis, and extensible station control.</p><ul class="help-list"><li><b>Station:</b> simulated receiver, direct FT-891 CAT or local Hamlib tuning, mode readback, band memories, quick log.</li><li><b>Signal Lab:</b> worker FFT, live audio, waterfall, bandpass filtering, WAV import and recording, CW and RTTY practice.</li><li><b>SDR:</b> RTL-SDR through a local rtl_tcp bridge, IQ imports, complex FFT, AM/FM/SSB demodulation.</li><li><b>FT8 / FT4:</b> embedded modem, complete UTC receive windows, WAV decoding, waveform export and one scheduled send.</li><li><b>Transmit:</b> explicit arm, hold PTT, duration watchdog, cancellation and Emergency RX. Simulator output is silent.</li><li><b>Engineering:</b> antenna estimates, Smith chart, matching, Butterworth filter synthesis, feedline calculations and units.</li><li><b>Propagation:</b> locator conversion, great-circle paths, UTC solar geometry and gray line.</li><li><b>Logbook:</b> local contacts, search, ADIF interchange and backup.</li></ul><div class="note">Direct reference hardware is the FT-891 and RTL-SDR. Other supported radios connect through an optional local Hamlib bridge; capabilities vary by configured model. Protocol, waveform, recording and simulator tests do not establish physical RF validation. The RTL-SDR requires the optional local bridge. Supported FT8/FT4 message formats follow the embedded upstream ft8_lib modem; this app does not claim WSJT-X feature or sensitivity parity. WSPR, rotators, contest automation and electromagnetic antenna solvers remain outside this release.</div><h3 style="margin-top:20px">Keyboard shortcuts</h3><ul class="help-list"><li><span class="mono">⌘/Ctrl K</span> Command palette</li><li><span class="mono">Alt 1–8</span> Switch workspaces</li><li><span class="mono">← / →</span> Tune one step in Station</li><li><span class="mono">Space</span> Pause / resume the synthetic source in Station</li><li><span class="mono">Escape</span> Emergency RX during a send; close a dialog</li></ul><p class="footnote">Audio levels are dBFS and are not a calibrated radio S-meter. Simple antenna estimates do not model radiation patterns or installation effects. Logs follow <a href="https://www.adif.org/315/ADIF_315_annotated.htm" target="_blank" rel="noopener">ADIF field conventions</a>.</p>`);
}
function paletteDialog():void {
  const modal=dialog('Command palette',`<input id="command-input" type="search" placeholder="Find a workspace or action…" aria-label="Search commands"><div id="command-results"></div>`,{palette:true});
  const commands=[...NAV.map(n=>({name:`Open ${n.label}`,hint:'Workspace',icon:n.id,run:()=>navigate(n.id)})),{name:'Set receiver frequency',hint:'Station',icon:'station',run:frequencyDialog},{name:'Log a contact',hint:'Logbook',icon:'plus',run:newContactDialog},{name:'Connect radio',hint:'Devices',icon:'link',run:connectDialog},{name:'Import WAV',hint:'Signal Lab',icon:'upload',run:()=>document.querySelector<HTMLInputElement>('#wav-file')!.click()},{name:'Export ADIF',hint:'Local export',icon:'download',run:()=>download(exportAdif(qsos),'radiodesk-log.adi')},{name:'Station settings',hint:'Local profile',icon:'settings',run:settingsDialog},{name:'Download standalone HTML',hint:'Application',icon:'download',run:()=>download(portableHtml(document),'radiodesk.html','text/html')}];
  const update=()=>{const query=modal.querySelector<HTMLInputElement>('#command-input')!.value.toLowerCase();const filtered=commands.filter(c=>c.name.toLowerCase().includes(query));modal.querySelector('#command-results')!.innerHTML=filtered.map(c=>`<button class="command-result" data-command="${commands.indexOf(c)}">${icon(c.icon)}${c.name}<small>${c.hint}</small></button>`).join('')||'<p class="empty small muted">No matching commands</p>';};update();modal.querySelector('#command-input')?.addEventListener('input',update);
  modal.addEventListener('click',event=>{const target=(event.target as HTMLElement).closest<HTMLElement>('[data-command]');if(target){const command=commands[Number(target.dataset.command)];closeDialog();command.run();}});
  modal.querySelector('#command-input')?.addEventListener('keydown',event=>{if((event as KeyboardEvent).key==='Enter'){const target=modal.querySelector<HTMLButtonElement>('[data-command]');target?.click();}});
}
function stopScan():void {if(scanTimer)clearInterval(scanTimer);scanTimer=null;}
function transmitBusy():boolean{return ['pending','transmitting','scheduled','releasing'].includes(transmit.getState().status)||radio.getState().ptt;}
function updateLegacyTransmitButtons():void{document.querySelectorAll<HTMLButtonElement>('#cw-transmit,#rtty-transmit').forEach(button=>button.disabled=audioSendPending||!transmit.getState().armed||transmit.getState().status!=='armed'||!radio.getCapabilities().digitalModes.includes(transmit.getState().mode));}
function stopOtherAudio():void{stopScan();stopDigitalPractice();if(audio.source.startsWith('WAV')||audibleInputPending){playbackRevision++;audibleInputPending=false;finishRecording();audio.stop();}void sdr.setListening(false).catch(()=>{});ftx.interruptReceive();}
function synchronizeAudioSafety():void{const active=transmitBusy();if(active&&!wasTransmitting)stopOtherAudio();wasTransmitting=active;}
async function armTransmit():Promise<void>{await openArmDialog({radio,transmit,output:transmitAudio,settings,dialog,close:closeDialog,notify,stopOtherAudio});}
async function sendAudioOnce(buffer:ArrayBuffer,mode:'CW'|'RTTY'):Promise<void>{
  if(audioSendPending)throw new Error('Transmit audio is already being prepared.');
  const revision=workspaceRevision,armRevision=transmitArmRevision;
  const state=transmit.getState();if(!state.armed||state.status!=='armed')throw new Error('Arm transmit in Station before sending audio.');
  if(!state.simulated&&!radio.getCapabilities().digitalModes.includes(radio.getState().mode))throw new Error('Select a supported upper-sideband audio mode and verify the radio input route. Audio CW/RTTY does not operate the hardware CW keyer or FSK input.');
  const wav=decodeWav(buffer),route=transmitRoute(),epoch=++audioSendEpoch;audioSendPending=true;updateLegacyTransmitButtons();stopOtherAudio();
  try{await transmitAudio.prepare(wav.samples,wav.sampleRate,route.id,route.confirmDefault,state.simulated);if(epoch!==audioSendEpoch||revision!==workspaceRevision||armRevision!==transmitArmRevision||!transmit.getState().armed)throw new Error('Audio send canceled by a workspace or transmit state change.');await transmit.scheduleOnce({id:crypto.randomUUID(),startAtUtcMs:Date.now()+2000,durationMs:wav.duration*1000,startAudio:()=>transmitAudio.start(),stopAudio:()=>transmitAudio.stop()});notify(`One ${mode} audio ${state.simulated?'simulated ':''}send scheduled`);}catch(error){if(epoch===audioSendEpoch)transmitAudio.stop();throw error;}finally{if(epoch===audioSendEpoch){audioSendPending=false;updateLegacyTransmitButtons();}}
}
function memoriesDialog():void {
  const modal=dialog('Band memories',`<p class="small muted">Reference receive frequencies, editable through the VFO. These are not transmit authorizations.</p><div class="panel" style="margin-top:15px">${BANDS.map(b=>`<button class="memory-row" data-memory="${b.memory}"><span>${b.label}</span><span>${(b.memory/1e6).toFixed(3)} MHz</span></button>`).join('')}</div><div class="button-row"><button class="btn" id="memory-scan">${scanTimer?'Stop':'Start'} simulator scan</button><span class="scan-state" id="scan-state">${scanTimer?'Scanning every 2 seconds':''}</span></div><p class="footnote">Scan practice is available with the simulated receiver. Real-radio scanning is not enabled in this build.</p>`);
  modal.querySelector('#memory-scan')?.addEventListener('click',()=>void safely(()=>{if(scanTimer){stopScan();memoriesDialog();return;}if(!radio.getCapabilities().simulated)throw new Error('Connect the simulator to use scan practice.');let i=0;scanTimer=setInterval(()=>void safely(async()=>{if(!radio.getCapabilities().simulated){stopScan();return;}const band=BANDS[i++%BANDS.length];await radio.setFrequency(band.memory);const label=document.querySelector('#scan-state');if(label)label.textContent=`${band.label} · ${(band.memory/1e6).toFixed(3)} MHz`; }),2000);modal.querySelector('#memory-scan')!.textContent='Stop simulator scan';}));
}
async function refreshDevices():Promise<void> {
  const [devices,serial]=await Promise.all([discoverAudioDevices(),discoverAuthorizedSerialDevices()]);const target=document.querySelector('#audio-device-list');
  if(target){const inputs=devices.filter(d=>d.kind==='audioinput');target.innerHTML=`${inputs.length?`<label for="audio-device-select">Receiver audio input</label><select id="audio-device-select"><option value="">System default input</option>${inputs.map(d=>`<option value="${escape(d.id)}" ${settings.audioDevice===d.id?'selected':''}>${escape(d.label)}</option>`).join('')}</select>`:'No audio inputs visible. Use live audio to request permission or import a WAV file.'}<p class="footnote">${serial.length} previously authorized serial interfaces. A permitted port is not proof of a particular receiver.</p>`;}
}
async function microphone():Promise<void> {finishRecording();clearSpectrumHistory();await audio.startMicrophone(settings.audioDevice||undefined);latestSource=audio.source;render();notify('Live input active · monitoring is silent');}
async function toggleSignal():Promise<void> {
  if(audio.source!=='Stopped'){if(recording){const blob=audio.stopRecording();if(blob)download(blob,`radiodesk-${Date.now()}.wav`);recording=false;}audio.stop();render();return;}
  const selected=document.querySelector<HTMLSelectElement>('#source-select')?.value??'demo';
  if(selected==='microphone')await microphone();else if(selected==='wav')document.querySelector<HTMLInputElement>('#wav-file')!.click();else{finishRecording();clearSpectrumHistory();audio.startDemo();render();}
}
async function action(name:string):Promise<void> {
  switch(name){
    case 'connect':connectDialog();break;case 'settings':settingsDialog();break;case 'about':aboutDialog();break;case 'palette':paletteDialog();break;case 'frequency':frequencyDialog();break;case 'memories':memoriesDialog();break;case 'new-qso':newContactDialog();break;
    case 'simulator':stopScan();transmitAudio.stop();await transmit.disarm();await radio.connectSimulator();render();notify('Simulated receiver connected');break;
    case 'disconnect':stopScan();transmitAudio.stop();await transmit.disarm();await radio.disconnect();render();notify('Receiver disconnected');break;
    case 'arm-transmit':await armTransmit();break;
    case 'emergency-rx':transmitAudio.stop();await transmit.emergencyStop();break;
    case 'disarm-transmit':transmitAudio.stop();await transmit.disarm();break;
    case 'signal-toggle':await toggleSignal();break;case 'microphone':await microphone();break;
    case 'import-wav':document.querySelector<HTMLInputElement>('#wav-file')!.click();break;
    case 'record':if(recording){const blob=audio.stopRecording();recording=false;if(blob)download(blob,`radiodesk-${new Date().toISOString().replaceAll(':','-')}.wav`);notify(blob?'WAV recording saved':'Recording contained no audio samples');}else{audio.startRecording();recording=true;notify('Recording raw mono input · maximum 10 minutes');}render();break;
    case 'discover':await refreshDevices();notify('Browser-visible devices refreshed');break;
    case 'export-adif':download(exportAdif(qsos),'radiodesk-log.adi','text/plain');notify(`Exported ${qsos.length} contacts as ADIF`);break;
    case 'restore-contact':await transactLog(async()=>{const qso=deletedQsos[0];if(!qso)throw new Error('There are no deleted contacts to restore.');const exists=qsos.some(existing=>existing.id===qso.id||contactIdentity(existing)===contactIdentity(qso));const next=exists?qsos:[qso,...qsos],remaining=deletedQsos.slice(1);await database.put('logbook',{qsos:next,deletedQsos:remaining});qsos=next;deletedQsos=remaining;});render();notify('Most recently deleted contact restored');break;
    case 'import-adif':document.querySelector<HTMLInputElement>('#adif-file')!.click();break;
    case 'export-backup':download(JSON.stringify({format:'radiodesk-backup',version:1,exportedAt:new Date().toISOString(),settings,qsos,deletedQsos},null,2),'radiodesk-backup.json','application/json');break;
    case 'import-backup':document.querySelector<HTMLInputElement>('#backup-file')!.click();break;
    case 'download-html':closeDialog();download(portableHtml(document),'radiodesk.html','text/html');notify('Self-contained RadioDesk HTML downloaded');break;
  }
}
document.addEventListener('click',event=>{const target=(event.target as HTMLElement).closest<HTMLElement>('[data-nav],[data-action],[data-tune],[data-mode],[data-memory],[data-delete-qso]');if(!target)return;
  void safely(async()=>{
    if(target.dataset.nav){navigate(target.dataset.nav as Workspace);return;}
    if(target.dataset.action){await action(target.dataset.action);return;}
    if(target.dataset.tune){stopScan();await radio.setFrequency(radio.getState().frequency+Number(target.dataset.tune)*settings.step);return;}
    if(target.dataset.mode){await radio.setMode(target.dataset.mode);return;}
    if(target.dataset.memory){stopScan();await radio.setFrequency(Number(target.dataset.memory));closeDialog();notify(`Tuned ${(Number(target.dataset.memory)/1e6).toFixed(3)} MHz`);return;}
    if(target.dataset.deleteQso){const id=target.dataset.deleteQso;const qso=qsos.find(q=>q.id===id)!;const modal=dialog(`Delete ${escape(qso.call)} contact?`,`<p class="small muted">${new Date(qso.timestamp).toISOString().slice(0,16).replace('T',' ')} UTC · ${escape(qso.mode)} · ${qso.frequency===null?'Unknown frequency · '+escape(qso.band):(qso.frequency/1e6).toFixed(3)+' MHz'}</p><div class="dialog-actions"><button class="btn" data-close-dialog>Keep contact</button><button class="btn danger" id="delete-contact">Delete contact</button></div>`);modal.querySelector('#delete-contact')?.addEventListener('click',()=>void safely(async()=>{await transactLog(async()=>{const nextTrash=[qso,...deletedQsos.filter(entry=>entry.id!==qso.id)];const next=qsos.filter(q=>q.id!==id);await database.put('logbook',{qsos:next,deletedQsos:nextTrash});deletedQsos=nextTrash;qsos=next;});closeDialog();render();notify(`Deleted ${qso.call}. Restore it from the logbook.`);}));}
  });
});
document.addEventListener('submit',event=>{if((event.target as HTMLElement).id!=='quick-log')return;event.preventDefault();void safely(async()=>{const form=event.target as HTMLFormElement,data=new FormData(form);await saveContact(createContact({call:String(data.get('call')),rstSent:String(data.get('sent')),rstReceived:String(data.get('received')),comment:String(data.get('comment')??'')}));document.querySelector<HTMLInputElement>('#quick-call')?.focus();});});
document.addEventListener('input',event=>{const input=event.target as HTMLInputElement;
  if(input.id==='log-search'){search=input.value;const filtered=qsos.filter(q=>`${q.call} ${q.mode} ${q.grid} ${q.name} ${q.comment}`.toLowerCase().includes(search.toLowerCase()));document.querySelector('#qso-table')!.innerHTML=qsoRows(filtered,true);document.querySelector('#log-count')!.textContent=`${filtered.length} contacts · UTC`;}
  if(input.id==='audio-gain'){void safely(()=>{audioGain=Number(input.value);audio.setGain(audioGain);document.querySelector('#gain-label')!.textContent=`${Number(input.value).toFixed(1)}×`;});}
});
document.addEventListener('change',event=>{const input=event.target as HTMLInputElement;
  void safely(async()=>{
    if(input.id==='tune-step'){settings.step=Number(input.value);await saveSettings();}
    if(input.id==='spectrum-range')setSpectrumRange(Number(input.value));
    if(input.id==='source-select'){if(input.value==='microphone')await microphone();else if(input.value==='wav')document.querySelector<HTMLInputElement>('#wav-file')!.click();else{finishRecording();clearSpectrumHistory();audio.startDemo();render();}}
    if(input.id==='audio-device-select'){settings.audioDevice=input.value;await saveSettings();}
    if(input.id==='audio-low'||input.id==='audio-high'){const low=Number(document.querySelector<HTMLInputElement>('#audio-low')!.value),high=Number(document.querySelector<HTMLInputElement>('#audio-high')!.value);audio.setBandpass(low,high);audioLow=low;audioHigh=high;}
    const file=input.files?.[0];if(!file)return;
    if(input.id==='wav-file'){
      if(transmitBusy())throw new Error('Stop transmission before starting speaker playback.');if(file.size>100_000_000)throw new Error('WAV import limit is 100 MB.');
      const revision=++playbackRevision;audibleInputPending=true;
      try{const buffer=await file.arrayBuffer();if(revision!==playbackRevision||transmitBusy())throw new Error('Speaker playback canceled by transmit.');finishRecording();clearSpectrumHistory();await audio.importWav(buffer);if(revision!==playbackRevision||transmitBusy()){audio.stop();throw new Error('Speaker playback canceled by transmit.');}navigate('signal');notify(`Analyzing ${file.name} · playback audible`);}
      finally{if(revision===playbackRevision)audibleInputPending=false;}
    }
    if(input.id==='adif-file'){const result=parseAdif(await file.text());let imported:Qso[]=[];await mutateLog(existing=>{const identities=new Set(existing.map(contactIdentity));imported=result.qsos.filter(q=>{const id=contactIdentity(q);if(identities.has(id))return false;identities.add(id);return true;});return [...imported,...existing].sort((a,b)=>b.timestamp.localeCompare(a.timestamp));});navigate('logbook');notify(`Imported ${imported.length} contacts${result.errors.length?`; ${result.errors.length} invalid records skipped · ${result.errors[0]}`:''}`,!!result.errors.length);}
    if(input.id==='backup-file'){if(file.size>20_000_000)throw new Error('Backup import limit is 20 MB.');const data=JSON.parse(await file.text()) as {format:string;version:number;qsos:Qso[];settings:Settings};if(data.format!=='radiodesk-backup'||data.version!==1||!Array.isArray(data.qsos))throw new Error('Not a supported RadioDesk backup.');const valid=data.qsos.map(q=>validateQso({...q,id:crypto.randomUUID()}));let merged:Qso[]=[];await mutateLog(existing=>{const ids=new Set(existing.map(contactIdentity));merged=valid.filter(q=>{const id=contactIdentity(q);if(ids.has(id))return false;ids.add(id);return true;});return [...merged,...existing].sort((a,b)=>b.timestamp.localeCompare(a.timestamp));});closeDialog();render();notify(`Merged ${merged.length} contacts. Current station settings retained.`);}
    input.value='';
  });
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){closeDialog();if(transmitBusy()){transmitAudio.stop();void safely(()=>transmit.emergencyStop());}return;}
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();paletteDialog();return;}
  if(event.altKey&&/^[1-8]$/.test(event.key)){event.preventDefault();navigate(NAV[Number(event.key)-1].id);return;}
  const active=document.activeElement;if(active?.matches('input,select,textarea,[data-ptt-hold]')||document.querySelector('.dialog-backdrop'))return;
  if(workspace==='station'&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){event.preventDefault();void safely(async()=>{stopScan();await radio.setFrequency(radio.getState().frequency+(event.key==='ArrowLeft'?-1:1)*settings.step);});}
  if(workspace==='station'&&event.code==='Space'){event.preventDefault();void safely(toggleSignal);}
});
radio.subscribe(state=>{
  synchronizeAudioSafety();
  const receiveKey=`${state.connected}|${state.frequency}|${state.mode}|${state.txStatus}`;if(receiveKey!==receiveIdentity){receiveIdentity=receiveKey;ftx.interruptReceive();}
  if(state.error&&state.error!==lastError){lastError=state.error;notify(state.error,true);}
  const identity=`${state.connected}|${state.driver}|${state.model}|${state.identitySource}|${state.verified}`;
  if(identity!==radioIdentity){radioIdentity=identity;render();return;}
  const display=document.querySelector('[data-action=frequency].frequency');if(display)display.innerHTML=`${frequency(state.frequency)}<span class="freq-unit">MHz</span>`;
  document.querySelectorAll<HTMLElement>('[data-mode]').forEach(button=>{const active=button.dataset.mode===state.mode;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  updateTransmitUi(transmit.getState(),radio);
  const deviceReadback=document.querySelector('#device-readback');if(deviceReadback)deviceReadback.textContent=`${frequency(state.frequency)} Hz · ${state.mode} · ${radio.getCapabilities().simulated?'Simulated data':state.identitySource==='hamlib-configured'?'Configured Hamlib backend readback':state.verified?'Protocol readback checked':'State unverified'}`;
  const band=document.querySelector('#summary-band');if(band)band.textContent=`${bandForFrequency(state.frequency)} · ${(state.frequency/1e6).toFixed(3)} MHz`;
});
audio.subscribe(frame=>{receiveFrame(frame);const bars=document.querySelectorAll('#meter-bars i');const level=Math.max(0,Math.min(24,Math.round((20*Math.log10(Math.max(frame.rms,1e-6))+60)/60*24)));bars.forEach((bar,index)=>bar.classList.toggle('lit',index<level));const drops=document.querySelector('#drop-value');if(drops)drops.textContent=String(audio.droppedFrames);});
audio.subscribePcm(frame=>{if(!transmitBusy())ftx.feed(frame.samples,frame.sampleRate,frame.endUtcMs,'receiver',`${frame.source}:${frame.generation}:gaps${frame.discontinuities}`,frame.continuityKnown);});
sdr.subscribeAudio(frame=>{if(!transmitBusy())ftx.feed(frame.samples,frame.sampleRate,Date.now(),'sdr',`${frame.source} · ${frame.frequencyHz} Hz · revision ${frame.configurationRevision} · drops ${frame.droppedSamples}`,true);});
transmit.subscribe(state=>{if(state.armed!==previouslyArmed){transmitArmRevision++;previouslyArmed=state.armed;if(!state.armed){audioSendEpoch++;audioSendPending=false;transmitAudio.stop();}}synchronizeAudioSafety();updateTransmitUi(state,radio);updateLegacyTransmitButtons();});
window.addEventListener('resize',redrawSpectrum);
window.addEventListener('pagehide',()=>{stopScan();stopDigitalPractice();transmitAudio.stop();audio.stop();sdr.disconnect();ftx.stopReceive();void transmit.emergencyStop().finally(()=>radio.disconnect()).catch(()=>{});});
setInterval(()=>{updateClock();const recordButton=document.querySelector('[data-action=record]');if(recordButton&&recording&&!audio.isRecording)recordButton.innerHTML=`${icon('download')}Save recording`;if(latestSource!==audio.source&&(workspace==='signal'||workspace==='station')){latestSource=audio.source;render();}},1000);

async function boot():Promise<void>{
  app.innerHTML='<p style="padding:40px;font:16px sans-serif;color:#abf173">Opening RadioDesk…</p>';
  await database.open();
  try{settings={...defaults,...await database.get<Partial<Settings>>('settings',{})};const legacy=await database.get<Qso[]>('qsos',[]);const logs=await database.get<{qsos:Qso[];deletedQsos:Qso[]}>('logbook',{qsos:legacy,deletedQsos:await database.get<Qso[]>('deleted-qsos',[])});qsos=Array.isArray(logs.qsos)?logs.qsos.map(validateQso):[];deletedQsos=Array.isArray(logs.deletedQsos)?logs.deletedQsos.map(validateQso):[];}catch(error){notify(`Local storage could not be read: ${String(error)}`,true);}
  for(const module of [{id:'radio',name:'Radio control',capabilities:['receive-tuning','cat-readback','guarded-ptt']},{id:'audio',name:'Audio & DSP',capabilities:['fft','waterfall','wav','bandpass']},{id:'sdr',name:'SDR receiver',capabilities:['rtl-tcp','iq-import','complex-fft','am-fm-ssb']},{id:'ftx',name:'FT8 / FT4 modem',capabilities:['ldpc','crc','live-utc-decode','waveform','one-shot-transmit']},{id:'engineering',name:'RF engineering',capabilities:['smith','filters','antennas','feedlines']},{id:'logging',name:'Local logbook',capabilities:['adif','search','local-storage']},{id:'propagation',name:'Propagation geometry',capabilities:['gray-line','maidenhead','great-circle']},{id:'digital',name:'CW & RTTY',capabilities:['cw-practice','rtty-practice','audio-transmit']}])registry.register(module);
  await radio.connectSimulator();audio.setBandpass(20,3000);audio.startDemo();latestSource=audio.source;render();
  if(database.mode==='memory')notify('Persistent storage unavailable. Export your log before closing.',true);
}
void safely(boot);
