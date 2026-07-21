// One-off CLI: fetch your real Amazon listings (SKU, ASIN, title) so you don't
// have to hunt through Seller Central manually. Requires .env with LWA_CLIENT_ID,
// LWA_CLIENT_SECRET, LWA_REFRESH_TOKEN (MARKETPLACE_ID optional, defaults to UK).
//
// Usage:  node scripts/list-asins.js
//
// Unlike api/amazon.js (which never blocks a serverless request waiting on
// Amazon's async report generation), this script is a one-off run from your
// own machine, so it's fine to poll until the report is actually ready.
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
require('./load-env')(ROOT);

const api = require(path.join(ROOT, 'api', 'amazon.js'));
const { SP_API_HOST, getAccessToken, spApiGet, spApiPost } = api;

const MARKETPLACE_ID = process.env.MARKETPLACE_ID || 'A1F83G8C2ARO7P';

// Keywords to suggest a match against BrightNext's known products — edit this
// list if your catalog changes, or just eyeball the full listing printed below.
const KNOWN_PRODUCTS = [
  { name: 'Pet Hair Remover', keywords: ['pet', 'hair'] },
  { name: 'Magnetic Phone Holder Mount', keywords: ['magnetic', 'holder', 'mount'] },
  { name: 'Smart Cable Organiser', keywords: ['cable', 'magnetic'] },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function createListingsReport(accessToken) {
  const res = await spApiPost('/reports/2021-06-30/reports', {
    reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
    marketplaceIds: [MARKETPLACE_ID],
  }, accessToken);
  return res.reportId;
}

async function pollUntilDone(accessToken, reportId, { attempts = 20, intervalMs = 15000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const status = await spApiGet(`/reports/2021-06-30/reports/${reportId}`, {}, accessToken);
    process.stdout.write(`  poll ${i + 1}/${attempts}: ${status.processingStatus}\n`);
    if (status.processingStatus === 'DONE') return status.reportDocumentId;
    if (status.processingStatus === 'FATAL' || status.processingStatus === 'CANCELLED') {
      throw new Error(`Report ${status.processingStatus.toLowerCase()}`);
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for report to finish — try again later, or increase `attempts` in this script.');
}

function httpsGetBuffer(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 400) return reject(new Error(`Download failed: ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function parseTsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM — corrupts the first header otherwise
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split('\t').map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function suggestMatch(title) {
  const lower = (title || '').toLowerCase();
  const hit = KNOWN_PRODUCTS.find(p => p.keywords.every(k => lower.includes(k)) || p.keywords.some(k => lower.includes(k)));
  return hit ? hit.name : null;
}

(async () => {
  const missing = ['LWA_CLIENT_ID', 'LWA_CLIENT_SECRET', 'LWA_REFRESH_TOKEN'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error('Missing from .env:', missing.join(', '));
    process.exit(1);
  }

  console.log('Requesting your Amazon listings report...');
  const accessToken = await getAccessToken();
  const reportId = await createListingsReport(accessToken);
  console.log('Report requested (id:', reportId + ') — polling until ready (this can take a minute or two)...');

  const reportDocumentId = await pollUntilDone(accessToken, reportId);
  const doc = await spApiGet(`/reports/2021-06-30/documents/${reportDocumentId}`, {}, accessToken);

  let buf = await httpsGetBuffer(doc.url);
  if (doc.compressionAlgorithm === 'GZIP') buf = zlib.gunzipSync(buf);

  const text = buf.toString('utf8');
  const rows = parseTsv(text);
  const headerLine = (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text).split(/\r?\n/)[0];
  console.log('\nColumns in this report:', headerLine.split('\t').join(', '));

  console.log(`\nFound ${rows.length} listing(s):\n`);
  console.log('SKU'.padEnd(24), 'PRICE'.padEnd(10), 'ASIN'.padEnd(14), 'TITLE');
  console.log('-'.repeat(100));

  for (const row of rows) {
    const sku = row['seller-sku'] || '';
    const asin = row['asin1'] || '';
    const price = row['price'] || '';
    const title = row['item-name'] || '';
    const match = suggestMatch(title);
    console.log(
      sku.padEnd(24),
      price.padEnd(10),
      asin.padEnd(14),
      title.slice(0, 50) + (match ? `  <-- looks like "${match}"` : '')
    );
  }

  console.log('\nCopy the ASIN (and price, if shown) for each matched product into PRODUCTS in');
  console.log('"BrightNext Website/brightnext-amazon-dashboard.html".');
})().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
