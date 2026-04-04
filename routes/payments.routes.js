import express from "express";
import crypto from "crypto";
import { query as q } from "../src/db.js";


import razorpay from "../lib/razorpay.js";
import { requireAuth } from "../src/middleware/auth.js";


export const paymentsRouter = express.Router();

/**
 * Helpers
 */
function nowIso() { return new Date().toISOString(); }

async function getPlanPriceOrThrow({ plan_code, country_code }) {
  const r = await q(
    `select plan_code,country_code,currency_code,amount_paise
     from subscription_plan_price
     where plan_code=$1 and country_code=$2 and is_active=true
     limit 1`,
    [plan_code, country_code]
  );
  if (r.rowCount === 0) {
    const e = new Error("plan_price_not_found");
    e.status = 400;
    throw e;
  }
  return r.rows[0];
}

async function isMethodEnabled(method_code) {
  const r = await q(
    `select is_enabled from payment_method where method_code=$1 limit 1`,
    [method_code]
  );
  return r.rowCount > 0 && r.rows[0].is_enabled === true;
}

async function isProviderEnabled({ method_code, provider_code, country_code }) {
  if (!provider_code) return true; // card might not require provider
  const r = await q(
    `select is_enabled from payment_provider
     where method_code=$1 and provider_code=$2 and country_code=$3
     limit 1`,
    [method_code, provider_code, country_code]
  );
  return r.rowCount > 0 && r.rows[0].is_enabled === true;
}

/**
 * GET /api/payments/config?country=IN
 * Returns enabled methods + enabled providers for that country
 */
paymentsRouter.get("/config", requireAuth, async (req, res) => {
  try {
    const country = String(req.query.country || "IN").toUpperCase();

    const methods = await q(
      `select method_code,display_name,icon_key,is_enabled,sort_order
       from payment_method
       where is_enabled=true
       order by sort_order asc`
    );

    const providers = await q(
      `select provider_id,method_code,provider_code,provider_name,country_code,logo_url,is_enabled,sort_order,metadata
       from (
         select provider_id,method_code,provider_code,provider_name,country_code,
                (metadata->>'logo_url') as logo_url,
                is_enabled,sort_order,metadata
         from payment_provider
       ) x
       where is_enabled=true and country_code=$1
       order by sort_order asc`,
      [country]
    );

    const grouped = methods.rows.map(m => ({
      ...m,
      providers: providers.rows.filter(p => p.method_code === m.method_code),
    }));

    res.json({ ok: true, country, methods: grouped, ts: nowIso() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "config_failed" });
  }
});

/**
 * POST /api/payments/orders
 * Body: { plan_code, country_code }
 * Server validates price from subscription_plan_price
 */
paymentsRouter.post("/orders", requireAuth, async (req, res) => {
  try {
    const plan_code = String(req.body.plan_code || "").trim();
    const country_code = String(req.body.country_code || "IN").toUpperCase();

    if (!plan_code) return res.status(400).json({ ok: false, error: "plan_code_required" });

    const price = await getPlanPriceOrThrow({ plan_code, country_code });

    const inserted = await q(
      `insert into payment_order(user_id,plan_code,country_code,currency_code,amount_paise,status)
       values($1,$2,$3,$4,$5,'CREATED')
       returning order_id,user_id,plan_code,country_code,currency_code,amount_paise,status,created_at`,
      [req.user.id, plan_code, country_code, price.currency_code, price.amount_paise]
    );

    res.json({ ok: true, order: inserted.rows[0] });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "order_create_failed" });
  }
});

/**
 * POST /api/payments/orders/:orderId/attempt
 * Body: { method_code, provider_code? }
 * Creates Razorpay Order and stores payment_attempt
 */
paymentsRouter.post("/orders/:orderId/attempt", requireAuth, async (req, res) => {
  try {
    const orderId = String(req.params.orderId);
    const method_code = String(req.body.method_code || "").trim();
    const provider_code = req.body.provider_code ? String(req.body.provider_code).trim() : null;

    if (!method_code) return res.status(400).json({ ok: false, error: "method_code_required" });

    // fetch app order
    const orderR = await q(
      `select * from payment_order where order_id=$1 and user_id=$2 limit 1`,
      [orderId, req.user.id]
    );
    if (orderR.rowCount === 0) return res.status(404).json({ ok: false, error: "order_not_found" });

    const order = orderR.rows[0];
    if (order.status !== "CREATED") {
      return res.status(400).json({ ok: false, error: "order_not_in_created_state" });
    }

    // config checks
    const methodOk = await isMethodEnabled(method_code);
    if (!methodOk) return res.status(400).json({ ok: false, error: "method_disabled" });

    const providerOk = await isProviderEnabled({
      method_code,
      provider_code,
      country_code: order.country_code,
    });
    if (!providerOk) return res.status(400).json({ ok: false, error: "provider_disabled" });

    // Create Razorpay order
    const razorOrder = await razorpay.orders.create({
      amount: order.amount_paise,
      currency: order.currency_code,
      receipt: String(order.order_id),
      notes: {
        plan_code: order.plan_code,
        user_id: String(order.user_id),
        country_code: order.country_code,
      },
    });

    const attemptR = await q(
      `insert into payment_attempt(order_id,method_code,provider_code,razorpay_order_id,status)
       values($1,$2,$3,$4,'CREATED')
       returning attempt_id,order_id,method_code,provider_code,razorpay_order_id,status,created_at`,
      [order.order_id, method_code, provider_code, razorOrder.id]
    );

    // mark order pending (optional but recommended)
    await q(
      `update payment_order set status='PENDING', updated_at=now() where order_id=$1`,
      [order.order_id]
    );

    res.json({
      ok: true,
      attempt: attemptR.rows[0],
      razorpay: {
        key: process.env.RAZORPAY_KEY_ID,
        razorpay_order_id: razorOrder.id,
        amount: razorOrder.amount,
        currency: razorOrder.currency,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "attempt_create_failed" });
  }
});

/**
 * POST /api/payments/verify
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * Verifies signature and marks attempt + order PAID
 */
paymentsRouter.post("/verify", requireAuth, async (req, res) => {
  try {
    const razorpay_order_id = String(req.body.razorpay_order_id || "");
    const razorpay_payment_id = String(req.body.razorpay_payment_id || "");
    const razorpay_signature = String(req.body.razorpay_signature || "");

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: "missing_verify_fields" });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      // mark failed attempt (best effort)
      await q(
        `update payment_attempt set status='FAILED', error_reason='INVALID_SIGNATURE', updated_at=now()
         where razorpay_order_id=$1`,
        [razorpay_order_id]
      );
      return res.status(400).json({ ok: false, error: "invalid_signature" });
    }

    // fetch attempt + ensure belongs to user via order
    const attemptR = await q(
      `select a.*, o.user_id
       from payment_attempt a
       join payment_order o on o.order_id=a.order_id
       where a.razorpay_order_id=$1
       limit 1`,
      [razorpay_order_id]
    );
    if (attemptR.rowCount === 0) return res.status(404).json({ ok: false, error: "attempt_not_found" });

    const attempt = attemptR.rows[0];
    if (String(attempt.user_id) !== String(req.user.id)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    // transaction updates
    await q("begin");
    try {
      await q(
        `update payment_attempt
         set status='PAID',
             razorpay_payment_id=$1,
             razorpay_signature=$2,
             updated_at=now()
         where attempt_id=$3`,
        [razorpay_payment_id, razorpay_signature, attempt.attempt_id]
      );

      await q(
        `update payment_order
         set status='PAID', updated_at=now()
         where order_id=$1`,
        [attempt.order_id]
      );

      await q("commit");
    } catch (e) {
      await q("rollback");
      throw e;
    }

    res.json({ ok: true, status: "PAID" });
  } catch (e) {
    res.status(500).json({ ok: false, error: "verify_failed" });
  }
});

/**
 * GET /api/payments/orders/:orderId
 * For frontend polling if needed
 */
paymentsRouter.get("/orders/:orderId", requireAuth, async (req, res) => {
  try {
    const orderId = String(req.params.orderId);
    const r = await q(
      `select order_id,plan_code,country_code,currency_code,amount_paise,status,created_at,updated_at
       from payment_order
       where order_id=$1 and user_id=$2
       limit 1`,
      [orderId, req.user.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "order_not_found" });
    res.json({ ok: true, order: r.rows[0] });
  } catch {
    res.status(500).json({ ok: false, error: "order_fetch_failed" });
  }
});

/**
 * POST /api/payments/webhook/razorpay
 * IMPORTANT: must be mounted with RAW body parser (see src/index.js)
 */
export async function razorpayWebhookHandler(req, res) {
  try {
    const sig = req.headers["x-razorpay-signature"];
    const rawBody = req.body; // Buffer

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    if (sig !== expected) return res.status(400).send("Invalid signature");

    const event = JSON.parse(rawBody.toString("utf8"));

    // common useful events: payment.captured, payment.failed, order.paid
    const type = event.event;

    if (type === "payment.captured") {
      const p = event.payload?.payment?.entity;
      const razorpay_order_id = p?.order_id;
      const razorpay_payment_id = p?.id;

      if (razorpay_order_id && razorpay_payment_id) {
        await q("begin");
        try {
          await q(
            `update payment_attempt
             set status='PAID',
                 razorpay_payment_id=$1,
                 updated_at=now()
             where razorpay_order_id=$2`,
            [razorpay_payment_id, razorpay_order_id]
          );

          await q(
            `update payment_order
             set status='PAID', updated_at=now()
             where order_id = (
               select order_id from payment_attempt
               where razorpay_order_id=$1
               limit 1
             )`,
            [razorpay_order_id]
          );
          await q("commit");
        } catch (e) {
          await q("rollback");
          throw e;
        }
      }
    }

    if (type === "payment.failed") {
      const p = event.payload?.payment?.entity;
      const razorpay_order_id = p?.order_id;
      const reason = p?.error_description || p?.error_reason || "PAYMENT_FAILED";
      if (razorpay_order_id) {
        await q(
          `update payment_attempt
           set status='FAILED', error_reason=$1, updated_at=now()
           where razorpay_order_id=$2`,
          [reason, razorpay_order_id]
        );
        await q(
          `update payment_order
           set status='FAILED', updated_at=now()
           where order_id = (
             select order_id from payment_attempt
             where razorpay_order_id=$1
             limit 1
           )`,
          [razorpay_order_id]
        );
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
}
