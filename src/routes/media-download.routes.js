const express = require("express");
const { spawn, execFile } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const router = express.Router();

// Use local standalone binary in dev, fall back to PATH on production (Render)
const YT_DLP =
  process.env.YT_DLP_PATH ||
  (() => {
    const local = "/Users/santoshkushwaha/Library/Python/3.9/bin/yt-dlp-new";
    try {
      require("fs").accessSync(local);
      return local;
    } catch {
      return "yt-dlp"; // installed on PATH by render.yaml build command
    }
  })();

function isSupportedPlatformUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    return (
      h.includes("youtube.com") ||
      h === "youtu.be" ||
      h.includes("facebook.com") ||
      h.includes("fb.watch") ||
      h.includes("instagram.com") ||
      h.includes("vimeo.com") ||
      h.includes("twitter.com") ||
      h.includes("x.com") ||
      h.includes("tiktok.com")
    );
  } catch {
    return false;
  }
}

function isDirectMediaUrl(url) {
  return /\.(mp4|webm|mov|m4v|mkv|mp3|wav|ogg|aac|m4a|flac)(\?|#|$)/i.test(url);
}

function sanitizeFilename(name) {
  return name.replace(/[^\w\s.\-()]/g, "_").trim().substring(0, 200);
}

/**
 * GET /api/media/download
 * Query params:
 *   url      - the media URL
 *   filename - desired output filename (optional)
 *   format   - "audio" | "video" (default: video)
 */
router.get("/download", async (req, res) => {
  const url = (req.query.url || "").toString().trim();
  const format = (req.query.format || "video").toString().trim();
  const filenameHint = (req.query.filename || "").toString().trim();

  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  // --- Direct file proxy ---
  if (isDirectMediaUrl(url)) {
    try {
      const axios = require("axios");
      const upstream = await axios.get(url, {
        responseType: "stream",
        timeout: 30000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      const ct = upstream.headers["content-type"] || "application/octet-stream";
      const cl = upstream.headers["content-length"];
      const filename = filenameHint || path.basename(new URL(url).pathname) || "media-file";

      res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFilename(filename)}"`);
      res.setHeader("Content-Type", ct);
      if (cl) res.setHeader("Content-Length", cl);

      upstream.data.pipe(res);
      return;
    } catch (err) {
      return res.status(502).json({ error: "Failed to proxy direct file: " + err.message });
    }
  }

  // --- Platform URL via yt-dlp ---
  if (!isSupportedPlatformUrl(url)) {
    return res.status(400).json({ error: "Unsupported URL. Only YouTube, Facebook, Instagram, Vimeo, TikTok, and direct media file URLs are supported." });
  }

  // Build a temp output path
  const tmpDir = os.tmpdir();
  const tmpId = `ytdlp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputTemplate = path.join(tmpDir, `${tmpId}.%(ext)s`);

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=web_safari,default",
    "--output", outputTemplate,
  ];

  if (format === "audio") {
    // Download best audio-only track; no ffmpeg needed for m4a/webm audio
    args.push(
      "--format", "140/bestaudio[ext=m4a]/bestaudio",
    );
  } else {
    // Use combined video+audio streams (no ffmpeg/merge required).
    // Format 18 = 360p combined mp4 with audio — reliable and widely available.
    // Fall back to best single-file mp4 if 18 is unavailable.
    args.push(
      "--format", "18/best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best",
    );
  }

  // Get filename from yt-dlp first
  args.push(url);

  return new Promise((resolve) => {
    const proc = spawn(YT_DLP, args, { timeout: 180000 });

    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error("[yt-dlp] exit", code, stderr.slice(-500));

        // Clean up any partial files
        try {
          const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(tmpId));
          files.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
        } catch { }

        if (!res.headersSent) {
          res.status(502).json({
            error: "yt-dlp failed to download the media.",
            detail: stderr.slice(-400),
          });
        }
        return resolve();
      }

      // Find the downloaded file
      let downloadedFile = null;
      try {
        const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(tmpId));
        if (files.length > 0) {
          downloadedFile = path.join(tmpDir, files[0]);
        }
      } catch { }

      if (!downloadedFile || !fs.existsSync(downloadedFile)) {
        if (!res.headersSent) {
          res.status(502).json({ error: "yt-dlp finished but output file not found." });
        }
        return resolve();
      }

      const ext = path.extname(downloadedFile).replace(".", "") || (format === "audio" ? "m4a" : "mp4");
      const mimeMap = {
        mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
        mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg",
        aac: "audio/aac", wav: "audio/wav",
      };
      // For audio format requests rename .m4a to .mp3 for better browser compatibility
      const serveExt = (format === "audio" && ext === "m4a") ? "m4a" : ext;
      const contentType = mimeMap[serveExt] || "application/octet-stream";
      const outName = sanitizeFilename(filenameHint || `media.${serveExt}`);

      res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", fs.statSync(downloadedFile).size);

      const stream = fs.createReadStream(downloadedFile);
      stream.pipe(res);

      stream.on("close", () => {
        try { fs.unlinkSync(downloadedFile); } catch { }
        resolve();
      });

      stream.on("error", () => {
        try { fs.unlinkSync(downloadedFile); } catch { }
        if (!res.headersSent) res.status(500).end();
        resolve();
      });
    });

    proc.on("error", (err) => {
      console.error("[yt-dlp] spawn error", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "yt-dlp could not be started: " + err.message });
      }
      resolve();
    });
  });
});

/**
 * GET /api/media/info
 * Returns video title, formats, thumbnail etc. without downloading.
 */
router.get("/info", (req, res) => {
  const url = (req.query.url || "").toString().trim();
  if (!url) return res.status(400).json({ error: "url is required" });

  if (!isSupportedPlatformUrl(url)) {
    return res.status(400).json({ error: "Unsupported URL." });
  }

  const args = [
    "--dump-json",
    "--no-playlist",
    "--no-warnings",
    "--extractor-args", "youtube:player_client=web_safari,default",
    url,
  ];

  let stdout = "";
  let stderr = "";

  const proc = spawn(YT_DLP, args, { timeout: 30000 });
  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  proc.on("close", (code) => {
    if (code !== 0) {
      return res.status(502).json({ error: "Could not fetch media info.", detail: stderr.slice(-300) });
    }
    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title || "Unknown title",
        duration: info.duration,
        thumbnail: info.thumbnail,
        uploader: info.uploader,
        formats: (info.formats || []).map((f) => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: f.resolution,
          filesize: f.filesize,
          vcodec: f.vcodec,
          acodec: f.acodec,
          format_note: f.format_note,
        })),
      });
    } catch {
      res.status(502).json({ error: "Failed to parse media info." });
    }
  });

  proc.on("error", (err) => {
    res.status(500).json({ error: "yt-dlp could not be started: " + err.message });
  });
});

module.exports = router;
