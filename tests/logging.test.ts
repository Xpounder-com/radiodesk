import test from 'node:test';
import assert from 'node:assert/strict';
import { exportAdif, parseAdif } from '../src/logging/adif.ts';
import { validateQso, type Qso } from '../src/logging/qsos.ts';
const qso: Qso = {id:'fixture',call:'K1ABC',timestamp:'2026-10-12T03:41:00Z',frequency:14074000,mode:'USB',rstSent:'59',rstReceived:'57',grid:'FN31',name:'Alex',comment:'A <test> comment',stationCall:'W9ABC'};
test('ADIF round trip keeps UTC, MHz, SSB submode, and tag-like comment',()=> { const result=parseAdif(exportAdif([qso])); assert.equal(result.errors.length,0); const {id,...actual}=result.qsos[0]; const {id:original,...expected}=qso; assert.deepEqual(actual,{...expected,timestamp:'2026-10-12T03:41:00Z'}); });
test('ADIF official example preserves band-only data without inventing frequency',()=>{ const result=parseAdif('<call:6>WN4AZY<band:3>20M<mode:4>RTTY<qso_date:8>19960513<time_on:4>1305<eor>'); assert.equal(result.qsos[0].timestamp,'1996-05-13T13:05:00Z'); assert.equal(result.qsos[0].frequency,null); assert.equal(result.qsos[0].band,'20m'); assert.ok(!exportAdif(result.qsos).includes('<FREQ:')); });
test('ADIF rejects a non-existent date and truncated lengths',()=>{ assert.equal(parseAdif('<CALL:5>K1ABC<QSO_DATE:8>20260230<TIME_ON:4>1200<FREQ:6>14.074<MODE:2>CW<EOR>').errors.length,1); assert.throws(()=>parseAdif('<CALL:100>K1ABC')); });
test('callsigns normalize and invalid grid rejected',()=>{ assert.equal(validateQso({...qso,call:' k1abc '}).call,'K1ABC'); assert.throws(()=>validateQso({...qso,grid:'ZZ99'})); });
test('log modes reject HTML and map digital submodes to ADIF parent modes',()=>{ assert.throws(()=>validateQso({...qso,mode:'<img src=x onerror=alert(1)>'})); assert.ok(exportAdif([{...qso,mode:'FT4'}]).includes('<MODE:4>MFSK<SUBMODE:3>FT4')); assert.ok(exportAdif([{...qso,mode:'PSK31'}]).includes('<MODE:3>PSK<SUBMODE:5>PSK31')); assert.ok(!exportAdif([{...qso,mode:'SSB'}]).includes('SUBMODE')); });

test('generic receiver DATA mode is preserved as application metadata, not a fabricated modem',()=>{const text=exportAdif([{...qso,mode:'DATA-USB'}]);assert.ok(!text.includes('<MODE:'));assert.ok(text.includes('<APP_RADIODESK_MODE:8>DATA-USB'));assert.equal(parseAdif(text).qsos[0].mode,'DATA-USB');});
test('ADI export is ASCII and preserves international text in app metadata',()=>{const original={...qso,name:'José',comment:'سلام 👋\n73'};const text=exportAdif([original]);assert.ok(!/[^\x00-\x7f]/.test(text));const restored=parseAdif(text).qsos[0];assert.equal(restored.name,original.name);assert.equal(restored.comment,original.comment);});
