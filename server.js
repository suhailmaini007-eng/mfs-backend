/**
 * MFS Live Market Backend
 * Serves real-time Indian & global market data for Maini Financial Services dashboard
 * 
 * Data sources (in priority order):
 *   1. Fyers WebSocket API  — real-time Indian equities (if configured)
 *   2. Zerodha / Kite API   — real-time Indian equities (if configured)  
 *   3. Yahoo Finance v8 API — ~15 min delayed, no key required (fallback)
 *
 * Deploy on Render (free tier) → set env vars → point HTML to your Render URL
 */

'use strict';

const express   = require('express');
const cors      = require('cors');
const NodeCache = require('node-cache');
const axios     = require('axios');

const app   = express();
const cache = new NodeCache({ stdTTL: 55 }); // 55-second cache (refresh every 60s)

// ─── CORS: allow any origin so the HTML file works from localhost or any host ──
app.use(cors());
app.use(express.json());

// ─── CONFIG from environment variables ────────────────────────────────────────
const PORT          = process.env.PORT || 3000;

// Fyers
const FYERS_APP_ID  = process.env.FYERS_APP_ID  || '';
const FYERS_SECRET  = process.env.FYERS_SECRET   || '';
const FYERS_TOKEN   = process.env.FYERS_TOKEN    || ''; // access_token (refresh daily or use auto-refresh)

// Zerodha / Kite
const KITE_API_KEY  = process.env.KITE_API_KEY   || '';
const KITE_TOKEN    = process.env.KITE_ACCESS_TOKEN || ''; // access_token

// ─── SYMBOLS ──────────────────────────────────────────────────────────────────
// Yahoo Finance symbols
const YF_SYMBOLS = [
  '^NSEI','^NSEBANK','^BSESN','^INDIAVIX',
  '^CNXIT','^CNXPHARMA','^CNXAUTO','^CNXBANK','^CNXFMCG','^CNXMETAL','^NSEMDCP50',
  '^DJI','^IXIC','^GSPC',
  '^HSI','^N225','^FTSE','^GDAXI',
  'GC=F','CL=F','INR=X'
];

// Fyers NSE symbols (only Indian indices)
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

// Zerodha NSE instrument tokens (NSE indices)
const KITE_SYMBOLS = {
  '^NSEI'     : 256265,
  '^NSEBANK'  : 260105,
  '^CNXIT'    : 259849,
  '^CNXPHARMA': 260617,
  '^CNXAUTO'  : 258801,
};

// ─── HELPER: format a quote into a unified object ─────────────────────────────
function makeQuote(sym, ltp, prevClose, chg, pct, timestamp) {
  const ltpN = parseFloat(ltp) || 0;
  const prevN = parseFloat(prevClose) || 0;
  const chgN  = chg != null ? parseFloat(chg) : ltpN - prevN;
  const pctN  = pct != null ? parseFloat(pct)  : prevN ? ((chgN / prevN) * 100) : 0;
  return {
    symbol   : sym,
    ltp      : ltpN,
    prevClose: prevN,
    chg      : parseFloat(chgN.toFixed(2)),
    pct      : parseFloat(pctN.toFixed(4)),
    up       : chgN >= 0,
    time     : timestamp || Math.floor(Date.now() / 1000),
    source   : 'yahoo',
  };
}

// ─── SOURCE 1: Yahoo Finance ──────────────────────────────────────────────────
async function fetchYahooFinance(symbols) {
  const fields = 'regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,regularMarketTime,shortName';
  const url = `https://query2.finance.yahoo.com/v8/finance/quote?symbols=${symbols.join(',')}&fields=${fields}&formatted=false&lang=en-US&region=IN`;
  
  const res = await axios.get(url, {
    timeout: 10000,
    headers: {
      'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept'          : 'application/json',
      'Accept-Language' : 'en-US,en;q=0.9',
      'Referer'         : 'https://finance.yahoo.com/',
    }
  });

  const results = res.data?.quoteResponse?.result;
  if (!Array.isArray(results) || results.length === 0)
    throw new Error('Yahoo: empty result');

  const out = {};
  results.forEach(q => {
    if (!q.regularMarketPrice) return;
    out[q.symbol] = {
      ...makeQuote(
        q.symbol,
        q.regularMarketPrice,
        q.regularMarketPreviousClose,
        q.regularMarketChange,
        q.regularMarketChangePercent,
        q.regularMarketTime
      ),
      shortName: q.shortName || q.symbol,
      source   : 'yahoo',
    };
  });
  return out;
}

// ─── SOURCE 2: Fyers API ──────────────────────────────────────────────────────
async function fetchFyersQuotes() {
  if (!FYERS_TOKEN) return null;

  const fyersSyms = Object.values(FYERS_SYMBOLS).join(',');
  const url = `https://api-t1.fyers.in/data/quotes?symbols=${encodeURIComponent(fyersSyms)}`;

  const res = await axios.get(url, {
    timeout: 8000,
    headers: {
      'Authorization': `${FYERS_APP_ID}:${FYERS_TOKEN}`,
      'Content-Type' : 'application/json',
    }
  });

  if (res.data?.code !== 200) throw new Error('Fyers: ' + (res.data?.message || 'unknown error'));

  const out = {};
  const reverseMap = Object.fromEntries(Object.entries(FYERS_SYMBOLS).map(([k, v]) => [v, k]));

  (res.data?.d || []).forEach(item => {
    const yahooSym = reverseMap[item.n];
    if (!yahooSym) return;
    const v = item.v;
    out[yahooSym] = {
      ...makeQuote(yahooSym, v.lp, v.prev_close_price, v.ch, v.chp, v.tt),
      shortName: item.n,
      source   : 'fyers',
    };
  });
  return out;
}

// ─── SOURCE 3: Zerodha / Kite API ────────────────────────────────────────────
async function fetchKiteQuotes() {
  if (!KITE_API_KEY || !KITE_TOKEN) return null;

  const tokens = Object.values(KITE_SYMBOLS);
  const url = `https://api.kite.trade/quote?i=${tokens.join('&i=')}`;

  const res = await axios.get(url, {
    timeout: 8000,
    headers: {
      'X-Kite-Version' : '3',
      'Authorization'  : `token ${KITE_API_KEY}:${KITE_TOKEN}`,
    }
  });

  if (!res.data?.data) throw new Error('Kite: empty response');

  const out = {};
  const reverseMap = Object.fromEntries(Object.entries(KITE_SYMBOLS).map(([k, v]) => [String(v), k]));

  Object.entries(res.data.data).forEach(([key, v]) => {
    // key is like "NSE:NIFTY 50"
    const token = v.instrument_token;
    const yahooSym = reverseMap[String(token)];
    if (!yahooSym) return;
    const ltp      = v.last_price;
    const prevClose = v.ohlc?.close || v.last_price;
    const chg = ltp - prevClose;
    const pct = prevClose ? (chg / prevClose) * 100 : 0;
    out[yahooSym] = {
      ...makeQuote(yahooSym, ltp, prevClose, chg, pct, Math.floor(Date.now() / 1000)),
      shortName: key,
      source   : 'kite',
    };
  });
  return out;
}

// ─── MARKET MOOD INDEX (computed from Nifty 50 52w high/low approximation) ───
function computeMMI(quotes) {
  const nifty = quotes['^NSEI'];
  if (!nifty) return { value: 50, zone: 'NEUTRAL', prev: null };
  // Simple RSI-style estimate using intraday change (rough proxy)
  // For production, integrate CNN Fear & Greed or IndiaMoodIndex API
  const pctAbs = Math.min(Math.abs(nifty.pct) * 10, 15);
  let base = 50;
  if (nifty.up) base = 50 + pctAbs;
  else base = 50 - pctAbs;
  base = Math.max(5, Math.min(95, Math.round(base)));
  const zone = base < 30 ? 'EXTREME FEAR' : base < 50 ? 'FEAR' : base < 70 ? 'GREED' : 'EXTREME GREED';
  return { value: base, zone, prev: null };
}

// ─── MAIN QUOTES ENDPOINT ────────────────────────────────────────────────────
app.get('/api/quotes', async (req, res) => {
  const cached = cache.get('quotes');
  if (cached) return res.json({ ...cached, cached: true });

  let quotes   = {};
  let sources  = [];
  let errors   = [];

  // Try Fyers first for Indian data
  try {
    const fyersData = await fetchFyersQuotes();
    if (fyersData && Object.keys(fyersData).length > 0) {
      quotes  = { ...quotes, ...fyersData };
      sources.push('fyers');
    }
  } catch (e) {
    errors.push('fyers: ' + e.message);
  }

  // Try Kite for Indian data (merges / fills gaps)
  try {
    const kiteData = await fetchKiteQuotes();
    if (kiteData && Object.keys(kiteData).length > 0) {
      quotes  = { ...quotes, ...kiteData };
      if (!sources.includes('kite')) sources.push('kite');
    }
  } catch (e) {
    errors.push('kite: ' + e.message);
  }

  // Always fetch Yahoo for global indices + commodities + anything missing
  try {
    const yfData = await fetchYahooFinance(YF_SYMBOLS);
    // Merge: don't overwrite Indian symbols if already fetched from Fyers/Kite
    Object.entries(yfData).forEach(([sym, data]) => {
      if (!quotes[sym]) quotes[sym] = data;
      else {
        // Still take Yahoo data for global symbols
        const m = META_GROUPS[sym];
        if (m && (m === 'us' || m === 'asia' || m === 'eu' || m === 'comm')) {
          quotes[sym] = data;
        }
      }
    });
    sources.push('yahoo');
  } catch (e) {
    errors.push('yahoo: ' + e.message);
  }

  if (Object.keys(quotes).length === 0) {
    return res.status(503).json({ error: 'All data sources failed', errors });
  }

  const mmi = computeMMI(quotes);
  const payload = {
    quotes,
    mmi,
    sources,
    errors,
    updatedAt : new Date().toISOString(),
    cached    : false,
  };

  cache.set('quotes', payload);
  res.json(payload);
});

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  res.json({
    status     : 'ok',
    time_ist   : ist,
    fyers      : !!FYERS_TOKEN  ? 'configured' : 'not configured',
    kite       : !!KITE_TOKEN   ? 'configured' : 'not configured',
    yahoo      : 'always on (fallback)',
    cache_ttl  : cache.options.stdTTL + 's',
  });
});

// ─── FYERS TOKEN REFRESH ENDPOINT (call this from your daily cron/script) ───
app.post('/api/fyers/token', async (req, res) => {
  // In production, implement Fyers auth code flow here
  // For now, token must be set via FYERS_TOKEN env var
  res.json({ message: 'Set FYERS_TOKEN env var on Render. See README for daily refresh script.' });
});

const META_GROUPS = {
  '^NSEI':'india','^NSEBANK':'india','^BSESN':'india','^INDIAVIX':'india',
  '^CNXIT':'sector','^CNXPHARMA':'sector','^CNXAUTO':'sector','^CNXBANK':'sector',
  '^CNXFMCG':'sector','^CNXMETAL':'sector','^NSEMDCP50':'sector',
  '^DJI':'us','^IXIC':'us','^GSPC':'us',
  '^HSI':'asia','^N225':'asia','^FTSE':'eu','^GDAXI':'eu',
  'GC=F':'comm','CL=F':'comm','INR=X':'comm',
};

app.listen(PORT, () => {
  console.log(`\n🚀 MFS Live Backend running on port ${PORT}`);
  console.log(`   Fyers: ${FYERS_TOKEN ? '✅ configured' : '⚠️  not configured (Yahoo fallback)'}`);
  console.log(`   Kite:  ${KITE_TOKEN  ? '✅ configured' : '⚠️  not configured (Yahoo fallback)'}`);
  console.log(`   GET /api/quotes  → live market data`);
  console.log(`   GET /health      → status check\n`);
});
