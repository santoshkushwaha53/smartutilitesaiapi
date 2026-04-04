// routes/otp.route.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "../src/db.js";
import { isValidEmail, sendTemplateEmail } from "../src/services/emailService.js";

const router = express.Router();

const OTP_EXPIRES_MIN = Number(process.env.OTP_EXPIRES_MINUTES || 10);
const OTP_LEN = Number(process.env.OTP_LENGTH || 6);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const OTP_MAX_RESENDS = Number(process.env.OTP_MAX_RESENDS || 5);

const PURPOSE = {
  VERIFY_EMAIL: "VERIFY_EMAIL",
  LOGIN_OTP: "LOGIN_OTP",
  PASSWORD_RESET: "PASSWORD_RESET",
};
const ALLOWED_PURPOSES = new Set(Object.values(PURPOSE));

// 🔐 JWT helpers
function ensureJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set in environment variables");
  }
  return secret;
}

function signJwt(payload) {
  return jwt.sign(payload, ensureJwtSecret(), { expiresIn: "7d" });
}

// 🔢 OTP helpers
function generateOtp(len = 6) {
  const min = 10 ** (len - 1);
  const max = 10 ** len - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

async function getActiveOtpRow(email, purpose) {
  const sql = `
    SELECT *
    FROM auth_otp
    WHERE email = $1
      AND purpose = $2
      AND consumed_at IS NULL
      AND expires_at > now()
    ORDER BY otp_id DESC
    LIMIT 1
  `;
  const { rows } = await query(sql, [email, purpose]);
  return rows[0] || null;
}

/**
 * POST /api/auth/otp/request
 */
router.post("/auth/otp/request", async (req, res) => {
  try {
    const { email, purpose, name } = req.body || {};

    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Valid email is required." });
    }
    if (!ALLOWED_PURPOSES.has(purpose)) {
      return res.status(400).json({ ok: false, error: "Invalid OTP purpose." });
    }

    const active = await getActiveOtpRow(email, purpose);
    if (active) {
      if (active.resend_count >= active.max_resends) {
        return res.status(429).json({
          ok: false,
          error: "Resend limit reached. Please try again later.",
        });
      }

      await query(`UPDATE auth_otp SET consumed_at = now() WHERE otp_id = $1`, [active.otp_id]);
    }

    const otp = generateOtp(OTP_LEN);
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_MIN * 60 * 1000);

    const insertSql = `
      INSERT INTO auth_otp (email, purpose, otp_hash, expires_at, max_attempts, max_resends)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    await query(insertSql, [
      email,
      purpose,
      otpHash,
      expiresAt.toISOString(),
      OTP_MAX_ATTEMPTS,
      OTP_MAX_RESENDS,
    ]);

    const templateCode =
      purpose === PURPOSE.VERIFY_EMAIL
        ? "VERIFY_EMAIL"
        : purpose === PURPOSE.PASSWORD_RESET
        ? "PASSWORD_RESET"
        : "LOGIN_OTP";

    await sendTemplateEmail({
      templateCode,
      to: email,
      vars: {
        name: name || "there",
        otp,
        expiresMinutes: OTP_EXPIRES_MIN,
      },
    });

    return res.json({
      ok: true,
      message: "Your OTP has been sent to your email. Please check your inbox (and spam).",
      expiresMinutes: OTP_EXPIRES_MIN,
    });
  } catch (err) {
    console.error("[/auth/otp/request] failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to send OTP. Please try again." });
  }
});

/**
 * POST /api/auth/otp/verify
 * One-shot: verify OTP + best-effort login profile
 */
router.post("/auth/otp/verify", async (req, res) => {
  try {
    const { email, purpose, otp } = req.body || {};

    if (!isValidEmail(email) || !ALLOWED_PURPOSES.has(purpose) || !otp) {
      return res
        .status(400)
        .json({ ok: false, error: "email, purpose and otp are required." });
    }

    const row = await getActiveOtpRow(email, purpose);
    if (!row) {
      return res.status(400).json({ ok: false, error: "OTP not found or expired." });
    }

    // attempt guard
    if (row.attempts >= row.max_attempts) {
      await query(`UPDATE auth_otp SET consumed_at = now() WHERE otp_id = $1`, [row.otp_id]);
      return res
        .status(400)
        .json({ ok: false, error: "OTP expired. Please request a new OTP." });
    }

    const ok = await bcrypt.compare(String(otp), row.otp_hash);

    if (!ok) {
      await query(`UPDATE auth_otp SET attempts = attempts + 1 WHERE otp_id = $1`, [row.otp_id]);
      return res.status(400).json({ ok: false, error: "Invalid OTP." });
    }

    // ✅ success -> consume (archive)
    await query(`UPDATE auth_otp SET consumed_at = now() WHERE otp_id = $1`, [row.otp_id]);

    // ✅ if this OTP is for email verification, flip the flag in app_userlogin
    let emailVerifiedUpdated = false;

    if (purpose === PURPOSE.VERIFY_EMAIL) {
      const upd = await query(
        `
        UPDATE app_userlogin
           SET email_verified = true
         WHERE lower(email) = lower($1)
           AND (email_verified IS NULL OR email_verified = false)
         RETURNING email_verified
        `,
        [email]
      );

      emailVerifiedUpdated = (upd?.rowCount || 0) > 0;
    }

    // -----------------------------------------------------------
    // BEST-EFFORT login profile (does NOT break OTP)
    // -----------------------------------------------------------
    let token = null;
    let userPayload = null;
    let profile = null;
    let loginError = null;

    try {
      const cleanEmail = String(email || "").trim().toLowerCase();

      // 🔹 derive a NON-NULL first_name from email (fix for NOT NULL constraint)
      const localPart = cleanEmail.split("@")[0] || "friend";
      const firstName =
        localPart.length > 0
          ? localPart.charAt(0).toUpperCase() + localPart.slice(1)
          : "Friend";
      const lastName = null; // assuming last_name is nullable

      const spRes = await query(
        `SELECT * FROM public.sp_oauth_adopt_login($1::text, $2::text, $3::text, $4::text)`,
        [
          cleanEmail,  // p_email
          "otp",       // p_provider (change if SP expects 'email' or 'social')
          firstName,   // p_first_name (NON-NULL)
          lastName     // p_last_name
        ]
      );

      const row2 = spRes.rows?.[0];

      if (!row2) {
        loginError = "login_failed: no row from sp_oauth_adopt_login";
      } else {
        const u = {
          id: row2.id,
          email: row2.o_email, // SP returns o_email
          role_id: row2.role_id,
          active: row2.active,
          is_block: row2.is_block,
          email_verified: row2.email_verified,
          login_provider: row2.login_provider,
          chart_id: row2.chart_id,
          version: row2.ui_version ?? 1,
          system: row2.ui_system ?? null,
          language: row2.ui_language ?? "en",
          country: row2.ui_country ?? null,
          theme: row2.ui_theme ?? "light",
          birth_chart: row2.ui_birth_chart ?? "western",
        };

        if (!u.active) {
          loginError = "Account is disabled";
        } else if (u.is_block && Number(u.is_block) !== 0) {
          loginError = "Account is blocked";
        } else {
          token = signJwt({
            sub: u.id,
            email: u.email,
            role: u.role_id || "user",
            provider: u.login_provider,
          });

          userPayload = {
            id: u.id,
            email: u.email,
            role: u.role_id || "user",
            email_verified: true,
            chart_id: u.chart_id,
            login_provider: u.login_provider,
            version: u.version,
            system: u.system,
            language: u.language,
            country: u.country,
            theme: u.theme,
            birth_chart: u.birth_chart,
          };

          profile = row2.profile ?? null;
        }
      }
    } catch (loginErr) {
      console.error("[/auth/otp/verify] failed to load profile/login:", loginErr);
      loginError = loginErr?.message || "login_failed";
    }

    // FINAL RESPONSE:
    return res.json({
      ok: true,
      message:
        purpose === PURPOSE.VERIFY_EMAIL
          ? "Email verified successfully."
          : "OTP verified successfully.",
      purpose,
      email,
      email_verified: purpose === PURPOSE.VERIFY_EMAIL ? true : undefined,
      email_verified_updated: purpose === PURPOSE.VERIFY_EMAIL ? emailVerifiedUpdated : undefined,

      token: token || undefined,
      user: userPayload || undefined,
      profile: profile || undefined,
      login_error: loginError || undefined,
    });
  } catch (err) {
    console.error("[/auth/otp/verify] failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to verify OTP." });
  }
});

export default router;
