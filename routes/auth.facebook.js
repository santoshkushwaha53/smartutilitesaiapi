// routes/auth.facebook.js
import 'dotenv/config';

import express from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const router = express.Router();

/* ----------------------------------------
   Helpers
---------------------------------------- */
function fbAuthURL({ appId, redirectUri, state, scope = 'public_profile,email', v = 'v23.0' }) {
  const base = `https://www.facebook.com/${v}/dialog/oauth`;
  const q = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope,
  });
  return `${base}?${q.toString()}`;
}

async function exchangeCodeForToken({ appId, appSecret, redirectUri, code, v = 'v23.0' }) {
  const url = new URL(`https://graph.facebook.com/${v}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code', code);

  const resp = await fetch(url);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`token http ${resp.status} ${txt}`);
  }
  return resp.json();
}

async function fetchFBProfile({ access_token, v = 'v23.0' }) {
  const url = new URL(`https://graph.facebook.com/${v}/me`);
  url.searchParams.set('fields', 'id,name,first_name,last_name,email,picture');
  url.searchParams.set('access_token', access_token);

  const resp = await fetch(url);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`profile http ${resp.status} ${txt}`);
  }
  return resp.json();
}

/* ----------------------------------------
   Routes
---------------------------------------- */

// Debug env (safe)
router.get('/start/debug', (req, res) => {
  res.json({
    ok: true,
    appId_present: !!process.env.FACEBOOK_APP_ID,
    redirectUri: process.env.FACEBOOK_REDIRECT_URI,
    clientUrl: process.env.CLIENT_URL,
  });
});

// Step 1: Start OAuth
router.get('/start', (req, res) => {
  const appId = (process.env.FACEBOOK_APP_ID || '').trim();
  const redirectUri = (process.env.FACEBOOK_REDIRECT_URI || '').trim();

  if (!appId || !redirectUri) {
    return res.status(500).json({
      ok: false,
      error: 'Server misconfigured',
      missing: {
        FACEBOOK_APP_ID: !appId,
        FACEBOOK_REDIRECT_URI: !redirectUri,
      },
    });
  }

  const state = crypto.randomBytes(16).toString('hex');

  res.cookie('fb_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // true on HTTPS
    path: '/',
    maxAge: 10 * 60 * 1000,
  });

  const url = fbAuthURL({ appId, redirectUri, state });
  return res.redirect(url);
});

// Step 2: Facebook redirects HERE
router.get('/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const expected = req.cookies?.fb_oauth_state;

    if (!code) return res.status(400).send('Missing code');
    if (!state || state !== expected) return res.status(400).send('Invalid state');

    res.clearCookie('fb_oauth_state', { path: '/' });

    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const redirectUri = process.env.FACEBOOK_REDIRECT_URI;

    const token = await exchangeCodeForToken({
      appId,
      appSecret,
      redirectUri,
      code,
    });

    const profile = await fetchFBProfile({ access_token: token.access_token });

    const jwtToken = jwt.sign(
      {
        sub: `fb:${profile.id}`,
        name: profile.name,
        email: profile.email || null,
        picture: profile?.picture?.data?.url || null,
        provider: 'facebook',
      },
      process.env.JWT_SECRET || 'dev-secret',
      { expiresIn: '7d' }
    );

    // ✅ THIS IS THE CRITICAL FIX
    // Must be FULL UI BASE (not origin only)
    const clientBase = (process.env.CLIENT_URL || 'http://localhost:8100')
      .trim()
      .replace(/\/+$/, '');

    const channel = process.env.FB_OAUTH_CHANNEL || 'sohum_fb_oauth';

    const payload = encodeURIComponent(JSON.stringify({
      ok: true,
      jwt: jwtToken,
      channel,
    }));

    const redirectTo = `${clientBase}/oauth/facebook#payload=${payload}`;

    console.log('[facebook callback] →', redirectTo);

    res.set('Cache-Control', 'no-store');
    return res.redirect(302, redirectTo);

  } catch (err) {
    console.error('[facebook callback error]', err);
    return res.status(500).send('Facebook login failed');
  }
});

export default router;
