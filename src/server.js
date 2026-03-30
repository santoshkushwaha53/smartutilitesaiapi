require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path   = require("path");
const websiteSafetyRoutes = require("./routes/website-safety.routes");
const authRoutes     = require("./modules/holidays/routes/auth.routes");
const statesRoutes   = require("./modules/holidays/routes/states.routes");
const festivalsRoutes = require("./modules/holidays/routes/festivals.routes");
const holidaysRoutes = require("./modules/holidays/routes/holidays.routes");
const seoRoutes      = require("./modules/holidays/routes/seo.routes");
const blogRoutes     = require("./modules/blog/blog.routes");
const adminRoutes    = require("./modules/holidays/routes/admin.routes");
const uploadRoutes   = require("./modules/holidays/routes/upload.routes");
const importRoutes   = require("./modules/holidays/routes/import.routes");
const kidsRoutes     = require("./modules/holidays/routes/kids.routes");

const app = express();

const allowedOrigins = (
  process.env.CORS_ORIGIN ||
  "http://localhost:4200,http://localhost:8100,http://127.0.0.1:4200,http://127.0.0.1:8100"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(morgan("dev"));

app.get("/api/health", function (_req, res) {
  res.json({
    ok: true,
    service: "smartutilitiesai-api",
  });
});

app.use("/api/website-safety", websiteSafetyRoutes);

// India Public Holidays — Admin API
app.use("/api/auth",      authRoutes);
app.use("/api/states",    statesRoutes);
app.use("/api/festivals", festivalsRoutes);
app.use("/api/holidays",  holidaysRoutes);
app.use("/api/seo",       seoRoutes);
app.use("/api/blog",      blogRoutes);
app.use("/api/admin",     adminRoutes);
app.use("/api/upload",    uploadRoutes);
app.use("/api/import",    importRoutes);
app.use("/api/kids",      kidsRoutes);

app.use(function (err, _req, res, _next) {
  if (err && err.message && err.message.startsWith("CORS blocked")) {
    return res.status(403).json({
      message: err.message,
      allowedOrigins,
    });
  }

  return res.status(500).json({
    message: "Server error",
  });
});

const port = Number(process.env.PORT || 4000);

app.listen(port, function () {
  console.log(`API running on http://localhost:${port}`);
  console.log("Allowed origins:", allowedOrigins);
});