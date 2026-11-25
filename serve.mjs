// Zero-dependency static file server for the clustered-light lab.
// Usage: node serve.mjs [port]
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PREFERRED = Number(process.argv[2]) || Number(process.env.PORT) || 5180;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    // Resolve and confine to ROOT.
    const filePath = path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');
    if (!existsSync(filePath)) return send(res, 404, 'Not found: ' + pathname);
    const data = await readFile(filePath);
    send(res, 200, data, MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  } catch (err) {
    send(res, 500, 'Server error: ' + (err && err.message ? err.message : String(err)));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    server.listen(0); // fall back to an ephemeral port
  } else {
    console.error(err);
    process.exit(1);
  }
});

server.listen(PREFERRED, () => {
  const port = server.address().port;
  console.log('');
  console.log('  夜市 · 分簇灯光实验室  (clustered forward renderer)');
  console.log('  ---------------------------------------------------');
  console.log(`  Interface : http://localhost:${port}/`);
  console.log(`  Root      : ${ROOT}`);
  console.log('  Headless correctness + image report: npm run verify');
  console.log('');
});
