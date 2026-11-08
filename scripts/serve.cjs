const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');

const DIST = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 5123);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.sf2': 'application/octet-stream',
  '.sf3': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

http
  .createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(DIST)) {
        res.writeHead(403).end();
        return;
      }
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      const data = await fs.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`serving ${DIST} on http://127.0.0.1:${PORT}`));