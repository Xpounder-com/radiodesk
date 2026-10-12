import { bandForQso, validateQso, type Qso } from './qsos.ts';
function field(key: string, value: string): string { return value ? `<${key}:${Array.from(value).length}>${value}` : ''; }
const ADIF_MODES=new Set('AM ARDOP ATV CHIP CLO CONTESTI CW DIGITALVOICE DOMINO DYNAMIC FAX FM FSK441 FT8 HELL ISCAT JT4 JT6M JT9 JT44 JT65 MFSK MSK144 MT63 OLIVIA OPERA PAC PAX PKT PSK PSK2K Q15 QRA64 ROS RTTY RTTYM SSB SSTV T10 THOR THRB TOR V4 VOI WINMOR WSPR'.split(' '));
function ascii(value:string):string{return value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,'?');}
export function exportAdif(qsos: Qso[]): string {
  const header = `RadioDesk local station log\n<ADIF_VER:5>3.1.5<PROGRAMID:9>RadioDesk<PROGRAMVERSION:5>0.1.0<EOH>\n`;
  return header + qsos.map(qso => {
    const utc = new Date(qso.timestamp).toISOString();
    const mappings:Record<string,[string,string]>={USB:['SSB','USB'],LSB:['SSB','LSB'],SSB:['SSB',''],FT4:['MFSK','FT4'],PSK31:['PSK','PSK31'],'FM-N':['FM',''],'AM-N':['AM',''],'CW-R':['CW',''],'RTTY-USB':['RTTY',''],'RTTY-LSB':['RTTY','']};
    const unresolved=!mappings[qso.mode]&&!ADIF_MODES.has(qso.mode);
    const [mode,submode]=unresolved?['','']:mappings[qso.mode]??[qso.mode,''];
    const band=bandForQso(qso);
    const specialText=/[^\x20-\x7e]/.test(qso.name+qso.comment);
    const preservedText=specialText?JSON.stringify({name:qso.name,comment:qso.comment}).replace(/[^\x20-\x7e]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`):'';
    const fields: Record<string,string> = {CALL:qso.call,QSO_DATE:utc.slice(0,10).replaceAll('-',''),TIME_ON:utc.slice(11,19).replaceAll(':',''),FREQ:qso.frequency === null?'':(qso.frequency/1e6).toFixed(6),BAND:['General coverage','Unknown band'].includes(band)?'':band,MODE:mode,SUBMODE:submode,APP_RADIODESK_MODE:unresolved?qso.mode:'',RST_SENT:ascii(qso.rstSent),RST_RCVD:ascii(qso.rstReceived),GRIDSQUARE:qso.grid,NAME:ascii(qso.name),COMMENT:ascii(qso.comment),APP_RADIODESK_TEXT:preservedText,STATION_CALLSIGN:ascii(qso.stationCall)};
    return Object.entries(fields).map(([k,v])=>field(k,v)).join('')+'<EOR>';
  }).join('\n');
}
export function parseAdif(text: string): { qsos: Qso[]; errors: string[] } {
  if (text.length > 20_000_000) throw new Error('ADIF file exceeds 20 MB.');
  const chars = Array.from(text); const qsos: Qso[] = []; const errors: string[] = []; let record: Record<string,string> = {}; let index=0; let row=0;
  while (index < chars.length) {
    if (chars[index] !== '<') { index++; continue; }
    const end = chars.indexOf('>', index+1); if (end < 0) throw new Error('Unterminated ADIF tag.');
    const tag = chars.slice(index+1,end).join('').toUpperCase(); index=end+1;
    if (tag === 'EOH') { record={}; continue; }
    if (tag === 'EOR') {
      row++; try {
        const date = record.QSO_DATE ?? ''; const time = (record.TIME_ON ?? '').padEnd(6,'0');
        if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) throw new Error('missing or invalid UTC date/time');
        const timestamp = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${time.slice(0,2)}:${time.slice(2,4)}:${time.slice(4,6)}Z`;
        if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString().slice(0,10).replaceAll('-','') !== date) throw new Error('invalid UTC calendar date');
        const frequency = record.FREQ ? Number(record.FREQ)*1e6 : null;
        const preserved=record.APP_RADIODESK_TEXT?JSON.parse(record.APP_RADIODESK_TEXT) as {name:string;comment:string}:null;
        qsos.push(validateQso({id:globalThis.crypto.randomUUID(), call:record.CALL??'',timestamp,frequency,...(frequency===null?{band:record.BAND?.toLowerCase()}:{}),mode:record.SUBMODE || record.MODE || record.APP_RADIODESK_MODE || '',rstSent:record.RST_SENT??'',rstReceived:record.RST_RCVD??'',grid:record.GRIDSQUARE??'',name:preserved?.name??record.NAME??'',comment:preserved?.comment??record.COMMENT??'',stationCall:record.STATION_CALLSIGN??''}));
      } catch(error) { errors.push(`Record ${row}: ${error instanceof Error ? error.message : String(error)}`); }
      record={}; continue;
    }
    const match = /^([A-Z0-9_]+):(\d+)(?::[A-Z])?$/.exec(tag);
    if (!match) continue;
    const count=Number(match[2]); if (count > 1_000_000 || index+count > chars.length) throw new Error(`Invalid length for ${match[1]}.`);
    record[match[1]]=chars.slice(index,index+count).join(''); index+=count;
  }
  if (Object.keys(record).some(key=>key==='CALL')) errors.push('Final record is missing <EOR>.');
  return {qsos,errors};
}
