// ═══════════════════════════════════════════
//  BRIGHTNEXT AMAZON ANALYTICS — DATA ENGINE
// ═══════════════════════════════════════════

// Declared early: simulate() (called below, at page-init time) depends on currentRange.
let isLiveMode = false;
let currentRange = '30d';
let liveTotals = null; // { totalRevenue, totalUnits, returnRate } from the aggregate SP-API endpoint
let currentReturns = []; // real returned-item records; only ever real data, never simulated

// ── name/asin below are REAL (from npm run list-asins against your Seller
// Central account). unitPrice/cogs/amazonFeeRate/fbaFee/ppcCostPerUnit/
// shippingIn/storageFee/returnRate are ESTIMATES — Amazon's API has no
// visibility into your COGS or ad spend, so these are rough placeholders
// (typical UK FBA small-accessory figures) until you replace them with your
// real numbers. Units/revenue will already be 100% real once the Reports API
// pipeline finishes (see api/amazon.js) — only margin/profit/ROI depend on
// these estimates being corrected. baseUnits/growth only affect the DEMO
// fallback view (shown until live data loads), not the real figures.
const PRODUCTS = [
  {
    name: 'Pet Hair Remover',
    asin: 'B0GJN4G35W',
    color: '#FF6B2C',
    unitPrice: 12.99,  // ESTIMATE
    cogs: 3.25,         // ESTIMATE
    amazonFeeRate: 0.153,
    fbaFee: 2.80,        // ESTIMATE
    ppcCostPerUnit: 1.00, // ESTIMATE
    shippingIn: 0.60,    // ESTIMATE
    storageFee: 0.18,    // ESTIMATE
    returnRate: 0.02,    // ESTIMATE
    baseUnits: 250,
    growth: 0.10
  },
  {
    name: 'Magnetic Phone Holder Mount',
    asin: 'B0GR1V9PSG',
    color: '#FFB800',
    unitPrice: 15.99,   // ESTIMATE
    cogs: 4.00,          // ESTIMATE
    amazonFeeRate: 0.153,
    fbaFee: 3.00,         // ESTIMATE
    ppcCostPerUnit: 1.20, // ESTIMATE
    shippingIn: 0.70,     // ESTIMATE
    storageFee: 0.20,     // ESTIMATE
    returnRate: 0.02,     // ESTIMATE
    baseUnits: 180,
    growth: 0.10
  },
  {
    name: 'Smart Cable Organiser — Black',
    asin: 'B0GJT5ZPT1',
    color: '#00E5FF',
    unitPrice: 9.99,    // ESTIMATE
    cogs: 2.50,          // ESTIMATE
    amazonFeeRate: 0.153,
    fbaFee: 2.50,         // ESTIMATE
    ppcCostPerUnit: 0.90, // ESTIMATE
    shippingIn: 0.45,     // ESTIMATE
    storageFee: 0.12,     // ESTIMATE
    returnRate: 0.02,     // ESTIMATE
    baseUnits: 150,
    growth: 0.10
  },
  {
    name: 'Smart Cable Organiser — White',
    asin: 'B0GJT7WLJR',
    color: '#40C4FF',
    unitPrice: 9.99,    // ESTIMATE
    cogs: 2.50,          // ESTIMATE
    amazonFeeRate: 0.153,
    fbaFee: 2.50,         // ESTIMATE
    ppcCostPerUnit: 0.90, // ESTIMATE
    shippingIn: 0.45,     // ESTIMATE
    storageFee: 0.12,     // ESTIMATE
    returnRate: 0.02,     // ESTIMATE
    baseUnits: 150,
    growth: 0.10
  }
];

// ── baseUnits above are tuned for a 30-day baseline; scale for the active range ──
function daysForRange(range) {
  if (range === 'ytd') {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    return Math.max(1, Math.round((now - start) / 86400000));
  }
  return parseInt(range, 10) || 30;
}

// ── Cost/margin/ROI math shared by simulated AND real (units, revenue) data.
// Amazon has no visibility into our COGS/PPC/storage/etc., so those always
// come from each product's own config here — only units and revenue can ever
// come from a real source (SP-API aggregate totals, or per-ASIN report data).
function deriveProductMetrics(p, units, revenue) {
  const totalCogs = +(units * p.cogs).toFixed(2);
  const amazonReferral = +(revenue * p.amazonFeeRate).toFixed(2);
  const fbaTotal = +(units * p.fbaFee).toFixed(2);
  const ppcSpend = +(units * p.ppcCostPerUnit).toFixed(2);
  const shipping = +(units * p.shippingIn).toFixed(2);
  const storage = +(units * p.storageFee).toFixed(2);
  const returnCost = +(Math.round(units * p.returnRate) * (p.cogs + p.fbaFee)).toFixed(2);
  const totalFees = +(amazonReferral + fbaTotal).toFixed(2);
  const totalCost = +(totalCogs + totalFees + ppcSpend + shipping + storage + returnCost).toFixed(2);
  const netProfit = +(revenue - totalCost).toFixed(2);
  const margin = revenue > 0 ? +((netProfit / revenue) * 100).toFixed(1) : 0;
  const roi = totalCost > 0 ? +((netProfit / totalCost) * 100).toFixed(0) : 0;

  return {
    units, revenue, totalCogs, amazonReferral, fbaTotal,
    ppcSpend, shipping, storage, returnCost, totalFees, totalCost,
    netProfit, margin, roi
  };
}

// ── Simulate realistic data with slight randomness ──
function simulate() {
  const jitter = () => 0.9 + Math.random() * 0.2;
  const periodScale = daysForRange(currentRange) / 30;

  return PRODUCTS.map(p => {
    const units = Math.round(p.baseUnits * periodScale * jitter());
    const revenue = +(units * p.unitPrice).toFixed(2);
    const growthPct = +((p.growth + (Math.random() * 0.06 - 0.03)) * 100).toFixed(1);
    return { ...p, ...deriveProductMetrics(p, units, revenue), growthPct };
  }).sort((a, b) => b.margin - a.margin); // Sort by margin desc
}

// Same shape as simulate(), but no random jitter — used to scale the product
// mix to real aggregate totals while the Reports API is still generating (see
// applyLiveData below). Using simulate() there instead would re-randomize the
// whole table on every refresh even though the real total didn't change.
function baselineMix() {
  const periodScale = daysForRange(currentRange) / 30;
  return PRODUCTS.map(p => {
    const units = Math.round(p.baseUnits * periodScale);
    const revenue = +(units * p.unitPrice).toFixed(2);
    const growthPct = +(p.growth * 100).toFixed(1);
    return { ...p, ...deriveProductMetrics(p, units, revenue), growthPct };
  }).sort((a, b) => b.margin - a.margin);
}

let currentData = simulate();

// ── Determine winner ──
function getWinner(data) {
  // Winner = highest composite score: 40% margin + 30% ROI + 30% revenue share
  const totalRev = data.reduce((s, p) => s + p.revenue, 0);
  const maxMargin = Math.max(...data.map(p => p.margin));
  const maxROI = Math.max(...data.map(p => p.roi));

  let best = null, bestScore = -1;
  data.forEach(p => {
    const score =
      (maxMargin !== 0 ? (p.margin / maxMargin) * 0.4 : 0) +
      (maxROI !== 0 ? (p.roi / maxROI) * 0.3 : 0) +
      (totalRev !== 0 ? (p.revenue / totalRev) * 0.3 : 0);
    if (score > bestScore) { bestScore = score; best = p; }
  });
  return best ?? data[0] ?? null;
}

// ══════════════════════════
//  RENDER FUNCTIONS
// ══════════════════════════

function renderAll() {
  currentData = simulate();
  renderWinner();
  renderKPIs();
  renderTable();
  renderProfitCards();
  renderCharts();
}

function renderWinner() {
  const w = getWinner(currentData);
  document.getElementById('winnerName').textContent = w.name;
  document.getElementById('winnerRevenue').textContent = '£' + w.revenue.toLocaleString();
  document.getElementById('winnerMargin').textContent = w.margin + '%';
  document.getElementById('winnerUnits').textContent = w.units;
  document.getElementById('winnerROI').textContent = w.roi + '%';
}

function renderKPIs() {
  const totals = currentData.reduce((acc, p) => {
    acc.revenue += p.revenue;
    acc.units += p.units;
    acc.profit += p.netProfit;
    return acc;
  }, { revenue: 0, units: 0, profit: 0 });

  // Revenue/units/returns: prefer the authoritative aggregate SP-API totals when
  // live, since currentData may only cover our configured PRODUCTS (an unmatched
  // real ASIN would otherwise be silently missing from these figures). Profit
  // stays derived from currentData — Amazon has no visibility into our COGS/fees.
  if (isLiveMode && liveTotals) {
    totals.revenue = liveTotals.totalRevenue;
    totals.units = liveTotals.totalUnits;
  }
  const avgReturn = isLiveMode && liveTotals
    ? (liveTotals.returnRate * 100).toFixed(1)
    : (currentData.reduce((s, p) => s + p.returnRate, 0) / currentData.length * 100).toFixed(1);

  const avgMargin = totals.revenue > 0 ? (totals.profit / totals.revenue * 100).toFixed(1) : '0.0';

  document.getElementById('kpiRevenue').textContent = '£' + Math.round(totals.revenue).toLocaleString();
  document.getElementById('kpiUnits').textContent = totals.units.toLocaleString();
  document.getElementById('kpiProfit').textContent = '£' + Math.round(totals.profit).toLocaleString();
  document.getElementById('kpiMargin').textContent = avgMargin + '%';
  document.getElementById('kpiReturns').textContent = avgReturn + '%';
}

function renderTable() {
  const winner = getWinner(currentData);
  const tbody = document.getElementById('productTableBody');
  tbody.innerHTML = currentData.map(p => {
    const isWinner = p.asin === winner.asin;
    let badge = '';
    if (isWinner) badge = '<span class="badge badge-winner">🏆 WINNER</span>';
    else if (p.growthPct > 15) badge = '<span class="badge badge-growth">↑ GROWTH</span>';
    else if (p.growthPct > 5) badge = '<span class="badge badge-stable">→ STABLE</span>';
    else badge = '<span class="badge badge-risk">⚠ WATCH</span>';

    const marginColor = p.margin > 35 ? 'var(--green)' : p.margin > 20 ? 'var(--amber)' : 'var(--red)';
    const marginWidth = Math.min(p.margin / 50 * 100, 100);

    return `<tr style="${isWinner ? 'background:rgba(0,230,118,0.03);' : ''}">
      <td>
        <div class="product-cell">
          <div class="product-dot" style="background:${p.color}"></div>
          <div>
            <div class="product-name-col">${p.name}</div>
            <div class="product-asin">${p.asin}</div>
          </div>
        </div>
      </td>
      <td>${badge}</td>
      <td class="mono">${p.units}</td>
      <td class="mono">£${p.revenue.toLocaleString()}</td>
      <td class="mono" style="color:var(--text-dim)">£${p.totalCogs.toLocaleString()}</td>
      <td class="mono" style="color:var(--text-dim)">£${p.totalFees.toLocaleString()}</td>
      <td class="mono" style="color:var(--text-dim)">£${p.ppcSpend.toLocaleString()}</td>
      <td class="mono" style="color:${p.netProfit > 0 ? 'var(--green)' : 'var(--red)'}">£${p.netProfit.toLocaleString()}</td>
      <td>
        <div style="display:flex; align-items:center; gap:0.5rem;">
          <div class="margin-bar-container">
            <div class="margin-bar" style="width:${marginWidth}%; background:${marginColor};"></div>
          </div>
          <span class="mono" style="font-size:0.8rem; color:${marginColor}">${p.margin}%</span>
        </div>
      </td>
      <td class="mono" style="color:${p.roi > 100 ? 'var(--green)' : 'var(--amber)'}">${p.roi}%</td>
    </tr>`;
  }).join('');
}

function renderProfitCards() {
  const grid = document.getElementById('profitGrid');
  grid.innerHTML = currentData.map(p => `
    <div class="profit-card">
      <div class="profit-card-title">
        <span style="color:${p.color}">●</span> ${p.name}
      </div>
      <div class="profit-row">
        <span class="label">Revenue</span>
        <span class="val">£${p.revenue.toLocaleString()}</span>
      </div>
      <div class="profit-row">
        <span class="label">COGS (Product Cost)</span>
        <span class="val negative">-£${p.totalCogs.toLocaleString()}</span>
      </div>
      <div class="profit-row">
        <span class="label">Amazon Referral Fee</span>
        <span class="val negative">-£${p.amazonReferral.toLocaleString()}</span>
      </div>
      <div class="profit-row">
        <span class="label">FBA Fulfilment Fee</span>
        <span class="val negative">-£${p.fbaTotal.toLocaleString()}</span>
      </div>
      <div class="profit-row">
        <span class="label">PPC / Advertising</span>
        <span class="val negative">-£${p.ppcSpend.toLocaleString()}</span>
      </div>
      <div class="profit-row">
        <span class="label">Inbound Shipping</span>
        <span class="val negative">-£${p.shipping.toLocaleString()}</span>
      </div>
      <div class="profit-row">
        <span class="label">Storage Fees</span>
        <span class="val negative">-£${p.storageFee.toLocaleString()}</span>
      </div>
      <div class="profit-row">
        <span class="label">Returns Cost</span>
        <span class="val negative">-£${p.returnCost.toLocaleString()}</span>
      </div>
      <div class="profit-total">
        <span>Net Profit</span>
        <span class="val" style="color:${p.netProfit > 0 ? 'var(--green)' : 'var(--red)'}">£${p.netProfit.toLocaleString()}</span>
      </div>
      <div style="margin-top:0.5rem; text-align:center;">
        <span class="badge ${p.margin > 35 ? 'badge-winner' : p.margin > 20 ? 'badge-growth' : 'badge-risk'}" style="font-size:0.72rem;">
          Margin: ${p.margin}%  |  ROI: ${p.roi}%
        </span>
      </div>
    </div>
  `).join('');
}

// ══════════════════════════
//  CHARTS (Chart.js)
// ══════════════════════════

let revenueChartInstance, pieChartInstance, costChartInstance, roiChartInstance;

function renderCharts() {
  renderRevenueChart();
  renderPieChart();
  renderCostChart();
  renderROIChart();
}

function renderRevenueChart() {
  const ctx = document.getElementById('revenueChart').getContext('2d');
  if (revenueChartInstance) revenueChartInstance.destroy();

  const labels = Array.from({length: 30}, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - 29 + i);
    return d.getDate() + '/' + (d.getMonth() + 1);
  });

  const totalDailyRevBase = currentData.reduce((s, p) => s + p.revenue, 0) / 30;
  const totalDailyProfitBase = currentData.reduce((s, p) => s + p.netProfit, 0) / 30;

  const revData = labels.map((_, i) => {
    const trend = 1 + (i / 30) * 0.15;
    return +(totalDailyRevBase * trend * (0.8 + Math.random() * 0.4)).toFixed(0);
  });

  const profitData = labels.map((_, i) => {
    const trend = 1 + (i / 30) * 0.2;
    return +(totalDailyProfitBase * trend * (0.75 + Math.random() * 0.5)).toFixed(0);
  });

  revenueChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Revenue',
          data: revData,
          borderColor: '#00E5FF',
          backgroundColor: 'rgba(0,229,255,0.08)',
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2
        },
        {
          label: 'Net Profit',
          data: profitData,
          borderColor: '#00E676',
          backgroundColor: 'rgba(0,230,118,0.06)',
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHitRadius: 10,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#7BA3C4', font: { family: 'Rajdhani', size: 11 }, boxWidth: 12, padding: 16 }},
        tooltip: {
          backgroundColor: '#0A1E35', titleColor: '#E8F4FD', bodyColor: '#7BA3C4',
          borderColor: 'rgba(0,229,255,0.2)', borderWidth: 1,
          titleFont: { family: 'Rajdhani', weight: '700' },
          bodyFont: { family: 'JetBrains Mono', size: 12 },
          callbacks: { label: ctx => ctx.dataset.label + ': £' + ctx.parsed.y.toLocaleString() }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(0,229,255,0.04)' }, ticks: { color: '#4A6F8F', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 10 }},
        y: { grid: { color: 'rgba(0,229,255,0.04)' }, ticks: { color: '#4A6F8F', font: { family: 'JetBrains Mono', size: 10 }, callback: v => '£' + v }}
      }
    }
  });
}

function renderPieChart() {
  const ctx = document.getElementById('productPieChart').getContext('2d');
  if (pieChartInstance) pieChartInstance.destroy();

  pieChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: currentData.map(p => p.name.split(' ').slice(0, 3).join(' ')),
      datasets: [{
        data: currentData.map(p => p.revenue),
        backgroundColor: currentData.map(p => p.color),
        borderColor: '#081828',
        borderWidth: 3,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#7BA3C4', font: { family: 'Rajdhani', size: 11 }, padding: 12, boxWidth: 10 }},
        tooltip: {
          backgroundColor: '#0A1E35', titleColor: '#E8F4FD', bodyColor: '#7BA3C4',
          borderColor: 'rgba(0,229,255,0.2)', borderWidth: 1,
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
              return ' £' + ctx.parsed.toLocaleString() + ' (' + (ctx.parsed / total * 100).toFixed(1) + '%)';
            }
          }
        }
      }
    }
  });
}

function renderCostChart() {
  const ctx = document.getElementById('costChart').getContext('2d');
  if (costChartInstance) costChartInstance.destroy();

  const categories = ['COGS', 'Amazon Fees', 'FBA', 'PPC', 'Shipping', 'Storage', 'Returns'];
  const getCategory = (p, cat) => {
    switch (cat) {
      case 'COGS': return p.totalCogs;
      case 'Amazon Fees': return p.amazonReferral;
      case 'FBA': return p.fbaTotal;
      case 'PPC': return p.ppcSpend;
      case 'Shipping': return p.shipping;
      case 'Storage': return +p.storageFee;
      case 'Returns': return p.returnCost;
    }
  };

  costChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: categories,
      datasets: currentData.map(p => ({
        label: p.name.split(' ').slice(0, 2).join(' '),
        data: categories.map(c => getCategory(p, c)),
        backgroundColor: p.color + 'CC',
        borderColor: p.color,
        borderWidth: 1,
        borderRadius: 3
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { color: '#7BA3C4', font: { family: 'Rajdhani', size: 11 }, boxWidth: 10, padding: 14 }},
        tooltip: {
          backgroundColor: '#0A1E35', borderColor: 'rgba(0,229,255,0.2)', borderWidth: 1,
          titleColor: '#E8F4FD', bodyColor: '#7BA3C4',
          callbacks: { label: ctx => ctx.dataset.label + ': £' + ctx.parsed.y.toLocaleString() }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#4A6F8F', font: { family: 'Rajdhani', size: 10 } }, stacked: false },
        y: { grid: { color: 'rgba(0,229,255,0.04)' }, ticks: { color: '#4A6F8F', font: { family: 'JetBrains Mono', size: 10 }, callback: v => '£' + v }, stacked: false }
      }
    }
  });
}

function renderROIChart() {
  const ctx = document.getElementById('roiChart').getContext('2d');
  if (roiChartInstance) roiChartInstance.destroy();

  roiChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: currentData.map(p => p.name.split(' ').slice(0, 2).join(' ')),
      datasets: [{
        label: 'ROI %',
        data: currentData.map(p => p.roi),
        backgroundColor: currentData.map(p => p.roi > 150 ? 'rgba(0,230,118,0.7)' : p.roi > 80 ? 'rgba(0,229,255,0.6)' : 'rgba(255,184,0,0.6)'),
        borderColor: currentData.map(p => p.roi > 150 ? '#00E676' : p.roi > 80 ? '#00E5FF' : '#FFB800'),
        borderWidth: 1,
        borderRadius: 6,
        barPercentage: 0.6
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0A1E35', borderColor: 'rgba(0,229,255,0.2)', borderWidth: 1,
          callbacks: { label: ctx => 'ROI: ' + ctx.parsed.x + '%' }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(0,229,255,0.04)' }, ticks: { color: '#4A6F8F', font: { family: 'JetBrains Mono', size: 10 }, callback: v => v + '%' }},
        y: { grid: { display: false }, ticks: { color: '#7BA3C4', font: { family: 'Rajdhani', size: 12, weight: '600' } }}
      }
    }
  });
}

// ══════════════════════════
//  LIVE DATA / SP-API
// ══════════════════════════
// (isLiveMode / currentRange declared near the top — simulate() needs them at page-init time)

// Called when user clicks "Connect Live" in the API panel.
// Credentials always come from server-side env vars (LWA_CLIENT_ID/SECRET/REFRESH_TOKEN) — never from the browser.
async function connectLive() {
  const btn = document.getElementById('connectBtn');
  const msg = document.getElementById('apiStatusMsg');

  btn.disabled = true;
  btn.textContent = 'Connecting…';
  msg.className = 'api-status-msg';
  msg.textContent = 'Fetching data from SP-API…';

  try {
    const res = await fetch(`/api/amazon?range=${currentRange}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Server error ' + res.status }));
      throw new Error(err.error || 'Request failed');
    }

    const data = await res.json();
    isLiveMode = true;
    applyLiveData(data);

    const badge = document.getElementById('dataBadge');
    badge.className = 'data-mode-badge live';
    badge.textContent = '◉ LIVE';

    msg.className = 'api-status-msg ok';
    msg.textContent = `Connected — live data loaded for ${currentRange.toUpperCase()}. Auto-refresh every 15 min.`;
    btn.textContent = 'Reconnect';
    btn.disabled = false;

    // Auto-refresh every 15 minutes
    setInterval(() => fetchAndApplyLive(), 15 * 60 * 1000);
  } catch (err) {
    msg.className = 'api-status-msg err';
    msg.textContent = 'Connection failed: ' + err.message;
    btn.textContent = 'Connect Live';
    btn.disabled = false;
  }
}

// showErrors=true for user-initiated actions (range switch, manual refresh) so a
// failed request is visible instead of silently leaving stale data on screen while
// the newly clicked range button shows as active. Background auto-refresh stays quiet.
async function fetchAndApplyLive(showErrors = false) {
  if (!isLiveMode) return;
  const msg = document.getElementById('apiStatusMsg');
  try {
    const res = await fetch(`/api/amazon?range=${currentRange}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Server error ' + res.status }));
      throw new Error(err.error || 'Request failed');
    }
    applyLiveData(await res.json());
    if (showErrors) {
      msg.className = 'api-status-msg ok';
      msg.textContent = `Live data refreshed for ${currentRange.toUpperCase()}.`;
    }
  } catch (err) {
    if (showErrors) {
      msg.className = 'api-status-msg err';
      msg.textContent = 'Refresh failed: ' + err.message + ' — showing last successful data.';
    }
    // background auto-refresh: swallow the error, keep showing the last successful data
  }
}

// data.products (from the Reports API) is real per-ASIN { asin, units, revenue }
// once Amazon has finished generating that range's report — until then it's [].
// When we have it, use it directly (true per-product parity with Seller Central,
// for any ASIN present in our own PRODUCTS config). Otherwise fall back to
// scaling the demo product mix so at least the KPI totals are accurate.
function applyLiveData(data) {
  if (!data || !data.live) return;

  liveTotals = { totalRevenue: data.totalRevenue, totalUnits: data.totalUnits, returnRate: data.returnRate };

  const realByAsin = new Map((data.products || []).map(r => [r.asin, r]));
  const haveRealProducts = PRODUCTS.some(p => realByAsin.has(p.asin));

  if (haveRealProducts) {
    currentData = PRODUCTS.map(p => {
      const real = realByAsin.get(p.asin);
      const units = real?.units ?? 0;
      const revenue = real?.revenue ?? 0;
      return { ...p, ...deriveProductMetrics(p, units, revenue), growthPct: +(p.growth * 100).toFixed(1) };
    }).sort((a, b) => b.margin - a.margin);
  } else {
    // Report not ready yet (or none of our configured ASINs matched) — scale a
    // *stable* product mix so the table stays proportionate to the real totals.
    // Using simulate() here (which re-randomizes on every call) would make the
    // table jump around on every refresh even though the real total didn't change.
    currentData = baselineMix();
    const demoRevTotal = currentData.reduce((s, p) => s + p.revenue, 0);
    const scale = demoRevTotal > 0 ? data.totalRevenue / demoRevTotal : 1;
    currentData = currentData.map(p => {
      const units = Math.round(p.units * scale);
      const revenue = +(p.revenue * scale).toFixed(2);
      return { ...p, ...deriveProductMetrics(p, units, revenue), growthPct: p.growthPct };
    }).sort((a, b) => b.margin - a.margin);
  }

  renderWinner();
  renderKPIs();
  renderTable();
  renderProfitCards();
  renderCharts();

  currentReturns = mergeReturns(data.returns || []);
  renderReturns();
}

// Returns data comes from Amazon's API, not our own trusted PRODUCTS config —
// escape before injecting into innerHTML below.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Real returned-item records only — no simulated fallback here. Fabricating
// individual fake return incidents (order IDs, reasons) would be actively
// misleading in a way aggregate demo revenue numbers aren't.
function mergeReturns(rawReturns) {
  return rawReturns.map(r => {
    const product = PRODUCTS.find(p => p.asin === r.asin);
    return {
      ...r,
      productName: product ? product.name : (r.sku || r.asin || 'Unknown product'),
      // Amazon's returns report has no refund amount field; estimate from our
      // own unit price. Real disposition/reason/date/order id are all as-is from Amazon.
      estimatedRefund: product ? +(r.quantity * product.unitPrice).toFixed(2) : null,
    };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function renderReturns() {
  const body = document.getElementById('returnsBody');
  const summary = document.getElementById('returnsSummary');
  if (!body) return;

  if (!isLiveMode) {
    body.innerHTML = '<tr><td colspan="6" class="returns-empty">Connect your Amazon account above to see real returns data.</td></tr>';
    if (summary) summary.textContent = 'Real returned units from Amazon — connect live to see data';
    return;
  }

  if (currentReturns.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="returns-empty">No returns in this period, or the returns report is still generating (check back in a minute).</td></tr>';
    if (summary) summary.textContent = 'Real returned units from Amazon';
    return;
  }

  const totalUnits = currentReturns.reduce((s, r) => s + r.quantity, 0);
  const totalRefund = currentReturns.reduce((s, r) => s + (r.estimatedRefund || 0), 0);
  if (summary) {
    summary.textContent = `${currentReturns.length} return${currentReturns.length === 1 ? '' : 's'} · ${totalUnits} unit${totalUnits === 1 ? '' : 's'} · ~£${totalRefund.toFixed(2)} estimated refunds`;
  }

  body.innerHTML = currentReturns.map(r => `
    <tr>
      <td>${escapeHtml(r.date) || '—'}</td>
      <td>${escapeHtml(r.orderId) || '—'}</td>
      <td>${escapeHtml(r.productName)}</td>
      <td>${r.quantity}</td>
      <td>${escapeHtml(r.reason) || '—'}</td>
      <td>${r.estimatedRefund != null ? '£' + r.estimatedRefund.toFixed(2) + ' (est.)' : '—'}</td>
    </tr>
  `).join('');
}

// ══════════════════════════
//  INTERACTIONS
// ══════════════════════════

function setRange(btn, range) {
  document.querySelectorAll('.date-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentRange = range;
  if (isLiveMode) {
    fetchAndApplyLive(true);
  } else {
    renderAll();
  }
}

function refreshData(btn) {
  btn.classList.add('spinning');
  const done = () => btn.classList.remove('spinning');
  if (isLiveMode) {
    fetchAndApplyLive(true).then(done);
  } else {
    setTimeout(() => { renderAll(); done(); }, 800);
  }
}

// ── Auto-refresh every 60 seconds (demo mode only) ──
setInterval(() => { if (!isLiveMode) renderAll(); }, 60000);

// Call once the dashboard is actually visible — immediately for the public
// dashboard, or from admin.html's showDashboard() after a successful login,
// so a gated page doesn't silently fetch/render before authentication.
function initDashboard() {
  renderAll();
  tryAutoConnect();
}

// ── Silently try live data on load; falls back to demo with no error shown ──
async function tryAutoConnect() {
  try {
    const res = await fetch(`/api/amazon?range=${currentRange}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.live) return;

    isLiveMode = true;
    applyLiveData(data);

    const badge = document.getElementById('dataBadge');
    if (badge) { badge.className = 'data-mode-badge live'; badge.textContent = '◉ LIVE'; }
    const btn = document.getElementById('connectBtn');
    if (btn) btn.textContent = 'Reconnect';

    setInterval(() => fetchAndApplyLive(), 15 * 60 * 1000);
  } catch (_) { /* stay in demo mode silently */ }
}
