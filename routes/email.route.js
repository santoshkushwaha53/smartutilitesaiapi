/**
 * email.route.js
 * -------------------------------------------------------------
 * PURPOSE:
 *  - Central Email Engine for SohumAstro AI
 *  - Send different types of emails using templates stored in Postgres
 *  - Uses Zoho SMTP (support@sohumastroai.com)
 *
 * WHY:
 *  - We do NOT send emails from frontend (Angular/Ionic) because it exposes SMTP credentials
 *  - Backend controls templates, security, and sending rules
 *
 * HOW IT WORKS:
 *  - Email templates are stored in Postgres table: email_template
 *  - Templates use placeholders like: {{name}}, {{otp}}, {{verifyUrl}}
 *  - This route fetches a template by template_code, replaces placeholders and sends email
 *
 * ENDPOINTS:
 *  1) POST /api/contact         -> Contact Us (support inbox + auto ack)
 *  2) POST /api/email/send      -> Generic template sender (welcome, otp, verify, billing, etc)
 *
 * IMPORTANT SECURITY NOTE:
 *  - For OTP, Password reset, Billing receipt: DO NOT allow sending to arbitrary "to" emails
 *  - In production you should enforce: to === loggedInUserEmail (JWT)
 */

import express from "express";
import nodemailer from "nodemailer";
import { query } from "../src/db.js";
import { sendTemplateEmail, smtpVerify, isValidEmail } from "../src/services/emailService.js";

const router = express.Router();

/* =============================================================
   1) SMTP CONFIG (Zoho)
   =============================================================
   This is your email account that will SEND emails.
   Example: support@sohumastroai.com
------------------------------------------------------------- */
const ZOHO_USER = process.env.ZOHO_SMTP_USER; // required
const ZOHO_PASS = process.env.ZOHO_SMTP_PASS; // required
const ZOHO_HOST = process.env.ZOHO_SMTP_HOST || "smtp.zoho.com";
const ZOHO_PORT = Number(process.env.ZOHO_SMTP_PORT || 587);

// Support inbox where you want to RECEIVE contact messages.
// Usually same as sender mailbox.
const SUPPORT_TO = process.env.SUPPORT_TO || ZOHO_USER;

// For links in emails (verify/reset)
const APP_URL = process.env.APP_URL || "https://sohumastroai.com";

// Create SMTP transporter (reused for all sends)
const transporter = nodemailer.createTransport({
  host: ZOHO_HOST,
  port: ZOHO_PORT,
  secure: ZOHO_PORT === 465, // 465 = SSL, 587 = TLS
  auth: { user: ZOHO_USER, pass: ZOHO_PASS },
});

/* =============================================================
   2) TEMPLATE CODES (Whitelist)
   =============================================================
   WHY:
   - Prevent abuse: user cannot send "any template"
   - Only templates in this list can be sent
------------------------------------------------------------- */
const TEMPLATE = {
  CONTACT_SUPPORT_TO_SUPPORT: "CONTACT_SUPPORT_TO_SUPPORT",
  CONTACT_SUPPORT_ACK_USER: "CONTACT_SUPPORT_ACK_USER",
  WELCOME: "WELCOME",
  VERIFY_EMAIL: "VERIFY_EMAIL",
  LOGIN_OTP: "LOGIN_OTP",
  PASSWORD_RESET: "PASSWORD_RESET",
  PASSWORD_CHANGED: "PASSWORD_CHANGED",
  BILLING_RECEIPT: "BILLING_RECEIPT",
};

const ALLOWED_TEMPLATES = new Set(Object.values(TEMPLATE));

/* =============================================================
   3) HELPER FUNCTIONS
   ============================================================= */

/**
 * escapeHtml()
 * WHY:
 * - Prevent HTML injection in emails if user types <script> etc.
 * - Always escape user-supplied input before inserting into HTML template
 */
function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * isValidEmail()
 * WHY:
 * - Basic validation to reduce sending failures / invalid data
 */
// function isValidEmail(email) {
//   return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
// }

/**
 * renderTemplate()
 * WHAT:
 * - Replace placeholders like {{name}} with values from vars
 *
 * WHY:
 * - Keep templates dynamic and editable in DB
 *
 * NOTE:
 * - Values are HTML-escaped for safety.
 */
function renderTemplate(templateString, vars = {}) {
  const safeVars = {};
  for (const [k, v] of Object.entries(vars || {})) {
    safeVars[k] = escapeHtml(v ?? "");
  }

  return String(templateString || "").replace(
    /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (_, key) => safeVars[key] ?? ""
  );
}

/**
 * getEmailTemplate()
 * WHAT:
 * - Fetch template from Postgres table email_template
 *
 * TABLE STRUCTURE:
 * - template_code (PK)
 * - subject_tpl
 * - html_tpl
 * - is_enabled
 */
async function getEmailTemplate(templateCode) {
  const sql = `
    SELECT template_code, subject_tpl, html_tpl, is_enabled
    FROM email_template
    WHERE template_code = $1
    LIMIT 1
  `;
  const { rows } = await query(sql, [templateCode]);

  if (!rows.length) return null;
  if (!rows[0].is_enabled) return { disabled: true };
  return rows[0];
}

/**
 * sendMail()
 * WHAT:
 * - Actually sends an email using Zoho SMTP
 *
 * PARAMETERS:
 * - to        : receiver email
 * - subject   : email subject
 * - html      : HTML body
 * - replyTo   : (optional) if you want reply to go somewhere else
 *
 * EXAMPLE:
 * - Contact form: send to SUPPORT_TO but set replyTo = user email
 *   so support can directly reply to user.
 */
async function sendMail({ to, subject, html, replyTo }) {
  await transporter.sendMail({
    from: `"SohumAstro AI Support" <${ZOHO_USER}>`,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
}

/**
 * buildCommonVars()
 * WHY:
 * - Every email usually needs common values
 * - So we auto-fill them if missing
 */
function buildCommonVars(inputVars = {}) {
  return {
    ...inputVars,
    now: new Date().toISOString(),
    appUrl: inputVars.appUrl || APP_URL,
    name: inputVars.name || "there",
    expiresMinutes: inputVars.expiresMinutes ?? 10,
    expiresHours: inputVars.expiresHours ?? 24,
  };
}

/* =============================================================
   4) ROUTE #1: CONTACT US
   =============================================================
   WHEN TO USE:
   - User submits contact form (name, email, subject, message)

   WHAT IT DOES:
   - Email #1: send user message to support@sohumastroai.com
   - Email #2: auto-reply to user: "we received your message"

   WHY 2 emails:
   - Support receives message
   - User gets confirmation (better user experience)
------------------------------------------------------------- */
router.post("/contact", async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};

    // Validate inputs
    if (!isValidEmail(email) || !message) {
      return res.status(400).json({
        ok: false,
        error: "Valid email and message are required.",
      });
    }

    // Vars used in templates
    const vars = buildCommonVars({
      name: name || "-",
      email,
      subject: subject || "Contact Form",
      message,
    });

    // Template 1: Support inbox email
    const tSupport = await getEmailTemplate(TEMPLATE.CONTACT_SUPPORT_TO_SUPPORT);
    if (!tSupport || tSupport.disabled) {
      return res.status(500).json({
        ok: false,
        error: "Support email template missing or disabled.",
      });
    }

    await sendMail({
      to: SUPPORT_TO,
      subject: renderTemplate(tSupport.subject_tpl, vars),
      html: renderTemplate(tSupport.html_tpl, vars),
      replyTo: email, // So support can click "Reply" to respond to user
    });

    // Template 2: Auto-ack email to user
    const tAck = await getEmailTemplate(TEMPLATE.CONTACT_SUPPORT_ACK_USER);
    if (!tAck || tAck.disabled) {
      return res.status(500).json({
        ok: false,
        error: "Ack email template missing or disabled.",
      });
    }

    await sendMail({
      to: email,
      subject: renderTemplate(tAck.subject_tpl, vars),
      html: renderTemplate(tAck.html_tpl, vars),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[/contact] send failed:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to send email. Please try again later.",
    });
  }
});

/* =============================================================
   5) ROUTE #2: GENERIC TEMPLATE EMAIL SENDER
   =============================================================
   WHEN TO USE:
   - Welcome email (after successful signup)
   - Verify email (after signup)
   - OTP login (when user requests login by OTP)
   - Password reset (when user clicks "forgot password")
   - Password changed (after user updates password)
   - Billing receipt (after payment success)

   REQUEST BODY (ALL PARAMETERS):
   {
     "templateCode": "WELCOME" | "VERIFY_EMAIL" | "LOGIN_OTP" | ...
     "to": "user@email.com",
     "vars": {
        "name": "Satya",
        ... template-specific variables ...
     },
     "replyTo": "optional@email.com"
   }

   TEMPLATE-SPECIFIC VARS REQUIRED:
   - WELCOME: { name, appUrl? }
   - VERIFY_EMAIL: { name, verifyUrl, expiresHours? }
   - LOGIN_OTP: { name, otp, expiresMinutes? }
   - PASSWORD_RESET: { name, resetUrl, expiresHours? }
   - PASSWORD_CHANGED: { name }
   - BILLING_RECEIPT: { name, invoiceNo, planName, amount, currency, purchaseDate }

   SECURITY:
   - In production, enforce `to` is the logged in user's email for OTP/reset/billing
------------------------------------------------------------- */
router.post("/email/send", async (req, res) => {
  try {
    const { templateCode, to, vars = {}, replyTo } = req.body || {};

    // Basic required fields
    if (!templateCode || !to) {
      return res.status(400).json({
        ok: false,
        error: "templateCode and to are required.",
      });
    }

    // Protect from misuse: allow only known templates
    if (!ALLOWED_TEMPLATES.has(templateCode)) {
      return res.status(403).json({
        ok: false,
        error: "Template not allowed.",
      });
    }

    if (!isValidEmail(to)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid recipient email.",
      });
    }

    // Optional: validate replyTo if provided
    if (replyTo && !isValidEmail(replyTo)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid replyTo email.",
      });
    }

    /**
     * OPTIONAL SECURITY HARDENING (recommended):
     * -------------------------------------------------
     * If you have JWT auth, you should NOT allow user to set `to` freely.
     *
     * Example:
     *   const loggedInUserEmail = req.user.email;
     *   if (templateCode !== 'CONTACT_SUPPORT...' && to !== loggedInUserEmail) block it.
     */

    // Fetch template from DB
    const tpl = await getEmailTemplate(templateCode);
    if (!tpl || tpl.disabled) {
      return res.status(500).json({
        ok: false,
        error: "Email template missing or disabled.",
      });
    }

    // Merge default/common variables (name, appUrl, expires, now...)
    const mergedVars = buildCommonVars(vars);

    // Render final subject + HTML
    const subject = renderTemplate(tpl.subject_tpl, mergedVars);
    const html = renderTemplate(tpl.html_tpl, mergedVars);

    // Send email
    await sendMail({ to, subject, html, replyTo });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[/email/send] failed:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to send email.",
    });
  }
});
// ✅ QUICK SMTP health check (temporary for debugging)
router.get("/email/verify", async (req, res) => {
  try {
    await transporter.verify(); // checks SMTP login + connection
    return res.json({ ok: true, message: "SMTP OK" });
  } catch (err) {
    console.error("[smtp verify] failed:", err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;
