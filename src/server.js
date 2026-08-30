require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const websiteSafetyRoutes = require("./routes/website-safety.routes");
const uploadTestRoute = require("./routes/network-upload-test.route");
const mediaDownloadRoute = require("./routes/media-download.route");
const authRoutes = require("./routes/auth.route");
const holidaysRoutes = require("./routes/holidays.route");
const statesRoutes = require("./routes/states.route");
const festivalsRoutes = require("./routes/festivals.route");
const wishesRoutes = require("./routes/wishes.route");
const importRoutes = require("./routes/import.route");
const currencyRoutes = require("./routes/currency.route");
const metalsRoutes = require("./routes/metals.routes");
const { startMetalsSyncScheduler } = require("./services/metals.service");
const nearbyRoutes = require("./routes/nearby.route");

// restored routes
const blogRoutes = require("./routes/blog.routes");
const seoRoutes = require("./routes/seo.routes");

// Admin CMS + holiday auto-ingestion (merged in from the `main` branch, which
// carries the admin panel backend that `production` never had)
const adminRoutes = require("./modules/holidays/routes/admin.routes");
const kidsRoutes = require("./modules/holidays/routes/kids.routes");
const uploadRoutes = require("./modules/holidays/routes/upload.routes");
const ingestionRoutes = require("./modules/holidays/routes/ingestion.routes");
const cron = require("node-cron");
const { runIngestion } = require("./modules/holidays/ingestion/run");

// Public developer API portal
const developerRoutes = require("./modules/developer-api/developer.routes");
const publicApiRoutes = require("./modules/developer-api/public-api.routes");
const { apiKeyAuth } = require("./modules/developer-api/api-key.middleware");

const app = express();

const allowedOrigins = (
  process.env.CORS_ORIGIN ||
  [
    "http://localhost:4200",
    "http://localhost:4201",
    "http://localhost:8100",
    "http://127.0.0.1:4200",
    "http://127.0.0.1:4201",
    "http://127.0.0.1:8100",
    "https://www.smartutilitiesai.com",
    "https://smartutilitiesai.com",
    "https://api.smartutilitiesai.com",
    "https://indiapublicholidays.com",
    "https://www.indiapublicholidays.com",
  ].join(",")
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function isLocalAllowedOrigin(origin) {
  if (!origin) return false;

  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

// Public developer API (/api/v1/*, /api/developer/*) is key-gated, not
// origin-gated — external developers call it from their own sites/servers,
// so it needs open CORS. Everything else keeps the fixed allowlist.
const PUBLIC_API_PREFIXES = ["/api/v1", "/api/developer"];

function isPublicApiPath(pathname) {
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function corsOptionsDelegate(req, callback) {
  if (isPublicApiPath(req.path)) {
    return callback(null, { origin: true, methods: ["GET", "POST"], allowedHeaders: ["Content-Type", "X-API-Key"] });
  }

  const origin = req.header("Origin");
  if (!origin || allowedOrigins.includes(origin) || isLocalAllowedOrigin(origin)) {
    return callback(null, { origin: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"], credentials: false });
  }

  return callback(new Error(`CORS blocked for origin: ${origin}`));
}

app.use(helmet());
app.use(cors(corsOptionsDelegate));
app.options("/{*any}", cors(corsOptionsDelegate));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use(uploadTestRoute);
app.use("/api", mediaDownloadRoute);
app.use("/api/website-safety", websiteSafetyRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/holidays", holidaysRoutes);
app.use("/api/states", statesRoutes);
app.use("/api/festivals", festivalsRoutes);
app.use("/api/wishes", wishesRoutes);
app.use("/api/import", importRoutes);
app.use("/api/currency", currencyRoutes);
app.use("/api/market/metals", metalsRoutes);
app.use("/api/travel", nearbyRoutes);

// restored mounts
app.use("/api/blog", blogRoutes);
app.use("/api/seo", seoRoutes);

// Admin CMS + holiday auto-ingestion
app.use("/api/admin", adminRoutes);
app.use("/api/kids", kidsRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/ingestion", ingestionRoutes);

// Public developer API portal — /api/developer/signup needs no key (that's
// how you get one); /api/v1/* requires the X-API-Key header.
app.use("/api/developer", developerRoutes);
app.use("/api/v1", apiKeyAuth, publicApiRoutes);

app.get("/api/health", function (_req, res) {
  res.json({
    ok: true,
    service: "smartutilitiesai-api",
  });
});

app.use(function (err, _req, res, _next) {
  if (err && err.message && err.message.startsWith("CORS blocked")) {
    return res.status(403).json({
      message: err.message,
      allowedOrigins,
    });
  }

  console.error(err);
  return res.status(500).json({
    message: "Server error",
  });
});

const port = Number(process.env.PORT || 4000);

// do not let metals sync crash the whole API
(async () => {
  try {
    await startMetalsSyncScheduler();
  } catch (error) {
    console.error("Metals scheduler failed to start:", error);
  }
})();

app.listen(port, function () {
  console.log(`API running on http://localhost:${port}`);
  console.log("Allowed origins:", allowedOrigins);
});

// Weekly auto-refresh of the holiday review queue — every Monday 03:00 IST.
// Approval still requires a human via /api/ingestion/queue/:id/approve, so a
// stale or misparsed source can never publish bad dates on its own.
if (process.env.HOLIDAY_INGESTION_CRON !== "off") {
  cron.schedule(
    "0 3 * * 1",
    function () {
      console.log("[holiday-ingestion] scheduled run starting...");
      runIngestion({ triggeredBy: "schedule" })
        .then((run) => console.log("[holiday-ingestion] scheduled run finished:", run.id, run.status))
        .catch((err) => console.error("[holiday-ingestion] scheduled run failed:", err.message));
    },
    { timezone: "Asia/Kolkata" }
  );
}
