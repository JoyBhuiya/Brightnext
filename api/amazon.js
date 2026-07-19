// Vercel Serverless Function — Amazon SP-API proxy
// Keeps LWA credentials server-side; browser never sees them.
// SP-API no longer requires AWS SigV4 signing — LWA access token auth only.

const https = require('https');

const {
  LWA_CLIENT_ID,
  LWA_CLIENT_SECRET,
  LWA_REFRESH_TOKEN,
  MARKETPLACE_ID = 'A1F83G8C2ARO7P', // UK marketplace default
} = process.env;

// ── Simple in-memory token cache (valid per cold-start) ──
let cachedToken = null;
let tokenExpiry = 0;

// ── Simple in-memory data cache (15 min TTL) ──
const dataCache = {};
const CACHE_TTL = 15 * 60 * 1000;

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

// ── SP-API request helper ──
async function spApiGet(path, queryParams, accessToken) {
  const host = 'sellingpartnerapi-eu.amazon.com';
  const qs = new URLSearchParams(queryParams).toString();
  const headers = { 'x-amz-access-token': accessToken };

  return httpsGet(host, `${path}?${qs}`, headers);
}

// ── Fetch order metrics (revenue + units by ASIN) ──
async function fetchSalesMetrics(accessToken, days) {
  const endDate = new Date();
  const startDate = new Date(Date.now() - days * 86400000);

  const data = await spApiGet('/sales/v1/orderMetrics', {
    marketplaceIds: MARKETPLACE_ID,
    interval: `${startDate.toISOString().slice(0, 10)}T00:00:00Z--${endDate.toISOString().slice(0, 10)}T23:59:59Z`,
    granularity: 'Total',
    granularityTimeZone: 'Europe/London',
  }, accessToken);

  return data;
}

// ── Fetch recent orders (for return rate estimation) ──
async function fetchOrders(accessToken, days) {
  const createdAfter = new Date(Date.now() - days * 86400000).toISOString();
  return spApiGet('/orders/v0/orders', {
    MarketplaceIds: MARKETPLACE_ID,
    CreatedAfter: createdAfter,
    OrderStatuses: 'Shipped,Unshipped,PartiallyShipped',
  }, accessToken);
}

// ── Transform SP-API response into dashboard-compatible shape ──
function transformData(salesData, ordersData) {
  // SP-API returns aggregate totals; map to the shape renderAll() expects.
  // Falls back to empty arrays if unexpected shape received.
  const metrics = salesData?.payload ?? [];
  const orders = ordersData?.payload?.Orders ?? [];

  const totalRevenue = metrics.reduce((s, m) => s + parseFloat(m.orderItemSalesRevenue?.amount ?? 0), 0);
  const totalUnits = metrics.reduce((s, m) => s + (m.unitCount ?? 0), 0);

  // Count returns from orders with status = Cancelled/Returned (approximation)
  const returnCount = orders.filter(o => o.OrderStatus === 'Canceled').length;
  const returnRate = orders.length > 0 ? returnCount / orders.length : 0;

  return {
    live: true,
    totalRevenue: +totalRevenue.toFixed(2),
    totalUnits,
    returnRate: +returnRate.toFixed(4),
    // Per-product breakdown not available from orderMetrics aggregate endpoint;
    // use product-level reports for richer data (Reports API, async).
    products: [],
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

  const days = parseInt(req.query.range, 10) || 30;
  const cacheKey = `metrics_${days}`;
  const cached = dataCache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  try {
    const accessToken = await getAccessToken();
    const [salesData, ordersData] = await Promise.all([
      fetchSalesMetrics(accessToken, days),
      fetchOrders(accessToken, days),
    ]);

    const result = transformData(salesData, ordersData);
    dataCache[cacheKey] = { ts: Date.now(), data: result };
    res.status(200).json(result);
  } catch (err) {
    console.error('SP-API error:', err.message);
    res.status(502).json({ error: 'SP-API request failed: ' + err.message });
  }
};

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
