import type { SdrController, SdrFrame, DemodulationOptions, IqFormat } from '../sdr/index.ts';
import { icon } from './icons.ts';

const escape = (text: unknown): string => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number, digits = 2): string => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const field = (id: string, label: string, value: number, step = 'any'): string => `<div class="field"><label for="${id}">${escape(label)}</label><input id="${id}" type="number" step="${step}" value="${value}"></div>`;
const result = (label: string, value: string, unit = ''): string => `<div><div class="result-label">${escape(label)}</div><div class="result-value">${escape(value)} <small>${escape(unit)}</small></div></div>`;

export function renderSdr(): string {
  return `<section id="sdr-workbench" class="grid2"><section class="panel full"><div class="panel-head"><h2>Wideband IQ receiver</h2><span class="tag">RF / COMPLEX IQ</span></div><div class="panel-body"><div class="field-grid"><div class="field full"><label for="sdr-endpoint">rtl_tcp WebSocket bridge · paste the complete token-bearing URL printed by the bridge</label><input id="sdr-endpoint" placeholder="ws://127.0.0.1:8765/iq?token=…" autocomplete="off" spellcheck="false"></div>${field('sdr-center', 'Requested centre frequency · MHz', 100)}<div class="field"><label for="sdr-rate">Requested IQ sample rate · samples / second</label><select id="sdr-rate"><option value="2048000" selected>2,048,000 · 2.048 MHz span</option><option value="2400000">2,400,000 · 2.4 MHz span</option><option value="1024000">1,024,000 · 1.024 MHz span</option><option value="256000">256,000 · 256 kHz span</option></select></div><div class="field"><label for="sdr-gain-mode">Requested tuner gain</label><select id="sdr-gain-mode"><option value="auto">Automatic</option><option value="manual">Manual gain</option></select></div>${field('sdr-gain', 'Manual tuner gain · dB (receiver dependent)', 20)}<div class="field"><label for="sdr-fft">Complex FFT size · applies when starting a source</label><select id="sdr-fft"><option value="1024">1,024</option><option value="2048">2,048</option><option value="4096" selected>4,096</option><option value="8192">8,192</option><option value="16384">16,384</option></select></div></div><div class="button-row"><button id="sdr-connect" class="btn primary">${icon('link')} Connect IQ receiver</button><button id="sdr-disconnect" class="btn">${icon('close')} Disconnect / stop</button><button id="sdr-tune" class="btn">Apply requested frequency</button><button id="sdr-apply-gain" class="btn">Apply requested gain</button><button id="sdr-fixture" class="btn">Start synthetic IQ fixture</button></div><p id="sdr-error" class="error-inline" role="status"></p><p class="footnote">This source is complex I,Q from an RF receiver. The Station microphone and mono audio WAV source are receiver audio and cannot expose this RF span. The single HTML contains the receiver client and DSP; real RTL-SDR hardware uses the optional local rtl_tcp bridge. No direct USB driver or RF transmit is implied by this receive path.</p><p class="footnote mono">rtl_tcp -a 127.0.0.1 -p 1234 -s 2048000<br>python3 bridge/rtl_tcp_ws.py<br>For a local HTML file: python3 bridge/rtl_tcp_ws.py --allow-file-origin</p></div></section><section class="panel full"><div class="panel-head"><h2>RF spectrum &amp; waterfall</h2><span id="sdr-source" class="small muted">Stopped · no IQ data</span></div><div class="panel-body"><canvas id="sdr-spectrum" class="chart" width="1100" height="300" aria-label="Full complex RF spectrum in dBFS per FFT bin, with absolute RF frequency axis"></canvas><canvas id="sdr-waterfall" class="chart" width="1100" height="170" style="height:170px;margin-top:8px" aria-label="RF waterfall showing complex IQ magnitude over time"></canvas><div id="sdr-frame-stats" class="calc-results four" aria-live="polite"></div><p class="footnote">Left → right: centre − sample rate / 2 through centre + sample rate / 2. The centre DC bin is removed with a window-weighted mean. Magnitudes are dBFS per FFT bin, with no antenna, dBm or S-meter calibration. Click the spectrum to select a software receive channel.</p></div></section><section class="panel"><div class="panel-head"><h2>Local receive audio</h2><span class="small muted">Demodulation · speakers off initially</span></div><div class="panel-body"><div class="field-grid"><div class="field"><label for="sdr-demod">Detector</label><select id="sdr-demod"><option value="AM">AM envelope</option><option value="FM">FM phase detector</option><option value="USB">Upper sideband</option><option value="LSB">Lower sideband</option></select></div>${field('sdr-offset', 'Software channel offset from centre · Hz', 0)}${field('sdr-bandwidth', 'RF bandwidth AM/FM · audio upper edge SSB · Hz', 10000)}${field('sdr-deviation', 'FM deviation reference · Hz', 2500)}<div class="field"><label for="sdr-volume">Speaker volume</label><input id="sdr-volume" type="range" min="0" max="1" step="0.01" value="0.5"></div></div><div class="button-row"><button id="sdr-demod-apply" class="btn">Apply receive channel</button><button id="sdr-listen" class="btn">${icon('play')} Enable listening</button><button id="sdr-mute" class="btn">${icon('pause')} Mute speakers</button></div><p class="footnote">The worker mixes the selected RF channel, filters before decimation and demodulates locally. USB/LSB select positive/negative sidebands. AM removes detector DC after envelope detection. FM uses a conjugate phase discriminator; broadcast stereo and RDS are outside this detector. Receive audio is also available to local digital decoders while speakers are muted.</p></div></section><section class="panel"><div class="panel-head"><h2>Offline IQ recording</h2>${icon('folder')}</div><div class="panel-body"><div class="field-grid"><div class="field"><label for="sdr-import-format">File sample encoding</label><select id="sdr-import-format"><option value="wav">Stereo WAV · left I / right Q</option><option value="u8">Raw unsigned 8-bit · I,Q</option><option value="s16le">Raw signed 16-bit little endian · I,Q</option><option value="f32le">Raw float32 little endian · I,Q</option></select></div>${field('sdr-import-rate', 'Raw IQ sample rate · Hz (WAV uses file header)', 192000, '1')}${field('sdr-import-center', 'Recording RF centre metadata · MHz', 14.074)}<div class="field"><label for="sdr-import-loop">Playback</label><select id="sdr-import-loop"><option value="once">Once</option><option value="loop">Loop recording</option></select></div><div class="field full"><label for="sdr-file">Select local IQ recording · maximum 64 MiB</label><input id="sdr-file" type="file" accept=".wav,.iq,.raw,.bin,.cf32,.cs16,.cu8"></div></div><div class="button-row"><button id="sdr-import" class="btn">${icon('upload')} Play imported IQ</button></div><p class="footnote">Raw IQ needs the original sample rate and RF centre metadata. A stereo music file is not an IQ recording merely because it has two channels. Hardware retuning cannot change an imported recording; use the software channel offset within its captured RF span.</p></div></section><section class="panel full"><div class="panel-head"><h2>Transport &amp; processing</h2><span id="sdr-control-status" class="small muted">No hardware readback</span></div><div id="sdr-transport-stats" class="panel-body" aria-live="polite"></div></section></section>`;
}

export function bindSdr(controller: SdrController, notify: (text: string, error?: boolean) => void, allowListening:()=>boolean=()=>true): () => void {
  const root = document.getElementById('sdr-workbench'); if (!root) return () => {};
  const abort = new AbortController(); let latestFrame: SdrFrame | null = null;
  const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  const select = (id: string): HTMLSelectElement => document.getElementById(id) as HTMLSelectElement;
  const num = (id: string): number => { const value = input(id).value; if (value.trim() === '' || !Number.isFinite(Number(value))) throw new Error(`${input(id).labels?.[0]?.textContent ?? id} needs a number.`); return Number(value); };
  const output = (id: string, html: string): void => { const node = document.getElementById(id); if (node) node.innerHTML = html; };
  const error = (e: unknown): void => { const message = e instanceof Error ? e.message : String(e); const node = document.getElementById('sdr-error'); if (node) node.textContent = message; notify(message, true); };
  const clearError = (): void => { const node = document.getElementById('sdr-error'); if (node) node.textContent = ''; };
  const bind = (id: string, action: () => void | Promise<void>): void => document.getElementById(id)?.addEventListener('click', () => { Promise.resolve().then(action).then(clearError).catch(error); }, { signal: abort.signal });
  const readDemod = (): DemodulationOptions => ({ mode: select('sdr-demod').value as DemodulationOptions['mode'], offsetHz: num('sdr-offset'), bandwidthHz: num('sdr-bandwidth'), fmDeviationHz: num('sdr-deviation') });
  const syncDemod = (): void => { const d = controller.stats.demodulation; select('sdr-demod').value = d.mode; input('sdr-offset').value = String(d.offsetHz); input('sdr-bandwidth').value = String(d.bandwidthHz); input('sdr-deviation').value = String(d.fmDeviationHz ?? 2500); };

  const stats = controller.stats;
  input('sdr-center').value = String(stats.centerFrequency / 1e6); input('sdr-gain').value = String(stats.gainDb ?? 20); select('sdr-gain-mode').value = stats.gainDb === null ? 'auto' : 'manual';
  if ([...select('sdr-rate').options].some(option => option.value === String(stats.sampleRate))) select('sdr-rate').value = String(stats.sampleRate);
  if (stats.endpoint) input('sdr-endpoint').value = stats.endpoint;
  syncDemod();
  bind('sdr-connect', async () => {
    await controller.connect(input('sdr-endpoint').value.trim(), { centerFrequency: Math.round(num('sdr-center') * 1e6), sampleRate: Number(select('sdr-rate').value), gainDb: select('sdr-gain-mode').value === 'auto' ? null : num('sdr-gain'), fftSize: Number(select('sdr-fft').value) });
    notify('RTL0 receiver header received. Frequency, rate and gain commands were requested; rtl_tcp provides no hardware readback.');
  });
  bind('sdr-disconnect', () => { controller.disconnect(); notify('IQ reception stopped.'); });
  bind('sdr-tune', () => { controller.tune(Math.round(num('sdr-center') * 1e6)); notify('RF frequency command sent; requested value has no rtl_tcp readback.'); });
  bind('sdr-apply-gain', () => { controller.setGain(select('sdr-gain-mode').value === 'auto' ? null : num('sdr-gain')); notify('Tuner gain command sent.'); });
  bind('sdr-fixture', () => { controller.startSynthetic(Math.round(num('sdr-center') * 1e6)); syncDemod(); notify('Synthetic IQ fixture started: AM carrier at centre +20 kHz with 1 kHz audio. No live receiver is involved.'); });
  bind('sdr-demod-apply', () => { controller.setDemodulation(readDemod()); notify('Software receive channel updated.'); });
  bind('sdr-listen', async () => { if(!allowListening())throw new Error('Cancel transmission before enabling receive speaker audio.');await controller.setListening(true, num('sdr-volume'));if(!allowListening()){await controller.setListening(false);throw new Error('Receive speaker audio was canceled by transmission.');}notify('Local IQ demodulation listening enabled.'); });
  bind('sdr-mute', async () => { await controller.setListening(false); notify('Speakers muted; receive audio continues to subscribed decoders.'); });
  input('sdr-volume').addEventListener('input', () => { if (controller.stats.listening) void controller.setListening(true, Number(input('sdr-volume').value)).catch(error); }, { signal: abort.signal });
  select('sdr-demod').addEventListener('change', () => { const mode = select('sdr-demod').value; input('sdr-bandwidth').value = mode === 'USB' || mode === 'LSB' ? '3000' : mode === 'FM' ? '16000' : '10000'; }, { signal: abort.signal });
  bind('sdr-import', async () => {
    const file = input('sdr-file').files?.[0]; if (!file) throw new Error('Choose a local IQ recording first.');
    if (file.size > 64 * 1024 * 1024) throw new Error('IQ recording exceeds the 64 MiB import limit.');
    const format: IqFormat = { kind: select('sdr-import-format').value as IqFormat['kind'], sampleRate: num('sdr-import-rate'), centerFrequency: Math.round(num('sdr-import-center') * 1e6), loop: select('sdr-import-loop').value === 'loop', fftSize: Number(select('sdr-fft').value) };
    controller.importIq(await file.arrayBuffer(), format); input('sdr-center').value = String(format.centerFrequency / 1e6); syncDemod();
    notify(`Playing local IQ recording: ${file.name}. No live RF receiver is involved.`);
  });

  const draw = (frame: SdrFrame): void => {
    const canvas = document.getElementById('sdr-spectrum') as HTMLCanvasElement | null, ctx = canvas?.getContext('2d');
    const waterfall = document.getElementById('sdr-waterfall') as HTMLCanvasElement | null, water = waterfall?.getContext('2d');
    if (!canvas || !ctx || !waterfall || !water) return;
    const w = canvas.width, h = canvas.height, left = 55, right = w - 20, top = 15, bottom = h - 36;
    const xAt = (frequency: number) => left + (frequency - frame.minimumFrequency) / frame.sampleRate * (right - left);
    const yAt = (db: number) => top + Math.max(0, Math.min(120, -db)) / 120 * (bottom - top);
    ctx.clearRect(0, 0, w, h); ctx.font = '13px monospace'; ctx.lineWidth = 1; ctx.strokeStyle = '#2b3c42'; ctx.fillStyle = '#9caeb7';
    for (const db of [0, -30, -60, -90, -120]) { const y = yAt(db); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.fillText(String(db), 8, y + 5); }
    for (let i = 0; i <= 4; i++) { const f = frame.minimumFrequency + i / 4 * frame.sampleRate, x = xAt(f); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); const label = fmt(f / 1e6, 4); ctx.fillText(label, Math.max(left, Math.min(right - ctx.measureText(label).width, x - 28)), h - 12); }
    ctx.strokeStyle = '#abf173'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = left; x <= right; x++) {
      const begin = Math.floor((x - left) / (right - left) * frame.bins.length), end = Math.min(frame.bins.length, Math.max(begin + 1, Math.ceil((x + 1 - left) / (right - left) * frame.bins.length)));
      let maximum = -160; for (let bin = begin; bin < end; bin++) maximum = Math.max(maximum, frame.bins[bin]!);
      const y = yAt(maximum); if (x === left) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const d = controller.stats.demodulation, channel = frame.centerFrequency + d.offsetHz;
    const low = d.mode === 'USB' ? channel + 150 : d.mode === 'LSB' ? channel - d.bandwidthHz : channel - d.bandwidthHz / 2;
    const high = d.mode === 'USB' ? channel + d.bandwidthHz : d.mode === 'LSB' ? channel - 150 : channel + d.bandwidthHz / 2;
    ctx.fillStyle = 'rgba(171,241,115,0.12)'; ctx.fillRect(xAt(low), top, xAt(high) - xAt(low), bottom - top);
    ctx.strokeStyle = '#d4bd70'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(xAt(channel), top); ctx.lineTo(xAt(channel), bottom); ctx.stroke(); ctx.setLineDash([]);
    water.drawImage(waterfall, 0, 0, waterfall.width, waterfall.height - 1, 0, 1, waterfall.width, waterfall.height - 1);
    const row = water.createImageData(waterfall.width, 1);
    for (let x = 0; x < waterfall.width; x++) {
      const start = Math.floor(x / waterfall.width * frame.bins.length), end = Math.max(start + 1, Math.ceil((x + 1) / waterfall.width * frame.bins.length));
      let maximum = -160; for (let i = start; i < Math.min(end, frame.bins.length); i++) maximum = Math.max(maximum, frame.bins[i]!);
      const strength = Math.max(0, Math.min(1, (maximum + 105) / 100));
      row.data[x * 4] = Math.round(12 + 220 * strength ** 3); row.data[x * 4 + 1] = Math.round(20 + 220 * strength); row.data[x * 4 + 2] = Math.round(28 + 100 * Math.sin(strength * Math.PI)); row.data[x * 4 + 3] = 255;
    }
    water.putImageData(row, 0, 0);
    output('sdr-frame-stats', result('Peak RF frequency', fmt(frame.peakFrequency / 1e6, 6), 'MHz') + result('Peak magnitude', fmt(frame.peakDb, 1), 'dBFS / bin') + result('Bin spacing', fmt(frame.sampleRate / frame.fftSize, 1), 'Hz') + result('RF span', fmt(frame.sampleRate / 1e6, 3), 'MHz'));
  };
  document.getElementById('sdr-spectrum')?.addEventListener('click', event => {
    if (!latestFrame) return;
    const canvas = event.currentTarget as HTMLCanvasElement, bounds = canvas.getBoundingClientRect(), x = (event.clientX - bounds.left) / bounds.width * canvas.width;
    const fraction = Math.max(0, Math.min(1, (x - 55) / (canvas.width - 75)));
    input('sdr-offset').value = String(Math.round((fraction - 0.5) * latestFrame.sampleRate));
    try { controller.setDemodulation(readDemod()); draw(latestFrame); clearError(); } catch (e) { error(e); }
  }, { signal: abort.signal });
  const unsubscribe = controller.subscribe(frame => { latestFrame = frame; draw(frame); });
  const updateStats = (): void => {
    const s = controller.stats;
    const source = document.getElementById('sdr-source'); if (source) source.textContent = `${s.source} · ${s.state}`;
    const control = document.getElementById('sdr-control-status'); if (control) control.textContent = s.controlStatus;
    const tuner = s.header ? `${s.header.tunerName} · ${s.header.tunerGainCount} supported gain steps reported` : s.controlStatus === 'synthetic fixture' ? 'Synthetic fixture' : s.controlStatus === 'recording metadata' ? 'Operator-supplied recording metadata' : 'No RTL0 receiver header';
    output('sdr-transport-stats', `<div class="calc-results four">${result('Received IQ samples', fmt(s.receivedSamples, 0))}${result('Skipped IQ samples', fmt(s.droppedSamples, 0))}${result('Queued blocks', `${s.pendingBlocks} / 4`)}${result('Listening', s.listening ? 'Enabled' : 'Muted')}</div><p class="footnote">${escape(tuner)}. ${escape(s.controlStatus)}. Received ${(s.receivedBytes / 1024 / 1024).toFixed(2)} MiB; skipped ${s.droppedBlocks} IQ blocks; skipped ${s.droppedAudioBlocks} speaker blocks. Tuning discards a brief settling interval. Drops are visible and make a digital-mode capture discontinuous.</p>${s.lastError ? `<p class="error-inline">${escape(s.lastError)}</p>` : ''}`);
    const connected = s.state === 'receiving'; (document.getElementById('sdr-tune') as HTMLButtonElement).disabled = !connected; (document.getElementById('sdr-apply-gain') as HTMLButtonElement).disabled = !connected;
    (document.getElementById('sdr-connect') as HTMLButtonElement).disabled = s.state === 'connecting';
  };
  updateStats(); const timer = setInterval(updateStats, 500);
  return () => { abort.abort(); unsubscribe(); clearInterval(timer); };
}
