import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

const router = express.Router();

const codeSchema = z.object({
  code: z.string().min(10, 'Missing Google auth code'),
});

function ensureJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set');
  return s.trim();
}

// Exchange google code -> tokens
async function exchangeCodeForTokens({ code, clientId, clientSecret }) {
  const url = 'https://oauth2.googleapis.com/token';

  // GIS popup code flow uses redirect_uri=postmessage
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: 'postmessage',
    grant_type: 'authorization_code',
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`token http ${resp.status} ${txt}`);
  }
  return resp.json(); // { access_token, id_token, ... }
}

// Fetch profile
async function fetchGoogleUserInfo(accessToken) {
  const resp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`userinfo http ${resp.status} ${txt}`);
  }
  return resp.json(); // { sub, email, email_verified, name, picture, ... }
}

/**
 * ✅ POST /api/auth/google/code
 * Returns social JWT only (no DB).
 * Frontend must call /api/auth/oauth/adopt with this jwt.
 */
router.post('/google/code', async (req, res) => {
  try {
    const { code } = codeSchema.parse(req.body);

    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();

    if (!clientId || !clientSecret) {
      return res.status(500).json({
        ok: false,
        error: 'Google OAuth server misconfigured',
        missing: {
          GOOGLE_CLIENT_ID: !clientId,
          GOOGLE_CLIENT_SECRET: !clientSecret,
        },
      });
    }

    const tokens = await exchangeCodeForTokens({ code, clientId, clientSecret });

    if (!tokens?.access_token) {
      return res.status(400).json({ ok: false, error: 'Google token exchange failed' });
    }

    const profile = await fetchGoogleUserInfo(tokens.access_token);

    const email = String(profile?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({
        ok: false,
        error: 'Google login did not return an email address',
      });
    }

    // ✅ Make a short-lived "social JWT" exactly like Facebook callback does
    const socialJwt = jwt.sign(
      {
        sub: `google:${profile.sub}`,
        name: profile.name || null,
        email,
        picture: profile.picture || null,
        provider: 'google',
        email_verified: !!profile.email_verified,
      },
      ensureJwtSecret(),
      { expiresIn: '15m' }
    );

    return res.json({
      ok: true,
      jwt: socialJwt,
      provider: 'google',
    });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({ ok: false, error: 'Invalid payload', details: err.issues });
    }
    console.error('[google/code] error:', err?.message || err, err?.stack);
    return res.status(500).json({ ok: false, error: 'Google login failed' });
  }
});
router.get('/google/debug', (req, res) => {
  res.json({
    ok: true,
    GOOGLE_CLIENT_ID_present: !!process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET_present: !!process.env.GOOGLE_CLIENT_SECRET,
    JWT_SECRET_present: !!process.env.JWT_SECRET,
  });
});

export default router;
