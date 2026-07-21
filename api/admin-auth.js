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

// Best-effort in-memory brute-force throttle (per cold-start instance only —
// Vercel may run multiple instances, so this isn't a substitute for a real
// rate-limit service, but it adds real friction for casual guessing).
const attempts = {}; // ip -> { count, windowStart }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

module.exports = function handler(req, res) {
  // No CORS header: this is only ever called same-origin from admin.html —
  // omitting it means browsers block any other site's cross-origin attempt
  // to probe credentials through a visitor.
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = attempts[ip];
  if (entry && now - entry.windowStart < WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
    return res.status(429).json({ ok: false, error: 'Too many attempts — try again later.' });
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }

  const { username, password } = body || {};
  const ok = username === ADMIN_USER && password === ADMIN_PASSWORD;

  if (ok) {
    delete attempts[ip];
  } else {
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      attempts[ip] = { count: 1, windowStart: now };
    } else {
      entry.count++;
    }
  }

  res.status(ok ? 200 : 401).json({ ok });
};
