// index.js

// ─────────────────────────────────────────────────────────────
// Core & third-party imports
// ─────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import geoRouter from './routes/geo.js';
import { fileURLToPath } from 'url';
import filesRouter from './routes/files.routes.js';
import pointsAdminRouter from './routes/points.admin.route.js';
import freeAstroRouter from './routes/freeastro.route.js';
import topupsRouter from './routes/topups.route.js';

// 👇 just importing this file registers all cron jobs
import './jobs/PlanetsScheduler.js';
import adminAiMasterRouter from './routes/adminAiMaster.route.js';
import {
  runDailyJobNow,
  runWeeklyJobNow,
  runMonthlyJobNow,
  runYearlyJobNow,
} from './jobs/PlanetsScheduler.js';

import './jobs/HousesScheduler.js';
import {
  runDailyHousesJobNow,
  runWeeklyHousesJobNow,
  runMonthlyHousesJobNow,
  runYearlyHousesJobNow,
} from './jobs/HousesScheduler.js';
// index.js (near other job imports)
import './jobs/AspectsScheduler.js';
import {
  runDailyAspectsJobNow,
  runWeeklyAspectsJobNow,
  runMonthlyAspectsJobNow,
  runYearlyAspectsJobNow,
} from './jobs/AspectsScheduler.js';
import dailyHoroscopeRawSummaryRoute from
  "./routes/daily-horoscope-raw-summary_route.js";
import freeastroSchedulerRouter from './routes/freeastroScheduler.route.js';
import freeastroWesternRouter from './routes/freeastro-western.route.js';
// ─────────────────────────────────────────────────────────────
// Internal imports: DB / utils
// ─────────────────────────────────────────────────────────────
import { query } from './src/db.js'; // (currently unused, kept as-is)
import promotionsAdminRouter from './routes/promotions.admin.route.js';

// ─────────────────────────────────────────────────────────────
// Internal imports: Routers
// ─────────────────────────────────────────────────────────────
import promotionsRouter from './routes/promotions.route.js';
import providersAdminRouter from './routes/providers.admin.route.js';
import statusProvidersRouter from './routes/status.providers.route.js';
import prokeralaRouter from './routes/prokerala.route.js';

import authRoutes from './routes/auth.js';
import { requireAuth, requireAdmin } from './src/middleware/auth.js';
import fbAuthRoutes from './routes/auth.facebook.js';
import googleRouter from './routes/auth.google.js';
import userRoutes from './routes/users.js';

import todayHoroscopeRoute from './routes/horoscope.today.route.js';
import horoscopeReadTableRouter from './routes/horoscope.read.table.route.js';
import horoscopeRouter from './routes/horoscope.route.js';       // unified router
import rawPublicHoroscope from './routes/horoscope.public.raw.route.js';

import predictionRouter from './routes/prediction.route.js';
import aiBatchRouter from './routes/ai.batch.route.js';
import rawAiRouter from "./routes/raw-bundle-ai-predict.route.js";
import subscriptionsRouter from './routes/subscriptions.route.js';
import pointsRouter from './routes/points.route.js';
import astroChatRoute from './routes/astrochat.route.js';
import sunCompatRouter from './routes/sun.compat.route.js';
import tarotRoutes from './routes/tarot.routes.js';
import auspiciousRouter from './routes/auspicious.route.js';
import apiManagerRouter from './routes/apiManager.routes.js';
import { logApiCallStart, logApiCallEnd } from './src/apiCallLog.js';
import apiCallsRouter from './routes/admin.apiCalls.route.js';

// prpmot managment
import chipsAdminRouter from './routes/chips.admin.route.js';
import publicPricingRouter from './routes/public.pricing.route.js';
import adminPlansRouter from './routes/admin.plans.route.js';
import adminTopupsRouter from './routes/admin.topups.route.js';
import aiConfigAdminRouter from './routes/ai-config.admin.route.js';
import masterAdminRouter from './routes/adminMaster.js';
import adminApiJobsRouter from './routes/adminApiJobs.route.js';
import { razorpayWebhookHandler, paymentsRouter } 
  from "./routes/payments.routes.js";
import { adminPaymentsRouter } from './routes/admin.payments.routes.js';
import emailRouter from "./routes/email.route.js";
import otpRouter from "./routes/otp.route.js";
import passwordRouter from "./routes/password.route.js";
import birthchartGetOrGenerate from './routes/Birthchart/birthchart_get_or_generate.route.js';
import birthchartRawRouter from './routes/Birthchart/freeastro_Birthchart.route.js';
import settingsRoutes from './routes/Settings/settings.page.routes.js';
import vedicBirthchartRoutes from './routes/Birthchart/vedic.birthchart.routes.js';
import miscSettingsRoutes from './routes/Settings/misc-settings.routes.js';
import supportTicketsRouter from './routes/support-tickets.router.js';
import transitRouter from './routes/transit.js';
import analyticsRouter from './routes/analytics.route.js';
import travelFreeRouter from "./routes/travel-free.router.js";
// ─────────────────────────────────────────────────────────────
// Env bootstrap & basic boot log
// ───────────────────────────────────────────────────────────
dotenv.config(); // keep position (no logic change)

console.log('[BOOT] index.js file =', new URL(import.meta.url).pathname);

// ─────────────────────────────────────────────────────────────
// App bootstrap
// ─────────────────────────────────────────────────────────────
const app = express();
const ENABLE_PREWARM = process.env.ENABLE_PREWARM === 'true';

// ⭐ ES module-safe __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// One PORT everywhere (Render sets process.env.PORT; default 4000 locally)
const PORT = Number(process.env.PORT ?? 4000);

// ─────────────────────────────────────────────────────────────
// CORS configuration (FIRST)
// ─────────────────────────────────────────────────────────────

// Allow dev (ANY localhost port) + your production domains
const PROD_ALLOW = new Set([
  'https://m.sohumastroai.com',
  'https://sohumastroai.com',
  'https://www.sohumastroai.com',
  'https://sohum-astro-web.vercel.app',
]);

// Helper: localhost detection
const isLocalhost = (origin) =>
  !!origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

// Allow Capacitor/Ionic app schemes & common LAN testing hosts
const APP_SCHEMES = new Set(['capacitor://localhost', 'ionic://localhost']);

const isLan = (origin) =>
  !!origin &&
  /^https?:\/\/(10\.0\.2\.2|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (APP_SCHEMES.has(origin)) return cb(null, true);
    if (isLocalhost(origin) || isLan(origin)) return cb(null, true);
    if (PROD_ALLOW.has(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

  // ✅ ADD missing headers here
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-session-id',
    'X-Session-Id',
    'x-requested-with'
  ],

  maxAge: 86400,
};


app.use(cors(corsOptions));
// Express v5-safe preflight matcher (no bare "*")
app.options(/.*/, cors(corsOptions));

// ─────────────────────────────────────────────────────────────
// Helmet (SECOND) – security headers
// ─────────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginEmbedderPolicy: false, // allow cross-origin fetch usage
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // don't force same-origin for resources
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  })
);
// ─────────────────────────────────────────────────────────────


// 🔔 Razorpay webhook MUST be before express.json
app.post(
  "/api/payments/webhook/razorpay",
  express.raw({ type: "*/*" }),
  razorpayWebhookHandler
);

// User payments
app.use("/api/payments", paymentsRouter);

// Admin payments
app.use(
  "/api/admin/payments",
  requireAuth,
  requireAdmin,
  adminPaymentsRouter
);

// ─────────────────────────────────────────────────────────────
// Body parsing, cookies & tiny logger
//  ⚠️ MUST be before any routers that need req.body
// ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Tiny logger
app.use((req, _res, next) => {
  console.log(req.method, req.path, req.query || {});
  next();
});

// ─────────────────────────────────────────────────────────────
// JWT attach middleware (before routes)
// ─────────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  const h = req.headers?.authorization || '';

  if (h.startsWith('Bearer ')) {
    const token = h.slice(7);
    try {
      const payload = jwt.verify(token, (process.env.JWT_SECRET || '').trim());
      // Minimal shape expected by requireAuth in promotions.route.js
      req.user = { id: payload.sub, email: payload.email };
    } catch (e) {
      // Invalid/expired token → leave req.user undefined; requireAuth will 401
      console.warn('[JWT] verify failed:', e.message);
    }
  }

  next();
});

// Log just the redeem call once it arrives (helps confirm header & user)
app.use((req, _res, next) => {
  if (req.method === 'POST' && req.path === '/api/promo/redeem') {
    console.log('[REDEEM] auth hdr:', req.headers.authorization || '(none)');
    console.log('[REDEEM] req.user:', req.user || null);
  }
  next();
});

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

// Admin/probing for provider routing (READ-ONLY admin API)
app.use('/api/horoscope/providers', providersAdminRouter);
app.use('/api/horoscope/providers', statusProvidersRouter);

// Today helper endpoints (legacy/simple)
app.use('/api/horoscope/today', todayHoroscopeRoute);

// Prokerala raw/cache caller
app.use('/api/prokerala', prokeralaRouter);

// Auth & user
app.use('/api/auth', authRoutes);
app.use('/api/auth/facebook', fbAuthRoutes);
app.use('/api/auth', googleRouter);
app.use('/api/user', userRoutes);

// Predictions (LLM)
app.use('/api/prediction', predictionRouter);

// Unified multi-period, multi-topic horoscope endpoint (serves /api/horoscope/get)
app.use('/api/horoscope', horoscopeRouter);

// Read-table helper under /api/horoscope/read to avoid shadowing
app.use('/api/horoscope/read', horoscopeReadTableRouter);

// Public raw endpoints
app.use('/api/public', rawPublicHoroscope);

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Utilities for quick inspection
app.get('/api/ai/ping2', (_req, res) => res.json({ ok: true, direct: true }));
app.use('/api/ai', aiBatchRouter);

// Admin points
app.use('/api/admin/points', pointsAdminRouter);

// Admin: API Call Logs viewer
app.use('/api/admin', apiCallsRouter);
app.use('/api/admin/master', masterAdminRouter);
app.use('/api/admin/ai', adminAiMasterRouter);
//  Natal Chart
app.use('/api/freeastro', freeastroWesternRouter);
app.use("/api", otpRouter);
app.use("/api", passwordRouter);


// Vedic Birth Chart Interpretation Route Prompt
// ─────────────────────────────────────────────────────────────  
app.use('/api/birthchart', birthchartGetOrGenerate);

// Misc Settings Routes
app.use('/api/misc-settings', miscSettingsRoutes);

// ─────────────────────────────────────────────────────────────
// More routes here...
// ─────────────────────────────────────────────────────────────
/* ---------- routes ---------- */
// This makes your endpoints become:
// POST  /api/birthchart/western/birth-chart/raw
// GET   /api/birthchart/western/chart/:chartId
// GET   /api/birthchart/western/chart/:chartId/full

app.use('/api/birthchart', birthchartRawRouter);
app.use((req, res, next) => {
  console.log('[INCOMING]', req.method, req.url);
  next();
});
app.use('/api/birthchart', vedicBirthchartRoutes); 
app.use('/api', settingsRoutes);
app.use("/api/astro/raw-ai", rawAiRouter);
// support tickets routes
app.use('/api/support-tickets', supportTicketsRouter);
// ─────────────────────────────────────────────────────────────
// Daily Horoscope Raw Summary Routes 
// ─────────────────────────────────────────────────────────────
app.use(
  "/api/astro/raw-summary",
  dailyHoroscopeRawSummaryRoute
);
// Route inspectors for debugging
// ─────────────────────────────────────────────────────────────
// Simple route inspector for humans
app.use('/api/transit', transitRouter);
//auth analytics route
app.use('/api/analytics', analyticsRouter);
app.get('/__routes_simple', (_req, res) => {
  const out = [];

  for (const layer of app._router?.stack || []) {
    if (layer.route?.path) {
      out.push({
        mount: '/',
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      for (const r of layer.handle.stack) {
        if (r.route?.path) {
          out.push({
            mount: '(router)',
            path: r.route.path,
            methods: Object.keys(r.route.methods),
          });
        }
      }
    }
  }

  res.type('application/json').send(JSON.stringify(out));
});

// More detailed route inspector
function printMounted(appRef) {
  const paths = [];

  appRef?._router?.stack?.forEach((layer) => {
    if (layer?.route?.path) {
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m])
        .map((m) => m.toUpperCase())
        .join(',');
      paths.push(`${methods} ${layer.route.path}`);
    } else if (layer?.name === 'router' && layer?.regexp) {
      const base =
        layer.regexp
          ?.toString?.()
          .replace(/^\/\^\\\//, '/')
          .replace(/\\\/\?\(\?=\\\/\|\$\)\/i$/, '') || '(router)';
      paths.push(`ROUTER ${base}`);
    }
  });

  console.log('ROUTES MOUNTED:', paths);
}

app.get('/__routes', (_req, res) => {
  try {
    if (!app || !app._router || !app._router.stack) {
      return res.json({ routes: [] });
    }

    const routes = [];

    for (const layer of app._router.stack) {
      if (layer?.route?.path) {
        routes.push({
          path: layer.route.path,
          methods: Object.keys(layer.route.methods).map((m) =>
            m.toUpperCase()
          ),
        });
      } else if (layer?.name === 'router' && layer?.handle?.stack) {
        for (const sub of layer.handle.stack) {
          if (sub?.route?.path) {
            routes.push({
              path: '(mounted) ' + sub.route.path,
              methods: Object.keys(sub.route.methods).map((m) =>
                m.toUpperCase()
              ),
            });
          }
        }
      }
    }

    res.json({ routes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Debug: whoami (JWT)
// ─────────────────────────────────────────────────────────────
app.get('/api/debug/whoami', (req, res) => {
  const h = req.headers?.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : null;

  let decoded = null;
  let verifyError = null;

  try {
    if (bearer) {
      decoded = jwt.verify(bearer, (process.env.JWT_SECRET || '').trim());
    }
  } catch (e) {
    verifyError = e?.message || String(e);
  }

  res.json({
    hasAuthHeader: !!h,
    bearerLen: bearer ? bearer.length : 0,
    verifyError, // if non-null, this tells you what's wrong
    decoded: decoded
      ? {
          sub: decoded.sub,
          email: decoded.email,
          iat: decoded.iat,
          exp: decoded.exp,
        }
      : null,
    reqUser: req.user ?? null, // what your middleware set
  });
});

// ✅ Simple logger self-test: writes one row into astro_api_call_log
app.get('/api/debug/log-test', async (_req, res) => {
  try {
    // 1) start log
    const id = await logApiCallStart({
      providerId: 'test-provider',
      providerName: 'IndexJS Log Test',
      featureId: 'debug-log',
      chatScopeId: null,
      audienceScope: null,
      endpoint: '/api/debug/log-test',
      method: 'GET',
      requestSource: 'index.js /api/debug/log-test',
      requestFor: 'self-test',
      requestLength: null,
      callChannel: 'backend', // your "backend" channel
      originTag: 'index-log-test',
    });

    // simulating work...
    await new Promise((r) => setTimeout(r, 200));

    // 2) end log
    await logApiCallEnd(id, {
      statusCode: 200,
      ok: true,
      errorText: null,
      responseLength: null,
    });

    res.json({ ok: true, id });
  } catch (e) {
    console.error('[LOG-TEST ERROR]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Promotions, subscriptions, points, astro chat, compat, tarot
// ─────────────────────────────────────────────────────────────

// Promotions
app.use('/api', promotionsRouter);

// Subscriptions
console.log('[BOOT] subscriptionsRouter typeof =', typeof subscriptionsRouter);
app.use('/api/subscription', subscriptionsRouter);

// Inline probe to prove base works even if import breaks
app.get('/api/subscription/ping-inline', (_req, res) =>
  res.json({ ok: true, scope: 'index.inline' })
);

// Points (non-admin)
app.use('/api', pointsRouter);

// AI Astrologer Chat
app.use('/api/astrochat', astroChatRoute);

// Compatibility
app.use('/api/v1/sun-compat', sunCompatRouter);

// Tarot
app.use('/api/tarot', tarotRoutes);

// Auspicious timings / astro helpers
app.use('/api/astro', auspiciousRouter);

// 🔐 all /api/admin/promotions routes = auth + admin only
app.use('/api/admin/promotions', requireAuth, requireAdmin, promotionsAdminRouter);

// Public pricing
app.use('/api', publicPricingRouter);

// API Manager (admin config for providers)
app.use('/api/admin', apiManagerRouter);

// ⭐ AI CONFIG ADMIN (moved AFTER express.json & JWT)
app.use('/api/admin', aiConfigAdminRouter);

// ─────────────────────────────────────────────────────────────
// Static assets: images + manifest
// ─────────────────────────────────────────────────────────────

// ⭐ 1) Serve everything inside /public at /static
// public/assets/images/planets/sun.png
//   →  GET /static/assets/images/planets/sun.png
app.use('/static', express.static(path.join(__dirname, 'public')));

// mount under /api 
//Topup 
app.use('/api/admin', adminPlansRouter);
app.use('/api', adminTopupsRouter);
app.use('/api/topups', topupsRouter);

// ⭐ 2) Manifest route (you already had this, just keep it here)
app.get('/assets/images/manifest', (_req, res) => {
  const manifestPath = path.join(
    __dirname,
    'public',
    'assets',
    'images-manifest.json'
  );

  if (!fs.existsSync(manifestPath)) {
    return res.status(404).json({ error: 'images-manifest.json not found' });
  }

  res.sendFile(manifestPath);
});

// Allow browser to access uploaded files
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// ─────────────────────────────────────────────────────────────
// Geo routes
// ─────────────────────────────────────────────────────────────
app.use('/api/geo', geoRouter);

// ─────────────────────────────────────────────────────────────
// Admin file uploads & promo chips management
// ─────────────────────────────────────────────────────────────
// Our upload API
app.use('/api/admin/files', filesRouter);
// Promotion chips management
app.use('/api/admin/chips', chipsAdminRouter);
// FreeAstro JSON proxy endpoints
app.use('/api/freeastro', freeAstroRouter);
// 👉 admin / manual trigger routes
app.use('/api/admin/freeastro', freeastroSchedulerRouter);
// ─────────────────────────────────────────────────────────────
app.use('/api/admin', adminApiJobsRouter);
// ─────────────────────────────────────────────────────────────
// Contact route
// ─────────────────────────────────────────────────────────────
app.use("/api", emailRouter);
app.use("/api/travel", travelFreeRouter);
// ─────────────────────────────────────────────────────────────
// Prewarmers (optional)
// ─────────────────────────────────────────────────────────────
const SIGNS = [
  'aries',
  'taurus',
  'gemini',
  'cancer',
  'leo',
  'virgo',
  'libra',
  'scorpio',
  'sagittarius',
  'capricorn',
  'aquarius',
  'pisces',
];

const TOPICS = [
  'general',
  'love',
  'career',
  'money',
  'health',
  'relationships',
  'numerology',
  'lucky_number',
  'lucky_color',
];

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'SohumAstroAI/1.0',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    throw new Error(`HTTP ${r.status} ${await r.text()}`);
  }

  return r.json();
}

async function prewarmtoday() {
  for (const sign of SIGNS) {
    for (const day of ['today', 'tomorrow']) {
      try {
        const url = `/api/horoscope/today?sign=${sign}&day=${day}`;
        await fetch(`http://localhost:${PORT}${url}`, {
          headers: { 'User-Agent': 'SohumAstroAI/1.0' },
        });
        console.log('prewarmed:', url);
      } catch (e) {
        console.log('prewarm failed:', sign, day, String(e));
      }
    }
  }
}

async function prewarmGenerictodayAndTomorrow() {
  const base = `http://localhost:${PORT}/api/horoscope/get`;

  for (const sign of SIGNS) {
    for (const system of ['vedic', 'western']) {
      for (const period of ['today', 'tomorrow']) {
        try {
          await postJSON(base, {
            audience: 'generic',
            sign,
            system,
            period,
            topics: TOPICS,
            lang: 'en',
            tone: 'concise',
          });
          console.log('prewarm/get ok:', sign, system, period);
        } catch (e) {
          console.error(
            'prewarm/get fail:',
            sign,
            system,
            period,
            e.message
          );
        }
      }
    }
  }
}

async function prewarmGenericWindowsIfDue() {
  const now = new Date();
  const day = now.getDay(); // 0 Sun..6 Sat
  const date = now.getDate();
  const month = now.getMonth(); // 0..11
  const base = `http://localhost:${PORT}/api/horoscope/get`;

  // Weekly (Monday after 00:10)
  if (
    day === 1 &&
    now.getHours() === 0 &&
    now.getMinutes() >= 10 &&
    now.getMinutes() < 60
  ) {
    for (const sign of SIGNS) {
      for (const system of ['vedic', 'western']) {
        try {
          await postJSON(base, {
            audience: 'generic',
            sign,
            system,
            period: 'weekly',
            topics: TOPICS,
            lang: 'en',
            tone: 'concise',
          });
        } catch (e) {
          console.error('prewarm weekly fail:', sign, system, e.message);
        }
      }
    }
  }

  // Monthly (1st of month, after 00:15)
  if (
    date === 1 &&
    now.getHours() === 0 &&
    now.getMinutes() >= 15 &&
    now.getMinutes() < 60
  ) {
    for (const sign of SIGNS) {
      for (const system of ['vedic', 'western']) {
        try {
          await postJSON(base, {
            audience: 'generic',
            sign,
            system,
            period: 'monthly',
            topics: TOPICS,
            lang: 'en',
            tone: 'concise',
          });
        } catch (e) {
          console.error('prewarm monthly fail:', sign, system, e.message);
        }
      }
    }
  }

  // Yearly (1 Jan, after 00:20)
  if (
    date === 1 &&
    month === 0 &&
    now.getHours() === 0 &&
    now.getMinutes() >= 20 &&
    now.getMinutes() < 60
  ) {
    for (const sign of SIGNS) {
      for (const system of ['vedic', 'western']) {
        try {
          await postJSON(base, {
            audience: 'generic',
            sign,
            system,
            period: 'yearly',
            topics: TOPICS,
            lang: 'detailed',
          });
        } catch (e) {
          console.error('prewarm yearly fail:', sign, system, e.message);
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`[BOOT] Listening on PORT=${PORT}`);
  printMounted(app);
});

server.on('listening', () => {
  try {
    printMounted(app);
  } catch {}
});

// ─────────────────────────────────────────────────────────────
// Enable prewarmers
// ─────────────────────────────────────────────────────────────
if (ENABLE_PREWARM) {
  prewarmtoday();
  prewarmGenerictodayAndTomorrow();
  prewarmGenericWindowsIfDue();

  setInterval(prewarmtoday, 8 * 60 * 60 * 1000);
  setInterval(prewarmGenerictodayAndTomorrow, 12 * 60 * 60 * 1000);
  setInterval(prewarmGenericWindowsIfDue, 60 * 60 * 1000);
}
