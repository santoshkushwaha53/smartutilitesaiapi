// API/src/services/promotions.admin.service.js
import pool from '../db.js';
import { z } from 'zod';

// ------------------------------------------------------
// Default assignment config
// ------------------------------------------------------
export const DEFAULT_ASSIGNMENT_CONFIG = {
  // High-level toggles
  enable_for_all: false,

  // Segments
  target_new_users: false,
  target_existing_users: false,

  // Filters
  zodiac_signs: [],       // e.g. ["aries", "taurus"]
  plans: [],              // e.g. ["free", "plus", "premium"]
  channels: [],           // e.g. ["web", "android", "ios"]
};

// Zod schema to validate assignment rules
const AssignmentRulesSchema = z
  .object({
    enable_for_all: z.boolean().optional(),
    target_new_users: z.boolean().optional(),
    target_existing_users: z.boolean().optional(),

    zodiac_signs: z.array(z.string()).optional(),
    plans: z.array(z.string()).optional(),
    channels: z.array(z.string()).optional(),
  })
  .strict();

// Helper: merge defaults with a (partial) config
function mergeAssignmentConfig(partialConfig = {}) {
  // Validate & clean using Zod (partial = all fields optional)
  const parsed = AssignmentRulesSchema.partial().parse(partialConfig);

  // Safe merge: default → parsed (only known keys override)
  return {
    ...DEFAULT_ASSIGNMENT_CONFIG,
    ...parsed,
  };
}

class PromotionsAdminService {
  // ------------------------------------------------------
  // Existing admin APIs
  // ------------------------------------------------------

  async list({ status = null, kind = null }) {
    const { rows } = await pool.query(
      'SELECT * FROM promo_admin_list($1::promo_status, $2::promo_kind)',
      [status, kind]
    );
    return rows;
  }

  // Use promotions table directly
  async details(promoId) {
    const { rows } = await pool.query(
      'SELECT * FROM public.promotions WHERE id = $1',
      [promoId]
    );
    return rows[0] || null;
  }

  async stats(promoId) {
    const { rows } = await pool.query(
      'SELECT promo_admin_stats($1) AS json',
      [promoId]
    );
    return rows[0]?.json || null;
  }

  async create(payload, adminUserId) {
    const {
      kind,
      code,
      name,
      description,
      points,
      days_valid,
      start_at,
      end_at,
      max_global_redemptions,
      max_per_user,
      metadata = {},
    } = payload;

    const { rows } = await pool.query(
      `SELECT promo_admin_create(
         $1::promo_kind,
         $2::text,
         $3::text,
         $4::text,
         $5::integer,
         $6::integer,
         $7::timestamptz,
         $8::timestamptz,
         $9::integer,
         $10::integer,
         $11::uuid,
         $12::jsonb
       ) AS row`,
      [
        kind,
        code,
        name,
        description,
        points,
        days_valid,
        start_at,
        end_at,
        max_global_redemptions,
        max_per_user,
        adminUserId,
        metadata,
      ]
    );
    return rows[0].row;
  }

  async update(promoId, payload) {
  const {
    name = null,
    description = null,
    points = null,
    days_valid = null,
    start_at = null,
    end_at = null,
    status = null,
    max_global_redemptions = null,
    max_per_user = null,
    metadata = null,
  } = payload;

  const { rows } = await pool.query(
    `SELECT promo_admin_update(
       $1::uuid,
       $2::text,
       $3::text,
       $4::integer,
       $5::integer,
       $6::timestamptz,
       $7::timestamptz,
       $8::promo_status,
       $9::integer,
       $10::integer,
       $11::jsonb
     ) AS row`,
    [
      promoId,
      name,
      description,
      points,
      days_valid,
      start_at,
      end_at,
      status,
      max_global_redemptions,
      max_per_user,
      metadata,
    ]
  );
  return rows[0].row;
}


  async generateCodes(promoId, { prefix, count }) {
    const { rows } = await pool.query(
      'SELECT promo_admin_generate_codes($1, $2, $3) AS row',
      [promoId, prefix, count]
    );
    return rows.map((r) => r.row);
  }

  async listCodes(promoId) {
    const { rows } = await pool.query(
      `SELECT * FROM public.promo_codes
       WHERE promo_id = $1
       ORDER BY created_at DESC`,
      [promoId]
    );
    return rows;
  }

  async listUsage(promoId) {
    const { rows } = await pool.query(
      `SELECT up.*, u.email
       FROM public.user_promotions up
       LEFT JOIN app_userlogin u ON u.id = up.user_id
       WHERE up.promo_id = $1
       ORDER BY up.created_at DESC`,
      [promoId]
    );
    return rows;
  }

  // ------------------------------------------------------
  // NEW: Promotion assignment APIs
  // ------------------------------------------------------

  /**
   * Get effective assignment rules for a promotion:
   * - Reads promotions.metadata
   * - Extracts metadata.assignment_rules (if any)
   * - Safely merges with DEFAULT_ASSIGNMENT_CONFIG
   */
  async getAssignment(promoId) {
    const { rows } = await pool.query(
      'SELECT metadata FROM public.promotions WHERE id = $1',
      [promoId]
    );

    if (!rows.length) {
      const err = new Error('Promotion not found');
      err.statusCode = 404;
      throw err;
    }

    const metadata = rows[0].metadata || {};
    const existingRules = metadata.assignment_rules || {};

    const effective = mergeAssignmentConfig(existingRules);
    return effective;
  }

  /**
   * Save assignment rules for a promotion:
   * - Validates & sanitizes config
   * - Merges with defaults
   * - Stores into promotions.metadata.assignment_rules
   */
  // API/src/services/promotions.admin.service.js
async saveAssignment(promoId, assignmentRules) {
  // just store in promotions.metadata.assignment_rules, or your own table
  const { rows } = await pool.query(
    `
    UPDATE public.promotions
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{assignment_rules}',
      $2::jsonb,
      true
    )
    WHERE id = $1
    RETURNING (metadata->'assignment_rules') AS assignment_rules
    `,
    [promoId, assignmentRules]
  );

  if (!rows.length) {
    const err = new Error('Promotion not found');
    err.statusCode = 404;
    throw err;
  }

  return rows[0].assignment_rules;
}

}

const adminPromosSvc = new PromotionsAdminService();
export default adminPromosSvc;
