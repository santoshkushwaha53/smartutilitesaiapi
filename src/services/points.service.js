import pool from '../db.js';

class PointsService {
  /**
   * Resolve whatever the caller passes (email or uuid) into the internal
   * UUID from app_userlogin.user_id.
   *
   * - If userId already looks like a UUID, just return it.
   * - Otherwise treat it as email_id and look up user_id.
   */
  async resolveUserId(userId) {
    if (!userId) return null;
 debugger;
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // If it’s already a UUID, use as-is
    if (uuidRegex.test(userId)) {
      return userId;
    }

    // Otherwise assume it's an email_id → fetch user_id from app_userlogin
    const r = await pool.query(
      'SELECT id FROM app_userlogin WHERE email = $1',
      [userId]
    )

    const row = r.rows && r.rows[0];
    return row ? row.id : null;
  }

  async spend(userId, cost, reason = 'user', extra = {}) {
    debugger;

    // 🔹 resolve email/uuid -> internal UUID
    const resolvedUserId = await this.resolveUserId(userId);
    if (!resolvedUserId) {
      return { ok: false, error: 'user_not_found', summary: null };
    }

    const { location = null, question = null, clientTs = null, requestId = null } = extra;

    const r1 = await pool.query(
      'SELECT points_spend($1,$2,$3,$4,$5,$6,$7) AS json',
      [resolvedUserId, cost, reason, location, question, clientTs, requestId] // ← forwards question
    );

    const payload = r1.rows[0]?.json;

    const r2 = await pool.query(
      'SELECT user_subscription_details($1) AS json',
      [resolvedUserId]
    );
    const details = r2.rows[0]?.json ?? null;

    return { ...(payload || {}), summary: details };
  }

  async credit(userId, amount, reason = 'manual') {
    const resolvedUserId = await this.resolveUserId(userId);
    if (!resolvedUserId) {
      return { ok: false, error: 'user_not_found', summary: null };
    }

    const r1 = await pool.query(
      'SELECT points_credit($1,$2,$3) AS json',
      [resolvedUserId, amount, reason]
    );
    const payload = r1.rows[0]?.json;

    const r2 = await pool.query(
      'SELECT user_subscription_details($1) AS json',
      [resolvedUserId]
    );
    const details = r2.rows[0]?.json ?? null;

    return { ...(payload || {}), summary: details };
  }

  async balance(userId) {
    const resolvedUserId = await this.resolveUserId(userId);
    if (!resolvedUserId) {
      return { ok: false, error: 'user_not_found', balance: 0 };
    }

    const { rows } = await pool.query(
      'SELECT points_balance($1) AS balance',
      [resolvedUserId]
    );
    return { ok: true, balance: rows[0]?.balance ?? 0 };
  }

  async history(userId, limit = 50) {
    const resolvedUserId = await this.resolveUserId(userId);
    if (!resolvedUserId) {
      return [];
    }

    const { rows } = await pool.query(
      'SELECT points_usage_list($1,$2) AS json',
      [resolvedUserId, limit]
    );
    return rows[0]?.json ?? [];
  }
}

const pointsSvc = new PointsService();
export default pointsSvc;
