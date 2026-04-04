// API/src/services/promotions.service.js
import pool from '../db.js'; // db.js is in /API/src/db.js

class PromotionsService {
  async lookup(code, userId) {
    const { rows } = await pool.query('SELECT promo_lookup($1, $2) AS json', [
      code,
      userId || null,
    ]);
    return rows[0].json;
  }
  async redeem(userId, code) {
    const { rows } = await pool.query('SELECT promo_redeem($1, $2) AS json', [
      userId,
      code,
    ]);
    return rows[0].json;
  }
  async suspend(promoId) {
    await pool.query('SELECT promo_suspend($1)', [promoId]);
  }
  async blockCode(code) {
    await pool.query('SELECT promo_block_code($1)', [code]);
  }
}
const svc = new PromotionsService();
export default svc;
