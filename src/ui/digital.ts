import { icon } from './icons.ts';
import { encodeMorse, decodeMorse, generateCwWav } from '../digital/morse.ts';
import { encodeBaudot, decodeBaudot, generateRttyWav } from '../digital/rtty.ts';
import { decodeDigitalWav } from '../digital/decode-client.ts';

let playing: HTMLAudioElement | null = null;
let playingUrl: string | null = null;

export function stopDigitalPractice(): void {
  playing?.pause(); playing = null;
  if (playingUrl) URL.revokeObjectURL(playingUrl); playingUrl = null;
}
const stopPractice=stopDigitalPractice;

export function renderDigital(): string {
  return `<div class="grid2">
    <section class="panel" aria-labelledby="cw-title">
      <div class="panel-head"><h2 id="cw-title">CW studio</h2><span class="tag">LOCAL AUDIO</span></div>
      <div class="panel-body">
        <div class="field"><label for="cw-text">Message</label><textarea id="cw-text" rows="2" maxlength="2000">CQ CQ DE N0CALL 73</textarea></div>
        <div class="field-grid" style="margin-top:14px">
          <div class="field"><label for="cw-wpm">Character speed · WPM</label><input id="cw-wpm" type="number" min="3" max="80" value="20"></div>
          <div class="field"><label for="cw-effective">Spacing speed · WPM</label><input id="cw-effective" type="number" min="3" max="80" value="20"></div>
          <div class="field"><label for="cw-tone">Audio tone · Hz</label><input id="cw-tone" type="number" min="100" max="4000" value="700"></div>
          <div class="field"><label for="cw-code">Morse symbols · / separates words</label><textarea id="cw-code" class="mono" rows="2">-.-. --.- / -.-. --.- / -.. . / -. ----- -.-. .- .-.. .-.. / --... ...--</textarea></div>
        </div>
        <div class="button-row">
          <button id="cw-encode" class="btn">${icon('keyboard')}Encode text</button>
          <button id="cw-decode" class="btn">Decode symbols</button>
          <button id="cw-play" class="btn primary">${icon('play')}Play practice</button>
          <button id="cw-download" class="btn">${icon('download')}WAV</button>
          <button id="cw-import" class="btn">${icon('upload')}Decode WAV</button>
          <button id="cw-stop" class="btn">${icon('pause')}Stop</button>
          <button id="cw-transmit" class="btn outline-accent" disabled>Send audio once</button>
        </div>
        <input id="cw-file" type="file" accept=".wav,audio/wav,audio/x-wav" hidden>
        <div id="cw-result" class="digital-output" role="status" aria-live="polite" style="font-size:13px;letter-spacing:0">Ready for CW practice.</div>
        <p class="footnote">PARIS timing with 1:3 elements and 1:3:7 gaps. Lower spacing speed adds Farnsworth spacing. WAV decode expects a single stable tone and matching speeds. Listening practice plays through your speakers.</p>
      </div>
    </section>
    <section class="panel" aria-labelledby="rtty-title">
      <div class="panel-head"><h2 id="rtty-title">RTTY workbench</h2><span class="tag">ITA2 · 5 BIT</span></div>
      <div class="panel-body">
        <div class="field"><label for="rtty-text">Message · international ITA2 alphabet</label><textarea id="rtty-text" rows="2" maxlength="2000">CQ CQ DE N0CALL 599 73</textarea></div>
        <div class="field-grid" style="margin-top:14px">
          <div class="field"><label for="rtty-baud">Symbol rate · baud</label><select id="rtty-baud"><option value="45.45">45.45 baud</option value="50">50 baud</option><option value="75">75 baud</option><option value="100">100 baud</option></select></div>
          <div class="field"><label for="rtty-mark">Mark tone · Hz</label><input id="rtty-mark" type="number" min="100" max="10000" value="2125"></div>
          <div class="field"><label for="rtty-shift">Tone shift · Hz</label><input id="rtty-shift" type="number" min="1" max="1000" value="170"></div>
          <div class="field"><label for="rtty-code">ITA2 codewords · decimal, 0–31</label><textarea id="rtty-code" class="mono" rows="2"></textarea></div>
        </div>
        <label class="settings-check"><input id="rtty-reverse" type="checkbox"> Reverse mark and space tones</label>
        <div class="button-row">
          <button id="rtty-encode" class="btn">${icon('keyboard')}Encode text</button>
          <button id="rtty-decode" class="btn">Decode codewords</button>
          <button id="rtty-play" class="btn primary">${icon('play')}Play practice</button>
          <button id="rtty-download" class="btn">${icon('download')}WAV</button>
          <button id="rtty-import" class="btn">${icon('upload')}Decode WAV</button>
          <button id="rtty-stop" class="btn">${icon('pause')}Stop</button>
          <button id="rtty-transmit" class="btn outline-accent" disabled>Send audio once</button>
        </div>
        <input id="rtty-file" type="file" accept=".wav,audio/wav,audio/x-wav" hidden>
        <div id="rtty-result" class="digital-output" role="status" aria-live="polite" style="font-size:13px;letter-spacing:0">Ready for RTTY practice.</div>
        <p class="footnote">Phase-continuous audio FSK: one start bit, five bits LSB first, 1.5 stop bits. WAV decode uses fixed baud and tones; validate against clean recordings. National ITA2 symbols are excluded.</p>
      </div>
    </section>
    <div class="note full">CW and RTTY generate audio and decode WAV recordings with the selected settings. Sending audio requires the transmit arm above and a confirmed audio mode supported by the connected radio driver; audio CW does not operate the CW keyer and audio RTTY does not use the FSK input. FT8 / FT4 has its own workspace.</div>
  </div>`;
}

export function bindDigital(notify: (message: string, error?: boolean) => void, transmit?: (buffer:ArrayBuffer,mode:'CW'|'RTTY')=>Promise<void>): void {
  stopPractice();
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  const area = (id: string) => document.getElementById(id) as HTMLTextAreaElement;
  const resultNodes = { cw: document.getElementById('cw-result')!, rtty: document.getElementById('rtty-result')! };
  const output = (mode: 'cw' | 'rtty', message: string) => { resultNodes[mode].textContent = message; };
  const cwOptions = () => ({ wpm: Number(input('cw-wpm').value), farnsworthWpm: Number(input('cw-effective').value), toneHz: Number(input('cw-tone').value), volume: 0.2 });
  const rttyOptions = () => ({ baud: Number(input('rtty-baud').value), markHz: Number(input('rtty-mark').value), shiftHz: Number(input('rtty-shift').value), reverse: input('rtty-reverse').checked, volume: 0.2 });
  const action = (id: string, callback: () => void | Promise<void>) => {
    document.getElementById(id)!.addEventListener('click', () => {
      Promise.resolve().then(callback).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Digital audio operation failed.', true));
    });
  };
  async function play(buffer: ArrayBuffer): Promise<void> {
    stopPractice(); playingUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    playing = new Audio(playingUrl); playing.addEventListener('ended', stopPractice, { once: true });
    try { await playing.play(); } catch (error) { stopPractice(); throw error; }
  }
  function download(buffer: ArrayBuffer, name: string): void {
    const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' })), link = document.createElement('a');
    link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  action('cw-encode', () => { area('cw-code').value = encodeMorse(area('cw-text').value); output('cw', 'Message encoded using International Morse symbols.'); });
  action('cw-decode', () => { const decoded = decodeMorse(area('cw-code').value); area('cw-text').value = decoded; output('cw', decoded || 'No Morse symbols entered.'); });
  action('cw-play', async () => { await play(generateCwWav(area('cw-text').value, cwOptions())); output('cw', 'Playing CW practice through your speakers.'); });
  action('cw-download', () => { download(generateCwWav(area('cw-text').value, cwOptions()), 'radiodesk-cw.wav'); notify('CW practice WAV prepared.'); });
  action('cw-stop', () => { stopPractice(); output('cw', 'Practice audio stopped.'); });
  action('cw-transmit', async () => { if(!transmit)throw new Error('Transmit is unavailable.');await transmit(generateCwWav(area('cw-text').value,cwOptions()),'CW'); });
  action('rtty-encode', () => { area('rtty-code').value = encodeBaudot(area('rtty-text').value).join(' '); output('rtty', 'ITA2 letters and figures shifts encoded.'); });
  action('rtty-decode', () => {
    const entered = area('rtty-code').value.trim();
    if (entered && !/^\d+(?:[\s,]+\d+)*$/.test(entered)) throw new Error('Use decimal codewords from 0 to 31, separated by spaces or commas.');
    const decoded = decodeBaudot(entered ? entered.split(/[\s,]+/).map(Number) : []); area('rtty-text').value = decoded; output('rtty', decoded || 'No ITA2 codewords entered.');
  });
  action('rtty-play', async () => { await play(generateRttyWav(area('rtty-text').value, rttyOptions())); output('rtty', 'Playing RTTY practice through your speakers.'); });
  action('rtty-download', () => { download(generateRttyWav(area('rtty-text').value, rttyOptions()), 'radiodesk-rtty.wav'); notify('RTTY practice WAV prepared.'); });
  action('rtty-stop', () => { stopPractice(); output('rtty', 'Practice audio stopped.'); });
  action('rtty-transmit', async () => { if(!transmit)throw new Error('Transmit is unavailable.');await transmit(generateRttyWav(area('rtty-text').value,rttyOptions()),'RTTY'); });
  for (const mode of ['cw', 'rtty'] as const) {
    action(`${mode}-import`, () => { input(`${mode}-file`).click(); });
    const fileInput = input(`${mode}-file`);
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0]; if (!file) return;
      const importButton = document.getElementById(`${mode}-import`) as HTMLButtonElement;
      importButton.disabled = true;
      try {
        const request = mode === 'cw' ? { mode, options: cwOptions() } as const : { mode, options: rttyOptions() } as const;
        if (file.size > 32 * 1024 * 1024) throw new Error('For offline digital decoding, import a WAV smaller than 32 MB.');
        output(mode, `Analyzing ${file.name}…`);
        const buffer = await file.arrayBuffer();
        const result = request.mode === 'cw' ? await decodeDigitalWav(request.mode, buffer, request.options) : await decodeDigitalWav(request.mode, buffer, request.options);
        output(mode, result || 'No message resolved. Check the tone, speed and recording.');
        notify(`${mode.toUpperCase()} WAV analyzed with fixed settings.`);
      } catch (error) { const message = error instanceof Error ? error.message : 'Could not decode WAV.'; output(mode, message); notify(message, true); }
      finally { fileInput.value = ''; importButton.disabled = false; }
    });
  }
  area('rtty-code').value = encodeBaudot(area('rtty-text').value).join(' ');
}
