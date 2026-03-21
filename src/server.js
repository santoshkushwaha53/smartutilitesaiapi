require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const websiteSafetyRoutes = require("./routes/website-safety.routes");

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
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/api/health", function (_req, res) {
  res.json({
    ok: true,
    service: "smartutilitiesai-api",
  });
});

app.use("/api/website-safety", websiteSafetyRoutes);

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