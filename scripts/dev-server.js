// Minimal local dev server that mirrors vercel.json routing:
//   /api/*  -> serverless functions in ../api
//   /*      -> static files under "../BrightNext Website"
// For local development only; production uses Vercel.
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.join(__dirname, '..');
const STATIC_DIR = path.join(ROOT, 'BrightNext Website');
const API_DIR = path.join(ROOT, 'api');

// ── Load .env so local dev sees the same vars as Vercel's env config ──
const ENV_PATH = path.join(ROOT, '.env');
if (fs.existsSync(ENV_PATH)) {
  let envContent = fs.readFileSync(ENV_PATH, 'utf8');
  if (envContent.charCodeAt(0) === 0xFEFF) envContent = envContent.slice(1); // strip BOM (Notepad UTF-8)
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function makeRes(res) {
  // Shim the Vercel/Express-style helpers the handler expects.
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
  return res;
}

const server = http.createServer(async (req, res) => {
  makeRes(res);
  const parsed = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    const name = pathname.replace('/api/', '').replace(/\/$/, '');
    const file = path.join(API_DIR, name + '.js');
    if (!fs.existsSync(file)) { res.status(404).json({ error: 'No such function: ' + name }); return; }
    try {
      const handler = require(file);
      req.query = parsed.query;
      await handler(req, res);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(STATIC_DIR, pathname);
  if (!filePath.startsWith(STATIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.statusCode = 404; res.end('Not found'); return;
  }
  res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => console.log('Dev server on http://localhost:' + PORT));
