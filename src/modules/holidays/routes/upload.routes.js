const express = require("express");
const multer = require("multer");
const path = require("path");
const { authMiddleware: auth } = require("../../../core/middlewares/auth.middleware");
const imagekit = require("../../../services/imagekit.service");

const router = express.Router();

const fileFilter = (_req, file, cb) => {
  const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"];
  if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
  else cb(new Error("Only image files are allowed"));
};

// Memory storage so we can stream the buffer straight to ImageKit.
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
});

router.get("/status", auth, (_req, res) => {
  res.json({
    provider: "imagekit",
    configured: imagekit.configured(),
    folder: process.env.IMAGEKIT_FOLDER || "/indiaph/articles",
  });
});

// POST /api/upload/image  — single image → ImageKit CDN URL
router.post("/image", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const folder = req.body?.folder || undefined;
    const result = await imagekit.uploadImage(req.file, { folder });
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message || "Upload failed" });
  }
});

// POST /api/upload/images — multiple images (up to 10)
router.post("/images", auth, upload.array("files", 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }
    const folder = req.body?.folder || undefined;
    const urls = [];
    for (const file of req.files) {
      urls.push(await imagekit.uploadImage(file, { folder }));
    }
    res.json({ urls });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ message: err.message || "Upload failed" });
  }
});

router.use((err, _req, res, _next) => {
  res.status(400).json({ message: err.message || "Upload failed" });
});

module.exports = router;
