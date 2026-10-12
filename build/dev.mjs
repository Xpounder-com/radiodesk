import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const port = Number(process.env.PORT || 4173);
createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  try {
    const build = spawnSync(process.execPath, ['build/build.mjs'], { encoding:'utf8' });
    if (build.status !== 0) throw new Error(build.stderr);
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' });
    res.end(await readFile('dist/radiodesk.html'));
  } catch(error) { res.writeHead(500); res.end(String(error)); }
}).listen(port, '127.0.0.1', () => console.log(`RadioDesk: http://127.0.0.1:${port}`));
