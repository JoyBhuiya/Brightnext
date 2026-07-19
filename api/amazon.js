// Vercel Serverless Function — Amazon SP-API proxy
// Keeps LWA credentials server-side; browser never sees them.
// SP-API no longer requires AWS SigV4 signing — LWA access token auth only.

const https = require('https');
const zlib = require('zlib');

const {
  LWA_CLIENT_ID,
  LWA_CLIENT_SECRET,
  LWA_REFRESH_TOKEN,
  MARKETPLACE_ID = 'A1F83G8C2ARO7P', // UK marketplace default
} = process.env;

const TIME_ZONE = 'Europe/London'; // matches default UK marketplace; align with your account's timezone

// ── Simple in-memory token cache (valid per cold-start) ──
let cachedToken = null;
let tokenExpiry = 0;

// ── Simple in-memory data cache (15 min TTL) ──
const dataCache = {};
const CACHE_TTL = 15 * 60 * 1000;

// ── Per-ASIN report lifecycle cache (report generation is async on Amazon's
// side and can take anywhere from seconds to a few minutes — never block a
// request waiting for it; advance the state machine by one step per request
// and let the next request, e.g. the 15-min auto-refresh, pick up the result) ──
const reportsCache = {}; // key -> { status: 'pending'|'ready', reportId, products, ts }
const REPORT_CACHE_TTL = 30 * 60 * 1000;

// ── LWA: exchange refresh token for access token ──
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: LWA_REFRESH_TOKEN,
    client_id: LWA_CLIENT_ID,
    client_secret: LWA_CLIENT_SECRET,
  }).toString();

  const data = await httpsPost('api.amazon.com', '/auth/o2/token', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
  });

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── SP-API request helpers ──
const SP_API_HOST = 'sellingpartnerapi-eu.amazon.com';

async function spApiGet(path, queryParams, accessToken) {
  const qs = new URLSearchParams(queryParams).toString();
  return httpsGet(SP_API_HOST, `${path}?${qs}`, { 'x-amz-access-token': accessToken });
}

async function spApiPost(path, body, accessToken) {
  return httpsPostJson(SP_API_HOST, path, body, { 'x-amz-access-token': accessToken });
}

// ── Timezone-aware date helpers (no external deps) ──
// Seller Central reports "last 7/30/90 days" and "YTD" using the account's own
// local calendar days. Slicing plain UTC dates can shift the window by up to a
// day versus Seller Central depending on time of year (BST/GMT), which shows
// up as mismatched totals. These helpers compute boundaries in TIME_ZONE instead.
function ymdInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function startOfDayUTC(ymd, timeZone) {
  const naiveUTC = new Date(`${ymd}T00:00:00Z`);
  const asZoneWallClock = new Date(naiveUTC.toLocaleString('en-US', { timeZone }));
  const asUTCWallClock = new Date(naiveUTC.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = asUTCWallClock.getTime() - asZoneWallClock.getTime();
  return new Date(naiveUTC.getTime() + offsetMs);
}

// Accepts '7d' / '30d' / '90d' / 'ytd' (or bare numbers); returns { startDate, endDate, key }.
function computeInterval(rangeParam) {
  const now = new Date();
  const key = rangeParam === 'ytd' ? 'ytd' : `${parseInt(rangeParam, 10) || 30}d`;

  if (key === 'ytd') {
    const year = ymdInZone(now, TIME_ZONE).slice(0, 4);
    return { startDate: startOfDayUTC(`${year}-01-01`, TIME_ZONE), endDate: now, key };
  }

  const days = parseInt(key, 10);
  const startYmd = ymdInZone(new Date(now.getTime() - days * 86400000), TIME_ZONE);
  return { startDate: startOfDayUTC(startYmd, TIME_ZONE), endDate: now, key };
}

// ── Fetch order metrics (revenue + units by ASIN) ──
async function fetchSalesMetrics(accessToken, interval) {
  return spApiGet('/sales/v1/orderMetrics', {
    marketplaceIds: MARKETPLACE_ID,
    interval: `${interval.startDate.toISOString()}--${interval.endDate.toISOString()}`,
    granularity: 'Total',
    granularityTimeZone: TIME_ZONE,
  }, accessToken);
}

// ── Fetch recent orders (for return rate estimation) ──
async function fetchOrders(accessToken, interval) {
  return spApiGet('/orders/v0/orders', {
    MarketplaceIds: MARKETPLACE_ID,
    CreatedAfter: interval.startDate.toISOString(),
    OrderStatuses: 'Shipped,Unshipped,PartiallyShipped',
  }, accessToken);
}

// ── Reports API: real per-ASIN units + revenue (Business Reports data) ──
async function createSalesReport(accessToken, interval) {
  const res = await spApiPost('/reports/2021-06-30/reports', {
    reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
    marketplaceIds: [MARKETPLACE_ID],
    dataStartTime: interval.startDate.toISOString(),
    dataEndTime: interval.endDate.toISOString(),
  }, accessToken);
  return res.reportId;
}

async function getReportStatus(accessToken, reportId) {
  return httpsGet(SP_API_HOST, `/reports/2021-06-30/reports/${reportId}`, { 'x-amz-access-token': accessToken });
}

async function getReportDocument(accessToken, reportDocumentId) {
  return httpsGet(SP_API_HOST, `/reports/2021-06-30/documents/${reportDocumentId}`, { 'x-amz-access-token': accessToken });
}

async function downloadAndParseReport(doc) {
  let buf = await httpsGetBuffer(doc.url);
  if (doc.compressionAlgorithm === 'GZIP') buf = zlib.gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}

function extractProductsFromReport(report) {
  const rows = report?.salesAndTrafficByAsin ?? [];
  return rows.map(r => ({
    asin: r.childAsin || r.parentAsin,
    units: r.salesByAsin?.unitsOrdered ?? 0,
    revenue: parseFloat(r.salesByAsin?.orderedProductSales?.amount ?? 0),
  }));
}

// Advances the report lifecycle for this range by exactly one step per call —
// never blocks waiting for Amazon to finish generating the report. Returns
// whatever per-ASIN data is currently known (possibly []); the *next* request
// (auto-refresh every 15 min, or a manual refresh) will pick up further progress.
async function advanceProductsReport(accessToken, interval) {
  const key = interval.key;
  const entry = reportsCache[key];

  if (entry?.status === 'ready' && Date.now() - entry.ts < REPORT_CACHE_TTL) {
    return entry.products;
  }

  if (entry?.status === 'pending') {
    try {
      const status = await getReportStatus(accessToken, entry.reportId);
      if (status.processingStatus === 'DONE' && status.reportDocumentId) {
        const doc = await getReportDocument(accessToken, status.reportDocumentId);
        const report = await downloadAndParseReport(doc);
        const products = extractProductsFromReport(report);
        reportsCache[key] = { status: 'ready', products, ts: Date.now() };
        return products;
      }
      if (status.processingStatus === 'FATAL' || status.processingStatus === 'CANCELLED') {
        delete reportsCache[key]; // let the next request start over
      }
    } catch (err) {
      console.error('Report status check failed:', err.message);
    }
    return entry.products ?? [];
  }

  // Nothing in flight for this range — kick one off, don't wait for it.
  try {
    const reportId = await createSalesReport(accessToken, interval);
    reportsCache[key] = { status: 'pending', reportId, products: entry?.products ?? [], ts: entry?.ts ?? 0 };
  } catch (err) {
    console.error('Report creation failed:', err.message);
  }
  return entry?.products ?? [];
}

// ── Transform SP-API response into dashboard-compatible shape ──
function transformData(salesData, ordersData, products) {
  // SP-API returns aggregate totals; map to the shape renderAll() expects.
  // Falls back to empty arrays if unexpected shape received.
  const metrics = salesData?.payload ?? [];
  const orders = ordersData?.payload?.Orders ?? [];

  const totalRevenue = metrics.reduce((s, m) => s + parseFloat(m.totalSales?.amount ?? 0), 0);
  const totalUnits = metrics.reduce((s, m) => s + (m.unitCount ?? 0), 0);

  // Count returns from orders with status = Cancelled/Returned (approximation)
  const returnCount = orders.filter(o => o.OrderStatus === 'Canceled').length;
  const returnRate = orders.length > 0 ? returnCount / orders.length : 0;

  return {
    live: true,
    totalRevenue: +totalRevenue.toFixed(2),
    totalUnits,
    returnRate: +returnRate.toFixed(4),
    // Real per-ASIN { asin, units, revenue } once the Reports API pipeline has
    // finished for this range; [] until then (dashboard falls back gracefully).
    products,
  };
}

// ── Main handler ──
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const missingCreds = !LWA_CLIENT_ID || !LWA_CLIENT_SECRET || !LWA_REFRESH_TOKEN;

  if (missingCreds) {
    return res.status(503).json({ error: 'SP-API credentials not configured on server.' });
  }

  const interval = computeInterval(String(req.query.range || '30d').toLowerCase());
  const cacheKey = `metrics_${interval.key}`;
  const cached = dataCache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  try {
    const accessToken = await getAccessToken();
    const [salesData, ordersData, products] = await Promise.all([
      fetchSalesMetrics(accessToken, interval),
      fetchOrders(accessToken, interval),
      advanceProductsReport(accessToken, interval),
    ]);

    const result = transformData(salesData, ordersData, products);
    dataCache[cacheKey] = { ts: Date.now(), data: result };
    res.status(200).json(result);
  } catch (err) {
    console.error('SP-API error:', err.message);
    res.status(502).json({ error: 'SP-API request failed: ' + err.message });
  }
};

// Exposed for reuse by one-off scripts (e.g. scripts/list-asins.js) — the default
// export above is what Vercel actually invokes as the serverless handler.
module.exports.SP_API_HOST = SP_API_HOST;
module.exports.getAccessToken = getAccessToken;
module.exports.spApiGet = spApiGet;
module.exports.spApiPost = spApiPost;

// ── Low-level HTTPS helpers (no external deps needed) ──
function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from ' + hostname + ': ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`SP-API ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPostJson(hostname, path, body, headers) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`SP-API ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Fetches raw bytes from an arbitrary URL (used for the pre-signed S3 report
// document URL) — no auth header needed/wanted, and no JSON parsing here since
// the payload may be gzip-compressed binary.
function httpsGetBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 400) return reject(new Error(`Report download ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
