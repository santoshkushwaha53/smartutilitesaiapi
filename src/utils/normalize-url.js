function normalizeInputUrl(input) {
  const raw = String(input || "").trim();

  if (!raw) {
    throw new Error("Please enter a website URL.");
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch (err) {
    throw new Error("Please enter a valid website URL.");
  }

  if (!parsed.hostname) {
    throw new Error("Please enter a valid website URL.");
  }

  return parsed.toString();
}

function isPrivateOrLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local")
  ) {
    return true;
  }

  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;

  const m172 = host.match(/^172\.(\d{1,3})\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }

  return false;
}

function getHostRootLabel(hostname) {
  const host = String(hostname || "").toLowerCase();
  const parts = host.split(".").filter(Boolean);

  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }

  return parts[0] || host;
}

module.exports = {
  normalizeInputUrl,
  isPrivateOrLocalHost,
  getHostRootLabel,
};