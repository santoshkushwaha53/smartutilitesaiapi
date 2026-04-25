require("dotenv").config();

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

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin) || isLocalAllowedOrigin(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

app.use(helmet());
app.use(cors(corsOptions));
app.options("/{*any}", cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

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
