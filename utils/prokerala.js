// utils/prokerala.js
import axios from 'axios';

const TOKEN_URL = process.env.PK_TOKEN_URL || 'https://api.prokerala.com/token';
const API_BASE  = process.env.PK_API_BASE  || 'https://api.prokerala.com';

// For sandbox: Prokerala allows only January 1 (any year).
// You can change the year via PK_SANDBOX_DATE if needed.
const SANDBOX_DATE = (process.env.PK_SANDBOX_DATE || '2025-01-01').slice(0, 10);

let tokenCache = { token: null, expAt: 0 };

/* ─────────────────────────────────────────────
 * SIMPLE SANDBOX DATE OVERRIDE
 * ───────────────────────────────────────────── */

// Force datetime to SANDBOX_DATE, keep time+offset if present
function forceSandboxDate(params = {}) {
  const out = { ...params };

  // 1) Handle main datetime
  const original = typeof out.datetime === 'string' ? out.datetime : null;
  let base = original || `${SANDBOX_DATE}T00:00:00+00:00`;

  const tIndex = base.indexOf('T');
  const timePart = tIndex >= 0 ? base.substring(tIndex) : 'T00:00:00+00:00';

  out.datetime = `${SANDBOX_DATE}${timePart}`;

  // 2) Handle optional profile.datetime (if present)
  if (out.profile && typeof out.profile.datetime === 'string') {
    const pBase = out.profile.datetime;
    const pIdx  = pBase.indexOf('T');
    const pTime = pIdx >= 0 ? pBase.substring(pIdx) : timePart;

    out.profile = {
      ...out.profile,
      datetime: `${SANDBOX_DATE}${pTime}`,
    };
  }

  console.log('[PROKERALA] Sandbox override:', {
    datetime: out.datetime,
    profileDatetime: out.profile?.datetime,
  });

  return out;
}

/* ─────────────────────────────────────────────
 * TOKEN HANDLING
 * ───────────────────────────────────────────── */

async function getToken() {
  if (tokenCache.token && tokenCache.expAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.PK_CLIENT_ID,
    client_secret: process.env.PK_CLIENT_SECRET,
  });

  const { data } = await axios.post(TOKEN_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  tokenCache = {
    token: data.access_token,
    expAt: Date.now() + data.expires_in * 1000,
  };

  return tokenCache.token;
}

/* ─────────────────────────────────────────────
 * MAIN CALLER
 * ───────────────────────────────────────────── */

export async function callProkerala(endpoint, params = {}) {
  // 🔥 ALWAYS sandbox-normalize datetime for now
  const sandboxedParams = forceSandboxDate(params);

  const token = await getToken();
  const path  = endpoint.replace(/^\/+/, '');
  const url   = `${API_BASE}/${path}`;

  console.log('[PROKERALA] Final outgoing params:', {
    endpoint,
    datetime: sandboxedParams.datetime,
    profileDatetime: sandboxedParams?.profile?.datetime,
  });

  const res = await axios.get(url, {
    params: sandboxedParams,
    headers: { Authorization: `Bearer ${token}` },
  });

  return { data: res.data, headers: res.headers, status: res.status };
}
