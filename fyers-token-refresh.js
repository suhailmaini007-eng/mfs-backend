/**
 * fyers-token-refresh.js
 * ──────────────────────
 * Run this script ONCE daily (e.g. 8:45 AM IST via cron / GitHub Actions)
 * to generate a fresh Fyers access token and push it to your Render service.
 *
 * Usage:
 *   FYERS_APP_ID=xxx FYERS_SECRET=yyy FYERS_AUTH_CODE=zzz \
 *   RENDER_SERVICE_ID=srv-xxx RENDER_API_KEY=rnd_xxx \
 *   node fyers-token-refresh.js
 *
 * How to get AUTH_CODE:
 *   1. Open browser → https://api-t1.fyers.in/api/v3/generate-authcode?
 *        client_id=YOUR_APP_ID&redirect_uri=https://127.0.0.1&response_type=code&state=mfs
 *   2. Login with Fyers credentials + TOTP
 *   3. Copy auth_code from the redirect URL
 *   4. Run this script with that code (valid for ~60 seconds)
 */

'use strict';
const https = require('https');

const {
  FYERS_APP_ID,
  FYERS_SECRET,
  FYERS_AUTH_CODE,
  RENDER_SERVICE_ID, // your Render service ID, e.g. srv-abc123
  RENDER_API_KEY,    // Render API key from https://dashboard.render.com/u/settings#api-keys
} = process.env;

if (!FYERS_APP_ID || !FYERS_SECRET || !FYERS_AUTH_CODE) {
  console.error('❌ Missing required env vars: FYERS_APP_ID, FYERS_SECRET, FYERS_AUTH_CODE');
  process.exit(1);
}

async function post(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const [, host, path] = url.match(/https:\/\/([^/]+)(.*)/);
    const req = https.request({ host, path, method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers
    }}, res => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function put(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const [, host, path] = url.match(/https:\/\/([^/]+)(.*)/);
    const req = https.request({ host, path, method: 'PUT', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers
    }}, res => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('🔑 Step 1: Generating Fyers access token…');
  
  const tokenRes = await post('https://api-t1.fyers.in/api/v3/validate-authcode', {
    grant_type : 'authorization_code',
    appIdHash  : require('crypto').createHash('sha256')
                  .update(`${FYERS_APP_ID}:${FYERS_SECRET}`).digest('hex'),
    code       : FYERS_AUTH_CODE,
  });

  const access_token = tokenRes?.access_token;
  if (!access_token) {
    console.error('❌ Failed to get access token:', JSON.stringify(tokenRes));
    process.exit(1);
  }
  console.log('✅ Got access token:', access_token.slice(0, 20) + '…');

  if (!RENDER_SERVICE_ID || !RENDER_API_KEY) {
    console.log('\n⚠️  RENDER_SERVICE_ID / RENDER_API_KEY not set.');
    console.log('   Manually set FYERS_TOKEN on Render to:', access_token);
    return;
  }

  console.log('🚀 Step 2: Updating FYERS_TOKEN on Render…');
  const renderRes = await put(
    `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,
    [{ key: 'FYERS_TOKEN', value: access_token }],
    { Authorization: `Bearer ${RENDER_API_KEY}`, Accept: 'application/json' }
  );
  console.log('✅ Render response:', JSON.stringify(renderRes).slice(0, 200));
  console.log('\n🎉 Done! FYERS_TOKEN updated. Render will restart the service automatically.');
})();
