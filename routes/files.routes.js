// routes/files.routes.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = express.Router();

/**
 * @typedef {'android-apk' | 'ios-ipa' | 'json-data' | 'image-asset'} UploadCategory
 */

/**
 * @param {UploadCategory} category
 */
function getFolderForCategory(category) {
  const root = process.cwd(); // your API project root
  switch (category) {
    case 'android-apk':
      return path.join(root, 'uploads', 'android-apk');
    case 'ios-ipa':
      return path.join(root, 'uploads', 'ios-ipa');
    case 'json-data':
      return path.join(root, 'uploads', 'json-data');
    case 'image-asset':
      return path.join(root, 'uploads', 'image-asset');
    default:
      throw new Error(`Unknown category: ${category}`);
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    /** @type {UploadCategory} */
    const category = req.query.category;

    if (!category) {
      return cb(new Error('Missing category query param'), '');
    }

    try {
      const folder = getFolderForCategory(category);
      fs.mkdirSync(folder, { recursive: true });
      cb(null, folder);
    } catch (err) {
      console.error('Error in destination():', err);
      cb(err, '');
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitized = file.originalname.replace(/\s+/g, '_');
    cb(null, `${timestamp}_${sanitized}`);
  },
});

const upload = multer({ storage });

router.post('/upload', upload.single('file'), (req, res) => {
  /** @type {UploadCategory} */
  const category = req.query.category;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const relativePath = path
    .relative(path.join(process.cwd(), 'uploads'), file.path)
    .replace(/\\/g, '/');

  const downloadUrl = `/uploads/${relativePath}`;

  return res.json({
    fileName: file.filename,
    fileSizeBytes: file.size,
    uploadedAt: new Date().toISOString(),
    downloadUrl,
    category,
  });
});

router.get('/current', (req, res) => {
  /** @type {UploadCategory} */
  const category = req.query.category;
  const folder = getFolderForCategory(category);

  try {
    if (!fs.existsSync(folder)) {
      return res.json(null);
    }

    const files = fs.readdirSync(folder);
    if (!files.length) {
      return res.json(null);
    }

    const withStats = files.map((name) => {
      const full = path.join(folder, name);
      const stat = fs.statSync(full);
      return { name, full, stat };
    });

    withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const latest = withStats[0];

    const relativePath = path
      .relative(path.join(process.cwd(), 'uploads'), latest.full)
      .replace(/\\/g, '/');

    const downloadUrl = `/uploads/${relativePath}`;

    res.json({
      fileName: latest.name,
      fileSizeBytes: latest.stat.size,
      uploadedAt: latest.stat.mtime.toISOString(),
      downloadUrl,
      category,
    });
  } catch (err) {
    console.error('Error in GET /current:', err);
    res.status(500).json({ message: 'Failed to read current file' });
  }
});

router.delete('/current', (req, res) => {
  /** @type {UploadCategory} */
  const category = req.query.category;
  const folder = getFolderForCategory(category);

  try {
    if (!fs.existsSync(folder)) {
      return res.status(200).json({});
    }

    const files = fs.readdirSync(folder);
    if (!files.length) {
      return res.status(200).json({});
    }

    const withStats = files.map((name) => {
      const full = path.join(folder, name);
      const stat = fs.statSync(full);
      return { name, full, stat };
    });

    withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const latest = withStats[0];

    fs.unlinkSync(latest.full);
    return res.status(200).json({});
  } catch (err) {
    console.error('Error in DELETE /current:', err);
    res.status(500).json({ message: 'Failed to delete file' });
  }
});

export default router;
