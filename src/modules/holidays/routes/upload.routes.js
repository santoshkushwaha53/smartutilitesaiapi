const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const auth     = require('../../../middleware/auth.middleware');

const router = express.Router();

const UPLOAD_DIR = path.resolve(__dirname, '../../../uploads/festivals');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const safe = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    cb(null, `${safe}-${Date.now()}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'];
  if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
  else cb(new Error('Only image files are allowed'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB

// POST /api/upload/image  — single image
router.post('/image', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  const url = `/uploads/festivals/${req.file.filename}`;
  res.json({ url, filename: req.file.filename, originalName: req.file.originalname, size: req.file.size });
});

// POST /api/upload/images — multiple images (up to 10)
router.post('/images', auth, upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ message: 'No files uploaded' });
  const urls = req.files.map(f => ({ url: `/uploads/festivals/${f.filename}`, filename: f.filename, size: f.size }));
  res.json({ urls });
});

// Error handler for multer
router.use((err, _req, res, _next) => {
  res.status(400).json({ message: err.message || 'Upload failed' });
});

module.exports = router;
