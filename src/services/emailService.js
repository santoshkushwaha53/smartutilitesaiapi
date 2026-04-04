// src/services/emailService.js
import nodemailer from "nodemailer";
import { query } from "../db.js";

const ZOHO_USER = process.env.ZOHO_SMTP_USER;
const ZOHO_PASS = process.env.ZOHO_SMTP_PASS;
const ZOHO_HOST = process.env.ZOHO_SMTP_HOST || "smtp.zoho.com";
const ZOHO_PORT = Number(process.env.ZOHO_SMTP_PORT || 587);

const APP_URL = process.env.APP_URL || "https://sohumastroai.com";

if (!ZOHO_USER || !ZOHO_PASS) {
  console.warn("[emailService] Missing ZOHO_SMTP_USER/ZOHO_SMTP_PASS in env");
}

const transporter = nodemailer.createTransport({
  host: ZOHO_HOST,
  port: ZOHO_PORT,
  secure: ZOHO_PORT === 465,
  auth: { user: ZOHO_USER, pass: ZOHO_PASS },
});

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

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

/*
function buildCommonVars(inputVars = {}) {
  return {
    ...inputVars,
    now: new Date().toISOString(),
    appUrl: inputVars.appUrl || APP_URL,
    name: inputVars.name || "there",
    expiresMinutes: inputVars.expiresMinutes ?? 10,
    expiresHours: inputVars.expiresHours ?? 24,
  };
}*/
function buildCommonVars(inputVars = {}) {
  const fallbackName =
    inputVars.name ||
    inputVars.userEmail ||
    inputVars.email ||
    "there";

  return {
    ...inputVars,
    now: new Date().toISOString(),
    appUrl: inputVars.appUrl || APP_URL,
    name: fallbackName,
    expiresMinutes: inputVars.expiresMinutes ?? 10,
    expiresHours: inputVars.expiresHours ?? 24,
  };
}

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

/*
export async function sendTemplateEmail({ templateCode, to, vars = {}, replyTo }) {
  if (!templateCode || !to) throw new Error("templateCode and to are required");
  if (!isValidEmail(to)) throw new Error("Invalid recipient email");

  const tpl = await getEmailTemplate(templateCode);
  if (!tpl || tpl.disabled) throw new Error("Email template missing or disabled");

  const mergedVars = buildCommonVars(vars);
  const subject = renderTemplate(tpl.subject_tpl, mergedVars);
  const html = renderTemplate(tpl.html_tpl, mergedVars);

  await transporter.sendMail({
    from: `"SohumAstro AI Support" <${ZOHO_USER}>`,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });

  return true;
}
*/

// ✅ ACTIVE VERSION – now supports optional `from` override
export async function sendTemplateEmail({
  templateCode,
  to,
  vars = {},
  replyTo,
  from, // 👈 OPTIONAL: custom "from" (e.g. ZOHO_SMTP_SUPPORT for support tickets)
}) {
  if (!templateCode || !to) {
    throw new Error("templateCode and to are required");
  }
  if (!isValidEmail(to)) {
    throw new Error("Invalid recipient email");
  }

  console.log("[emailService] sendTemplateEmail START", {
    templateCode,
    to,
  });

  const tpl = await getEmailTemplate(templateCode);
  if (!tpl || tpl.disabled) {
    console.error("[emailService] template missing/disabled", templateCode, tpl);
    throw new Error("Email template missing or disabled");
  }

  const mergedVars = buildCommonVars(vars);
  const subject = renderTemplate(tpl.subject_tpl, mergedVars);
  const html = renderTemplate(tpl.html_tpl, mergedVars);

  console.log("[emailService] sending via SMTP", {
    to,
    subjectPreview: subject.slice(0, 80),
  });

  await transporter.sendMail({
    // 👇 If caller passes a `from`, use it.
    //    Otherwise, fall back to the original default From address.
    from: from || `"SohumAstro AI Support" <${ZOHO_USER}>`,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });

  console.log("[emailService] sendTemplateEmail OK", {
    templateCode,
    to,
  });

  return true;
}

export async function smtpVerify() {
  await transporter.verify();
  return true;
}
