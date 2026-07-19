// Loads .env into process.env (if present) — shared by dev-server.js and one-off
// scripts. Node doesn't read .env files automatically, and this project avoids
// adding a dotenv dependency for a handful of key=value lines.
const fs = require('fs');
const path = require('path');

module.exports = function loadEnv(root) {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;

  let content = fs.readFileSync(envPath, 'utf8');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1); // strip BOM (Notepad UTF-8)

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
};
