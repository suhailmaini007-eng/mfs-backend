/**
 * MFS Live Market Backend v5
 * ──────────────────────────
 * Fixed: verbose error logging, Fyers API v3 correct endpoint & auth format,
 *        silent null returns replaced with thrown errors so errors[] is always populated
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
const PORT              = process.env.PORT              || 3000;
const FYERS_APP_ID      = process.env.FYERS_APP_ID      || '';
const FYERS_TOKEN       = process.env.FYERS_TOKEN       || '';
const KITE_API_KEY      = process.env.KITE_API_KEY      || '';
const KITE_TOKEN        = process.env.KITE_ACCESS_TOKEN || '';
const TWELVE_DATA_KEY   = process.env.TWELVE_DATA_KEY   || '';
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || '';
const FMP_KEY           = process.env.FMP_KEY           || '';

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

const TD_SYMBOLS = {
  'NIFTY'    : '^NSEI',   'BANKNIFTY': '^NSEBANK',
  'DJI'      : '^DJI',    'NDX'      : '^IXIC',
  'SPX'      : '^GSPC',   'HSI'      : '^HSI',
  'NI225'    : '^N225',   'FTSE'     : '^FTSE',
  'DAX'      : '^GDAXI',  'XAU/USD'  : 'GC=F',
  'WTI/USD'  : 'CL=F',   'USD/INR'  : 'INR=X',
};

const FMP_SYMBOLS = {
  '^NSEI' : 'NIFTY',  '^BSESN': '^BSESN',
  '^DJI'  : '^DJI',   '^IXIC' : '^IXIC',
  '^GSPC' : '^GSPC',  '^HSI'  : '^HSI',
  '^N225' : '^N225',  '^FTSE' : '^FTSE',
  '^GDAXI': '^GDAXI', 'GC=F'  : 'GCUSD',
  'CL=F'  : 'CLUSD',  'INR=X' : 'USDINR',
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
      'User-Agent': 'Mozilla/5.0 (compatible; MFS-Backend/5.0)',
      'Accept': 'application/json',
      ...(opts.headers || {}),
    },
    ...opts,
  });
}

// ─── SOURCE A: Fyers v3 API ───────────────────────────────────────────────────
async function fetchFyers() {
  if (!FYERS_TOKEN) throw new Error('FYERS_TOKEN env var not set');
  if (!FYERS_APP_ID) throw new Error('FYERS_APP_ID env var not set');

  const syms = Object.values(FYERS_SYMBOLS).join(',');

  // Fyers API v3 correct endpoint and auth header format
  const url = `https://api-t1.fyers.in/data/quotes/?symbols=${encodeURIComponent(syms)}`;
  const authHeader = `${FYERS_APP_ID}:${FYERS_TOKEN}`;

  console.log(`[Fyers] Calling: ${url}`);
  console.log(`[Fyers] Auth: ${FYERS_APP_ID}:${FYERS_TOKEN.slice(0,20)}...`);

  const res = await axiosGet(url, {
    headers: { 'Authorization': authHeader },
  });

  console.log(`[Fyers] Response code: ${res.data?.code}, message: ${res.data?.message}`);
  console.log(`[Fyers] Response keys: ${Object.keys(res.data || {}).join(', ')}`);

  // Fyers returns code 200 on success
  if (res.data?.code !== 200) {
    throw new Error(`Fyers API error — code: ${res.data?.code}, msg: ${JSON.stringify(res.data?.message || res.data)}`);
  }

  const items = res.data?.d || res.data?.data || [];
  console.log(`[Fyers] Items received: ${items.length}`);

  if (items.length === 0) {
    throw new Error(`Fyers returned 0 quotes. Full response: ${JSON.stringify(res.data).slice(0, 300)}`);
  }

  const rev = Object.fromEntries(Object.entries(FYERS_SYMBOLS).map(([k, v]) => [v, k]));
  const out = {};

  items.forEach(item => {
    // Fyers v3 data structure: item.n = symbol, item.v = quote data
    const sym = rev[item.n];
    if (!sym) { console.log(`[Fyers] Unknown symbol: ${item.n}`); return; }
    const v = item.v;
    const ltp = v.lp || v.last_price || v.close_price || 0;
    const prev = v.prev_close_price || v.prev_close || 0;
    const chg = v.ch || v.change || (ltp - prev);
    const pct = v.chp || v.change_percentage || (prev ? (chg / prev) * 100 : 0);
    out[sym] = { ...makeQuote(sym, ltp, prev, chg, pct, v.tt || null, 'fyers') };
    console.log(`[Fyers] ${sym} = ${ltp}`);
  });

  if (Object.keys(out).length === 0) {
    throw new Error('Fyers: parsed 0 quotes from response items');
  }

  return out;
}

// ─── SOURCE B: Kite ───────────────────────────────────────────────────────────
async function fetchKite() {
  if (!KITE_API_KEY) throw new Error('KITE_API_KEY not set');
  if (!KITE_TOKEN)   throw new Error('KITE_ACCESS_TOKEN not set');

  const res = await axiosGet(
    `https://api.kite.trade/quote?i=${Object.values(KITE_SYMBOLS).join('&i=')}`,
    { headers: { 'X-Kite-Version': '3', 'Authorization': `token ${KITE_API_KEY}:${KITE_TOKEN}` } }
  );
  if (!res.data?.data) throw new Error(`Kite: empty response — ${JSON.stringify(res.data).slice(0,200)}`);

  const rev = Object.fromEntries(Object.entries(KITE_SYMBOLS).map(([k, v]) => [String(v), k]));
  const out = {};
  Object.entries(res.data.data).forEach(([, v]) => {
    const sym = rev[String(v.instrument_token)]; if (!sym) return;
    const ltp = v.last_price, prev = v.ohlc?.close || ltp;
    out[sym] = { ...makeQuote(sym, ltp, prev, ltp - prev, prev ? ((ltp - prev) / prev * 100) : 0, null, 'kite') };
  });
  return out;
}

// ─── SOURCE C: Twelve Data ────────────────────────────────────────────────────
async function fetchTwelveData() {
  if (!TWELVE_DATA_KEY) throw new Error('TWELVE_DATA_KEY not set');

  const indices     = ['NIFTY','BANKNIFTY','DJI','NDX','SPX','HSI','NI225','FTSE','DAX'];
  const forex       = ['USD/INR'];
  const commodities = ['XAU/USD','WTI/USD'];
  const out = {};

  const processQuote = (sym, q) => {
    if (!q || q.status === 'error' || !q.close) {
      console.log(`[TD] Skip ${sym}: ${JSON.stringify(q).slice(0,100)}`);
      return;
    }
    const ourSym = TD_SYMBOLS[sym]; if (!ourSym) return;
    const ltp  = parseFloat(q.close)          || 0;
    const prev = parseFloat(q.previous_close) || ltp;
    const chg  = parseFloat(q.change)         || (ltp - prev);
    const pct  = parseFloat(q.percent_change) || (prev ? (chg / prev) * 100 : 0);
    out[ourSym] = { ...makeQuote(ourSym, ltp, prev, chg, pct, null, 'twelvedata') };
  };

  try {
    const r = await axiosGet(`https://api.twelvedata.com/quote?symbol=${indices.join(',')}&apikey=${TWELVE_DATA_KEY}`);
    const d = r.data || {};
    indices.forEach(s => processQuote(s, indices.length === 1 ? d : d[s]));
  } catch (e) { console.log('[TD] indices error:', e.message); }

  try {
    const r = await axiosGet(`https://api.twelvedata.com/quote?symbol=${forex.join(',')}&apikey=${TWELVE_DATA_KEY}`);
    forex.forEach(s => processQuote(s, r.data));
  } catch (e) { console.log('[TD] forex error:', e.message); }

  try {
    const r = await axiosGet(`https://api.twelvedata.com/quote?symbol=${commodities.join(',')}&apikey=${TWELVE_DATA_KEY}`);
    const d = r.data || {};
    commodities.forEach(s => processQuote(s, commodities.length === 1 ? d : d[s]));
  } catch (e) { console.log('[TD] commodities error:', e.message); }

  if (Object.keys(out).length === 0) throw new Error('Twelve Data: 0 quotes parsed');
  return out;
}

// ─── SOURCE D: FMP ────────────────────────────────────────────────────────────
async function fetchFMP() {
  if (!FMP_KEY) throw new Error('FMP_KEY not set');

  const fmpSyms = Object.values(FMP_SYMBOLS).join(',');
  const res = await axiosGet(`https://financialmodelingprep.com/api/v3/quote/${fmpSyms}?apikey=${FMP_KEY}`);
  if (!Array.isArray(res.data)) throw new Error(`FMP: unexpected response — ${JSON.stringify(res.data).slice(0,200)}`);

  const rev = Object.fromEntries(Object.entries(FMP_SYMBOLS).map(([k, v]) => [v.toUpperCase(), k]));
  const out = {};
  res.data.forEach(q => {
    const ourSym = rev[q.symbol?.toUpperCase()]; if (!ourSym) return;
    const ltp  = parseFloat(q.price)            || 0; if (ltp === 0) return;
    const prev = parseFloat(q.previousClose)    || ltp;
    const chg  = parseFloat(q.change)           || (ltp - prev);
    const pct  = parseFloat(q.changesPercentage)|| (prev ? (chg / prev) * 100 : 0);
    out[ourSym] = { ...makeQuote(ourSym, ltp, prev, chg, pct, null, 'fmp') };
  });
  if (Object.keys(out).length === 0) throw new Error('FMP: 0 quotes parsed');
  return out;
}

// ─── SOURCE E: Alpha Vantage (USD/INR + Gold) ─────────────────────────────────
async function fetchAlphaVantage(needed) {
  if (!ALPHA_VANTAGE_KEY) throw new Error('ALPHA_VANTAGE_KEY not set');
  const out = {};

  if (needed.has('INR=X')) {
    try {
      const res = await axiosGet(`https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=INR&apikey=${ALPHA_VANTAGE_KEY}`);
      const rate = parseFloat(res.data?.['Realtime Currency Exchange Rate']?.['5. Exchange Rate']);
      if (rate) out['INR=X'] = { ...makeQuote('INR=X', rate, rate, 0, 0, null, 'alphavantage') };
    } catch (e) { console.log('[AV] FX error:', e.message); }
  }

  return Object.keys(out).length > 0 ? out : null;
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

  // A: Fyers
  try {
    const d = await fetchFyers();
    if (d && Object.keys(d).length > 0) { Object.assign(quotes, d); sources.push('fyers'); }
  } catch (e) { console.error('[Fyers ERROR]', e.message); errors.push('fyers: ' + e.message); }

  // B: Kite
  try {
    const d = await fetchKite();
    if (d) { Object.entries(d).forEach(([k, v]) => { if (!quotes[k]) quotes[k] = v; }); sources.push('kite'); }
  } catch (e) { errors.push('kite: ' + e.message); }

  // C: Twelve Data
  try {
    const d = await fetchTwelveData();
    if (d && Object.keys(d).length > 0) {
      Object.entries(d).forEach(([k, v]) => {
        const grp = META_GROUPS[k];
        if (!quotes[k] || grp === 'us' || grp === 'asia' || grp === 'eu' || grp === 'comm') quotes[k] = v;
      });
      sources.push('twelvedata');
    }
  } catch (e) { errors.push('twelvedata: ' + e.message); }

  // D: FMP
  try {
    const d = await fetchFMP();
    if (d) { Object.entries(d).forEach(([k, v]) => { if (!quotes[k]) quotes[k] = v; }); sources.push('fmp'); }
  } catch (e) { errors.push('fmp: ' + e.message); }

  // E: Alpha Vantage (fills remaining gaps)
  try {
    const needed = new Set(Object.keys(META_GROUPS).filter(k => !quotes[k]));
    if (needed.size > 0 && ALPHA_VANTAGE_KEY) {
      const d = await fetchAlphaVantage(needed);
      if (d) { Object.entries(d).forEach(([k, v]) => { if (!quotes[k]) quotes[k] = v; }); sources.push('alphavantage'); }
    }
  } catch (e) { errors.push('alphavantage: ' + e.message); }

  if (Object.keys(quotes).length === 0) {
    console.error('ALL SOURCES FAILED:', errors);
    return res.status(503).json({ error: 'All data sources failed', errors });
  }

  const payload = {
    quotes, mmi: computeMMI(quotes), sources, errors,
    updatedAt: new Date().toISOString(), cached: false,
  };
  cache.set('quotes', payload);
  res.json(payload);
});

// ─── /api/debug — shows raw Fyers response for diagnosis ─────────────────────
app.get('/api/debug', async (req, res) => {
  if (!FYERS_TOKEN || !FYERS_APP_ID) {
    return res.json({ error: 'FYERS_TOKEN or FYERS_APP_ID not set in env vars' });
  }
  try {
    const syms = Object.values(FYERS_SYMBOLS).join(',');
    const url  = `https://api-t1.fyers.in/data/quotes/?symbols=${encodeURIComponent(syms)}`;
    const r    = await axiosGet(url, { headers: { 'Authorization': `${FYERS_APP_ID}:${FYERS_TOKEN}` } });
    res.json({ url, auth_prefix: `${FYERS_APP_ID}:${FYERS_TOKEN.slice(0,30)}...`, response: r.data });
  } catch (e) {
    res.json({ error: e.message, status: e.response?.status, data: e.response?.data });
  }
});

// ─── /health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status   : 'ok',
    version  : 'v5',
    time_ist : new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    env: {
      fyers        : FYERS_TOKEN      ? `✅ set (${FYERS_APP_ID})` : '❌ NOT SET',
      kite         : KITE_TOKEN       ? '✅ set' : '⚠️  not set',
      twelvedata   : TWELVE_DATA_KEY  ? '✅ set' : '⚠️  not set — get free at twelvedata.com',
      fmp          : FMP_KEY          ? '✅ set' : '⚠️  not set — get free at financialmodelingprep.com',
      alphavantage : ALPHA_VANTAGE_KEY? '✅ set' : '⚠️  not set',
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 MFS Live Backend v5 — port ${PORT}`);
  console.log(`   FYERS_APP_ID : ${FYERS_APP_ID || '❌ NOT SET'}`);
  console.log(`   FYERS_TOKEN  : ${FYERS_TOKEN ? FYERS_TOKEN.slice(0,30)+'...' : '❌ NOT SET'}`);
  console.log(`   Twelve Data  : ${TWELVE_DATA_KEY  ? '✅' : '⚠️  not set'}`);
  console.log(`   FMP          : ${FMP_KEY          ? '✅' : '⚠️  not set'}\n`);
});
