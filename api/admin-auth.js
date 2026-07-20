// Vercel Serverless Function — admin login check.
// Moves the password comparison server-side so the real credential isn't
// sitting in public client-side JS. Falls back to the original demo
// credentials only if ADMIN_USER/ADMIN_PASSWORD aren't set, so local dev
// still works out of the box — set real values in Vercel env vars for
// anything beyond a demo.
//
// Note: this only protects the *credential value* from being publicly
// readable. admin.html itself is still a static file with no protected API
// calls behind it, so the page content isn't truly access-controlled — for
// that, use Vercel's Deployment Protection / Edge Middleware on top of this.
const { ADMIN_USER = 'admin', ADMIN_PASSWORD = 'brightnext2026' } = process.env;

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }

  const { username, password } = body || {};
  const ok = username === ADMIN_USER && password === ADMIN_PASSWORD;
  res.status(ok ? 200 : 401).json({ ok });
};
