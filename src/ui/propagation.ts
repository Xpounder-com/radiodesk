import { greatCirclePath, maidenheadDecode, maidenheadEncode, solarPosition, solarTerminator } from '../propagation/index.ts';
import type { Coordinates } from '../propagation/index.ts';
import land from '../propagation/land.json';
import { icon } from './icons.ts';

const escape = (text: unknown): string => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number, digits = 1): string => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const result = (label: string, value: string, unit = ''): string => `<div><div class="result-label">${escape(label)}</div><div class="result-value">${escape(value)} <small>${escape(unit)}</small></div></div>`;

export function renderPropagation(stationGrid: string): string {
  return `<section id="propagation-workbench" class="grid2"><section class="panel full"><div class="panel-head"><h2>World path &amp; daylight</h2><span class="tag">OFFLINE GEOMETRY</span></div><div class="panel-body"><div class="field-grid"><div class="field"><label for="path-from">Your station · Maidenhead locator</label><input id="path-from" value="${escape(stationGrid)}" placeholder="e.g. EN61ev" maxlength="10" autocomplete="off" spellcheck="false"></div><div class="field"><label for="path-to">Destination · Maidenhead locator</label><input id="path-to" value="IO91wm" placeholder="e.g. IO91wm" maxlength="10" autocomplete="off" spellcheck="false"></div><div class="field"><label for="path-utc">Map date and time · UTC</label><input id="path-utc" type="datetime-local" value="${new Date().toISOString().slice(0, 16)}"></div><div class="field"><label for="path-twilight">Solar boundary</label><select id="path-twilight"><option value="0">Geometric terminator · 0°</option><option value="-6">Civil twilight · −6°</option><option value="-12">Nautical twilight · −12°</option><option value="-18">Astronomical twilight · −18°</option></select></div></div><div class="button-row"><button id="path-now" class="btn">${icon('propagation')} Use current UTC</button><button id="path-reverse" class="btn">Swap stations</button></div><p id="path-error" class="error-inline" role="status"></p><canvas id="path-map" class="map" width="1100" height="550" style="margin-top:16px" aria-label="Latitude and longitude map with calculated night shading, solar terminator and great-circle radio path"></canvas><div id="path-results" class="calc-results four" aria-live="polite"></div><p class="footnote">Offline <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a> land map · equirectangular projection. Paths use locator cell centres and a spherical Earth. Green line: short great circle; pale curve: selected solar boundary; shaded area: geometric night. The destination begins at an example London locator.</p></div></section><section class="panel"><div class="panel-head"><h2>Locator converter</h2>${icon('propagation')}</div><div class="panel-body"><div class="field-grid"><div class="field"><label for="locator-lat">Latitude · degrees north (±)</label><input id="locator-lat" type="number" min="-90" max="90" step="any" placeholder="41.8781"></div><div class="field"><label for="locator-lon">Longitude · degrees east (±)</label><input id="locator-lon" type="number" min="-180" max="180" step="any" placeholder="−87.6298"></div><div class="field"><label for="locator-precision">Locator precision</label><select id="locator-precision"><option value="4">4 characters</option><option value="6" selected>6 characters</option><option value="8">8 characters</option><option value="10">10 characters</option></select></div><div class="field"><label for="locator-text">Decode a locator</label><input id="locator-text" value="${escape(stationGrid)}" placeholder="e.g. EN61ev" maxlength="10" spellcheck="false"></div></div><div id="locator-result" class="calc-results" aria-live="polite"></div><p id="locator-error" class="error-inline" role="status"></p><p class="footnote">A locator defines an area. Decoded latitude and longitude are the centre of that area, with precision set by the character count.</p></div></section><section class="panel"><div class="panel-head"><h2>Solar geometry</h2>${icon('signal')}</div><div class="panel-body"><div id="solar-results" class="calc-results"></div><p class="footnote">Sun position comes from the NOAA fractional year approximation. It describes daylight geometry and does not calculate ionospheric conditions, HF reliability, MUF or signal strength.</p><div class="note">For an HF forecast, combine measured space weather and a propagation model with station power, antennas, season and path. A daylight map alone cannot say whether a band is open.</div></div></section></section>`;
}

function output(id: string, html: string): void { const node = document.getElementById(id); if (node) node.innerHTML = html; }
function message(id: string, error: unknown): void { const node = document.getElementById(id); if (node) node.textContent = error instanceof Error ? error.message : String(error ?? ''); }
function text(id: string): string { return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value; }
function numeric(id: string): number { const value = text(id); if (value.trim() === '' || !Number.isFinite(Number(value))) throw new RangeError('Enter latitude and longitude as numbers'); return Number(value); }

/** Spherical interpolation; skip the ambiguous antipodal route rather than invent one. */
function routePoints(from: Coordinates, to: Coordinates): Coordinates[] {
  if (greatCirclePath(from, to).initialBearingDegrees === null) return [];
  const rad = Math.PI / 180;
  const vector = (p: Coordinates): [number, number, number] => [Math.cos(p.latitude * rad) * Math.cos(p.longitude * rad), Math.cos(p.latitude * rad) * Math.sin(p.longitude * rad), Math.sin(p.latitude * rad)];
  const a = vector(from), b = vector(to);
  const angle = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  if (angle < 1e-8 || Math.abs(Math.PI - angle) < 1e-8) return [];
  const denominator = Math.sin(angle), points: Coordinates[] = [];
  for (let i = 0; i <= 160; i++) {
    const t = i / 160, ca = Math.sin((1 - t) * angle) / denominator, cb = Math.sin(t * angle) / denominator;
    const x = ca * a[0] + cb * b[0], y = ca * a[1] + cb * b[1], z = ca * a[2] + cb * b[2];
    points.push({ latitude: Math.atan2(z, Math.hypot(x, y)) / rad, longitude: Math.atan2(y, x) / rad });
  }
  return points;
}

type LandRing = number[][];
type LandPolygon = LandRing[];
type LandGeometry = { type: 'Polygon'; coordinates: LandPolygon } | { type: 'MultiPolygon'; coordinates: LandPolygon[] };
const landFeatures = (land as unknown as { features: { geometry: LandGeometry }[] }).features;

/** Keep each ring continuous across the dateline, then clip repeated worlds. */
function unwrapLandRing(ring: LandRing, referenceLongitude?: number): LandRing {
  if (ring.length === 0) return [];
  // The Antarctic polygon explicitly closes along the South Pole from −180
  // to +180. That edge spans the map bottom and must not collapse to one point.
  if (ring.some((point) => Math.abs(point[1]!) >= 89.999999)) return ring;
  const first = ring[0]!;
  let previous = first[0]!;
  if (referenceLongitude !== undefined) previous += Math.round((referenceLongitude - previous) / 360) * 360;
  const unwrapped: LandRing = [[previous, first[1]!]];
  for (let i = 1; i < ring.length; i++) {
    const point = ring[i]!;
    let longitude = point[0]!;
    while (longitude - previous > 180) longitude -= 360;
    while (longitude - previous < -180) longitude += 360;
    unwrapped.push([longitude, point[1]!]); previous = longitude;
  }
  return unwrapped;
}

function drawLand(ctx: CanvasRenderingContext2D, xAt: (lon: number) => number, yAt: (lat: number) => number, margin: number, width: number, height: number): void {
  ctx.save(); ctx.beginPath(); ctx.rect(margin, margin, width, height); ctx.clip();
  ctx.fillStyle = '#39484a'; ctx.strokeStyle = '#65797b'; ctx.lineWidth = 0.8;
  for (const feature of landFeatures) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      const exterior = unwrapLandRing(polygon[0] ?? []);
      if (exterior.length === 0) continue;
      const longitudes = exterior.map((point) => point[0]!);
      const reference = (Math.min(...longitudes) + Math.max(...longitudes)) / 2;
      const rings = [exterior, ...polygon.slice(1).map((ring) => unwrapLandRing(ring, reference))];
      for (const offset of [-360, 0, 360]) {
        ctx.beginPath();
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i++) {
            const point = ring[i]!, x = xAt(point[0]! + offset), y = yAt(point[1]!);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
        }
        ctx.fill('evenodd'); ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function drawMap(date: Date, altitude: number, from?: Coordinates, to?: Coordinates, fromLabel = '', toLabel = ''): void {
  const canvas = document.getElementById('path-map') as HTMLCanvasElement | null;
  const ctx = canvas?.getContext('2d'); if (!canvas || !ctx) return;
  const w = canvas.width, h = canvas.height, margin = 40, plotW = w - 2 * margin, plotH = h - 2 * margin;
  const xAt = (lon: number) => margin + (lon + 180) / 360 * plotW;
  const yAt = (lat: number) => margin + (90 - lat) / 180 * plotH;
  const sun = solarPosition(date), rad = Math.PI / 180;
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#182d30'; ctx.fillRect(margin, margin, plotW, plotH);
  drawLand(ctx, xAt, yAt, margin, plotW, plotH);
  // Sample a geometric solar altitude field, using one ephemeris calculation.
  const subLat = sun.subsolar.latitude * rad, subLon = sun.subsolar.longitude * rad;
  for (let y = 0; y < plotH; y += 5) {
    const lat = (90 - (y + 2.5) / plotH * 180) * rad;
    for (let x = 0; x < plotW; x += 5) {
      const lon = (-180 + (x + 2.5) / plotW * 360) * rad;
      const sineElevation = Math.sin(lat) * Math.sin(subLat) + Math.cos(lat) * Math.cos(subLat) * Math.cos(lon - subLon);
      if (sineElevation < 0) { ctx.fillStyle = sineElevation < Math.sin(-18 * rad) ? 'rgba(3,8,16,0.66)' : 'rgba(4,12,19,0.36)'; ctx.fillRect(margin + x, margin + y, Math.min(5, plotW - x), Math.min(5, plotH - y)); }
    }
  }
  ctx.strokeStyle = '#344b50'; ctx.lineWidth = 1; ctx.font = '13px monospace'; ctx.fillStyle = '#9caeb7';
  for (let lon = -180; lon <= 180; lon += 30) { const x = xAt(lon); ctx.beginPath(); ctx.moveTo(x, margin); ctx.lineTo(x, h - margin); ctx.stroke(); if (lon > -180 && lon < 180) ctx.fillText(`${Math.abs(lon)}${lon === 0 ? '°' : lon < 0 ? 'W' : 'E'}`, x - 16, h - 15); }
  for (let lat = -60; lat <= 60; lat += 30) { const y = yAt(lat); ctx.beginPath(); ctx.moveTo(margin, y); ctx.lineTo(w - margin, y); ctx.stroke(); ctx.fillText(`${Math.abs(lat)}${lat === 0 ? '°' : lat > 0 ? 'N' : 'S'}`, 3, y + 4); }
  const curve = (points: Coordinates[], stroke: string, lineWidth: number): void => {
    ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.beginPath(); let previousX: number | null = null;
    for (const point of points) { const x = xAt(point.longitude), y = yAt(point.latitude); if (previousX === null || Math.abs(x - previousX) > plotW / 2) ctx.moveTo(x, y); else ctx.lineTo(x, y); previousX = x; }
    ctx.stroke();
  };
  curve(solarTerminator(date, 360, altitude), '#7a919c', 2);
  if (from && to) curve(routePoints(from, to), '#abf173', 3);
  const marker = (point: Coordinates, label: string, color: string): void => {
    const x = xAt(point.longitude), y = yAt(point.latitude); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.font = 'bold 14px monospace';
    const width = ctx.measureText(label).width; const tx = Math.max(margin + 6, Math.min(w - margin - width - 6, x + 10)); ctx.fillText(label, tx, Math.max(margin + 16, y - 9));
  };
  marker(sun.subsolar, 'Sun', '#d4bd70');
  if (from) marker(from, fromLabel, '#abf173'); if (to) marker(to, toLabel, '#c6e5f0');
  ctx.font = '12px monospace'; ctx.fillStyle = '#9caeb7'; ctx.fillText(`${sun.timestamp.slice(0, 16).replace('T', ' ')} UTC`, margin, 21);
  ctx.strokeStyle = '#40535b'; ctx.lineWidth = 1; ctx.strokeRect(margin, margin, plotW, plotH);
}

export function bindPropagation(): void {
  const updatePath = (): void => {
    try {
      const rawDate = text('path-utc'); if (!rawDate) throw new RangeError('Enter a UTC date and time');
      const date = new Date(`${rawDate}Z`), altitude = Number(text('path-twilight'));
      const sun = solarPosition(date);
      output('solar-results', result('Subsolar latitude', fmt(sun.subsolar.latitude, 2), '°') + result('Subsolar longitude', fmt(sun.subsolar.longitude, 2), '°') + result('Equation of time', fmt(sun.equationOfTimeMinutes, 2), 'min'));
      let from: ReturnType<typeof maidenheadDecode> | undefined, to: ReturnType<typeof maidenheadDecode> | undefined;
      let pathError = '';
      try {
        if (!text('path-from').trim()) throw new RangeError('Enter your station locator to calculate a path.');
        from = maidenheadDecode(text('path-from')); to = maidenheadDecode(text('path-to'));
        const path = greatCirclePath(from, to);
        output('path-results', result('Short path', fmt(path.distanceKm, 0), 'km') + result('Initial bearing', path.initialBearingDegrees === null ? 'Undefined' : fmt(path.initialBearingDegrees), '°') + result('Long path', fmt(path.longPathDistanceKm, 0), 'km') + result('Long path bearing', path.longPathBearingDegrees === null ? 'Undefined' : fmt(path.longPathBearingDegrees), '°'));
      } catch (e) { pathError = e instanceof Error ? e.message : String(e); output('path-results', ''); }
      drawMap(date, altitude, from, to, from?.locator, to?.locator); message('path-error', pathError);
    } catch (e) { message('path-error', e); output('path-results', ''); output('solar-results', ''); }
  };
  for (const id of ['path-from', 'path-to', 'path-utc', 'path-twilight']) document.getElementById(id)?.addEventListener('input', updatePath);
  document.getElementById('path-now')?.addEventListener('click', () => { (document.getElementById('path-utc') as HTMLInputElement).value = new Date().toISOString().slice(0, 16); updatePath(); });
  document.getElementById('path-reverse')?.addEventListener('click', () => { const from = document.getElementById('path-from') as HTMLInputElement, to = document.getElementById('path-to') as HTMLInputElement; const old = from.value; from.value = to.value; to.value = old; updatePath(); });
  const updateLocator = (decode = false): void => {
    try {
      const grid = decode ? maidenheadDecode(text('locator-text')) : maidenheadDecode(maidenheadEncode(numeric('locator-lat'), numeric('locator-lon'), Number(text('locator-precision'))));
      if (!decode) (document.getElementById('locator-text') as HTMLInputElement).value = grid.locator;
      else { (document.getElementById('locator-lat') as HTMLInputElement).value = String(Number(grid.latitude.toFixed(8))); (document.getElementById('locator-lon') as HTMLInputElement).value = String(Number(grid.longitude.toFixed(8))); }
      output('locator-result', result('Locator', grid.locator) + result('Centre latitude', fmt(grid.latitude, 5), '°') + result('Centre longitude', fmt(grid.longitude, 5), '°'));
      message('locator-error', '');
    } catch (e) { message('locator-error', e); output('locator-result', ''); }
  };
  for (const id of ['locator-lat', 'locator-lon', 'locator-precision']) document.getElementById(id)?.addEventListener('input', () => updateLocator());
  document.getElementById('locator-text')?.addEventListener('input', () => updateLocator(true));
  if (text('locator-text').trim()) updateLocator(true);
  updatePath();
}
