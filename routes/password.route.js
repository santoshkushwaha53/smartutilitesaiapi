// routes/password.route.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import CryptoJS from "crypto-js";
import { query } from "../src/db.js";
import { isValidEmail, sendTemplateEmail } from "../src/services/emailService.js";

const router = Router();

const AUTH_SECRET = process.env.AUTH_SECRET || "CHANGE_THIS_TO_A_LONG_RANDOM_SECRET";

const OTP_EXPIRES_MIN = Number(process.env.OTP_EXPIRES_MINUTES || 10);
const OTP_LEN = Number(process.env.OTP_LENGTH || 6);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const OTP_MAX_RESENDS = Number(process.env.OTP_MAX_RESENDS || 5);

const PURPOSE = {
  PASSWORD_RESET: "PASSWORD_RESET",
};

function decryptPasswordIfNeeded(value) {
  if (!value || typeof value !== "string") return value;
  if (!value.startsWith("enc:")) return value;

  const cipherText = value.substring(4);
  try {
    const bytes = CryptoJS.AES.decrypt(cipherText, AUTH_SECRET);
    return bytes.toString(CryptoJS.enc.Utf8) || "";
  } catch {
    return "";
  }
}

function generateOtp(len = 6) {
  const min = 10 ** (len - 1);
  const max = 10 ** len - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

async function findUserByEmail(email) {
  // You are using app_userlogin for login-basic (password_hash exists there)
  const { rows } = await query(
    `SELECT id, email
       FROM app_userlogin
      WHERE email = $1
      LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function getActiveOtpRow(email, purpose) {
  const { rows } = await query(
    `SELECT *
       FROM auth_otp
      WHERE email = $1
        AND purpose = $2
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY otp_id DESC
      LIMIT 1`,
    [email, purpose]
  );
  return rows[0] || null;
}

async function consumeOtp(otp_id) {
  await query(`UPDATE auth_otp SET consumed_at = now() WHERE otp_id = $1`, [otp_id]);
}

/**
 * POST /api/auth/password/forgot
 * Body: { email }
 * Response: always ok (don’t reveal if email exists)
 */
router.post("/auth/password/forgot", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Valid email is required." });
    }

    const user = await findUserByEmail(email);

    // Always return ok to prevent account enumeration
    if (!user) {
      return res.json({
        ok: true,
        message: "If this email is registered, an OTP has been sent. Please check inbox/spam.",
      });
    }

    // If active OTP exists, enforce resend limit and consume old OTP
    const active = await getActiveOtpRow(email, PURPOSE.PASSWORD_RESET);
    if (active) {
      if (active.resend_count >= active.max_resends) {
        return res.status(429).json({
          ok: false,
          error: "Resend limit reached. Please try again later.",
        });
      }
      // consume old active OTP so only 1 active OTP exists
      await consumeOtp(active.otp_id);
    }

    const otpRaw = String(req.body?.otp || "").trim();
  // ✅ generate OTP on backend (do not accept OTP from UI for forgot flow)
const otp = generateOtp(OTP_LEN);

// (optional) if some older clients still send OTP, ignore it safely:
// const otpRaw = String(req.body?.otp || "").trim();
// const _ignoredOtp = decryptOtpIfNeeded(otpRaw);

const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRES_MIN * 60 * 1000);

    const ins = await query(
      `INSERT INTO auth_otp (email, purpose, otp_hash, expires_at, max_attempts, max_resends)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING otp_id`,
      [email, PURPOSE.PASSWORD_RESET, otpHash, expiresAt.toISOString(), OTP_MAX_ATTEMPTS, OTP_MAX_RESENDS]
    );

    // Send OTP email (reuse LOGIN_OTP template which has {{otp}})
    await sendTemplateEmail({
      templateCode: "LOGIN_OTP",
      to: email,
      vars: { name: "there", otp, expiresMinutes: OTP_EXPIRES_MIN },
    });

    return res.json({
      ok: true,
      message: "Your OTP has been sent to your email. Please verify and set a new password.",
      expiresMinutes: OTP_EXPIRES_MIN,
      otp_id: ins.rows[0]?.otp_id, // optional (you can remove this in prod)
    });
  } catch (err) {
    console.error("[forgot password] failed:", err);
    return res.status(500).json({ ok: false, error: "Failed to process request." });
  }
});

/**
 * POST /api/auth/password/reset
 * Body: { email, otp, newPassword }
 * - verifies OTP
 * - updates password_hash
 * - consumes OTP
 * - sends PASSWORD_CHANGED email
 */
router.post("/auth/password/reset", async (req, res) => {
  try {
    console.log("[RESET] incoming body:", req.body);

    const email = String(req.body?.email || "").trim().toLowerCase();
    const otp = String(req.body?.otp || "").trim();
    const newPasswordRaw = req.body?.newPassword;

    console.log("[RESET] parsed:", { email, otp, hasPwd: !!newPasswordRaw });

    const newPassword = decryptPasswordIfNeeded(String(newPasswordRaw));
    console.log("[RESET] decrypted password length:", newPassword?.length);

    const user = await findUserByEmail(email);
    console.log("[RESET] user found:", !!user);

    const row = await getActiveOtpRow(email, PURPOSE.PASSWORD_RESET);
    console.log("[RESET] otp row:", row ? {
      otp_id: row.otp_id,
      attempts: row.attempts,
      expires_at: row.expires_at,
      consumed_at: row.consumed_at
    } : null);

    if (!row) {
      return res.status(400).json({ ok: false, error: "OTP not found or expired." });
    }

    const otpMatch = await bcrypt.compare(otp, row.otp_hash);
    console.log("[RESET] otp match:", otpMatch);

    if (!otpMatch) {
      return res.status(400).json({ ok: false, error: "Invalid OTP." });
    }

    await consumeOtp(row.otp_id);
    console.log("[RESET] otp consumed");

    const password_hash = await bcrypt.hash(newPassword, 10);
    console.log("[RESET] password hashed");

    await query(
      `UPDATE app_userlogin
       SET password_hash = $1, password_changed_date = now()
       WHERE email = $2`,
      [password_hash, email]
    );
    console.log("[RESET] app_userlogin updated");

    // await query(
    //   `UPDATE app_user
    //    SET password_hash = $1, password_changed_date = now()
    //    WHERE email = $2`,
    //   [password_hash, email]
    // );
    // console.log("[RESET] app_user updated");

    // 🔥 COMMENT THIS TEMPORARILY
    await sendTemplateEmail({
      templateCode: "PASSWORD_CHANGED",
      to: email,
      vars: { name: "there" },
    });

    console.log("[RESET] email skipped");

    return res.json({
      ok: true,
      message: "Your password has been changed successfully."
    });

  } catch (err) {
    console.error("🔥 RESET PASSWORD CRASH:", err);
    return res.status(500).json({ ok: false, error: "Failed to reset password." });
  }
});

function decryptOtpIfNeeded(value) {
  if (!value || typeof value !== "string") return "";
  const v = value.trim();
  if (!v.startsWith("enc:")) return v;

  const cipherText = v.substring(4);
  try {
    const bytes = CryptoJS.AES.decrypt(cipherText, AUTH_SECRET);
    return (bytes.toString(CryptoJS.enc.Utf8) || "").trim();
  } catch {
    return "";
  }
}

/**
 * POST /auth/password/initial
 *
 * Used ONLY during registration:
 * - Email is already verified (via separate OTP flow)
 * - This endpoint just sets the first password for that email
 *
 * Body:
 * {
 *   email: string;
 *   newPassword: string;  // can be encrypted, we reuse decryptPasswordIfNeeded
 * }
 */
router.post("/auth/password/initial", async (req, res) => {
  try {
    console.log("[INITIAL-PASSWORD] incoming body:", {
      email: req.body?.email,
      hasPwd: !!req.body?.newPassword,
    });

    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const newPasswordRaw = req.body?.newPassword;

    if (!email) {
      return res
        .status(400)
        .json({ ok: false, error: "Email is required." });
    }

    if (!newPasswordRaw) {
      return res
        .status(400)
        .json({ ok: false, error: "newPassword is required." });
    }

    // Decrypt password if you’re sending it encrypted from UI
    const newPassword = decryptPasswordIfNeeded(String(newPasswordRaw));
    console.log(
      "[INITIAL-PASSWORD] decrypted password length:",
      newPassword?.length
    );

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Password is too short. Please choose a stronger password.",
      });
    }

    // Optional: check that user record exists first
    const user = await findUserByEmail(email);
    console.log("[INITIAL-PASSWORD] user found:", !!user);

    if (!user) {
      return res
        .status(404)
        .json({ ok: false, error: "User not found for this email." });
    }

    // Hash password
    const password_hash = await bcrypt.hash(newPassword, 10);
    console.log("[INITIAL-PASSWORD] password hashed");

    // Update app_userlogin
    await query(
      `
        UPDATE app_userlogin
           SET password_hash = $1,
               password_changed_date = now()
         WHERE lower(email) = $2
      `,
      [password_hash, email]
    );
    console.log("[INITIAL-PASSWORD] app_userlogin updated");

    // ❌ No email sending here (as you requested)

    return res.json({
      ok: true,
      email,
      initialPasswordSet: true, // 🔹 flag for UI
      message: "Password has been created successfully.",
    });
  } catch (err) {
    console.error("🔥 INITIAL PASSWORD CRASH:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to create password." });
  }
});

export default router;
