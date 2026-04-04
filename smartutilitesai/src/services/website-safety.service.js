const axios = require("axios");
const cheerio = require("cheerio");
const tls = require("tls");
const { parse } = require("tldts");
const {
  normalizeInputUrl,
  isPrivateOrLocalHost,
  getHostRootLabel,
} = require("../utils/normalize-url");

const USER_AGENT =
  "SmartUtilitiesAI Website Safety Checker/2.0 (+https://smartutilitiesai.com)";

const CACHE = new Map();

const SUSPICIOUS_HOST_TERMS = [
  "verify",
  "secure",
  "bonus",
  "gift",
  "free",
  "claim",
  "wallet",
  "support",
  "signin",
  "login",
  "update",
  "recover",
  "banking",
  "payment",
  "pay",
  "crypto",
];

const SUSPICIOUS_TEXT_PATTERNS = [
  { label: "Urgent pressure wording", regex: /\b(act now|urgent|immediately|within 24 hours|limited time)\b/i },
  { label: "Giveaway or reward bait", regex: /\b(free reward|claim now|gift card|bonus reward|lucky winner)\b/i },
  { label: "Suspicious account verification wording", regex: /\b(verify your account|confirm your wallet|unlock account|suspend(ed)? account)\b/i },
  { label: "Payment pressure wording", regex: /\b(pay now|instant payment|complete payment|confirm payment)\b/i },
  { label: "Aggressive download wording", regex: /\b(download now|start download|install now)\b/i },
  { label: "Crypto recovery or wallet bait", regex: /\b(wallet recovery|seed phrase|crypto support|recover funds)\b/i },
  { label: "Telegram/WhatsApp support bait", regex: /\b(telegram support|whatsapp support|contact on telegram)\b/i },
];

const KNOWN_CLEAN_HOSTS = [
  "google.com",
  "microsoft.com",
  "apple.com",
  "amazon.com",
  "paypal.com",
  "github.com",
  "openai.com",
  "vercel.com",
];

const COMMON_BRANDS = [
  "google",
  "microsoft",
  "apple",
  "paypal",
  "amazon",
  "netflix",
  "instagram",
  "facebook",
  "whatsapp",
  "telegram",
  "bank",
];

const SUSPICIOUS_TLDS = new Set(["zip", "mov", "click", "top", "gq", "tk", "work"]);

function getCache(key) {
  const item = CACHE.get(key);
  if (!item) return null;
  if (item.expiresAt < Date.now()) {
    CACHE.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value, ttlMs) {
  CACHE.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function daysBetween(dateStr) {
  if (!dateStr) return undefined;
  const ts = new Date(dateStr).getTime();
  if (Number.isNaN(ts)) return undefined;
  return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
}

function getRegistrableDomain(hostname) {
  const parsed = parse(hostname);
  return parsed.domain || String(hostname || "").replace(/^www\./i, "");
}

async function traceRedirects(startUrl, maxHops) {
  let currentUrl = startUrl;
  const chain = [currentUrl];
  let html = "";
  let status = 0;
  let lastHeaders = {};

  for (let i = 0; i <= maxHops; i += 1) {
    const res = await axios.get(currentUrl, {
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 15000,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    status = res.status;
    lastHeaders = Object.fromEntries(
      Object.entries(res.headers || {}).map(([k, v]) => [
        String(k).toLowerCase(),
        Array.isArray(v) ? v.join(", ") : String(v),
      ])
    );

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const locationHeader = res.headers.location;
      if (!locationHeader) break;

      const nextUrl = new URL(locationHeader, currentUrl).toString();

      if (chain.includes(nextUrl)) {
        chain.push(nextUrl);
        currentUrl = nextUrl;
        break;
      }

      chain.push(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    if (typeof res.data === "string") {
      html = res.data;
    }

    return {
      finalUrl: currentUrl,
      chain,
      html,
      headers: lastHeaders,
      status,
    };
  }

  return {
    finalUrl: currentUrl,
    chain,
    html,
    headers: lastHeaders,
    status,
  };
}

function analyzeHtml(html) {
  const $ = cheerio.load(html || "");
  const allText = $("body").text().replace(/\s+/g, " ").trim();
  const title = ($("title").first().text() || "").trim();
  const canonicalUrl = ($('link[rel="canonical"]').attr("href") || "").trim();
  const robotsMeta = ($('meta[name="robots"]').attr("content") || "").trim();

  const links = $("a")
    .map(function (_i, el) {
      const href = ($(el).attr("href") || "").trim().toLowerCase();
      const text = ($(el).text() || "").trim().toLowerCase();
      return {
        href,
        text,
        combined: `${text} ${href}`.trim(),
      };
    })
    .get();

  const privacyFound = links.some((l) => /privacy/.test(l.combined) || /privacy-policy/.test(l.href));
  const termsFound = links.some((l) => /\bterms\b|\bconditions\b/.test(l.combined) || /terms-of-service|terms-and-conditions/.test(l.href));
  const contactFound =
    links.some((l) => /contact|support|help|customer care|customer-care/.test(l.combined)) ||
    links.some((l) => /mailto:|tel:/.test(l.href)) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(allText) ||
    /\+?\d[\d\s\-()]{7,}/.test(allText);

  const refundFound = links.some((l) => /refund|returns|return-policy/.test(l.combined));
  const aboutFound = links.some((l) => /\babout\b|about-us/.test(l.combined));

  const hasLoginPrompt = /\b(sign in|log in|login|account access)\b/i.test(allText);
  const hasPaymentPrompt = /\b(checkout|pay now|payment|card details|billing)\b/i.test(allText);
  const hasDownloadPrompt = /\b(download|install app|installer|apk)\b/i.test(allText);

  const suspiciousTextFlags = SUSPICIOUS_TEXT_PATTERNS
    .filter((item) => item.regex.test(allText))
    .map((item) => item.label);

  return {
    title,
    canonicalUrl,
    robotsMeta,
    privacyFound,
    termsFound,
    contactFound,
    refundFound,
    aboutFound,
    hasLoginPrompt,
    hasPaymentPrompt,
    hasDownloadPrompt,
    suspiciousTextFlags,
  };
}

async function fetchHtml(url) {
  const cached = getCache(`html:${url}`);
  if (cached) return cached;

  try {
    const res = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 3,
      validateStatus: () => true,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const html =
      res.status >= 200 && res.status < 400 && typeof res.data === "string"
        ? res.data
        : "";

    setCache(`html:${url}`, html, 10 * 60 * 1000);
    return html;
  } catch (_err) {
    return "";
  }
}

function looksLikePrivacyPage(html) {
  const text = cheerio.load(html || "")("body").text().replace(/\s+/g, " ").toLowerCase();
  return /privacy policy|privacy notice|personal data|data collection|cookies/.test(text);
}

function looksLikeTermsPage(html) {
  const text = cheerio.load(html || "")("body").text().replace(/\s+/g, " ").toLowerCase();
  return /terms of service|terms and conditions|acceptable use|governing law/.test(text);
}

function looksLikeContactPage(html) {
  const text = cheerio.load(html || "")("body").text().replace(/\s+/g, " ").toLowerCase();
  return (
    /contact us|customer support|support|help center/.test(text) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text) ||
    /\+?\d[\d\s\-()]{7,}/.test(text)
  );
}

function extractContactsAndSocials(html, origin) {
  const $ = cheerio.load(html || "");
  const emails = new Set();
  const phones = new Set();
  const socialProfiles = new Set();

  $("a").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();

    if (/^mailto:/i.test(href)) {
      emails.add(href.replace(/^mailto:/i, "").trim());
    }

    if (/^tel:/i.test(href)) {
      phones.add(href.replace(/^tel:/i, "").trim());
    }

    try {
      const full = new URL(href, origin).toString();
      if (/facebook\.com|instagram\.com|x\.com|twitter\.com|linkedin\.com|youtube\.com|t\.me|telegram\.me/i.test(full)) {
        socialProfiles.add(full);
      }
    } catch {}
  });

  const bodyText = $("body").text().replace(/\s+/g, " ");
  const emailMatches = bodyText.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || [];
  const phoneMatches = bodyText.match(/\+?\d[\d\s\-()]{7,}/g) || [];

  emailMatches.slice(0, 5).forEach((item) => emails.add(item.trim()));
  phoneMatches.slice(0, 5).forEach((item) => phones.add(item.trim()));

  return {
    emails: Array.from(emails),
    phones: Array.from(phones),
    socialProfiles: Array.from(socialProfiles),
  };
}

function extractSecurityHeaders(headers) {
  return {
    contentSecurityPolicy: !!headers["content-security-policy"],
    xFrameOptions: !!headers["x-frame-options"],
    referrerPolicy: !!headers["referrer-policy"],
    permissionsPolicy: !!headers["permissions-policy"],
    xContentTypeOptions: !!headers["x-content-type-options"],
  };
}

async function fetchSitemapUrls(baseUrl) {
  const cacheKey = `sitemap:${new URL(baseUrl).origin}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const origin = new URL(baseUrl).origin;
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];

  for (const url of candidates) {
    try {
      const res = await axios.get(url, {
        timeout: 10000,
        validateStatus: () => true,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
        },
      });

      if (res.status >= 200 && res.status < 400 && typeof res.data === "string") {
        const xml = res.data;
        const matches = [...xml.matchAll(/<loc>(.*?)<\/loc>/gi)].map((m) => m[1].trim());
        setCache(cacheKey, matches, 30 * 60 * 1000);
        return matches;
      }
    } catch (_err) {}
  }

  setCache(cacheKey, [], 10 * 60 * 1000);
  return [];
}

async function probeCommonTrustPages(baseUrl) {
  const origin = new URL(baseUrl).origin;
  const notes = [];
  const matchedUrls = {};

  const result = {
    privacyFound: false,
    termsFound: false,
    contactFound: false,
    refundFound: false,
    aboutFound: false,
    matchedUrls,
    notes,
  };

  const candidates = {
    privacy: [
      "/privacy",
      "/privacy-policy",
      "/privacy-policy.html",
      "/legal/privacy",
      "/policies/privacy-policy",
    ],
    terms: [
      "/terms",
      "/terms-and-conditions",
      "/terms-of-service",
      "/legal/terms",
      "/policies/terms",
    ],
    contact: [
      "/contact",
      "/contact-us",
      "/support",
      "/help",
    ],
    refund: [
      "/refund",
      "/refund-policy",
      "/returns",
      "/returns-policy",
    ],
    about: [
      "/about",
      "/about-us",
      "/company",
    ],
  };

  async function fetchPage(url) {
    try {
      const res = await axios.get(url, {
        timeout: 10000,
        maxRedirects: 3,
        validateStatus: () => true,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      return {
        ok: res.status >= 200 && res.status < 400,
        status: res.status,
        html: typeof res.data === "string" ? res.data : "",
        finalUrl:
          res.request?.res?.responseUrl ||
          url,
      };
    } catch {
      return {
        ok: false,
        status: 0,
        html: "",
        finalUrl: url,
      };
    }
  }

  function pathLooksLike(type, url) {
    const path = new URL(url).pathname.toLowerCase();

    if (type === "privacy") {
      return /privacy|privacy-policy|legal\/privacy/.test(path);
    }

    if (type === "terms") {
      return /terms|terms-of-service|terms-and-conditions|legal\/terms/.test(path);
    }

    if (type === "contact") {
      return /contact|contact-us|support|help/.test(path);
    }

    if (type === "refund") {
      return /refund|returns|return-policy/.test(path);
    }

    if (type === "about") {
      return /about|about-us|company/.test(path);
    }

    return false;
  }

  function contentLooksLike(type, html) {
    if (!html) return false;

    if (type === "privacy") return looksLikePrivacyPage(html);
    if (type === "terms") return looksLikeTermsPage(html);
    if (type === "contact") return looksLikeContactPage(html);
    if (type === "refund") return /refund|returns|return policy/i.test(html);
    if (type === "about") return /about us|our story|company/i.test(html);

    return false;
  }

  async function validateGroup(type, paths, resultKey, matchedKey, noteLabel) {
    for (const path of paths) {
      const url = `${origin}${path}`;
      const page = await fetchPage(url);

      if (!page.ok) continue;

      const matchedByPath = pathLooksLike(type, page.finalUrl);
      const matchedByContent = contentLooksLike(type, page.html);

      if (matchedByPath || matchedByContent) {
        result[resultKey] = true;
        matchedUrls[matchedKey] = page.finalUrl;

        if (matchedByContent) {
          notes.push(`${noteLabel} probe matched by content: ${page.finalUrl}`);
        } else {
          notes.push(`${noteLabel} probe matched by valid route: ${page.finalUrl}`);
        }
        break;
      }
    }
  }

  await validateGroup("privacy", candidates.privacy, "privacyFound", "privacyUrl", "Privacy page");
  await validateGroup("terms", candidates.terms, "termsFound", "termsUrl", "Terms page");
  await validateGroup("contact", candidates.contact, "contactFound", "contactUrl", "Contact/support page");
  await validateGroup("refund", candidates.refund, "refundFound", "refundUrl", "Refund/returns page");
  await validateGroup("about", candidates.about, "aboutFound", "aboutUrl", "About page");

  const sitemapUrls = await fetchSitemapUrls(baseUrl);

  if (sitemapUrls.length) {
    if (!result.privacyFound) {
      const hit = sitemapUrls.find((u) => /privacy|privacy-policy/i.test(u));
      if (hit) {
        result.privacyFound = true;
        matchedUrls.privacyUrl = hit;
        notes.push("Privacy page detected from sitemap.xml.");
      }
    }

    if (!result.termsFound) {
      const hit = sitemapUrls.find((u) => /terms|terms-of-service|terms-and-conditions|conditions/i.test(u));
      if (hit) {
        result.termsFound = true;
        matchedUrls.termsUrl = hit;
        notes.push("Terms page detected from sitemap.xml.");
      }
    }

    if (!result.contactFound) {
      const hit = sitemapUrls.find((u) => /contact|contact-us|support|help/i.test(u));
      if (hit) {
        result.contactFound = true;
        matchedUrls.contactUrl = hit;
        notes.push("Contact/support page detected from sitemap.xml.");
      }
    }

    if (!result.aboutFound) {
      const hit = sitemapUrls.find((u) => /about|about-us/i.test(u));
      if (hit) {
        result.aboutFound = true;
        matchedUrls.aboutUrl = hit;
        notes.push("About page detected from sitemap.xml.");
      }
    }
  }

  return result;
}

async function discoverTrustPages(baseUrl, homepageHtml) {
  const origin = new URL(baseUrl).origin;
  const $ = cheerio.load(homepageHtml || "");
  const candidates = new Set();

  $("a").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href) return;

    try {
      const full = new URL(href, origin).toString();
      if (full.startsWith(origin)) candidates.add(full);
    } catch {}
  });

  const sitemapUrls = await fetchSitemapUrls(baseUrl);
  sitemapUrls.forEach((u) => {
    try {
      if (u.startsWith(origin)) candidates.add(u);
    } catch {}
  });

  const prioritized = Array.from(candidates)
  .sort((a, b) => {
    const score = (u) =>
      /privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|legal|contact|contact-us|support|help|about|policy|cookies|disclaimer/i.test(u)
        ? 1
        : 0;
    return score(b) - score(a);
  })
  .slice(0, 20);

  const result = {
    privacyFound: false,
    termsFound: false,
    contactFound: false,
    refundFound: false,
    aboutFound: false,
    matchedUrls: {},
    notes: [],
  };

  for (const url of prioritized) {
    const html = await fetchHtml(url);
    if (!html) continue;

    if (!result.privacyFound && looksLikePrivacyPage(html)) {
      result.privacyFound = true;
      result.matchedUrls.privacyUrl = url;
      result.notes.push(`Privacy page content matched: ${url}`);
    }

    if (!result.termsFound && looksLikeTermsPage(html)) {
      result.termsFound = true;
      result.matchedUrls.termsUrl = url;
      result.notes.push(`Terms page content matched: ${url}`);
    }

    if (!result.contactFound && looksLikeContactPage(html)) {
      result.contactFound = true;
      result.matchedUrls.contactUrl = url;
      result.notes.push(`Contact/support page content matched: ${url}`);
    }

    if (!result.aboutFound && /about us|our story|company/i.test(html)) {
      result.aboutFound = true;
      result.matchedUrls.aboutUrl = url;
      result.notes.push(`About page content matched: ${url}`);
    }

    if (!result.refundFound && /refund|returns|return policy/i.test(html)) {
      result.refundFound = true;
      result.matchedUrls.refundUrl = url;
      result.notes.push(`Refund/returns page content matched: ${url}`);
    }
  }

  return result;
}

function extractRdapEvent(events, wanted) {
  if (!Array.isArray(events)) return undefined;

  const match = events.find((e) => {
    return String((e && e.eventAction) || "").toLowerCase() === String(wanted).toLowerCase();
  });

  return match && match.eventDate ? match.eventDate : undefined;
}

async function lookupDomainInfo(hostname) {
  const cacheKey = `rdap:${hostname}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const notes = [];
  const tld = hostname.split(".").pop();
  const rdapBases = [
    process.env.RDAP_BASE_URL,
    "https://rdap.org/domain/",
    tld === "com" ? "https://rdap.verisign.com/com/v1/domain/" : null,
    tld === "net" ? "https://rdap.verisign.com/net/v1/domain/" : null,
  ].filter(Boolean);

  for (const base of rdapBases) {
    try {
      const url = base + encodeURIComponent(hostname);

      const res = await axios.get(url, {
        timeout: 12000,
        validateStatus: () => true,
        headers: {
          Accept: "application/rdap+json, application/json;q=0.9,*/*;q=0.8",
          "User-Agent": USER_AGENT,
        },
      });

      if (res.status < 200 || res.status >= 300 || !res.data) {
        continue;
      }

      const data = res.data;

      const createdAt =
        extractRdapEvent(data.events, "registration") ||
        extractRdapEvent(data.events, "created");

      const updatedAt =
        extractRdapEvent(data.events, "last changed") ||
        extractRdapEvent(data.events, "last update of RDAP database");

      const expiresAt =
        extractRdapEvent(data.events, "expiration") ||
        extractRdapEvent(data.events, "expiry");

      let registrar = "";

      if (Array.isArray(data.entities)) {
        const registrarEntity = data.entities.find((e) => Array.isArray(e.roles) && e.roles.includes("registrar"));
        if (registrarEntity && Array.isArray(registrarEntity.vcardArray) && Array.isArray(registrarEntity.vcardArray[1])) {
          const fnRow = registrarEntity.vcardArray[1].find((v) => Array.isArray(v) && v[0] === "fn");
          registrar = fnRow && fnRow[3] ? fnRow[3] : "";
        }
      }

      const ageDays = daysBetween(createdAt);
      if (ageDays !== undefined) notes.push(`Domain appears to be about ${ageDays} day(s) old.`);
      if (expiresAt) notes.push("Domain expiry information is available.");
      if (registrar) notes.push("Registrar information is available.");
      notes.push(`RDAP source used: ${base}`);

      const result = {
        ageDays,
        createdAt,
        updatedAt,
        expiresAt,
        registrar,
        notes,
      };

      setCache(cacheKey, result, 24 * 60 * 60 * 1000);
      return result;
    } catch (_err) {}
  }

  const fallback = {
    notes: ["Domain registration lookup failed or was blocked."],
  };

  setCache(cacheKey, fallback, 60 * 60 * 1000);
  return fallback;
}

async function getTlsCertificateInfo(hostname) {
  const cacheKey = `tls:${hostname}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const result = await new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: hostname,
        port: 443,
        servername: hostname,
        rejectUnauthorized: false,
        timeout: 8000,
      },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !Object.keys(cert).length) {
          socket.end();
          return resolve({ notes: ["TLS certificate details were not available."] });
        }

    const validFrom = cert.valid_from ? new Date(cert.valid_from).toISOString() : undefined;
    const validTo = cert.valid_to ? new Date(cert.valid_to).toISOString() : undefined;

    let daysRemaining;
    if (validTo) {
      const expiryTs = new Date(validTo).getTime();
      if (!Number.isNaN(expiryTs)) {
        daysRemaining = Math.max(0, Math.ceil((expiryTs - Date.now()) / 86400000));
      }
    }
        socket.end();
        return resolve({
          issuer: cert.issuer && cert.issuer.O ? cert.issuer.O : undefined,
          validFrom,
          validTo,
          daysRemaining,
          notes: ["TLS certificate details were retrieved."],
        });
      }
    );

    socket.on("error", () => resolve({ notes: ["TLS certificate lookup failed."] }));
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ notes: ["TLS certificate lookup timed out."] });
    });
  });

  setCache(cacheKey, result, 6 * 60 * 60 * 1000);
  return result;
}

function getBrandMatchFromTitle(title) {
  const lowerTitle = String(title || "").toLowerCase();
  return COMMON_BRANDS.find((brand) => lowerTitle.includes(brand));
}

function analyzeBrandConsistency(hostname, title) {
  const notes = [];
  const root = getHostRootLabel(hostname);
  const lowerTitle = String(title || "").toLowerCase();
  const hyphenCount = (hostname.match(/-/g) || []).length;
  const hasPunycode = hostname.includes("xn--");
  const matchedBrand = getBrandMatchFromTitle(title);

  const suspiciousLookalike = !!(
    hasPunycode ||
    hyphenCount >= 3 ||
    (matchedBrand && !hostname.includes(matchedBrand))
  );

  const titleDomainMismatch =
    !!lowerTitle &&
    !!matchedBrand &&
    !hostname.includes(matchedBrand) &&
    !lowerTitle.includes(root);

  if (hasPunycode) notes.push("Domain uses punycode characters, which deserves extra caution.");
  if (hyphenCount >= 3) notes.push("Domain contains many hyphens, which can be a scam signal.");
  if (titleDomainMismatch) notes.push("Page title suggests a brand that does not clearly match the domain.");
  if (!notes.length) notes.push("No strong brand mismatch signal was found.");

  return {
    suspiciousLookalike,
    titleDomainMismatch,
    notes,
  };
}

function analyzeReputation(hostname, suspiciousFlags, ageDays) {
  const notes = [];
  const lowerHost = String(hostname || "").toLowerCase();
  const tld = lowerHost.split(".").pop() || "";

  if (KNOWN_CLEAN_HOSTS.some((item) => lowerHost === item || lowerHost.endsWith("." + item))) {
    notes.push("This domain matches a widely recognized host in the internal clean list.");
    return { status: "clean", provider: "Internal heuristic fallback", notes };
  }

  if (
    suspiciousFlags.length >= 4 ||
    suspiciousFlags.some((flag) => /wallet|gift|telegram|whatsapp/i.test(flag))
  ) {
    notes.push("Multiple suspicious content signals were found.");
    return { status: "malicious", provider: "Internal heuristic fallback", notes };
  }

  if ((ageDays !== undefined && ageDays < 45) || SUSPICIOUS_TLDS.has(tld)) {
    notes.push("Domain freshness or TLD choice increases caution.");
    return { status: "suspicious", provider: "Internal heuristic fallback", notes };
  }

  notes.push("No external reputation provider is configured, so this result is limited.");
  return { status: "unknown", provider: "Internal heuristic fallback", notes };
}

function createSummary(verdict, trustSignals, warningSignals) {
  if (verdict === "looks-trustworthy") {
    return `This website shows more positive trust signals than warning signs. ${
      warningSignals.length ? "A few caution points still exist." : "No major warning signs were found in this scan."
    }`;
  }
  if (verdict === "use-caution") {
    return "This website shows mixed trust signals. It may be fine for browsing, but extra care is wise before payments, downloads, or logins.";
  }
  if (verdict === "suspicious") {
    return "This website shows several warning signs. You should be cautious before entering personal details, signing in, or making payments.";
  }
  return "This website shows strong risk indicators. It should be treated carefully, especially for payments, downloads, or account access.";
}

function createBeginnerExplanation(verdict, hostname, trustSignals, warningSignals) {
  const topGood = trustSignals.slice(0, 3).join(", ");
  const topBad = warningSignals.slice(0, 3).join(", ");

  if (verdict === "looks-trustworthy") {
    return `The website ${hostname} looks relatively trustworthy in this scan because it shows helpful trust signals such as ${
      topGood || "HTTPS and stable site behavior"
    }. This does not guarantee safety, so still verify before making payments or downloading files.`;
  }
  if (verdict === "use-caution") {
    return `The website ${hostname} shows mixed trust signals. Some positive signs were found, but caution is still wise because of ${
      topBad || "a few missing or weak trust signals"
    }.`;
  }
  if (verdict === "suspicious") {
    return `The website ${hostname} appears suspicious because the scan found warning signs such as ${
      topBad || "multiple trust issues"
    }. Avoid rushing into payments, downloads, or login actions.`;
  }
  return `The website ${hostname} appears high risk in this scan because it shows several strong warning signs such as ${
    topBad || "multiple serious trust issues"
  }. It is safer to avoid payments, downloads, and account access here.`;
}

function getRecommendedActions(params) {
  const actions = [];

  if (params.score < 50) {
    actions.push("Avoid making payments on this website.");
    actions.push("Do not sign in with your main email or password.");
  }

  if (params.hasDownloadPrompt && params.score < 65) {
    actions.push("Avoid downloading files from this website unless you can verify it independently.");
  }

  if (params.hasPaymentPrompt && params.score < 75) {
    actions.push("Verify the brand and domain manually before entering card details.");
  }

  if (params.titleDomainMismatch) {
    actions.push("Search for the official brand website manually instead of trusting this link directly.");
  }

  if (params.ageDays !== undefined && params.ageDays < 60) {
    actions.push("Use extra caution because the domain appears very new.");
  }

  if (!params.contactFound) {
    actions.push("Be careful because clear contact or support details were not found.");
  }

  if (!actions.length) {
    actions.push("The site shows healthy trust signals, but always verify before payment, login, or download.");
  }

  return Array.from(new Set(actions));
}

async function scanWebsiteSafety(inputUrl) {
  const startedAt = Date.now();

  const normalizedUrl = normalizeInputUrl(inputUrl);
  const hostname = new URL(normalizedUrl).hostname.toLowerCase();

  if (isPrivateOrLocalHost(hostname)) {
    throw new Error("Local or private network addresses are not allowed for this tool.");
  }

  const trace = await traceRedirects(normalizedUrl, 5);
  const finalUrl = trace.finalUrl;
  const finalHostname = new URL(finalUrl).hostname.toLowerCase();
  const registrableDomain = getRegistrableDomain(finalHostname);

  const htmlInfo = analyzeHtml(trace.html);
  const probedPages = await probeCommonTrustPages(finalUrl);
  const crawledPages = await discoverTrustPages(finalUrl, trace.html);

  htmlInfo.privacyFound = htmlInfo.privacyFound || probedPages.privacyFound || crawledPages.privacyFound;
  htmlInfo.termsFound = htmlInfo.termsFound || probedPages.termsFound || crawledPages.termsFound;
  htmlInfo.contactFound = htmlInfo.contactFound || probedPages.contactFound || crawledPages.contactFound;
  htmlInfo.refundFound = htmlInfo.refundFound || probedPages.refundFound || crawledPages.refundFound;
  htmlInfo.aboutFound = htmlInfo.aboutFound || probedPages.aboutFound || crawledPages.aboutFound;

  const matchedUrls = {
    ...(probedPages.matchedUrls || {}),
    ...(crawledPages.matchedUrls || {}),
  };

  const domainInfo = await lookupDomainInfo(registrableDomain);
  const brandInfo = analyzeBrandConsistency(finalHostname, htmlInfo.title);
  const tlsCertificate = await getTlsCertificateInfo(finalHostname);

  const suspiciousHostFlags = SUSPICIOUS_HOST_TERMS
    .filter((term) => finalHostname.includes(term))
    .map((term) => `Suspicious domain wording: "${term}"`);

  const suspiciousFlags = []
    .concat(htmlInfo.suspiciousTextFlags)
    .concat(suspiciousHostFlags);

  const reputationInfo = analyzeReputation(registrableDomain, suspiciousFlags, domainInfo.ageDays);

  const enteredHost = new URL(normalizedUrl).hostname.toLowerCase();
  const finalHostChanged =
    enteredHost !== finalHostname &&
    !finalHostname.endsWith("." + enteredHost) &&
    !enteredHost.endsWith("." + finalHostname);

  const protocol = finalUrl.startsWith("https://") ? "https" : "http";
  const hstsPresent = !!trace.headers["strict-transport-security"];

  const httpsNotes = [];
  let httpsImpact = 0;

  if (protocol === "https") {
    httpsImpact += 10;
    httpsNotes.push("Website uses HTTPS.");
    if (hstsPresent) {
      httpsImpact += 2;
      httpsNotes.push("Strict-Transport-Security header is present.");
    }
  } else {
    httpsImpact -= 20;
    httpsNotes.push("Website does not use HTTPS.");
  }

  const redirectNotes = [];
  let redirectImpact = 0;
  const hopCount = Math.max(0, trace.chain.length - 1);
  let redirectSuspicious = false;

  if (hopCount === 0) {
    redirectImpact += 4;
    redirectNotes.push("No redirect hop was needed.");
  } else if (hopCount <= 2) {
    redirectNotes.push(`Website redirected ${hopCount} time(s), which is still fairly normal.`);
  } else if (hopCount <= 3) {
    redirectImpact -= 4;
    redirectSuspicious = true;
    redirectNotes.push(`Website redirected ${hopCount} time(s), which deserves caution.`);
  } else {
    redirectImpact -= 10;
    redirectSuspicious = true;
    redirectNotes.push(`Website redirected ${hopCount} time(s), which is unusually high.`);
  }

  if (finalHostChanged) {
    redirectImpact -= 8;
    redirectSuspicious = true;
    redirectNotes.push("Final destination domain differs from the originally entered domain.");
  }

  const domainNotes = []
    .concat(domainInfo.notes || [])
    .concat([`Domain lookup used registrable domain: ${registrableDomain}`]);

  let domainImpact = 0;

  if (domainInfo.ageDays !== undefined) {
    if (domainInfo.ageDays < 30) {
      domainImpact -= 18;
      domainNotes.push("Very new domains deserve extra caution.");
    } else if (domainInfo.ageDays < 180) {
      domainImpact -= 8;
      domainNotes.push("This is still a fairly new domain.");
    } else if (domainInfo.ageDays > 730) {
      domainImpact += 12;
      domainNotes.push("Older domain age is a positive trust signal.");
    } else if (domainInfo.ageDays > 365) {
      domainImpact += 6;
      domainNotes.push("Domain age is reasonably established.");
    }
  }

  const policyNotes = []
    .concat(probedPages.notes || [])
    .concat(crawledPages.notes || []);

  let policyImpact = 0;

  if (htmlInfo.privacyFound) {
    policyImpact += 4;
    policyNotes.push("Privacy page appears to be present.");
  } else {
    policyNotes.push("Privacy page was not clearly found.");
  }

  if (htmlInfo.termsFound) {
    policyImpact += 4;
    policyNotes.push("Terms or conditions page appears to be present.");
  } else {
    policyNotes.push("Terms or conditions page was not clearly found.");
  }

  if (htmlInfo.contactFound) {
    policyImpact += 4;
    policyNotes.push("Contact or support information appears to be present.");
  } else {
    policyNotes.push("Contact or support details were not clearly found.");
  }

  if (htmlInfo.refundFound) {
    policyImpact += 2;
    policyNotes.push("Refund or returns information appears to be present.");
  }

  if (htmlInfo.aboutFound) {
    policyImpact += 1;
    policyNotes.push("About page appears to be present.");
  }

  if (!htmlInfo.privacyFound && !htmlInfo.termsFound && !htmlInfo.contactFound) {
    policyImpact -= 12;
    policyNotes.push("Important trust pages appear to be missing.");
  }

  if ((htmlInfo.hasPaymentPrompt || htmlInfo.hasLoginPrompt) && !htmlInfo.contactFound) {
    policyImpact -= 6;
    policyNotes.push("The site prompts for sensitive actions without strong support/contact signals.");
  }

  const suspiciousNotes = [];
  let suspiciousImpact = 0;

  if (suspiciousFlags.length) {
    suspiciousImpact -= Math.min(20, suspiciousFlags.length * 4);
    suspiciousNotes.push(`${suspiciousFlags.length} suspicious signal(s) were detected.`);
    suspiciousNotes.push(...suspiciousFlags);
  } else {
    suspiciousNotes.push("No strong suspicious text patterns were found.");
  }

  if (htmlInfo.hasDownloadPrompt && suspiciousFlags.length) {
    suspiciousImpact -= 4;
    suspiciousNotes.push("Download prompt combined with suspicious wording increases caution.");
  }

  const brandNotes = [].concat(brandInfo.notes || []);
  let brandImpact = 0;

  if (brandInfo.suspiciousLookalike) brandImpact -= 10;
  if (brandInfo.titleDomainMismatch) brandImpact -= 8;
  if (!brandInfo.suspiciousLookalike && !brandInfo.titleDomainMismatch) brandImpact += 3;

  const securityHeaders = extractSecurityHeaders(trace.headers);
  const technicalNotes = [];
  let technicalImpact = 0;

  if (securityHeaders.contentSecurityPolicy) technicalImpact += 2;
  if (securityHeaders.xFrameOptions) technicalImpact += 1;
  if (securityHeaders.referrerPolicy) technicalImpact += 1;
  if (securityHeaders.permissionsPolicy) technicalImpact += 1;
  if (securityHeaders.xContentTypeOptions) technicalImpact += 1;

  if (htmlInfo.robotsMeta) {
    technicalNotes.push(`Robots meta found: ${htmlInfo.robotsMeta}`);
    if (/noindex/i.test(htmlInfo.robotsMeta)) {
      technicalImpact -= 2;
      technicalNotes.push("Page is marked noindex.");
    }
  }

  if (htmlInfo.canonicalUrl) {
    technicalNotes.push(`Canonical URL found: ${htmlInfo.canonicalUrl}`);
  }

  if (await fetchSitemapUrls(finalUrl).then((items) => items.length > 0)) {
    technicalNotes.push("Sitemap was found.");
  } else {
    technicalNotes.push("Sitemap was not found.");
  }

  const reputationNotes = [].concat(reputationInfo.notes || []);
  let reputationImpact = 0;

  if (reputationInfo.status === "clean") reputationImpact += 8;
  if (reputationInfo.status === "suspicious") reputationImpact -= 8;
  if (reputationInfo.status === "malicious") reputationImpact -= 20;

  const rawScore = clampScore(
    50 +
      httpsImpact +
      domainImpact +
      redirectImpact +
      policyImpact +
      suspiciousImpact +
      brandImpact +
      reputationImpact +
      technicalImpact
  );

  const score = Math.min(rawScore, 96);

  let verdict = "use-caution";
  if (score >= 75) verdict = "looks-trustworthy";
  else if (score >= 50) verdict = "use-caution";
  else if (score >= 25) verdict = "suspicious";
  else verdict = "high-risk";

  const trustSignals = [];
  const warningSignals = [];

  if (protocol === "https") trustSignals.push("Uses HTTPS");
  else warningSignals.push("Does not use HTTPS");

  if (hstsPresent) trustSignals.push("HSTS header present");

  if (domainInfo.ageDays !== undefined && domainInfo.ageDays > 365) {
    trustSignals.push("Domain is older than one year");
  } else if (domainInfo.ageDays !== undefined && domainInfo.ageDays < 60) {
    warningSignals.push("Domain appears very new");
  }

  if (hopCount === 0) trustSignals.push("No redirect chain");
  if (hopCount >= 3) warningSignals.push("Multiple redirects detected");
  if (finalHostChanged) warningSignals.push("Final destination differs from entered domain");

  if (htmlInfo.privacyFound) trustSignals.push("Privacy page detected");
  else warningSignals.push("Privacy page not clearly found");

  if (htmlInfo.termsFound) trustSignals.push("Terms page detected");
  else warningSignals.push("Terms page not clearly found");

  if (htmlInfo.contactFound) trustSignals.push("Contact/support signals found");
  else warningSignals.push("Contact/support details not clearly found");

  if (brandInfo.suspiciousLookalike) warningSignals.push("Possible lookalike domain signal");
  if (brandInfo.titleDomainMismatch) warningSignals.push("Possible title/domain mismatch");

  if (suspiciousFlags.length) suspiciousFlags.slice(0, 5).forEach((flag) => warningSignals.push(flag));

  if (reputationInfo.status === "clean") trustSignals.push("Internal clean host match");
  if (reputationInfo.status === "suspicious") warningSignals.push("Reputation clues suggest caution");
  if (reputationInfo.status === "malicious") warningSignals.push("Reputation clues suggest strong risk");

  const uniqueTrustSignals = Array.from(new Set(trustSignals));
  const uniqueWarningSignals = Array.from(new Set(warningSignals));

  const contacts = extractContactsAndSocials(trace.html, new URL(finalUrl).origin);
  const contactNotes = [];
  if (contacts.emails.length) contactNotes.push(`Found ${contacts.emails.length} email address(es).`);
  if (contacts.phones.length) contactNotes.push(`Found ${contacts.phones.length} phone number(s).`);
  if (contacts.socialProfiles.length) contactNotes.push(`Found ${contacts.socialProfiles.length} social profile link(s).`);
  if (!contactNotes.length) contactNotes.push("No direct contact or social profile details were extracted from the homepage HTML.");

  const summary = createSummary(verdict, uniqueTrustSignals, uniqueWarningSignals);
  const beginnerExplanation = createBeginnerExplanation(
    verdict,
    finalHostname,
    uniqueTrustSignals,
    uniqueWarningSignals
  );

  const recommendedActions = getRecommendedActions({
    score,
    ageDays: domainInfo.ageDays,
    hasLoginPrompt: htmlInfo.hasLoginPrompt,
    hasPaymentPrompt: htmlInfo.hasPaymentPrompt,
    hasDownloadPrompt: htmlInfo.hasDownloadPrompt,
    titleDomainMismatch: brandInfo.titleDomainMismatch,
    contactFound: htmlInfo.contactFound,
  });

  return {
    inputUrl,
    normalizedUrl,
    hostname,
    registrableDomain,
    finalUrl,
    siteTitle: htmlInfo.title,
    scannedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - startedAt,

    score,
    verdict,
    summary,

    trustSignals: uniqueTrustSignals,
    warningSignals: uniqueWarningSignals,
    recommendedActions,

    checks: {
      https: {
        passed: protocol === "https",
        protocol,
        hstsPresent,
        notes: httpsNotes,
        scoreImpact: httpsImpact,
      },

      domain: {
        registrableDomain,
        ageDays: domainInfo.ageDays,
        createdAt: domainInfo.createdAt,
        updatedAt: domainInfo.updatedAt,
        expiresAt: domainInfo.expiresAt,
        registrar: domainInfo.registrar,
        notes: domainNotes,
        scoreImpact: domainImpact,
      },

      redirects: {
        hopCount,
        chain: trace.chain,
        suspicious: redirectSuspicious,
        notes: redirectNotes,
        scoreImpact: redirectImpact,
      },

      policies: {
        privacyFound: htmlInfo.privacyFound,
        termsFound: htmlInfo.termsFound,
        contactFound: htmlInfo.contactFound,
        refundFound: htmlInfo.refundFound,
        aboutFound: htmlInfo.aboutFound,
        matchedUrls,
        notes: policyNotes,
        scoreImpact: policyImpact,
      },

      suspiciousPatterns: {
        matchedFlags: suspiciousFlags,
        notes: suspiciousNotes,
        scoreImpact: suspiciousImpact,
      },

      brandConsistency: {
        suspiciousLookalike: brandInfo.suspiciousLookalike,
        titleDomainMismatch: brandInfo.titleDomainMismatch,
        notes: brandNotes,
        scoreImpact: brandImpact,
      },

      reputation: {
        status: reputationInfo.status,
        provider: reputationInfo.provider,
        notes: reputationNotes,
        scoreImpact: reputationImpact,
      },

      technical: {
        statusCode: trace.status,
        canonicalUrl: htmlInfo.canonicalUrl || undefined,
        robotsMeta: htmlInfo.robotsMeta || undefined,
        sitemapFound: (await fetchSitemapUrls(finalUrl)).length > 0,
        securityHeaders,
        notes: technicalNotes,
        scoreImpact: technicalImpact,
      },

      contacts: {
        emails: contacts.emails,
        phones: contacts.phones,
        socialProfiles: contacts.socialProfiles,
        notes: contactNotes,
      },

      tlsCertificate,
    },

    beginnerExplanation,
    disclaimer:
      "This tool highlights trust signals and warning signs, but it cannot guarantee a website is safe. Always be careful before making payments, downloading files, or sharing personal information.",
  };
}

module.exports = {
  scanWebsiteSafety,
};