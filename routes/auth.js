// routes/auth.js
import { Router } from 'express';
import { query } from '../src/db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import CryptoJS from 'crypto-js';

const AUTH_SECRET = process.env.AUTH_SECRET || 'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET';
const router = Router();

/* ============ Schemas ============ */
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  first_name: z.string().min(1),
  last_name: z.string().optional().nullable(),
  date_of_birth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional()
    .nullable(),
  gender: z.enum(['male', 'female', 'non-binary', 'other']).optional().nullable(),
  relationship: z
    .enum(['single', 'married', 'engaged', 'soulmate', 'difficult'])
    .optional()
    .nullable(),
  zodiac_sign: z.string().optional().nullable(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const registerLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const loginBasicSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
const adoptOAuthSchema = z.object({
  jwt: z.string().min(20),
});
const emailCheckSchema = z.object({
  email: z.string().email(),
});

/** timing-safe dummy hash for missing users */
const SAFE_DUMMY_HASH =
  '$2a$10$R7Q8i1Tq5x8w0B7m6kqvmeG2Oci8t7kJ8b1c1JcYg7Ue3Hk5iP8Mi'; // "dummy"

function ensureJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('Server misconfigured: JWT_SECRET missing');
  return s.trim();
}

function signJwt(payload) {
  return jwt.sign(payload, ensureJwtSecret(), { expiresIn: '7d' });
}

/** 🔐 Decrypts AES password when prefixed with "enc:", otherwise returns as-is */
function decryptPasswordIfNeeded(value) {
  if (!value || typeof value !== 'string') return value;

  if (!value.startsWith('enc:')) {
    // old clients / plain text
    return value;
  }

  const cipherText = value.substring(4); // remove "enc:"
  try {
    const bytes = CryptoJS.AES.decrypt(cipherText, AUTH_SECRET);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return decrypted || '';
  } catch (e) {
    console.error('Password decrypt failed:', e);
    return '';
  }
}

/* ============ Health ============ */
router.get('/ping', (_req, res) => {
  res.json({ ok: true, scope: 'auth' });
});

/* ============ Full register -> app_user via fn_insert_app_user ============ */
/** NOTE: Your route name had a typo (user_deatils). Keeping it to avoid breaking clients. */
router.post('/user_deatils', async (req, res) => {
  try {
    const body = registerSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();

    // 🔐 decrypt if needed (in case UI sends enc:...)
    const plainPassword = decryptPasswordIfNeeded(body.password);
    if (!plainPassword) {
      await bcrypt.compare('dummy', SAFE_DUMMY_HASH);
      return res.status(400).json({ ok: false, error: 'Invalid password' });
    }

    const password_hash = await bcrypt.hash(plainPassword, 10);

    const sql = `
      SELECT fn_insert_app_user(
        $1, $2, $3, $4, $5::date, $6, $7, $8
      ) AS id
    `;
    const params = [
      email,
      password_hash,
      body.first_name,
      body.last_name ?? null,
      body.date_of_birth ?? null,
      body.gender ?? null,
      body.relationship ?? null,
      body.zodiac_sign ?? null,
    ];

    const { rows } = await query(sql, params);
    const id = rows?.[0]?.id;

    const token = signJwt({ sub: id, email });

    return res.status(201).json({ ok: true, id, token });
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Email already exists' });
    }
    if (err?.issues) {
      return res.status(400).json({ ok: false, error: 'Invalid payload', details: err.issues });
    }
    console.error('register error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/* ============ Login against app_user ============ */
router.post('/login', async (req, res) => {
  try {
    const body = loginSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();

    const { rows } = await query(
      `SELECT id, email, password_hash, first_name, last_name
         FROM app_user
        WHERE email = $1`,
      [email]
    );
    const user = rows?.[0];

    const plainPassword = decryptPasswordIfNeeded(body.password);

    // Optional debug (uncomment if needed)
    // console.log('RAW /login pw:', body.password);
    // console.log('DECRYPTED /login pw:', plainPassword);

    if (!plainPassword) {
      await bcrypt.compare('dummy', SAFE_DUMMY_HASH);
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }

    if (!user) {
      await bcrypt.compare(plainPassword, SAFE_DUMMY_HASH);
      return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(plainPassword, user.password_hash || '');
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const token = signJwt({ sub: user.id, email: user.email });

    return res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
      },
    });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({ ok: false, error: 'Invalid payload', details: err.issues });
    }
    console.error('login error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

/* ============ Minimal register OR login against app_userlogin ============ */
/**
 * Behavior:
 *  - if email exists with password_hash -> LOGIN (verify)
 *  - if email exists without password_hash (social-only) -> 409 tell to use social login
 *  - if email not exist -> REGISTER via your SP fn_insert_app_userlogin
 * Returns JWT on success for convenience.
 */
router.post('/login-basic', async (req, res) => {
  try {
    const parsed = loginBasicSchema.parse(req.body);
    const email = parsed.email.trim().toLowerCase();

    // 🔐 decrypt if needed (enc:...) coming from UI
    const password = decryptPasswordIfNeeded(parsed.password);

    if (!password) {
      // can't decrypt -> treat as invalid login
      await bcrypt.compare('dummy', SAFE_DUMMY_HASH);
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    const { rows } = await query(
      `SELECT id,
              email,
              password_hash,
              COALESCE(active, TRUE) AS active,
              COALESCE(failed_logins, 0) AS failed_logins,
              COALESCE(is_block, 0)      AS is_block,
              role_id,
              email_verified,
              per_chat_cost_points,
              no_of_free_bal_chat
         FROM app_userlogin
        WHERE email = $1`,
      [email]
    );

    if (!rows?.length) {
      await bcrypt.compare(password, SAFE_DUMMY_HASH); // timing
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    const u = rows[0];

    // 🔹 Blocked user check
    if (u.is_block && Number(u.is_block) !== 0) {
      return res
        .status(403)
        .json({ ok: false, error: 'Account is blocked. Please contact support.' });
    }

    if (!u.active) {
      return res.status(403).json({ ok: false, error: 'Account is disabled' });
    }

    const ok = await bcrypt.compare(password, u.password_hash || '');
    if (!ok) {
      await query(
        `UPDATE app_userlogin
            SET failed_logins = COALESCE(failed_logins, 0) + 1
          WHERE id = $1`,
        [u.id]
      );
      return res.status(401).json({ ok: false, error: 'Invalid email or password' });
    }

    // success -> reset failures, update login_status
    await query(
      `UPDATE app_userlogin
          SET failed_logins = 0,
              login_status  = $1::login_status,
              last_login    = NOW(),
              active        = COALESCE(active, TRUE)
        WHERE id = $2`,
      ['logged_in', u.id]
    );

    const token = signJwt({
      sub: u.id,
      email: u.email,
      role: u.role_id || 'user'
    });

    const prof = await query(
      `SELECT 
    a.id,
    a.email,
    a.first_name,
    a.last_name,
    a.date_of_birth AS birth,
    a.gender,
    a.relationship,
    a.zodiac_sign,
    b.country,
    a.birth_place AS city,
    c.chart_id,
    b.version,
    d.language,
    d.theme,
    d.birth_chart,
    d.notification_prefs
FROM app_user a
INNER JOIN birth_profile b 
    ON b.email = a.email
LEFT JOIN app_user_settings d
    ON a.email = d.user_id
LEFT JOIN public.birth_chart c 
    ON a.email = c.user_id
   AND c.system = d.birth_chart
        WHERE a.email = $1`,
      [u.email]
    );

    const p = prof.rows[0] ?? null;

    return res.json({
      ok: true,
      token,
      user: {
        id: u.id,
        email: u.email,
        role: u.role_id || 'user',
        email_verified: u.email_verified,
        per_chat_cost_points: u.per_chat_cost_points || 0,
        no_of_free_bal_chat: u.no_of_free_bal_chat || 0,
        chart_id: p?.chart_id || null,          // ✅ from profile, not app_userlogin
        version: p?.version || 1,
        language: p?.language || 'en',
        theme: p?.theme || 'light',
        birth_chart: p?.birth_chart || 'western',
      },
      profile: p,
    });
  } catch (err) {
    if (err?.issues) {
      return res
        .status(400)
        .json({ ok: false, error: 'Invalid payload', details: err.issues });
    }
    console.error('login-basic error', err);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error',
      hint: err?.message ?? String(err),
    });
  }
});


router.get('/role-access/:roleId', async (req, res) => {
  try {
    const roleId = String(req.params.roleId).trim();

    const { rows } = await query(
      `SELECT role_id,
              page_name,
              control_name,
              can_view,
              can_add,
              can_edit,
              can_delete
         FROM app_usercontrol_access
        WHERE role_id = $1
        ORDER BY page_name, control_name`,
      [roleId]
    );

    return res.json({
      ok: true,
      role: roleId,
      count: rows.length,
      access: rows,
    });
  } catch (err) {
    console.error('role-access error', err);
    return res
      .status(500)
      .json({ ok: false, error: 'Internal server error', hint: err?.message ?? String(err) });
  }
});

const accessCheckSchema = z.object({
  role: z.string().min(1),
  page: z.string().min(1),
  control: z.string().min(1),
});

router.get('/access-check', async (req, res) => {
  try {
    const parsed = accessCheckSchema.parse({
      role: req.query.role,
      page: req.query.page,
      control: req.query.control,
    });

    const { rows } = await query(
      `SELECT can_view,
              can_add,
              can_edit,
              can_delete
         FROM app_usercontrol_access
        WHERE role_id = $1
          AND page_name = $2
          AND control_name = $3
        LIMIT 1`,
      [parsed.role, parsed.page, parsed.control]
    );

    const row = rows[0];

    const perms = row
      ? {
          can_view: row.can_view,
          can_add: row.can_add,
          can_edit: row.can_edit,
          can_delete: row.can_delete,
        }
      : {
          can_view: false,
          can_add: false,
          can_edit: false,
          can_delete: false,
        };

    return res.json({
      ok: true,
      role: parsed.role,
      page: parsed.page,
      control: parsed.control,
      perms,
      source: row ? 'db' : 'default-none',
    });
  } catch (err) {
    if (err?.issues) {
      return res
        .status(400)
        .json({ ok: false, error: 'Invalid query params', details: err.issues });
    }
    console.error('access-check error', err);
    return res
      .status(500)
      .json({ ok: false, error: 'Internal server error', hint: err?.message ?? String(err) });
  }
});

/* ============ Debug helper ============ */
router.get('/who/:email', async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, LENGTH(password_hash) AS len, active, no_of_failed_login
       FROM app_userlogin
      WHERE email = $1`,
    [req.params.email.toLowerCase()]
  );
  res.json(rows[0] ?? null);
});
/* ============ Social OAuth Adopt (Facebook / Google) ============ */
/**
 * Behavior:
 *  - Social email is already verified
 *  - If email not exist -> INSERT
 *  - If exist -> VALIDATE & LOGIN
 *  - Track login source via login_provider
 */
router.post('/oauth/adopt', async (req, res) => {
  try {
    const { jwt: socialJwt } = adoptOAuthSchema.parse(req.body);

    // 🔐 Verify server-issued JWT (from facebook/google callback)
    const claims = jwt.verify(socialJwt, ensureJwtSecret());

    const email = String(claims?.email || '').trim().toLowerCase();
    const provider = String(claims?.provider || 'social').toLowerCase(); // facebook | google

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: 'Social login did not return an email address',
      });
    }

    // split name (safe)
    const fullName = String(claims?.name || '').trim();
    const firstName = fullName ? fullName.split(' ')[0] : null;
    const lastName =
      fullName && fullName.includes(' ')
        ? fullName.split(' ').slice(1).join(' ')
        : null;

    /* -----------------------------------------------------------
     * ✅ NEW: Single SP call (login upsert + ensure app_user + fetch profile)
     * --------------------------------------------------------- */
    const spRes = await query(
      `SELECT * FROM public.sp_oauth_adopt_login($1::text, $2::text, $3::text, $4::text)`,
      [email, provider, firstName, lastName]
    );

    const row = spRes.rows?.[0];
    if (!row) {
      return res.status(500).json({ ok: false, error: 'login_failed' });
    }

    // Keep same "u" fields your code expects
    const u = {
      id: row.id,
      email: row.email,
      role_id: row.role_id,
      active: row.active,
      is_block: row.is_block,
      email_verified: row.email_verified,
      per_chat_cost_points: row.per_chat_cost_points,
      no_of_free_bal_chat: row.no_of_free_bal_chat,
      login_provider: row.login_provider,
      chart_id: row.chart_id, // ✅ SP provides preferred chart_id
      // ✅ NEW: UI-friendly settings fields
        version: row.ui_version ?? 1,
        system: row.ui_system ?? null,
        language: row.ui_language ?? 'en',
        country: row.ui_country ?? null,
        theme: row.ui_theme ?? 'light',
        birth_chart: row.ui_birth_chart ?? 'western',
    };

    // 🔒 Validate account (unchanged behavior)
    if (!u.active) {
      return res.status(403).json({ ok: false, error: 'Account is disabled' });
    }
    if (u.is_block && Number(u.is_block) !== 0) {
      return res.status(403).json({ ok: false, error: 'Account is blocked' });
    }

    /* -----------------------------------------------------------
     * 3️⃣ Issue normal app JWT (unchanged)
     * --------------------------------------------------------- */
    const token = signJwt({
      sub: u.id,
      email: u.email,
      role: u.role_id || 'user',
      provider: u.login_provider,
    });

    // profile is already a JSON object from SP
    const profile = row.profile ?? null;

    return res.json({
      ok: true,
      token,
      user: {
        id: u.id,
        email: u.email,
        role: u.role_id || 'user',
        email_verified: true,
        per_chat_cost_points: u.per_chat_cost_points || 0,
        no_of_free_bal_chat: u.no_of_free_bal_chat || 0,
        chart_id: u.chart_id,
        login_provider: u.login_provider,

        // ✅ NEW: UI-friendly settings fields
        version: row.ui_version ?? 1,
        system: row.ui_system ?? null,
        language: row.ui_language ?? 'en',
        country: row.ui_country ?? null,
        theme: row.ui_theme ?? 'light',
        birth_chart: row.ui_birth_chart ?? 'western',
      },
      profile, // ✅ rich nested JSON
    });
  } catch (err) {
    if (err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
      return res.status(401).json({ ok: false, error: 'Invalid social token' });
    }
    if (err?.issues) {
      return res.status(400).json({ ok: false, error: 'Invalid payload', details: err.issues });
    }
    console.error('oauth/adopt error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});
// ... all your existing routes above (ping, user_deatils, login, login-basic, oauth/adopt, etc.)

// ============ Minimal register-only against app_userlogin ============
/**
 * POST /api/auth/register-login
 *
 * Behavior:
 *  - if email already exists in app_userlogin → 409 (email already registered)
 *  - if email does NOT exist → INSERT row + return JWT
 */
router.post('/register-login', async (req, res) => {
  try {
    // Validate basic shape using your existing schema
    const parsed = registerLoginSchema.parse(req.body);
    let email = parsed.email.trim().toLowerCase();

    // 🔐 Decrypt "enc:..." password if needed
    const plainPassword = decryptPasswordIfNeeded(parsed.password);

    if (!plainPassword) {
      // keep timing safe
      await bcrypt.compare('dummy', SAFE_DUMMY_HASH);
      return res.status(400).json({
        ok: false,
        error: 'Invalid password',
      });
    }

    // 1) Check if email already exists
    const { rows: existingRows } = await query(
      `SELECT id
         FROM app_userlogin
        WHERE email = $1`,
      [email]
    );

    if (existingRows.length > 0) {
      // 👇 This is what your Angular UI expects
      return res.status(409).json({
        ok: false,
        error: 'This email is already registered. Please log in.',
      });
    }

    // 2) Insert new login row
    const passwordHash = await bcrypt.hash(plainPassword, 10);

    const { rows } = await query(
      `INSERT INTO app_userlogin (email, password_hash, active, per_chat_cost_points, no_of_free_bal_chat)
VALUES ($1, $2, TRUE, 1, 30)
       RETURNING id`,
      [email, passwordHash]
    );

    const loginId = rows[0].id;

    // 3) Issue JWT using your helper
    const token = signJwt({ sub: loginId, email });

    return res.status(201).json({
      ok: true,
      id: loginId,
      jwt: token,
    });
  } catch (err) {
    if (err?.issues) {
      // zod validation error
      return res.status(400).json({
        ok: false,
        error: 'Invalid payload',
        details: err.issues,
      });
    }
    console.error('[register-login] error:', err);
    return res.status(500).json({
      ok: false,
      error: 'Internal server error while creating your account',
    });
  }
});
// ============ Check email existence & verification status ============
/**
 * POST /api/auth/check-email
 *
 * Request:
 *   { "email": "user@example.com" }
 *
 * Response:
 *   {
 *     ok: true,
 *     email: "user@example.com",
 *     email_valid: true,
 *     exists: true,
 *     email_verified: true,
 *     active: true,
 *     is_block: false
 *   }
 */
router.post('/check-email', async (req, res) => {
  try {
    // 1) Validate format with zod
    const parsed = emailCheckSchema.parse(req.body);
    const email = parsed.email.trim().toLowerCase();

    // 2) Look up in app_userlogin (where email_verified lives)
    const { rows } = await query(
      `SELECT
         email,
         COALESCE(email_verified, FALSE) AS email_verified,
         COALESCE(active, TRUE)          AS active,
         COALESCE(is_block, 0)           AS is_block
      
       FROM app_userlogin
       WHERE email = $1
       LIMIT 1`,
      [email]
    );

    const row = rows[0] || null;
    const exists = !!row;

    return res.json({
      ok: true,
      email,
      email_valid: true,
      exists,
      email_verified: exists ? !!row.email_verified : false,
      active: exists ? !!row.active : false,
      is_block: exists ? !!row.is_block : false,
    });
  } catch (err) {
    // zod validation error (bad email format)
    if (err?.issues) {
      return res.status(400).json({
        ok: false,
        email_valid: false,
        exists: false,
        email_verified: false,
        error: 'Invalid email format',
        details: err.issues,
      });
    }

    console.error('check-email error:', err);
    return res.status(500).json({
      ok: false,
      email_valid: false,
      exists: false,
      email_verified: false,
      error: 'Internal server error',
    });
  }
});

// 👇 Make sure THIS is the **last line** in routes/auth.js
export default router;
