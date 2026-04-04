// routes/analytics.route.js
import { Router } from 'express';
import { requireAuth } from '../src/middleware/auth.js';
import { query } from '../src/db.js';

const router = Router();

router.post('/events', requireAuth, async (req, res) => {
  const userId = req.user.id; // UUID from JWT
  const events = Array.isArray(req.body?.events) ? req.body.events : [];

  console.log('POST /api/analytics/events', JSON.stringify(req.body, null, 2));

  if (!events.length) {
    return res.status(400).json({ ok: false, error: 'no_events' });
  }

  const values = [];
  const params = [];

  events.forEach((ev) => {
    const moduleCode = ev.moduleCode || 'UNKNOWN';
    const route = ev.route || 'UNKNOWN';
    const type = ev.type || 'view_start';
    const startedAt = ev.startedAt || new Date().toISOString();
    const endedAt = ev.endedAt || null;
    const durationMs = ev.durationMs ?? null;
    const deviceType = ev.deviceType || null;
    const origin = ev.origin || null;
    const meta = ev.meta || null;

    values.push(
      `($${params.length + 1}, $${params.length + 2}, $${params.length + 3},
        $${params.length + 4}, $${params.length + 5}, $${params.length + 6},
        $${params.length + 7}, $${params.length + 8}, $${params.length + 9},
        $${params.length + 10}, $${params.length + 11})`
    );

    params.push(
      userId,       // 1: user_id (uuid)
      ev.sessionId, // 2: session_id (text)
      moduleCode,   // 3: module_code
      route,        // 4: route
      type,         // 5: event_type
      startedAt,    // 6: started_at
      endedAt,      // 7: ended_at
      durationMs,   // 8: duration_ms
      deviceType,   // 9: device_type
      origin,       // 10: origin
      meta          // 11: meta
    );
  });

  try {
    await query(
      `
      INSERT INTO app_usage_event
        (user_id, session_id, module_code, route,
         event_type, started_at, ended_at, duration_ms,
         device_type, origin, meta)
      VALUES ${values.join(',')}
      `,
      params
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('analytics insert error', err);
    return res.status(500).json({ ok: false, error: 'db_error' });
  }
});

export default router;
