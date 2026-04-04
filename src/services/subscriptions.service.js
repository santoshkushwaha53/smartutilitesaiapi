// API/src/services/subscriptions.service.js (unchanged)
import pool from '../db.js';

class SubscriptionsService {
  async details(userId) {
    const { rows } = await pool.query(
      'SELECT user_subscription_details($1) AS json',
      [userId]
    );
    return rows[0]?.json ?? null;
  }

  async applyDirect({ userId, planType, days, isFree = false }) {
    const { rows } = await pool.query(
      `SELECT jsonb_build_object(
         'ok', true,
         'grantResult', subscription_grant($1,$2, now(), $3, $4, CASE WHEN $4 THEN 'manual_free' ELSE 'purchase' END, NULL),
         'details', user_subscription_details($1)
       ) AS json`,
      [userId, planType, days, isFree]
    );
    return rows[0].json;
  }
}

const subsSvc = new SubscriptionsService();
export default subsSvc;
