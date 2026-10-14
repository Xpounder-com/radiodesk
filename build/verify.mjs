import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';

const html = await readFile('dist/radiodesk.html', 'utf8');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.match(html, /^<!doctype html>/i);
assert.equal((html.match(/<script>/g) || []).length, 1, 'one inline application script');
assert.equal((html.match(/<style>/g) || []).length, 1, 'one inline stylesheet');
assert.ok(!/<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=|<img\b[^>]*\bsrc\s*=/i.test(html), 'no external runtime assets');
assert.ok(!/\burl\(\s*["']?https?:/i.test(html), 'no remote CSS asset');
assert.match(html, /<div id="app"><\/div>/, 'no embedded user data in the application root');
assert.ok(html.includes(`RadioDesk v${pkg.version}`), 'application version matches package version');

const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
assert.ok(script, 'inline application code exists');
new vm.Script(script, { filename: 'radiodesk-inline.js' });
const ast = ts.createSourceFile('radiodesk-inline.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const strings = new Set();
const workspaceIds = ['station', 'signal', 'sdr', 'digital', 'engineering', 'logbook', 'propagation', 'devices'];
const cases = new Set();
let navigationFound = false;
const stringValue = node => node && ts.isStringLiteralLike(node) ? node.text : null;
const propertyValue = (object, name) => {
  if (!ts.isObjectLiteralExpression(object)) return null;
  const property = object.properties.find(p => ts.isPropertyAssignment(p) && ((ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === name));
  return property && ts.isPropertyAssignment(property) ? stringValue(property.initializer) : null;
};
function visit(node) {
  if (ts.isStringLiteralLike(node)) strings.add(node.text);
  if (ts.isCaseClause(node)) { const value = stringValue(node.expression); if (value !== null) cases.add(value); }
  if (ts.isArrayLiteralExpression(node) && node.elements.length === workspaceIds.length) {
    const ids = node.elements.map(element => propertyValue(element, 'id'));
    if (workspaceIds.every(id => ids.includes(id)) && node.elements.every(element => propertyValue(element, 'label') !== null)) navigationFound = true;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(navigationFound, 'all eight workspaces are wired in navigation');
for (const id of workspaceIds) assert.ok(cases.has(id), `workspace rendering case is missing: ${id}`);
assert.ok(strings.has('radiodesk-hamlib-v1'), 'the Hamlib client protocol is embedded in the single HTML');

const wasm = await readFile('wasm/ftx.wasm');
const wasmBase64 = wasm.toString('base64');
const manifest = JSON.parse(await readFile('wasm/ftx-build.json', 'utf8'));
assert.ok(WebAssembly.validate(wasm), 'FT8/FT4 binary is valid WebAssembly');
assert.equal(createHash('sha256').update(wasm).digest('hex'), manifest.wasmSha256, 'FT8/FT4 binary matches its build manifest');
assert.ok(html.includes(wasmBase64), 'exact FT8/FT4 WebAssembly bytes are embedded in the single HTML');
assert.ok(!html.includes('191111_110145.wav') && !html.includes('000000_000002.wav'), 'independent test recordings are not runtime assets');

const workers = [
  { name: 'CW/RTTY WAV decoder', entry: 'src/digital/decoder-worker.ts' },
  { name: 'wideband SDR IQ', entry: 'src/sdr/worker-entry.ts' },
  { name: 'FT8/FT4 WASM modem', entry: 'src/digital/ftx/worker.ts', define: { __RADIODESK_FTX_WASM__: JSON.stringify(wasmBase64) } },
];
const bundles = await Promise.all(workers.map(worker => build({ entryPoints: [worker.entry], bundle: true, write: false, format: 'iife', target: 'es2022', minify: true, ...(worker.define ? { define: worker.define } : {}) })));
for (let i = 0; i < workers.length; i++) {
  const source = bundles[i].outputFiles[0].text;
  new vm.Script(source, { filename: workers[i].entry });
  assert.ok(strings.has(source), `compiled ${workers[i].name} worker is embedded as source, without a runtime download`);
}

const notices = ['LICENSE', 'vendor/ft8_lib/LICENSE', 'vendor/ft8_lib/fft/LICENSE-BSD-3-Clause', 'wasm/LICENSE-Emscripten', 'wasm/LICENSE-musl', 'wasm/LICENSE-math'];
const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1];
assert.ok(head, 'document head exists');
for (const path of notices) {
  const notice = (await readFile(path, 'utf8')).replaceAll('--', '—');
  assert.ok(head.includes(path) && head.includes(notice), `license notice stays inside the document so portable HTML export preserves it: ${path}`);
}

console.log(`RadioDesk ${pkg.version} artifact verified: eight workspaces, three compiled workers, embedded FT8/FT4 WASM and complete license notices. One inline script/style; no external runtime assets or embedded station DOM.`);
