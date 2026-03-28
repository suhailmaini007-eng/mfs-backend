/**
 * MFS Live Market Backend v4
 * ──────────────────────────
 * Uses ONLY sources proven to work from cloud/server IPs:
 *
 *  A. Fyers API       — real-time Indian (when token set)
 *  B. Kite/Zerodha    — real-time Indian (when token set)
 *  C. Alpha Vantage   — free API key, 25 req/day, global indices + FX + commodities
 *  D. Twelve Data     — free API key, 800 req/day, excellent coverage
 *  E. Financial Modeling Prep (FMP) — free key, 250 req/day
 *
 * FREE KEY SETUP (2 minutes):
 *   Twelve Data  → https://twelvedata.com/register  (best free tier, use this first)
 *   Alpha Vantage→ https://www.alphavantage.co/support/#api-key
 *   FMP          → https://site.financialmodelingprep.com/register
 *
 * Add keys as Render env vars: TWELVE_DATA_KEY, ALPHA_VANTAGE_KEY, FMP_KEY
 */

'use strict';

const express   = require('express');
const cors      = require('cors');
const NodeCache = require('node-cache');
const axios     = require('axios');

const app   = express();
const cache = new NodeCache({ stdTTL: 55 });

app.use(cors());
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT             = process.env.PORT               || 3000;
const FYERS_APP_ID     = process.env.FYERS_APP_ID       || '';
const FYERS_TOKEN      = process.env.FYERS_TOKEN        || '';
const KITE_API_KEY     = process.env.KITE_API_KEY       || '';
const KITE_TOKEN       = process.env.KITE_ACCESS_TOKEN  || '';
const TWELVE_DATA_KEY  = process.env.TWELVE_DATA_KEY    || '';
const ALPHA_VANTAGE_KEY= process.env.ALPHA_VANTAGE_KEY  || '';
const FMP_KEY          = process.env.FMP_KEY            || '';

// ─── SYMBOL MAPS ──────────────────────────────────────────────────────────────
const FYERS_SYMBOLS = {
  '^NSEI'     : 'NSE:NIFTY50-INDEX',
  '^NSEBANK'  : 'NSE:NIFTYBANK-INDEX',
  '^CNXIT'    : 'NSE:NIFTYIT-INDEX',
  '^CNXPHARMA': 'NSE:NIFTYPHARMA-INDEX',
  '^CNXAUTO'  : 'NSE:NIFTYAUTO-INDEX',
  '^CNXFMCG'  : 'NSE:NIFTYFMCG-INDEX',
  '^CNXMETAL' : 'NSE:NIFTYMETAL-INDEX',
  '^NSEMDCP50': 'NSE:NIFTYMIDCAP50-INDEX',
};

const KITE_SYMBOLS = {
  '^NSEI': 256265, '^NSEBANK': 260105,
  '^CNXIT': 259849, '^CNXPHARMA': 260617, '^CNXAUTO': 258801,
};

// Twelve Data symbols → our keys
const TD_SYMBOLS = {
  'NIFTY'  : '^NSEI',
  'BANKNIFTY': '^NSEBANK',
  'DJI'    : '^DJI',
  'NDX'    : '^IXIC',
  'SPX'    : '^GSPC',
  'HSI'    : '^HSI',
  'NI225'  : '^N225',
  'FTSE'   : '^FTSE',
  'DAX'    : '^GDAXI',
  'XAU/USD': 'GC=F',
  'WTI/USD': 'CL=F',
  'USD/INR': 'INR=X',
};

// FMP symbols → our keys
const FMP_SYMBOLS = {
  '^NSEI' : 'NIFTY',
  '^BSESN': '^BSESN',
  '^DJI'  : '^DJI',
  '^IXIC' : '^IXIC',
  '^GSPC' : '^GSPC',
  '^HSI'  : '^HSI',
  '^N225' : '^N225',
  '^FTSE' : '^FTSE',
  '^GDAXI': '^GDAXI',
  'GC=F'  : 'GCUSD',
  'CL=F'  : 'CLUSD',
  'INR=X' : 'USDINR',
};

const META_GROUPS = {
  '^NSEI':'india','^NSEBANK':'india','^BSESN':'india','^INDIAVIX':'india',
  '^CNXIT':'sector','^CNXPHARMA':'sector','^CNXAUTO':'sector','^CNXBANK':'sector',
  '^CNXFMCG':'sector','^CNXMETAL':'sector','^NSEMDCP50':'sector',
  '^DJI':'us','^IXIC':'us','^GSPC':'us',
  '^HSI':'asia','^N225':'asia','^FTSE':'eu','^GDAXI':'eu',
  'GC=F':'comm','CL=F':'comm','INR=X':'comm',
};

// ─── HELPER ───────────────────────────────────────────────────────────────────
function makeQuote(sym, ltp, prevClose, chg, pct, timestamp, source) {
  const ltpN  = parseFloat(ltp)       || 0;
  const prevN = parseFloat(prevClose) || 0;
  const chgN  = chg  != null ? parseFloat(chg)  : ltpN - prevN;
  const pctN  = pct  != null ? parseFloat(pct)  : (prevN ? (chgN / prevN) * 100 : 0);
  return {
    symbol: sym, ltp: ltpN, prevClose: prevN,
    chg: parseFloat(chgN.toFixed(2)),
    pct: parseFloat(pctN.toFixed(4)),
    up: chgN >= 0,
    time: timestamp || Math.floor(Date.now() / 1000),
    source: source || 'unknown',
  };
}

function axiosGet(url, opts = {}) {
  return axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MFS-Backend/4.0)',
      'Accept': 'application/json',
      ...(opts.headers || {}),
    },
    ...opts,
  });
}

// ─── SOURCE A: Fyers ──────────────────────────────────────────────────────────
async function fetchFyers() {
  if (!FYERS_TOKEN || !FYERS_APP_ID) return null;
  const syms = Object.values(FYERS_SYMBOLS).join(',');
  const res = await axiosGet(
    `https://api-t1.fyers.in/data/quotes?symbols=${encodeURIComponent(syms)}`,
    { headers: { 'Authorization': `${FYERS_APP_ID}:${FYERS_TOKEN}` } }
  );
  if (res.data?.code !== 200) throw new Error('Fyers: ' + (res.data?.message || 'bad response'));
  const rev = Object.fromEntries(Object.entries(FYERS_SYMBOLS).map(([k, v]) => [v, k]));
  const out = {};
  (res.data?.d || []).forEach(item => {
    const sym = rev[item.n]; if (!sym) return;
    const v = item.v;
    out[sym] = { ...makeQuote(sym, v.lp, v.prev_close_price, v.ch, v.chp, v.tt, 'fyers') };
  });
  return out;
}

// ─── SOURCE B: Kite ───────────────────────────────────────────────────────────
async function fetchKite() {
  if (!KITE_API_KEY || !KITE_TOKEN) return null;
  const res = await axiosGet(
    `https://api.kite.trade/quote?i=${Object.values(KITE_SYMBOLS).join('&i=')}`,
    { headers: { 'X-Kite-Version': '3', 'Authorization': `token ${KITE_API_KEY}:${KITE_TOKEN}` } }
  );
  if (!res.data?.data) throw new Error('Kite: empty');
  const rev = Object.fromEntries(Object.entries(KITE_SYMBOLS).map(([k, v]) => [String(v), k]));
  const out = {};
  Object.entries(res.data.data).forEach(([, v]) => {
    const sym = rev[String(v.instrument_token)]; if (!sym) return;
    const ltp = v.last_price, prev = v.ohlc?.close || ltp;
    out[sym] = { ...makeQuote(sym, ltp, prev, ltp - prev, prev ? ((ltp - prev) / prev * 100) : 0, null, 'kite') };
  });
  return out;
}

// ─── SOURCE C: Twelve Data (free, 800 req/day, works from server) ─────────────
// Sign up free at https://twelvedata.com/register — instant API key
async function fetchTwelveData() {
  if (!TWELVE_DATA_KEY) return null;

  // Batch request — all symbols in one call
  const tdSyms = Object.keys(TD_SYMBOLS);

  // Split into: indices/stocks vs forex vs commodities (TD uses different endpoints)
  const indices  = ['NIFTY','BANKNIFTY','DJI','NDX','SPX','HSI','NI225','FTSE','DAX'];
  const forex    = ['USD/INR'];
  const commodities = ['XAU/USD','WTI/USD'];

  const out = {};

  // Fetch indices (exchange param needed for NSE)
  const idxRes = await axiosGet(
    `https://api.twelvedata.com/quote?symbol=${indices.join(',')}&apikey=${TWELVE_DATA_KEY}`
  );
  const idxData = idxRes.data || {};

  // TD returns object keyed by symbol when batch, or direct object for single
  const processQuote = (sym, q) => {
    if (!q || q.status === 'error' || !q.close) return;
    const ourSym = TD_SYMBOLS[sym]; if (!ourSym) return;
    const ltp  = parseFloat(q.close) || 0;
    const prev = parseFloat(q.previous_close) || ltp;
    const chg  = parseFloat(q.change) || (ltp - prev);
    const pct  = parseFloat(q.percent_change) || (prev ? (chg / prev) * 100 : 0);
    out[ourSym] = { ...makeQuote(ourSym, ltp, prev, chg, pct, null, 'twelvedata') };
  };

  // Handle both single (direct obj) and batch (keyed obj) responses
  if (indices.length === 1) {
    processQuote(indices[0], idxData);
  } else {
    indices.forEach(sym => processQuote(sym, idxData[sym]));
  }

  // Fetch forex
  if (forex.length > 0) {
    try {
      const fxRes = await axiosGet(
        `https://api.twelvedata.com/quote?symbol=${forex.join(',')}&apikey=${TWELVE_DATA_KEY}`
      );
      const fxData = fxRes.data || {};
      forex.forEach(sym => processQuote(sym, forex.length === 1 ? fxData : fxData[sym]));
    } catch (_) {}
  }

  // Fetch commodities
  if (commodities.length > 0) {
    try {
      const cmRes = await axiosGet(
        `https://api.twelvedata.com/quote?symbol=${commodities.join(',')}&apikey=${TWELVE_DATA_KEY}`
      );
      const cmData = cmRes.data || {};
      commodities.forEach(sym => processQuote(sym, commodities.length === 1 ? cmData : cmData[sym]));
    } catch (_) {}
  }

  if (Object.keys(out).length === 0) throw new Error('Twelve Data: no quotes parsed');
  return out;
}

// ─── SOURCE D: Alpha Vantage (free, 25 req/day, global coverage) ──────────────
// Sign up free at https://www.alphavantage.co/support/#api-key — instant key
// 25 calls/day on free tier — we use it selectively for what TD misses
const AV_SYMBOLS = {
  'INR'  : { from: 'USD', to: 'INR',  ourSym: 'INR=X',  type: 'fx'       },
  'GOLD' : { sym: 'XAUUSD',           ourSym: 'GC=F',   type: 'crypto'   }, // AV treats as crypto pair
  'CRUDE': { sym: 'USOIL',            ourSym: 'CL=F',   type: 'commodity' },
};

async function fetchAlphaVantage(needed) {
  if (!ALPHA_VANTAGE_KEY) return null;
  const out = {};

  // Only fetch what's still missing to conserve daily quota
  if (needed.has('INR=X')) {
    try {
      const res = await axiosGet(
        `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=INR&apikey=${ALPHA_VANTAGE_KEY}`
      );
      const rate = parseFloat(res.data?.['Realtime Currency Exchange Rate']?.['5. Exchange Rate']);
      const bid  = parseFloat(res.data?.['Realtime Currency Exchange Rate']?.['8. Bid Price']) || rate;
      if (rate) {
        out['INR=X'] = { ...makeQuote('INR=X', rate, bid, rate - bid, bid ? ((rate - bid) / bid * 100) : 0, null, 'alphavantage') };
      }
    } catch (_) {}
  }

  if (needed.has('GC=F')) {
    try {
      const res = await axiosGet(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=GLD&apikey=${ALPHA_VANTAGE_KEY}`
      );
      const q = res.data?.['Global Quote'];
      if (q?.['05. price']) {
        const ltp = parseFloat(q['05. price']);
        const prev = parseFloat(q['08. previous close']) || ltp;
        // GLD is ~1/10 of gold price, multiply by 10 for approx spot
        out['GC=F'] = { ...makeQuote('GC=F', ltp * 10, prev * 10, (ltp - prev) * 10, parseFloat(q['10. change percent']) || 0, null, 'alphavantage') };
      }
    } catch (_) {}
  }

  return Object.keys(out).length > 0 ? out : null;
}

// ─── SOURCE E: FMP — Financial Modeling Prep (free, 250 req/day) ──────────────
// Sign up free at https://site.financialmodelingprep.com/register
async function fetchFMP() {
  if (!FMP_KEY) return null;

  const fmpSyms = Object.values(FMP_SYMBOLS).join(',');
  const res = await axiosGet(
    `https://financialmodelingprep.com/api/v3/quote/${fmpSyms}?apikey=${FMP_KEY}`
  );

  if (!Array.isArray(res.data)) throw new Error('FMP: unexpected response');

  const rev = Object.fromEntries(Object.entries(FMP_SYMBOLS).map(([k, v]) => [v.toUpperCase(), k]));
  const out = {};
  res.data.forEach(q => {
    const ourSym = rev[q.symbol?.toUpperCase()]; if (!ourSym) return;
    const ltp  = parseFloat(q.price)         || 0;
    const prev = parseFloat(q.previousClose) || ltp;
    const chg  = parseFloat(q.change)        || (ltp - prev);
    const pct  = parseFloat(q.changesPercentage) || (prev ? (chg / prev) * 100 : 0);
    if (ltp === 0) return;
    out[ourSym] = { ...makeQuote(ourSym, ltp, prev, chg, pct, null, 'fmp') };
  });
  if (Object.keys(out).length === 0) throw new Error('FMP: no quotes parsed');
  return out;
}

// ─── SOURCE F: Open Exchange Rates (free, USD/INR specifically) ───────────────
// Free at https://openexchangerates.org/signup/free — 1000 req/month
const OER_APP_ID = process.env.OER_APP_ID || '';
async function fetchOER(needed) {
  if (!OER_APP_ID || !needed.has('INR=X')) return null;
  const res = await axiosGet(`https://openexchangerates.org/api/latest.json?app_id=${OER_APP_ID}&symbols=INR`);
  const inr = res.data?.rates?.INR;
  if (!inr) return null;
  return { 'INR=X': { ...makeQuote('INR=X', inr, inr, 0, 0, null, 'openexchangerates') } };
}

// ─── MMI ──────────────────────────────────────────────────────────────────────
function computeMMI(quotes) {
  const nifty = quotes['^NSEI'];
  if (!nifty) return { value: 50, zone: 'NEUTRAL' };
  const pctAbs = Math.min(Math.abs(nifty.pct) * 10, 15);
  let val = nifty.up ? 50 + pctAbs : 50 - pctAbs;
  val = Math.max(5, Math.min(95, Math.round(val)));
  const zone = val < 30 ? 'EXTREME FEAR' : val < 50 ? 'FEAR' : val < 70 ? 'GREED' : 'EXTREME GREED';
  return { value: val, zone };
}

// ─── /api/quotes ──────────────────────────────────────────────────────────────
app.get('/api/quotes', async (req, res) => {
  const cached = cache.get('quotes');
  if (cached) return res.json({ ...cached, cached: true });

  let quotes = {}, sources = [], errors = [];

  // A: Fyers (real-time Indian)
  try {
    const d = await fetchFyers();
    if (d && Object.keys(d).length > 0) { Object.assign(quotes, d); sources.push('fyers'); }
  } catch (e) { errors.push('fyers: ' + e.message); }

  // B: Kite (real-time Indian)
  try {
    const d = await fetchKite();
    if (d) { Object.entries(d).forEach(([k, v]) => { if (!quotes[k]) quotes[k] = v; }); sources.push('kite'); }
  } catch (e) { errors.push('kite: ' + e.message); }

  // C: Twelve Data (global indices + FX + commodities)
  try {
    const d = await fetchTwelveData();
    if (d && Object.keys(d).length > 0) {
      Object.entries(d).forEach(([k, v]) => {
        const grp = META_GROUPS[k];
        if (!quotes[k] || grp === 'us' || grp === 'asia' || grp === 'eu' || grp === 'comm') {
          quotes[k] = v;
        }
      });
      sources.push('twelvedata');
    }
  } catch (e) { errors.push('twelvedata: ' + e.message); }

  // D: FMP (fills gaps, especially Indian + global)
  try {
    const d = await fetchFMP();
    if (d) {
      Object.entries(d).forEach(([k, v]) => { if (!quotes[k]) quotes[k] = v; });
      sources.push('fmp');
    }
  } catch (e) { errors.push('fmp: ' + e.message); }

  // E: Alpha Vantage (fills remaining gaps — FX, Gold)
  try {
    const needed = new Set(Object.keys(META_GROUPS).filter(k => !quotes[k]));
    if (needed.size > 0) {
      const d = await fetchAlphaVantage(needed);
      if (d) {
        Object.entries(d).forEach(([k, v]) => { if (!quotes[k]) quotes[k] = v; });
        sources.push('alphavantage');
      }
    }
  } catch (e) { errors.push('alphavantage: ' + e.message); }

  // F: OER (USD/INR last resort)
  try {
    const needed = new Set(Object.keys(META_GROUPS).filter(k => !quotes[k]));
    if (needed.has('INR=X')) {
      const d = await fetchOER(needed);
      if (d) { Object.entries(d).forEach(([k, v]) => { if (!quotes[k]) quotes[k] = v; }); sources.push('oer'); }
    }
  } catch (e) { errors.push('oer: ' + e.message); }

  if (Object.keys(quotes).length === 0) {
    return res.status(503).json({ error: 'All data sources failed', errors });
  }

  const payload = {
    quotes, mmi: computeMMI(quotes), sources, errors,
    updatedAt: new Date().toISOString(), cached: false,
  };
  cache.set('quotes', payload);
  res.json(payload);
});

// ─── /health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status   : 'ok',
    time_ist : new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    fyers    : FYERS_TOKEN       ? '✅ configured' : '⚠️  not set',
    kite     : KITE_TOKEN        ? '✅ configured' : '⚠️  not set',
    twelvedata: TWELVE_DATA_KEY  ? '✅ configured' : '⚠️  NOT SET — get free key at twelvedata.com',
    fmp      : FMP_KEY           ? '✅ configured' : '⚠️  not set (optional)',
    alphavantage: ALPHA_VANTAGE_KEY ? '✅ configured' : '⚠️  not set (optional)',
    oer      : OER_APP_ID        ? '✅ configured' : '⚠️  not set (optional)',
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 MFS Live Backend v4 — port ${PORT}`);
  console.log(`   Twelve Data : ${TWELVE_DATA_KEY  ? '✅' : '❌ NOT SET — get free key at twelvedata.com'}`);
  console.log(`   FMP         : ${FMP_KEY          ? '✅' : '⚠️  not set'}`);
  console.log(`   Alpha Vant  : ${ALPHA_VANTAGE_KEY? '✅' : '⚠️  not set'}`);
  console.log(`   Fyers       : ${FYERS_TOKEN      ? '✅' : '⚠️  not set'}`);
  console.log(`   Kite        : ${KITE_TOKEN       ? '✅' : '⚠️  not set'}\n`);
});
