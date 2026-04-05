const express = require("express");
const dns = require("node:dns/promises");
const net = require("node:net");
const { Readable } = require("node:stream");

const router = express.Router();

const DIRECT_MEDIA_RE =
  /\.(mp4|webm|mov|m4v|mkv|mp3|wav|ogg|aac|m4a|flac)(\?|#|$)/i;

const BLOCKED_PLATFORM_HOSTS = [
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "facebook.com",
  "fb.watch",
  "vimeo.com",
  "tiktok.com",
];

function sanitizeFilename(name) {
  return String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function guessMimeFromPath(pathname) {
  const lower = pathname.toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".flac")) return "audio/flac";
  return "application/octet-stream";
}

function isBlockedPlatform(hostname) {
  const host = hostname.toLowerCase();
  return BLOCKED_PLATFORM_HOSTS.some(
    (blocked) => host === blocked || host.endsWith(`.${blocked}`)
  );
}

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;

    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;

    return false;
  }

  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80:")
    );
  }

  return false;
}

async function assertSafeTarget(targetUrl) {
  const hostname = targetUrl.hostname.toLowerCase();

  if (!/^https?:$/i.test(targetUrl.protocol)) {
    throw new Error("Only http/https URLs are allowed.");
  }

  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Local or internal addresses are not allowed.");
  }

  if (isBlockedPlatform(hostname)) {
    throw new Error(
      "Platform page links are preview-only and cannot be downloaded here."
    );
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Private network addresses are not allowed.");
    }
    return;
  }

  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!resolved.length) {
    throw new Error("Could not resolve the remote host.");
  }

  for (const item of resolved) {
    if (isPrivateIp(item.address)) {
      throw new Error("Private network addresses are not allowed.");
    }
  }
}

async function fetchWithSafeRedirects(url, init = {}, maxRedirects = 5) {
  let currentUrl = new URL(url);
  const requestInit = { ...init, redirect: "manual" };

  for (let i = 0; i <= maxRedirects; i += 1) {
    await assertSafeTarget(currentUrl);

    const response = await fetch(currentUrl, requestInit);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Redirect location is missing.");
      }

      currentUrl = new URL(location, currentUrl);
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  throw new Error("Too many redirects.");
}

function getFilename(targetUrl, requestedFilename, contentType) {
  if (requestedFilename) return sanitizeFilename(requestedFilename);

  const last = targetUrl.pathname.split("/").filter(Boolean).pop();
  if (last) return sanitizeFilename(decodeURIComponent(last));

  if (contentType?.startsWith("video/")) return "video-file.mp4";
  if (contentType?.startsWith("audio/")) return "audio-file.mp3";
  return "media-file";
}

router.get("/media/download", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "").trim();
    const requestedFilename = sanitizeFilename(
      String(req.query.filename || "").trim()
    );

    if (!rawUrl) {
      return res.status(400).json({ message: "Missing url query parameter." });
    }

    let targetUrl;
    try {
      targetUrl = new URL(rawUrl);
    } catch {
      return res.status(400).json({ message: "Invalid URL." });
    }

    if (!DIRECT_MEDIA_RE.test(targetUrl.href)) {
      return res.status(400).json({
        message:
          "This URL does not look like a direct audio or video file. Use a real media file URL like .mp4 or .mp3.",
      });
    }

    const { response: headResponse, finalUrl } = await fetchWithSafeRedirects(
      targetUrl.href,
      {
        method: "HEAD",
        headers: {
          "user-agent": "SmartUtilitiesAI/1.0",
        },
      }
    );

    const headContentType = (
      headResponse.headers.get("content-type") || ""
    ).toLowerCase();

    const looksLikeMedia =
      DIRECT_MEDIA_RE.test(finalUrl.href) ||
      headContentType.startsWith("video/") ||
      headContentType.startsWith("audio/");

    if (!looksLikeMedia) {
      return res.status(400).json({
        message:
          "The target does not look like a direct media file after inspection.",
      });
    }

    const { response: upstream, finalUrl: finalGetUrl } =
      await fetchWithSafeRedirects(finalUrl.href, {
        method: "GET",
        headers: {
          "user-agent": "SmartUtilitiesAI/1.0",
        },
      });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({
        message: `Upstream download failed with status ${upstream.status}.`,
      });
    }

    const contentType =
      upstream.headers.get("content-type") ||
      guessMimeFromPath(finalGetUrl.pathname);
    const contentLength = upstream.headers.get("content-length");
    const fileName = getFilename(finalGetUrl, requestedFilename, contentType);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Cache-Control", "no-store");

    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    console.error("GET /media/download failed:", error);

    const message =
      error instanceof Error
        ? error.message
        : "Server failed to download the media file.";

    res.status(500).json({ message });
  }
});

module.exports = router;