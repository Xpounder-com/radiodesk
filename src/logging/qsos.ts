export interface Qso {
  id: string; call: string; timestamp: string; frequency: number | null; mode: string; band?: string;
  rstSent: string; rstReceived: string; grid: string; name: string; comment: string;
  stationCall: string;
}
export const BANDS = [
  { label:'160m', low:1.8e6, high:2e6, memory:1.84e6 }, { label:'80m', low:3.5e6, high:4e6, memory:3.573e6 },
  { label:'60m', low:5.25e6, high:5.45e6, memory:5.357e6 }, { label:'40m', low:7e6, high:7.3e6, memory:7.074e6 },
  { label:'30m', low:10.1e6, high:10.15e6, memory:10.136e6 }, { label:'20m', low:14e6, high:14.35e6, memory:14.074e6 },
  { label:'17m', low:18.068e6, high:18.168e6, memory:18.1e6 }, { label:'15m', low:21e6, high:21.45e6, memory:21.074e6 },
  { label:'12m', low:24.89e6, high:24.99e6, memory:24.915e6 }, { label:'10m', low:28e6, high:29.7e6, memory:28.074e6 },
  { label:'6m', low:50e6, high:54e6, memory:50.313e6 }, { label:'2m', low:144e6, high:148e6, memory:144.2e6 }
];
export function bandForFrequency(hz: number): string { return BANDS.find(b => hz >= b.low && hz <= b.high)?.label ?? 'General coverage'; }
export function bandForQso(qso:Qso):string { return qso.frequency === null ? qso.band ?? 'Unknown band' : bandForFrequency(qso.frequency); }
export function validateQso(qso: Qso): Qso {
  for (const key of ['call','timestamp','mode','rstSent','rstReceived','grid','name','comment','stationCall'] as const) if(typeof qso[key] !== 'string') throw new Error(`Invalid contact field: ${key}.`);
  const call = qso.call.trim().toUpperCase();
  if (!/^[A-Z0-9/]{3,20}$/.test(call) || !/[A-Z]/.test(call) || !/[0-9]/.test(call)) throw new Error('Enter a callsign containing letters and numbers.');
  if (qso.frequency === null) { if(!BANDS.some(b=>b.label.toLowerCase()===qso.band?.toLowerCase())) throw new Error('A band is required when frequency is unknown.'); }
  else if (!Number.isFinite(qso.frequency) || qso.frequency <= 0) throw new Error('Frequency must be positive.');
  if (!Number.isFinite(Date.parse(qso.timestamp))) throw new Error('Invalid QSO date.');
  const mode=qso.mode.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9 -]{0,19}$/.test(mode)) throw new Error('Enter a valid radio mode.');
  if (qso.grid && !/^[A-R]{2}[0-9]{2}([A-X]{2})?([0-9]{2})?$/i.test(qso.grid)) throw new Error('Enter a 4, 6, or 8 character Maidenhead locator.');
  return {...qso, call, mode, grid:qso.grid.toUpperCase()};
}
export function contactIdentity(qso: Qso): string { return `${qso.call}|${new Date(qso.timestamp).toISOString()}|${qso.frequency ?? qso.band}|${qso.mode}`; }
