// ─────────────────────────────────────────────────────────────
// scripts/generate-assets-manifest.mjs
//
// Generate images-manifest.json from /public/assets
// • Includes images (png/jpg/svg/webp/gif)
// • Includes JSON files (lottie, config, data, etc.)
// • Produces a hash so client can detect changes dynamically
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// Resolve __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root of your API project
const ROOT = path.join(__dirname, '..');

// Folder that Express serves as:
//   app.use('/static', express.static(path.join(__dirname, 'public')));
// So we scan: /public/assets
const ASSETS_DIR = path.join(ROOT, 'public', 'assets');

// Output file: /public/assets/images-manifest.json
const MANIFEST_PATH = path.join(ASSETS_DIR, 'images-manifest.json');

// File extensions we want in the manifest
// (you can add more if needed: .mp3, .mp4 etc.)
const ALLOWED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.json'                 // 👈 include ALL JSON files as requested
]);

/**
 * Recursively walk a folder and collect relative file paths
 * under /public/assets. Returned paths are like:
 *   "images/planets/sun.png"
 *   "zodiac/sign/aries.png"
 *   "Data/planet-data.json"
 */
function walkAssets(dir, prefix = '') {
  const out = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      out.push(...walkAssets(absPath, relPath));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_EXT.has(ext)) {
        out.push(relPath);
      }
    }
  }

  return out;
}

/**
 * Build a stable hash from the file list.
 * • If you add/remove/rename any asset → hash will change
 * • Client can detect this and re-download everything once
 */
function buildHash(files) {
  const hash = crypto.createHash('md5');
  // Sort paths to get deterministic hash
  const sorted = [...files].sort();
  sorted.forEach(p => hash.update(p, 'utf8'));
  return hash.digest('hex');
}

function main() {
  console.log('🔍 Scanning assets in:', ASSETS_DIR);

  if (!fs.existsSync(ASSETS_DIR)) {
    console.error('❌ assets folder not found at', ASSETS_DIR);
    process.exit(1);
  }

  // Collect all image + JSON files
  const files = walkAssets(ASSETS_DIR);
  console.log(`📦 Found ${files.length} asset files for manifest.`);

  // Build hash
  const hash = buildHash(files);
  console.log('🔑 Manifest hash =', hash);

  const manifest = {
    hash,   // used by client (AssetCacheService) to detect changes
    files,  // relative paths under "assets/"
  };

  // Write images-manifest.json
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('✅ Manifest written to:', MANIFEST_PATH);
}

main();
