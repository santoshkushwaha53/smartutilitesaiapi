import express from "express";
import { query as q } from "../src/db.js";


import { adminOnly } from "../src/middleware/adminOnly.js";
import { requireAuth, requireAdmin } from "../src/middleware/auth.js";

export const adminPaymentsRouter = express.Router();

adminPaymentsRouter.use(requireAuth, adminOnly);

/**
 * GET /api/admin/payments/methods
 */
adminPaymentsRouter.get("/methods", async (req, res) => {
  const r = await q(`select * from payment_method order by sort_order asc`);
  res.json({ ok: true, methods: r.rows });
});

/**
 * PATCH /api/admin/payments/methods/:method_code
 * Body: { is_enabled?, sort_order?, display_name?, icon_key? }
 */
adminPaymentsRouter.patch("/methods/:method_code", async (req, res) => {
  const method_code = String(req.params.method_code);
  const { is_enabled, sort_order, display_name, icon_key } = req.body;

  const r = await q(
    `update payment_method
     set is_enabled = coalesce($1,is_enabled),
         sort_order = coalesce($2,sort_order),
         display_name = coalesce($3,display_name),
         icon_key = coalesce($4,icon_key),
         updated_at=now()
     where method_code=$5
     returning *`,
    [is_enabled, sort_order, display_name, icon_key, method_code]
  );

  if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, method: r.rows[0] });
});

/**
 * GET /api/admin/payments/providers?method_code=upi&country=IN
 */
adminPaymentsRouter.get("/providers", async (req, res) => {
  const method_code = req.query.method_code ? String(req.query.method_code) : null;
  const country = req.query.country ? String(req.query.country).toUpperCase() : null;

  const params = [];
  let where = "where 1=1";
  if (method_code) { params.push(method_code); where += ` and method_code=$${params.length}`; }
  if (country) { params.push(country); where += ` and country_code=$${params.length}`; }

  const r = await q(
    `select provider_id,method_code,provider_code,provider_name,country_code,is_enabled,sort_order,metadata
     from payment_provider
     ${where}
     order by sort_order asc`,
    params
  );

  res.json({ ok: true, providers: r.rows });
});

/**
 * POST /api/admin/payments/providers
 * Body: { method_code, provider_code, provider_name, country_code, sort_order?, is_enabled?, metadata? }
 */
adminPaymentsRouter.post("/providers", async (req, res) => {
  const {
    method_code,
    provider_code,
    provider_name,
    country_code,
    sort_order = 100,
    is_enabled = true,
    metadata = {},
  } = req.body;

  if (!method_code || !provider_code || !provider_name || !country_code) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }

  const r = await q(
    `insert into payment_provider(method_code,provider_code,provider_name,country_code,sort_order,is_enabled,metadata)
     values($1,$2,$3,$4,$5,$6,$7)
     returning *`,
    [method_code, provider_code, provider_name, String(country_code).toUpperCase(), sort_order, is_enabled, metadata]
  );

  res.json({ ok: true, provider: r.rows[0] });
});

/**
 * PATCH /api/admin/payments/providers/:provider_id
 */
adminPaymentsRouter.patch("/providers/:provider_id", async (req, res) => {
  const provider_id = Number(req.params.provider_id);
  const { is_enabled, sort_order, provider_name, metadata } = req.body;

  const r = await q(
    `update payment_provider
     set is_enabled = coalesce($1,is_enabled),
         sort_order = coalesce($2,sort_order),
         provider_name = coalesce($3,provider_name),
         metadata = coalesce($4,metadata),
         method_code = method_code
     where provider_id=$5
     returning *`,
    [is_enabled, sort_order, provider_name, metadata, provider_id]
  );

  if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, provider: r.rows[0] });
});
