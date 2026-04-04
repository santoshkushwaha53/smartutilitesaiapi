// routes/support-tickets.router.js
import express from 'express';
import { query } from '../src/db.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { sendTemplateEmail } from '../src/services/emailService.js'; // 👈 email helper

const router = express.Router();
// If ZOHO_SMTP_SUPPORT is not set, `from` falls back to default in emailService.
const SUPPORT_FROM_EMAIL = process.env.ZOHO_SMTP_SUPPORT || '';
/**
 * @typedef {Object} SupportTicketHeaderRow
 * @property {number} ticket_id
 * @property {string} ticket_no
 * @property {string} user_email
 * @property {string | null} user_id
 * @property {string} issue_type
 * @property {string} summary
 * @property {string} status
 * @property {string | null} device_info
 * @property {Date} created_at
 * @property {Date | null} updated_at
 */

/**
 * @typedef {Object} SupportTicketMessageRow
 * @property {number} message_id
 * @property {string} sender
 * @property {string | null} sender_email
 * @property {string} message_text
 * @property {string | null} screenshot_url
 * @property {Date} created_at
 */

// ─────────────────────────────────────────────────────────────
// Multer setup for inline screenshot uploads
// Files saved under: /uploads/support/<timestamp>-<name>
// URL exposed as:     /uploads/support/<filename>
// ─────────────────────────────────────────────────────────────
const SUPPORT_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'support');
if (!fs.existsSync(SUPPORT_UPLOAD_DIR)) {
  fs.mkdirSync(SUPPORT_UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, SUPPORT_UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/\s+/g, '_');
    cb(null, `${ts}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed'));
    }
    cb(null, true);
  },
});

/**
 * POST /api/support-tickets/tickets
 *
 * Content-Type: multipart/form-data
 * Fields:
 *   email: string
 *   userId?: string
 *   issueType: string
 *   summary: string
 *   details: string
 *   screenshot?: file (image)
 */
router.post('/tickets', upload.single('screenshot'), async (req, res) => {
  try {
    const { email, userId, issueType, summary, details } = req.body || {};
    const screenshotFile = req.file || null;

    if (!email || !issueType || !summary || !details) {
      return res.status(400).json({
        ok: false,
        error: 'email, issueType, summary and details are required.',
      });
    }

    // compute screenshot URL if file uploaded
    const screenshotUrl = screenshotFile
      ? `/uploads/support/${screenshotFile.filename}`
      : null;

    // 1) Insert header
    const hdrSql = `
      INSERT INTO public.support_ticket_hdr
        (user_email, user_id, issue_type, summary)
      VALUES
        (lower($1), $2, $3, $4)
      RETURNING ticket_id, ticket_no, status, created_at;
    `;

    const hdrResult = await query(hdrSql, [
      email,
      userId || email,     // in your app email == userId, safe fallback
      issueType,
      summary,
    ]);

    if (!hdrResult.rows || hdrResult.rows.length === 0) {
      return res
        .status(500)
        .json({ ok: false, error: 'Failed to create ticket header.' });
    }

    /** @type {SupportTicketHeaderRow} */
    const hdrRow = hdrResult.rows[0];

    const {
      ticket_id: ticketId,
      ticket_no: ticketNo,
      status,
      created_at: createdAt,
    } = hdrRow;

    // 2) Insert first message as 'user'
    const dtlSql = `
      INSERT INTO public.support_ticket_dtl
        (ticket_id, sender, sender_id, sender_email, message_text, screenshot_url)
      VALUES
        ($1, 'user', $2, lower($3), $4, $5)
      RETURNING message_id, created_at;
    `;

    const dtlResult = await query(dtlSql, [
      ticketId,
      userId || email,
      email,
      details,
      screenshotUrl,
    ]);

    const firstRow = dtlResult.rows && dtlResult.rows[0];
    const firstMessageId = firstRow ? firstRow.message_id : null;

   // 3) Fire-and-forget email notification to user
    //    - Uses template: SUPPORT_TICKET_CREATED_USER (must exist in email_template)
    //    - If ZOHO_SMTP_SUPPORT is set, send from that mailbox.
    //      Otherwise, `from` is undefined and emailService will fall back
    //      to the default `"SohumAstro AI Support" <ZOHO_SMTP_USER>`.
    (async () => {
      try {
        await sendTemplateEmail({
          templateCode: 'SUPPORT_TICKET_CREATED_USER',
          to: email,

          // 👇 Use dedicated support mailbox if provided in env.
          //    This does NOT break existing callers because `from`
          //    is optional in sendTemplateEmail.
          from: SUPPORT_FROM_EMAIL
            ? `"SohumAstro AI Support" <${SUPPORT_FROM_EMAIL}>`
            : undefined,

          vars: {
            userEmail: email,
            ticketNo: ticketNo,
            ticketId: String(ticketId),
            issueType: issueType,
            summary: summary,
            details: details,
            screenshotUrl: screenshotUrl || '',
          },
        });
        console.log(
          '[support-tickets] support email sent OK for ticket',
          ticketNo
        );
      } catch (e) {
        console.error('[support-tickets] user email send failed:', e);
        // do not affect API response
      }
    })();

    return res.status(201).json({
      ok: true,
      ticketId,
      ticketNo,
      status,
      createdAt,
      firstMessageId,
      message: 'Ticket created successfully.',
      screenshotUrl,
    });
  } catch (err) {
    console.error('create ticket error', err);
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to create ticket.' });
  }
});

/**
 * POST /api/support-tickets/tickets/:ticketId/messages
 *
 * Content-Type: multipart/form-data
 * Fields:
 *   sender: 'user' | 'admin'
 *   senderId?: string
 *   senderEmail?: string
 *   messageText: string
 *   screenshot?: file (image)
 */
router.post(
  '/tickets/:ticketId/messages',
  upload.single('screenshot'),
  async (req, res) => {
    try {
      const ticketId = Number(req.params.ticketId);
      const { sender, senderId, senderEmail, messageText } = req.body || {};
      const screenshotFile = req.file || null;

      if (!ticketId || !sender || !messageText) {
        return res.status(400).json({
          ok: false,
          error: 'ticketId, sender and messageText are required.',
        });
      }

      const checkResult = await query(
        `SELECT ticket_id FROM public.support_ticket_hdr WHERE ticket_id = $1`,
        [ticketId]
      );

      if (!checkResult.rows || checkResult.rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Ticket not found.' });
      }

      const screenshotUrl = screenshotFile
        ? `/uploads/support/${screenshotFile.filename}`
        : null;

      const sql = `
        INSERT INTO public.support_ticket_dtl
          (ticket_id, sender, sender_id, sender_email, message_text, screenshot_url)
        VALUES
          ($1, $2, $3, $4, $5, $6)
        RETURNING message_id, created_at;
      `;

      const result = await query(sql, [
        ticketId,
        sender,
        senderId || null,
        senderEmail ? senderEmail.toLowerCase() : null,
        messageText,
        screenshotUrl,
      ]);

      const row = result.rows && result.rows[0];
      const messageId = row ? row.message_id : null;
      const createdAt = row ? row.created_at : null;

      return res.status(201).json({
        ok: true,
        ticketId,
        messageId,
        createdAt,
        screenshotUrl,
      });
    } catch (err) {
      console.error('add message error', err);
      return res
        .status(500)
        .json({ ok: false, error: 'Failed to add message.' });
    }
  }
);

/**
 * GET /api/support-tickets/tickets/:ticketId/thread
 */
router.get('/tickets/:ticketId/thread', async (req, res) => {
  try {
    const ticketId = Number(req.params.ticketId);
    if (!ticketId) {
      return res.status(400).json({ ok: false, error: 'Invalid ticketId.' });
    }

    const hdrRes = await query(
      `SELECT ticket_id, ticket_no, user_email, user_id, issue_type, summary, status, device_info, created_at, updated_at
         FROM public.support_ticket_hdr
        WHERE ticket_id = $1`,
      [ticketId]
    );

    if (!hdrRes.rows || hdrRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Ticket not found.' });
    }

    /** @type {SupportTicketHeaderRow} */
    const row = hdrRes.rows[0];

    const header = {
      ticketId: row.ticket_id,
      ticketNo: row.ticket_no,
      userEmail: row.user_email,
      userId: row.user_id,
      issueType: row.issue_type,
      summary: row.summary,
      status: row.status,
      deviceInfo: row.device_info,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    const dtlRes = await query(
      `SELECT message_id, sender, sender_email, message_text, screenshot_url, created_at
         FROM public.support_ticket_dtl
        WHERE ticket_id = $1
        ORDER BY created_at ASC`,
      [ticketId]
    );

    /** @type {SupportTicketMessageRow[]} */
    const rows = dtlRes.rows || [];

    const messages = [];
    for (const msg of rows) {
      messages.push({
        messageId: msg.message_id,
        sender: msg.sender,
        senderEmail: msg.sender_email,
        messageText: msg.message_text,
        screenshotUrl: msg.screenshot_url,
        createdAt: msg.created_at,
      });
    }

    return res.json({
      ok: true,
      header,
      messages,
    });
  } catch (err) {
    console.error('get thread error', err);
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to load ticket thread.' });
  }
});
/**
 * PUBLIC: POST /api/support-tickets/public
 *
 * Content-Type: application/json
 * Body:
 *   {
 *     "email": string,
 *     "userId"?: string,
 *     "issueType": string,
 *     "summary": string,
 *     "details": string
 *   }
 *
 * This endpoint is intended for unauthenticated website forms.
 * No token required; do NOT wrap this route with auth middleware when mounting.
 */
router.post('/public', async (req, res) => {
  try {
    const { email, userId, issueType, summary, details } = req.body || {};

    if (!email || !issueType || !summary || !details) {
      return res.status(400).json({
        ok: false,
        error: 'email, issueType, summary and details are required.',
      });
    }

    // No file upload from web form, so screenshot is always null here
    const screenshotUrl = null;

    // 1) Insert header
    const hdrSql = `
      INSERT INTO public.support_ticket_hdr
        (user_email, user_id, issue_type, summary)
      VALUES
        (lower($1), $2, $3, $4)
      RETURNING ticket_id, ticket_no, status, created_at;
    `;

    const hdrResult = await query(hdrSql, [
      email,
      userId || email,     // fallback: userId = email
      issueType,
      summary,
    ]);

    if (!hdrResult.rows || hdrResult.rows.length === 0) {
      return res
        .status(500)
        .json({ ok: false, error: 'Failed to create ticket header.' });
    }

    const hdrRow = /** @type {SupportTicketHeaderRow} */ (hdrResult.rows[0]);

    const {
      ticket_id: ticketId,
      ticket_no: ticketNo,
      status,
      created_at: createdAt,
    } = hdrRow;

    // 2) Insert first message as 'user'
    const dtlSql = `
      INSERT INTO public.support_ticket_dtl
        (ticket_id, sender, sender_id, sender_email, message_text, screenshot_url)
      VALUES
        ($1, 'user', $2, lower($3), $4, $5)
      RETURNING message_id, created_at;
    `;

    const dtlResult = await query(dtlSql, [
      ticketId,
      userId || email,
      email,
      details,
      screenshotUrl,
    ]);

    const firstRow = dtlResult.rows && dtlResult.rows[0];
    const firstMessageId = firstRow ? firstRow.message_id : null;

    // 3) Fire-and-forget email notification to user (same template)
    (async () => {
      try {
        await sendTemplateEmail({
          templateCode: 'SUPPORT_TICKET_CREATED_USER',
          to: email,
          from: SUPPORT_FROM_EMAIL
            ? `"SohumAstro AI Support" <${SUPPORT_FROM_EMAIL}>`
            : undefined,
          vars: {
            userEmail: email,
            ticketNo: ticketNo,
            ticketId: String(ticketId),
            issueType: issueType,
            summary: summary,
            details: details,
            screenshotUrl: screenshotUrl || '',
          },
        });
        console.log(
          '[support-tickets/public] support email sent OK for ticket',
          ticketNo
        );
      } catch (e) {
        console.error('[support-tickets/public] user email send failed:', e);
        // do not affect API response
      }
    })();

    return res.status(201).json({
      ok: true,
      ticketId,
      ticketNo,
      status,
      createdAt,
      firstMessageId,
      message: 'Ticket created successfully.',
      screenshotUrl,
    });
  } catch (err) {
    console.error('public create ticket error', err);
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to create ticket.' });
  }
});

export default router;
