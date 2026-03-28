/**
 * MFS Live Market Backend v3
 * ──────────────────────────
 * Data sources (in priority order):
 *   1. Fyers API          — real-time Indian indices (when token set)
 *   2. Zerodha/Kite API   — real-time Indian indices (when token set)
 *   3. NSE India API      — free, no key, works from server IPs (Indian indices)
 *   4. stooq.com          — free CSV quotes, no key, works from server IPs (global)
 *   5. Yahoo Finance      — with exponential backoff retry (last resort)
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
const PORT         = process.env.PORT || 3000;
const FYERS_APP_ID = process.env.FYERS_APP_ID       || '';
const FYERS_TOKEN  = process.env.FYERS_TOKEN         || '';
const KITE_API_KEY = process.env.KITE_API_KEY        || '';
const KITE_TOKEN   = process.env.KITE_ACCESS_TOKEN   || '';

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
  '^NSEI'     : 256265,
  '^NSEBANK'  : 260105,
  '^CNXIT'    : 259849,
  '^CNXPHARMA': 260617,
  '^CNXAUTO'  : 258801,
};

const NSE_INDEX_MAP = {
  'NIFTY 50'       : '^NSEI',
  'NIFTY BANK'     : '^NSEBANK',
  'NIFTY IT'       : '^CNXIT',
  'NIFTY PHARMA'   : '^CNXPHARMA',
  'NIFTY AUTO'     : '^CNXAUTO',
  'NIFTY FMCG'     : '^CNXFMCG',
  'NIFTY METAL'    : '^CNXMETAL',
  'NIFTY MIDCAP 50': '^NSEMDCP50',
  'INDIA VIX'      : '^INDIAVIX',
};

const STOOQ_SYMBOLS = {
  '^DJI'  : '^dji',
  '^IXIC' : '^ndq',
  '^GSPC' : '^spx',
  '^HSI'  : '^hsi',
  '^N225' : '^n225',
  '^FTSE' : '^ftx',
  '^GDAXI': '^dax',
  '^BSESN': '^bse',
  'GC=F'  : 'xauusd',
  'CL=F'  : 'cl.f',
  'INR=X' : 'usdinr',
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
  const chgN  = chg != null ? parseFloat(chg) : ltpN - prevN;
  const pctN  = pct != null ? parseFloat(pct) : (prevN ? (chgN / prevN) * 100 : 0);
  return {
    symbol   : sym,
    ltp      : ltpN,
    prevClose: prevN,
    chg      : parseFloat(chgN.toFixed(2)),
    pct      : parseFloat(pctN.toFixed(4)),
    up       : chgN >= 0,
    time     : timestamp || Math.floor(Date.now() / 1000),
    source   : source || 'unknown',
  };
}

function axiosGet(url, opts = {}) {
  return axios.get(url, {
    timeout: 12000,
    headers: {
      'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Accept'         : 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(opts.headers || {}),
    },
    ...opts,
  });
}

// ─── SOURCE A: Fyers ──────────────────────────────────────────────────────────
async function fetchFyers() {
  if (!FYERS_TOKEN || !FYERS_APP_ID) return null;
  const syms = Object.values(FYERS_SYMBOLS).join(',');
  const res  = await axiosGet(
    `https://api-t1.fyers.in/data/quotes?symbols=${encodeURIComponent(syms)}`,
    { headers: { 'Authorization': `${FYERS_APP_ID}:${FYERS_TOKEN}` } }
  );
  if (res.data?.code !== 200) throw new Error('Fyers: ' + (res.data?.message || 'bad response'));
  const reverseMap = Object.fromEntries(Object.entries(FYERS_SYMBOLS).map(([k, v]) => [v, k]));
  const out = {};
  (res.data?.d || []).forEach(item => {
    const sym = reverseMap[item.n]; if (!sym) return;
    const v = item.v;
    out[sym] = { ...makeQuote(sym, v.lp, v.prev_close_price, v.ch, v.chp, v.tt, 'fyers'), shortName: item.n };
  });
  return out;
}

// ─── SOURCE B: Kite ───────────────────────────────────────────────────────────
async function fetchKite() {
  if (!KITE_API_KEY || !KITE_TOKEN) return null;
  const tokens = Object.values(KITE_SYMBOLS);
  const res = await axiosGet(
    `https://api.kite.trade/quote?i=${tokens.join('&i=')}`,
    { headers: { 'X-Kite-Version': '3', 'Authorization': `token ${KITE_API_KEY}:${KITE_TOKEN}` } }
  );
  if (!res.data?.data) throw new Error('Kite: empty');
  const reverseMap = Object.fromEntries(Object.entries(KITE_SYMBOLS).map(([k, v]) => [String(v), k]));
  const out = {};
  Object.entries(res.data.data).forEach(([, v]) => {
    const sym = reverseMap[String(v.instrument_token)]; if (!sym) return;
    const ltp = v.last_price, prev = v.ohlc?.close || ltp, chg = ltp - prev, pct = prev ? (chg / prev) * 100 : 0;
    out[sym] = { ...makeQuote(sym, ltp, prev, chg, pct, null, 'kite') };
  });
  return out;
}

// ─── SOURCE C: NSE India API (free, no key needed) ────────────────────────────
let _nseCookie = '';
let _nseCookieFetchedAt = 0;

async function fetchNSE() {
  const out = {};

  // NSE needs a session cookie — refresh every 30 minutes
  if (!_nseCookie || (Date.now() - _nseCookieFetchedAt) > 1800000) {
    try {
      const r = await axiosGet('https://www.nseindia.com/', {
        headers: { 'Accept': 'text/html,application/xhtml+xml,*/*', 'Referer': 'https://www.google.com/' },
        timeout: 10000,
      });
      const setCookie = r.headers['set-cookie'] || [];
      _nseCookie = setCookie.map(c => c.split(';')[0]).join('; ');
      _nseCookieFetchedAt = Date.now();
    } catch (_) { /* proceed without cookie, may still work */ }
  }

  const res = await axiosGet('https://www.nseindia.com/api/allIndices', {
    headers: {
      'Referer'         : 'https://www.nseindia.com/market-data/live-equity-market',
      'Accept'          : 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ..._nseCookie ? { 'Cookie': _nseCookie } : {},
    },
  });

  const indices = res.data?.data;
  if (!Array.isArray(indices)) throw new Error('NSE: unexpected response format');

  indices.forEach(idx => {
    const sym = NSE_INDEX_MAP[idx.indexSymbol] || NSE_INDEX_MAP[idx.index];
    if (!sym) return;
    const ltp  = parseFloat(idx.last)         || parseFloat(idx.current) || 0;
    const prev = parseFloat(idx.previousClose) || 0;
    const chg  = parseFloat(idx.change)        || (ltp - prev);
    const pct  = parseFloat(idx.percentChange) || (prev ? (chg / prev) * 100 : 0);
    if (ltp === 0) return;
    out[sym] = { ...makeQuote(sym, ltp, prev, chg, pct, null, 'nse') };
  });

  if (Object.keys(out).length === 0) throw new Error('NSE: no matching indices parsed');
  return out;
}

// ─── SOURCE D: Stooq CSV (free, global indices + commodities) ─────────────────
async function fetchStooq() {
  const stooqKeys = Object.values(STOOQ_SYMBOLS).join(',');
  const url = `https://stooq.com/q/l/?s=${stooqKeys}&f=sd2t2ohlcv&h&e=csv`;
  const res = await axiosGet(url, {
    headers: { 'Referer': 'https://stooq.com/' },
    responseType: 'text',
    timeout: 12000,
  });

  const lines = (res.data || '').trim().split('\n');
  if (lines.length < 2) throw new Error('Stooq: empty response');

  const reverseMap = Object.fromEntries(
    Object.entries(STOOQ_SYMBOLS).map(([k, v]) => [v.toLowerCase(), k])
  );

  const out = {};
  lines.slice(1).forEach(line => {
    const cols    = line.split(',');
    if (cols.length < 7) return;
    const stooqSym = (cols[0] || '').toLowerCase().trim();
    const ourSym   = reverseMap[stooqSym]; if (!ourSym) return;
    const close    = parseFloat(cols[6]) || 0; if (close === 0) return;
    const open_    = parseFloat(cols[3]) || close;
    const chg      = close - open_;
    const pct      = open_ ? (chg / open_) * 100 : 0;
    out[ourSym] = { ...makeQuote(ourSym, close, open_, chg, pct, null, 'stooq') };
  });

  if (Object.keys(out).length === 0) throw new Error('Stooq: no data parsed from CSV');
  return out;
}

// ─── SOURCE E: Yahoo Finance (rate-limited, exponential backoff) ───────────────
let _yfLastTry = 0;
let _yfBackoff = 120000;

async function fetchYahoo(symbols) {
  const waitRemaining = _yfBackoff - (Date.now() - _yfLastTry);
  if (_yfLastTry > 0 && waitRemaining > 0) {
    throw new Error(`Yahoo: in backoff (${Math.round(waitRemaining / 1000)}s remaining)`);
  }

  const fields = 'regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,regularMarketTime,shortName';
  _yfLastTry = Date.now();

  for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
    try {
      const res = await axiosGet(
        `${base}/v8/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&fields=${fields}&formatted=false`,
        { headers: { 'Referer': 'https://finance.yahoo.com/' } }
      );
      const results = res.data?.quoteResponse?.result;
      if (!Array.isArray(results) || results.length === 0) continue;
      _yfBackoff = 120000; // reset on success
      const out = {};
      results.forEach(q => {
        if (!q.regularMarketPrice) return;
        out[q.symbol] = {
          ...makeQuote(q.symbol, q.regularMarketPrice, q.regularMarketPreviousClose,
            q.regularMarketChange, q.regularMarketChangePercent, q.regularMarketTime, 'yahoo'),
          shortName: q.shortName || q.symbol,
        };
      });
      if (Object.keys(out).length > 0) return out;
    } catch (e) {
      if (e.response?.status === 429) {
        _yfBackoff = Math.min(_yfBackoff * 2, 7200000);
        throw new Error(`Yahoo: 429, next retry in ${Math.round(_yfBackoff / 60000)}m`);
      }
    }
  }
  throw new Error('Yahoo: all endpoints returned no data');
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
  } catch (e) { errors.push('fyers: ' + e.message); }

  // B: Kite
  try {
    const d = await fetchKite();
    if (d && Object.keys(d).length > 0) {
      Object.entries(d).forEach(([k, v]) => { if (!quotes[k]) quotes[k] = v; });
      sources.push('kite');
    }
  } catch (e) { errors.push('kite: ' + e.message); }

  // C: NSE India (Indian indices — free)
  try {
    const d = await fetchNSE();
    if (d && Object.keys(d).length > 0) {
      Object.entries(d).forEach(([k, v]) => { if (!quotes[k]) quotes[k] = v; });
      sources.push('nse');
    }
  } catch (e) { errors.push('nse: ' + e.message); }

  // D: Stooq (global + BSE + commodities — free)
  try {
    const d = await fetchStooq();
    if (d && Object.keys(d).length > 0) {
      Object.entries(d).forEach(([k, v]) => {
        const grp = META_GROUPS[k];
        if (!quotes[k] || grp === 'us' || grp === 'asia' || grp === 'eu' || grp === 'comm') {
          quotes[k] = v;
        }
      });
      sources.push('stooq');
    }
  } catch (e) { errors.push('stooq: ' + e.message); }

  // E: Yahoo Finance (only if still missing too many quotes)
  if (Object.keys(quotes).length < 8) {
    try {
      const allSyms = ['^NSEI','^NSEBANK','^BSESN','^INDIAVIX','^CNXIT','^CNXPHARMA',
        '^CNXAUTO','^CNXBANK','^CNXFMCG','^CNXMETAL','^NSEMDCP50',
        '^DJI','^IXIC','^GSPC','^HSI','^N225','^FTSE','^GDAXI','GC=F','CL=F','INR=X'];
      const d = await fetchYahoo(allSyms);
      Object.entries(d).forEach(([k, v]) => { if (!quotes[k]) quotes[k] = v; });
      sources.push('yahoo');
    } catch (e) { errors.push('yahoo: ' + e.message); }
  }

  if (Object.keys(quotes).length === 0) {
    return res.status(503).json({ error: 'All data sources failed', errors });
  }

  const payload = { quotes, mmi: computeMMI(quotes), sources, errors, updatedAt: new Date().toISOString(), cached: false };
  cache.set('quotes', payload);
  res.json(payload);
});

// ─── /health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status  : 'ok',
    time_ist: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    fyers   : FYERS_TOKEN ? 'configured' : 'not configured',
    kite    : KITE_TOKEN  ? 'configured' : 'not configured',
    free_sources: ['nse.india (Indian indices)', 'stooq.com (global + commodities)'],
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 MFS Live Backend v3 — port ${PORT}`);
  console.log(`   Fyers : ${FYERS_TOKEN ? '✅' : '⚠️  not set (using NSE free)'}`);
  console.log(`   Kite  : ${KITE_TOKEN  ? '✅' : '⚠️  not set (using NSE free)'}`);
  console.log(`   NSE   : ✅ free — Indian indices`);
  console.log(`   Stooq : ✅ free — global indices + commodities\n`);
});
