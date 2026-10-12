import { antennaLengths, butterworthDesign, butterworthResponse, complex, dbmToWatts, feedlineLoss, lMatch, lcResonanceHz, reflectionMetrics, transmissionLineInput, wattsToDbm } from '../engineering/index.ts';
import type { ButterworthOptions, Complex, ReactiveComponent } from '../engineering/index.ts';
import { icon } from './icons.ts';

type Tab = 'antennas' | 'smith' | 'filters' | 'feedlines';
let activeTab: Tab = 'antennas';
const escape = (text: unknown): string => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number, digits = 2): string => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : n === Infinity ? '∞' : n === -Infinity ? '−∞' : '—';
const result = (label: string, value: string, unit = ''): string => `<div><div class="result-label">${escape(label)}</div><div class="result-value">${escape(value)} <small>${escape(unit)}</small></div></div>`;
const field = (id: string, label: string, value: number, min = 0, step = 'any'): string => `<div class="field"><label for="${id}">${escape(label)}</label><input id="${id}" type="number" value="${value}" min="${min}" step="${step}" required></div>`;
function componentLabel(component: ReactiveComponent | null): string {
  if (!component) return 'Wire / omitted';
  if (component.kind === 'L') return `${fmt(component.henries * 1e6, 3)} µH`;
  return `${fmt(component.farads * 1e12, 2)} pF`;
}

function antennas(): string {
  return `<div class="grid2"><section class="panel"><div class="panel-head"><h2>Antenna dimensions</h2>${icon('station')}</div><div class="panel-body"><div class="field-grid">${field('ant-frequency', 'Operating frequency · MHz', 14.2, 0.000001)}${field('ant-factor', 'Dipole shortening factor', 0.9516343, 0.01)}${field('ant-loop-factor', 'Full wave loop length factor', 1, 0.01)}<div class="field"><label for="ant-unit">Display units</label><select id="ant-unit"><option value="m">Meters</option><option value="ft">Feet</option></select></div></div><div id="ant-results" class="calc-results" aria-live="polite"></div><p id="ant-error" class="error-inline" role="status"></p><p class="footnote">Starting dimensions for trimming and measurement. The default dipole factor reproduces the ARRL 468 / f(MHz) feet estimate. Loop dimensions begin at one free space wavelength.</p></div></section><section class="panel"><div class="panel-head"><h2>Wire geometry</h2><span class="tag">DIMENSIONS ONLY</span></div><div class="panel-body"><svg viewBox="0 0 520 230" role="img" aria-label="Centre fed dipole, quarter wave vertical and full wave loop geometry" style="width:100%;height:230px"><g fill="none" stroke="#abf173" stroke-width="3"><path d="M30 45h220M145 45v25"/><circle cx="140" cy="45" r="6" fill="#171c1e"/><path d="M345 40v130m-40 0h80m-40 0-28 30m28-30 28 30"/><path d="M60 105h140v100H60z"/></g><g fill="#9caeb7" font-size="12" font-family="sans-serif"><text x="68" y="25">½ λ dipole · two equal legs</text><text x="370" y="97">¼ λ</text><text x="88" y="159">1 λ loop</text><text x="288" y="220">Ground plane / radials</text></g></svg><p class="footnote">Height, ground, conductor diameter, insulation, nearby objects and matching affect resonance and feedpoint impedance. These dimensions do not predict gain, radiation pattern, efficiency or bandwidth.</p><div id="ant-secondary" class="calc-results"></div></div></section></div>`;
}

function smith(): string {
  return `<div class="grid2"><section class="panel"><div class="panel-head"><h2>Impedance &amp; matching</h2><span class="tag">IDEAL CIRCUIT</span></div><div class="panel-body"><div class="field-grid">${field('smith-r', 'Load resistance · Ω', 25)}${field('smith-x', 'Load reactance · Ω (±)', -30, -100000)}${field('smith-z0', 'Reference / source resistance · Ω', 50, 0.001)}${field('smith-frequency', 'Frequency · MHz', 14.2, 0.000001)}</div><div id="smith-results" class="calc-results" aria-live="polite"></div><p id="smith-error" class="error-inline" role="status"></p><div id="smith-matches"></div><p class="footnote">L networks match this complex load to a real source resistance at one frequency. Values assume lossless components. Topology reads from source to load; shunt elements connect to ground.</p></div></section><section class="panel"><div class="panel-head"><h2>Smith chart</h2><span class="small muted">Normalised to Z₀</span></div><div class="panel-body"><canvas id="smith-canvas" class="chart" width="850" height="500" aria-label="Smith chart with normalised impedance grid and load reflection point"></canvas><p class="footnote">Horizontal axis: resistance. Upper half: inductive reactance. Lower half: capacitive reactance. Dashed circle shows constant reflection magnitude.</p></div></section><section class="panel full"><div class="panel-head"><h2>Transmission line transform</h2><span class="small muted">Same load and frequency</span></div><div class="panel-body"><div class="field-grid">${field('line-length', 'Line length · meters', 10)}${field('line-vf', 'Velocity factor · 0 to 1', 0.66, 0.01)}${field('line-z0', 'Line characteristic impedance · Ω', 50, 0.001)}${field('line-loss', 'One way matched loss over this line · dB', 0)}</div><div id="line-results" class="calc-results"></div><p class="footnote">Uniform line with real characteristic impedance. Attenuation is the supplied total matched loss at the operating frequency; input SWR reduction from line loss does not imply better antenna efficiency.</p></div></section></div>`;
}

function filters(): string {
  return `<div class="grid2"><section class="panel"><div class="panel-head"><h2>Butterworth filter synthesis</h2><span class="tag">LC LADDER</span></div><div class="panel-body"><div class="field-grid"><div class="field"><label for="filter-kind">Response</label><select id="filter-kind"><option value="lowpass">Low pass</option><option value="highpass">High pass</option><option value="bandpass">Band pass</option></select></div>${field('filter-order', 'Prototype order · 1 to 15', 5, 1, '1')}${field('filter-cutoff', 'Cutoff · MHz', 30, 0.000001)}${field('filter-z0', 'Equal source & load · Ω', 50, 0.001)}<div class="field" data-bandpass hidden>${field('filter-lower', 'Lower −3 dB edge · MHz', 7, 0.000001)}</div><div class="field" data-bandpass hidden>${field('filter-upper', 'Upper −3 dB edge · MHz', 14, 0.000001)}</div></div><p id="filter-error" class="error-inline" role="status"></p><div id="filter-summary" class="calc-results" aria-live="polite"></div><p class="footnote">Series first, doubly terminated ladder. Ideal insertion response is relative to the matched passband. A band pass transformation doubles the physical order.</p></div></section><section class="panel"><div class="panel-head"><h2>Insertion response</h2><span class="small muted">Log frequency · dB</span></div><div class="panel-body"><canvas id="filter-canvas" class="chart response-chart" width="900" height="400" aria-label="Ideal Butterworth insertion response versus logarithmic frequency"></canvas><p class="footnote">Green: calculated ideal response. Dashed line: −3.01 dB. Component Q, parasitics, tolerances, self resonance and layout can change a built filter substantially.</p></div></section><section class="panel full"><div class="panel-head"><h2>Ladder components</h2><span class="small muted">Source → load</span></div><div id="filter-components" class="table-wrap"></div></section></div>`;
}

function feedlines(): string {
  return `<div class="grid2"><section class="panel"><div class="panel-head"><h2>Matched feedline loss</h2>${icon('link')}</div><div class="panel-body"><div class="field-grid">${field('feed-length', 'Cable length · meters', 30)}${field('feed-loss', 'Manufacturer loss at your frequency · dB / 100 m', 6)}${field('feed-power', 'Input power · watts', 100)}</div><div id="feed-results" class="calc-results" aria-live="polite"></div><p id="feed-error" class="error-inline" role="status"></p><p class="footnote">Use your cable manufacturer’s attenuation at the operating frequency. This calculation assumes matched terminations and reports cable dissipation. Mismatched-line loss requires more information than SWR alone.</p></div></section><section class="panel"><div class="panel-head"><h2>Power &amp; resonance</h2>${icon('signal')}</div><div class="panel-body"><div class="field-grid">${field('unit-watts', 'Power · watts', 100)}${field('unit-dbm', 'Power · dBm', 50, -300)}${field('unit-l', 'Inductance · µH', 1, 0.000001)}${field('unit-c', 'Capacitance · pF', 100, 0.000001)}</div><div id="unit-results" class="calc-results" aria-live="polite"></div><p id="unit-error" class="error-inline" role="status"></p><p class="footnote">dBm is power referenced to 1 mW; zero watts is −∞ dBm. LC resonance assumes ideal components without loading or parasitics.</p></div></section></div>`;
}

const content = (): string => ({ antennas, smith, filters, feedlines }[activeTab])();
export function renderEngineering(): string {
  const tabs: [Tab, string][] = [['antennas', 'Antennas'], ['smith', 'Smith chart'], ['filters', 'Filters'], ['feedlines', 'Feedlines & units']];
  return `<section id="engineering-workbench"><div class="tabs" role="tablist" aria-label="Engineering calculators">${tabs.map(([id, label]) => `<button type="button" role="tab" data-engineering-tab="${id}" class="${activeTab === id ? 'active' : ''}" aria-selected="${activeTab === id}">${escape(label)}</button>`).join('')}</div><div id="engineering-content" role="tabpanel">${content()}</div></section>`;
}

function number(id: string): number {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input || input.value.trim() === '' || !Number.isFinite(Number(input.value))) throw new RangeError(`${input?.labels?.[0]?.textContent ?? id} needs a number`);
  return Number(input.value);
}

function output(id: string, html: string): void { const node = document.getElementById(id); if (node) node.innerHTML = html; }
function error(id: string, message: unknown): void { const node = document.getElementById(id); if (node) node.textContent = message instanceof Error ? message.message : String(message ?? ''); }
function listen(ids: string[], update: () => void): void { for (const id of ids) document.getElementById(id)?.addEventListener('input', update); update(); }

function bindAntennas(): void {
  listen(['ant-frequency', 'ant-factor', 'ant-loop-factor', 'ant-unit'], () => {
    try {
      const lengths = antennaLengths(number('ant-frequency') * 1e6, number('ant-factor'), number('ant-loop-factor'));
      const unit = (document.getElementById('ant-unit') as HTMLSelectElement).value;
      const factor = unit === 'ft' ? 1 / 0.3048 : 1;
      output('ant-results', result('Dipole · total', fmt(lengths.dipoleTotalMeters * factor), unit) + result('Each dipole leg', fmt(lengths.dipoleLegMeters * factor), unit) + result('¼ wave vertical', fmt(lengths.quarterWaveVerticalMeters * factor), unit));
      output('ant-secondary', result('Full wave loop', fmt(lengths.fullWaveLoopPerimeterMeters * factor), unit) + result('Square loop side', fmt(lengths.squareLoopSideMeters * factor), unit) + result('Free space λ', fmt(lengths.wavelengthMeters * factor), unit));
      error('ant-error', '');
    } catch (e) { error('ant-error', e); output('ant-results', ''); output('ant-secondary', ''); }
  });
}

function drawSmith(gamma: Complex, load: Complex, z0: number): void {
  const canvas = document.getElementById('smith-canvas') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d'); if (!canvas || !ctx) return;
  const w = canvas.width, h = canvas.height, radius = h * 0.43, cx = w / 2, cy = h / 2;
  ctx.clearRect(0, 0, w, h); ctx.lineWidth = 1.2;
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.clip();
  ctx.strokeStyle = '#314046';
  for (const r of [0, 0.2, 0.5, 1, 2, 5, 10]) {
    ctx.beginPath(); ctx.arc(cx + radius * r / (r + 1), cy, radius / (r + 1), 0, 2 * Math.PI); ctx.stroke();
  }
  for (const x of [-10, -5, -2, -1, -0.5, -0.2, 0.2, 0.5, 1, 2, 5, 10]) {
    ctx.beginPath(); ctx.arc(cx + radius, cy - radius / x, radius / Math.abs(x), 0, 2 * Math.PI); ctx.stroke();
  }
  ctx.restore(); ctx.strokeStyle = '#65777d'; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy); ctx.stroke();
  ctx.strokeStyle = '#6a9c57'; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.arc(cx, cy, Math.hypot(gamma.re, gamma.im) * radius, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
  const px = cx + gamma.re * radius, py = cy - gamma.im * radius;
  ctx.fillStyle = '#abf173'; ctx.beginPath(); ctx.arc(px, py, 6, 0, 2 * Math.PI); ctx.fill();
  ctx.font = '16px monospace'; ctx.fillStyle = '#d5e5d8'; ctx.fillText(`z = ${fmt(load.re / z0, 2)} ${load.im >= 0 ? '+' : '−'} j${fmt(Math.abs(load.im / z0), 2)}`, 20, 28);
  ctx.fillStyle = '#9caeb7'; ctx.font = '13px monospace';
  for (const r of [0, 0.2, 0.5, 1, 2, 5]) {
    const g = (r - 1) / (r + 1); ctx.fillText(String(r), cx + g * radius + 3, cy + 16);
  }
  ctx.fillText('+jX', cx - radius - 35, cy - 100); ctx.fillText('−jX', cx - radius - 35, cy + 100);
}

function bindSmith(): void {
  listen(['smith-r', 'smith-x', 'smith-z0', 'smith-frequency', 'line-length', 'line-vf', 'line-z0', 'line-loss'], () => {
    try {
      const load = complex(number('smith-r'), number('smith-x')), z0 = number('smith-z0'), frequency = number('smith-frequency') * 1e6;
      const metrics = reflectionMetrics(load, z0);
      output('smith-results', result('VSWR', fmt(metrics.vswr), ': 1') + result('Return loss', fmt(metrics.returnLossDb), 'dB') + result('Reflected power', fmt(metrics.reflectedPowerFraction * 100), '%'));
      drawSmith(metrics.gamma, load, z0);
      if (load.re > 0) {
        const matches = lMatch(z0, load, frequency);
        output('smith-matches', `<div class="table-wrap" style="margin-top:18px"><table><thead><tr><th>From source to load</th><th>Series element</th><th>Shunt element</th></tr></thead><tbody>${matches.map((s) => `<tr><td>${s.topology === 'series-shunt' ? 'Series → shunt' : 'Shunt → series'}</td><td>${escape(componentLabel(s.series))}</td><td>${escape(componentLabel(s.shunt))}</td></tr>`).join('')}</tbody></table></div>`);
      } else output('smith-matches', '<p class="footnote">A purely reactive load cannot absorb real power. A finite lossless L match requires positive load resistance.</p>');
      const line = transmissionLineInput({ loadOhms: load, characteristicOhms: number('line-z0'), frequencyHz: frequency, lengthMeters: number('line-length'), velocityFactor: number('line-vf'), attenuationDb: number('line-loss') });
      const zin = line.inputImpedanceOhms;
      output('line-results', result('Input resistance', zin ? fmt(zin.re) : 'Open circuit', zin ? 'Ω' : '') + result('Input reactance', zin ? fmt(zin.im) : '—', 'Ω') + result('Electrical length', fmt(line.electricalLengthDegrees), '°'));
      error('smith-error', '');
    } catch (e) { error('smith-error', e); output('smith-results', ''); output('smith-matches', ''); output('line-results', ''); }
  });
}

function drawFilter(options: ButterworthOptions): void {
  const canvas = document.getElementById('filter-canvas') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d'); if (!canvas || !ctx) return;
  const reference = options.kind === 'bandpass' ? Math.sqrt(options.lowerHz * options.upperHz) : options.cutoffHz;
  const min = reference / 10, max = reference * 10;
  const w = canvas.width, h = canvas.height, left = 60, right = w - 24, top = 22, bottom = h - 48;
  const xAt = (f: number) => left + Math.log10(f / min) / 2 * (right - left);
  const yAt = (db: number) => top + Math.min(80, Math.max(0, -db)) / 80 * (bottom - top);
  ctx.clearRect(0, 0, w, h); ctx.font = '14px monospace'; ctx.strokeStyle = '#2a383d'; ctx.fillStyle = '#9caeb7'; ctx.lineWidth = 1;
  for (let db = 0; db >= -80; db -= 20) { const y = yAt(db); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.fillText(`${db}`, 10, y + 5); }
  for (const factor of [0.1, 0.2, 0.5, 1, 2, 5, 10]) { const f = reference * factor, x = xAt(f); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.fillText(fmt(f / 1e6, 1), x - 16, bottom + 23); }
  ctx.fillText('MHz', right - 22, h - 3);
  ctx.strokeStyle = '#687d69'; ctx.setLineDash([5, 6]); ctx.beginPath(); ctx.moveTo(left, yAt(-3.0103)); ctx.lineTo(right, yAt(-3.0103)); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = '#abf173'; ctx.lineWidth = 3; ctx.beginPath();
  for (let i = 0; i <= 500; i++) { const f = min * 10 ** (2 * i / 500), x = xAt(f), y = yAt(butterworthResponse(options, f).gainDb); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();
}

function bindFilters(): void {
  listen(['filter-kind', 'filter-order', 'filter-cutoff', 'filter-z0', 'filter-lower', 'filter-upper'], () => {
    try {
      const kind = (document.getElementById('filter-kind') as HTMLSelectElement).value as ButterworthOptions['kind'];
      document.querySelectorAll<HTMLElement>('[data-bandpass]').forEach((n) => { n.hidden = kind !== 'bandpass'; });
      const cutoff = document.getElementById('filter-cutoff'); if (cutoff?.parentElement) cutoff.parentElement.hidden = kind === 'bandpass';
      const base = { order: number('filter-order'), impedanceOhms: number('filter-z0') };
      const options: ButterworthOptions = kind === 'bandpass' ? { ...base, kind, lowerHz: number('filter-lower') * 1e6, upperHz: number('filter-upper') * 1e6 } : { ...base, kind, cutoffHz: number('filter-cutoff') * 1e6 };
      const design = butterworthDesign(options);
      output('filter-summary', result('Physical order', String(design.physicalOrder)) + result(kind === 'bandpass' ? 'Centre frequency' : 'Cutoff frequency', fmt(design.centerHz / 1e6, 3), 'MHz') + result('Termination', fmt(design.loadResistanceOhms, 0), 'Ω'));
      output('filter-components', `<table><thead><tr><th>Stage</th><th>Connection</th><th>Element / resonator</th><th>Values</th></tr></thead><tbody>${design.stages.map((s) => `<tr><td>${s.stage}</td><td>${escape(s.connection)}</td><td>${escape(s.arrangement.replaceAll('-', ' '))}</td><td class="mono">${s.components.map(componentLabel).map(escape).join(' + ')}</td></tr>`).join('')}</tbody></table>`);
      drawFilter(options); error('filter-error', '');
    } catch (e) { error('filter-error', e); output('filter-summary', ''); output('filter-components', ''); }
  });
}

function bindFeedlines(): void {
  listen(['feed-length', 'feed-loss', 'feed-power'], () => {
    try { const loss = feedlineLoss(number('feed-length'), number('feed-loss'), number('feed-power')); output('feed-results', result('Cable loss', fmt(loss.lossDb), 'dB') + result('Delivered power', fmt(loss.outputWatts), 'W') + result('Dissipated power', fmt(loss.dissipatedWatts), 'W')); error('feed-error', ''); }
    catch (e) { error('feed-error', e); output('feed-results', ''); }
  });
  const update = (fromDbm = false): void => {
    try {
      const watts = fromDbm ? dbmToWatts(number('unit-dbm')) : number('unit-watts');
      const dbm = wattsToDbm(watts);
      const other = document.getElementById(fromDbm ? 'unit-watts' : 'unit-dbm') as HTMLInputElement;
      other.value = Number.isFinite(fromDbm ? watts : dbm) ? String(Number((fromDbm ? watts : dbm).toPrecision(9))) : '';
      const resonance = lcResonanceHz(number('unit-l') * 1e-6, number('unit-c') * 1e-12);
      output('unit-results', result('Power', fmt(watts, watts < 1 ? 6 : 2), 'W') + result('Power', fmt(dbm), 'dBm') + result('LC resonance', fmt(resonance / 1e6, 4), 'MHz')); error('unit-error', '');
    } catch (e) { error('unit-error', e); output('unit-results', ''); }
  };
  document.getElementById('unit-dbm')?.addEventListener('input', () => update(true));
  for (const id of ['unit-watts', 'unit-l', 'unit-c']) document.getElementById(id)?.addEventListener('input', () => update(false));
  update();
}

function bindContent(): void { ({ antennas: bindAntennas, smith: bindSmith, filters: bindFilters, feedlines: bindFeedlines }[activeTab])(); }
export function bindEngineering(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-engineering-tab]').forEach((button) => button.addEventListener('click', () => {
    activeTab = button.dataset.engineeringTab as Tab;
    document.querySelectorAll<HTMLButtonElement>('[data-engineering-tab]').forEach((tab) => { const selected = tab === button; tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); });
    output('engineering-content', content()); bindContent();
  }));
  bindContent();
}
