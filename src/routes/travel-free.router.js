import express from "express";
import axios from "axios";

const router = express.Router();

/* =========================================================
   CONFIG
========================================================= */
const UA = "SohumAstrAI-HolidayPlanner/1.0 (+https://sohumastroai.com)";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 40;

const DEFAULT_RADIUS_KM = 3;
const MIN_RADIUS_KM = 2;
const MAX_RADIUS_KM = 300;

// Keep public Overpass small and stable
const MAX_OVERPASS_RADIUS_KM = 3;
const FALLBACK_MAX_RADIUS_KM = 1.5;
const MAX_PROCESS_RESULTS = 30;

// Timeouts
const OVERPASS_TIMEOUT_MS = 7000;
const NOMINATIM_TIMEOUT_MS = 6000;
const IPAPI_TIMEOUT_MS = 5000;
const WIKI_TIMEOUT_MS = 3500;

// Wikipedia enrichment
const DEFAULT_WIKI_ENRICH_COUNT = 0;
const MAX_WIKI_ENRICH_COUNT = 4;

// Cache
const nearbyCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;

/* =========================================================
   HELPERS
========================================================= */
function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) {
    return xff.split(",")[0].trim();
  }

  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-real-ip"] ||
    req.ip ||
    req.socket?.remoteAddress ||
    ""
  );
}

function isPrivateOrLocalIp(ipRaw) {
  const ip = String(ipRaw || "").replace(/^::ffff:/, "").trim();

  return (
    !ip ||
    ip === "::1" ||
    ip === "127.0.0.1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

function safeErrorMessage(err) {
  if (!err) return "Unknown error";
  if (err.code === "ECONNABORTED") return "Upstream map service timeout";

  if (axios.isAxiosError(err)) {
    return err.response?.data?.remark || err.message || "Request failed";
  }

  return err.message || String(err);
}

function trimText(text = "", max = 140) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (value.length <= max) return value;
  return value.slice(0, max).trimEnd() + "…";
}

function makeCacheKey({ lat, lon, radiusKm, limit, enrich, wikiCount }) {
  return [
    lat.toFixed(3),
    lon.toFixed(3),
    radiusKm,
    limit,
    enrich ? 1 : 0,
    wikiCount || 0,
  ].join("|");
}

function pruneCacheIfNeeded() {
  if (nearbyCache.size < MAX_CACHE_ENTRIES) return;
  const oldestKey = nearbyCache.keys().next().value;
  if (oldestKey) nearbyCache.delete(oldestKey);
}

function getCachedPayload(cacheKey) {
  const entry = nearbyCache.get(cacheKey);
  if (!entry) return null;

  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    nearbyCache.delete(cacheKey);
    return null;
  }

  return {
    ...entry.data,
    debug: {
      ...entry.data.debug,
      cacheHit: true,
      cacheAgeMs: Date.now() - entry.ts,
    },
  };
}

function setCachedPayload(cacheKey, payload) {
  pruneCacheIfNeeded();
  nearbyCache.set(cacheKey, {
    ts: Date.now(),
    data: payload,
  });
}

function prettyType(type) {
  const map = {
    attraction: "Attraction",
    museum: "Museum",
    gallery: "Gallery",
    viewpoint: "Viewpoint",
    zoo: "Zoo",
    theme_park: "Theme Park",
    beach: "Beach",
    peak: "Peak",
    waterfall: "Waterfall",
    park: "Park",
    garden: "Garden",
    nature_reserve: "Nature Reserve",
    historic: "Historic Site",
    place_of_worship: "Place of Worship",
    temple: "Temple",
    mosque: "Mosque",
    church: "Church",
    theatre: "Theatre",
    arts_centre: "Arts Centre",
    tower: "Tower",
    observatory: "Observatory",
    memorial: "Memorial",
    railway_exhibit: "Railway Exhibit",
    aircraft_exhibit: "Aircraft Exhibit",
    place: "Place",
  };

  return (
    map[type] ||
    String(type || "place")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function normalizePlaceType(tags = {}) {
  const tourism = tags.tourism;
  const natural = tags.natural;
  const leisure = tags.leisure;
  const historic = tags.historic;
  const amenity = tags.amenity;
  const railway = tags.railway;
  const aeroway = tags.aeroway;
  const memorial = tags.memorial;
  const building = tags.building;
  const manMade = tags.man_made;
  const waterway = tags.waterway;

  if (tourism) return tourism;
  if (natural) return natural;
  if (waterway === "waterfall") return "waterfall";
  if (leisure) return leisure;
  if (historic) return "historic";
  if (amenity === "place_of_worship") return "place_of_worship";
  if (amenity === "theatre") return "theatre";
  if (amenity === "arts_centre") return "arts_centre";
  if (building === "temple") return "temple";
  if (building === "mosque") return "mosque";
  if (building === "church") return "church";
  if (manMade === "tower") return "tower";
  if (manMade === "observatory") return "observatory";
  if (railway === "locomotive") return "railway_exhibit";
  if (aeroway === "aircraft") return "aircraft_exhibit";
  if (memorial) return "memorial";

  return "place";
}

function getCategoryInfo(type = "", name = "") {
  const t = String(type || "").toLowerCase();
  const n = String(name || "").toLowerCase();

  if (
    ["museum", "historic", "memorial"].includes(t) ||
    n.includes("museum") ||
    n.includes("heritage")
  ) {
    return { key: "heritage", label: "Heritage", badge: "Cultural spot" };
  }

  if (
    ["park", "garden", "beach", "waterfall", "peak"].includes(t) ||
    n.includes("park") ||
    n.includes("garden") ||
    n.includes("waterfall") ||
    n.includes("beach")
  ) {
    return { key: "nature", label: "Nature", badge: "Relaxing outing" };
  }

  if (
    ["place_of_worship", "temple", "mosque", "church"].includes(t) ||
    n.includes("temple") ||
    n.includes("mosque") ||
    n.includes("church")
  ) {
    return { key: "spiritual", label: "Spiritual", badge: "Peaceful visit" };
  }

  if (
    ["theme_park", "zoo"].includes(t) ||
    n.includes("lagoon") ||
    n.includes("theme") ||
    n.includes("zoo")
  ) {
    return { key: "family", label: "Family", badge: "Family favorite" };
  }

  return { key: "attractions", label: "Attractions", badge: "Popular stop" };
}

function distanceBadge(distanceKm) {
  if (!Number.isFinite(distanceKm)) return "";
  if (distanceKm <= 2) return "Very near";
  if (distanceKm <= 6) return "Short drive";
  if (distanceKm <= 15) return "Easy trip";
  return "Worth a trip";
}

/* =========================================================
   QUALITY FILTERS + SCORE
========================================================= */
function isUsefulPlace(p) {
  if (!p) return false;

  const name = (p.name || "").trim().toLowerCase();

  if (!name && (p.distanceKm ?? 999) < 0.2) return false;
  if (!name && (p.type === "railway_exhibit" || p.type === "aircraft_exhibit")) return false;
  if (!p.name && p.type === "historic") return false;

  if (name.includes("rumah sewa")) return false;
  if (name.includes("basketball court")) return false;
  if (name.includes("residents association")) return false;
  if (name.includes("guard house")) return false;
  if (name.includes("playground") && (p.distanceKm ?? 999) < 0.5) return false;

  return true;
}

function scorePlace(p) {
  let score = 0;
  const t = p.type || "";
  const hasName = !!(p.name && p.name.trim());
  const d = p.distanceKm ?? 999;

  if (["theme_park", "museum", "attraction", "zoo", "viewpoint", "beach", "waterfall"].includes(t)) {
    score += 50;
  }

  if (["historic", "park", "garden"].includes(t)) {
    score += 18;
  }

  if (["place_of_worship", "temple", "mosque", "church"].includes(t)) {
    score += 6;
  }

  if (hasName) score += 15;
  if (["railway_exhibit", "aircraft_exhibit"].includes(t)) score -= 20;

  score += Math.max(0, 16 - d);

  return score;
}

/* =========================================================
   IP + REVERSE
========================================================= */
async function getIpLocation(ip) {
  const cleanIp = String(ip || "").replace(/^::ffff:/, "").trim();

  const url = cleanIp
    ? `https://ipapi.co/${encodeURIComponent(cleanIp)}/json/`
    : `https://ipapi.co/json/`;

  const { data } = await axios.get(url, {
    timeout: IPAPI_TIMEOUT_MS,
    headers: { "User-Agent": UA },
  });

  if (!data || data.error) {
    throw new Error(data?.reason || "IP geolocation failed");
  }

  const lat = Number(data.latitude);
  const lon = Number(data.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Latitude/longitude not found from IP geolocation");
  }

  return {
    lat,
    lon,
    city: data.city || "",
    region: data.region || data.region_code || "",
    country: data.country_name || data.country || "",
    source: "ipapi.co",
  };
}

async function reverseGeocode(lat, lon) {
  const { data } = await axios.get("https://nominatim.openstreetmap.org/reverse", {
    timeout: NOMINATIM_TIMEOUT_MS,
    params: {
      format: "jsonv2",
      lat,
      lon,
      zoom: 10,
      addressdetails: 1,
    },
    headers: { "User-Agent": UA },
  });

  return data || null;
}

/* =========================================================
   OVERPASS
========================================================= */
async function runOverpassQuery(query) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  let lastErr = null;

  for (const url of endpoints) {
    try {
      const started = Date.now();

      const { data } = await axios.post(url, query, {
        timeout: OVERPASS_TIMEOUT_MS,
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": UA,
        },
      });

      console.log(
        `[Overpass OK] ${url} ${Date.now() - started}ms elements=${data?.elements?.length || 0}`
      );

      return Array.isArray(data?.elements) ? data.elements : [];
    } catch (e) {
      lastErr = e;
      console.warn(`[Overpass failed] ${url} code=${e?.code || ""} msg=${safeErrorMessage(e)}`);
    }
  }

  throw lastErr || new Error("All Overpass endpoints failed");
}

function mapOverpassElements(elements, lat, lon) {
  const mapped = elements
    .map((el) => {
      const tags = el.tags || {};
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;

      if (!Number.isFinite(elLat) || !Number.isFinite(elLon)) return null;

      const name = (tags.name || tags["name:en"] || "").trim();
      const type = normalizePlaceType(tags);

      const address = [
        tags["addr:housename"],
        tags["addr:housenumber"],
        tags["addr:street"],
        tags["addr:city"] || tags["addr:town"] || tags["addr:village"],
        tags["addr:state"],
      ]
        .filter(Boolean)
        .join(", ");

      return {
        id: `${el.type}-${el.id}`,
        name,
        type,
        typeLabel: prettyType(type),
        lat: Number(elLat),
        lon: Number(elLon),
        address,
        distanceKm: haversineKm(lat, lon, Number(elLat), Number(elLon)),
        osmType: el.type,
        osmId: el.id,
        placeDescription: "",
        placeSummary: "",
        placeImage: null,
        wikipediaUrl: null,
      };
    })
    .filter(Boolean);

  const seen = new Set();

  return mapped.filter((p) => {
    const key = `${(p.name || "").toLowerCase()}|${p.type}|${Math.round(p.lat * 1000)}|${Math.round(p.lon * 1000)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildStrictOverpassQuery(lat, lon, radiusMeters) {
  return `
[out:json][timeout:6];
(
  node["tourism"~"attraction|museum|viewpoint|zoo|theme_park"](around:${radiusMeters},${lat},${lon});
  way["tourism"~"attraction|museum|viewpoint|zoo|theme_park"](around:${radiusMeters},${lat},${lon});

  node["natural"~"beach|peak|waterfall"](around:${radiusMeters},${lat},${lon});
  way["natural"~"beach|peak|waterfall"](around:${radiusMeters},${lat},${lon});
);
out center tags;
`.trim();
}

function buildFallbackOverpassQuery(lat, lon, radiusMeters) {
  return `
[out:json][timeout:5];
(
  node["tourism"~"attraction|museum|theme_park|viewpoint"](around:${radiusMeters},${lat},${lon});
  way["tourism"~"attraction|museum|theme_park|viewpoint"](around:${radiusMeters},${lat},${lon});

  node["natural"~"beach|waterfall|peak"](around:${radiusMeters},${lat},${lon});
  way["natural"~"beach|waterfall|peak"](around:${radiusMeters},${lat},${lon});

  node["leisure"~"park|garden"](around:${radiusMeters},${lat},${lon});
  way["leisure"~"park|garden"](around:${radiusMeters},${lat},${lon});
);
out center tags;
`.trim();
}

async function executeNearbySearch(lat, lon, radiusKm) {
  const radiusMeters = Math.round(radiusKm * 1000);

  const strictRaw = await runOverpassQuery(buildStrictOverpassQuery(lat, lon, radiusMeters));
  const strictMapped = mapOverpassElements(strictRaw, lat, lon);
  let filtered = strictMapped.filter(isUsefulPlace);

  let fallbackUsed = false;
  let fallbackRawCount = 0;
  let fallbackMappedCount = 0;
  let fallbackRadiusKm = 0;

  if (filtered.length < 4) {
    fallbackUsed = true;
    fallbackRadiusKm = Math.min(radiusKm, FALLBACK_MAX_RADIUS_KM);

    try {
      const fallbackRaw = await runOverpassQuery(
        buildFallbackOverpassQuery(lat, lon, Math.round(fallbackRadiusKm * 1000))
      );

      fallbackRawCount = fallbackRaw.length;

      const fallbackMapped = mapOverpassElements(fallbackRaw, lat, lon);
      fallbackMappedCount = fallbackMapped.length;

      const byId = new Map();
      for (const p of [...filtered, ...fallbackMapped.filter(isUsefulPlace)]) {
        if (!byId.has(p.id)) byId.set(p.id, p);
      }
      filtered = [...byId.values()];
    } catch (e) {
      console.warn("[Overpass fallback failed]", safeErrorMessage(e));
      if (filtered.length === 0) throw e;
    }
  }

  filtered.sort((a, b) => {
    const sa = scorePlace(a);
    const sb = scorePlace(b);
    if (sb !== sa) return sb - sa;
    return (a.distanceKm ?? 999) - (b.distanceKm ?? 999);
  });

  filtered = filtered.slice(0, MAX_PROCESS_RESULTS);

  const places = filtered.map((p) => {
    const cat = getCategoryInfo(p.type, p.name);
    return {
      id: p.id,
      name: p.name || p.typeLabel,
      type: p.type,
      typeLabel: p.typeLabel,
      categoryKey: cat.key,
      categoryLabel: cat.label,
      badge: cat.badge,
      distanceBadge: distanceBadge(p.distanceKm),
      lat: p.lat,
      lon: p.lon,
      address: p.address || "",
      shortDescription: trimText(p.address || `${p.typeLabel} nearby`, 100),
      distanceKm: Number((p.distanceKm ?? 0).toFixed(2)),
      hasImage: false,
      placeDescription: "",
      placeSummary: "",
      placeImage: null,
      wikipediaUrl: null,
      openStreetMapUrl: `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=15/${p.lat}/${p.lon}`,
      googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.lat},${p.lon}`)}`,
    };
  });

  return {
    places,
    debug: {
      strictRawFound: strictRaw.length,
      mappedStrictFound: strictMapped.length,
      afterQualityFilter: filtered.length,
      fallbackUsed,
      fallbackRawFound: fallbackRawCount,
      fallbackMappedFound: fallbackMappedCount,
      fallbackRadiusKm,
      effectiveRadiusKm: radiusKm,
    },
  };
}

async function searchNearbyPlaces(lat, lon, userRadiusKm) {
  const cappedRadiusKm = Math.min(userRadiusKm, MAX_OVERPASS_RADIUS_KM);
  const radiusSteps = [cappedRadiusKm, 2]
    .filter((v, i, arr) => v >= MIN_RADIUS_KM && arr.indexOf(v) === i)
    .sort((a, b) => b - a);

  let lastErr = null;

  for (const radiusKm of radiusSteps) {
    try {
      console.log(`[Nearby search] trying radius=${radiusKm}km`);
      return await executeNearbySearch(lat, lon, radiusKm);
    } catch (e) {
      lastErr = e;
      console.warn(`[Nearby search retry] radius=${radiusKm}km failed: ${safeErrorMessage(e)}`);
    }
  }

  throw lastErr || new Error("Nearby place search failed");
}

/* =========================================================
   LIGHT ENRICHMENT
========================================================= */
async function getWikiSummary(placeName, city = "", country = "") {
  try {
    if (!placeName) return null;

    const q = [placeName, city, country].filter(Boolean).join(" ");

    const { data: searchData } = await axios.get("https://en.wikipedia.org/w/api.php", {
      timeout: WIKI_TIMEOUT_MS,
      params: {
        action: "query",
        list: "search",
        srsearch: q,
        format: "json",
        utf8: 1,
        srlimit: 1,
      },
      headers: { "User-Agent": UA },
    });

    const hit = searchData?.query?.search?.[0];
    if (!hit?.title) return null;

    const { data: summary } = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}`,
      {
        timeout: WIKI_TIMEOUT_MS,
        headers: { "User-Agent": UA },
      }
    );

    return {
      description: summary?.description || "",
      summary: summary?.extract || "",
      thumbnail: summary?.thumbnail?.source || null,
      wikipediaUrl: summary?.content_urls?.desktop?.page || null,
    };
  } catch {
    return null;
  }
}

async function enrichPlacesWithWikipedia(places, city, country, maxEnrich = 2) {
  if (!maxEnrich || maxEnrich <= 0) return places;

  const top = places.slice(0, maxEnrich);
  const rest = places.slice(maxEnrich);

  const enrichedTop = await Promise.all(
    top.map(async (p) => {
      if (!p?.name || p.name.length < 3) {
        return {
          ...p,
          placeDescription: "",
          placeSummary: "",
          placeImage: null,
          wikipediaUrl: p.wikipediaUrl || null,
          hasImage: false,
          shortDescription: p.shortDescription || "",
        };
      }

      const wiki = await getWikiSummary(p.name, city, country);

      const placeDescription = wiki?.description || "";
      const placeSummary = wiki?.summary || "";
      const placeImage = wiki?.thumbnail || null;
      const wikipediaUrl = wiki?.wikipediaUrl || null;

      return {
        ...p,
        placeDescription,
        placeSummary,
        placeImage,
        wikipediaUrl,
        hasImage: !!placeImage,
        shortDescription: trimText(
          placeDescription || placeSummary || p.address || `${p.typeLabel} nearby`,
          140
        ),
      };
    })
  );

  return [...enrichedTop, ...rest];
}

/* =========================================================
   ROUTE
========================================================= */
router.get("/nearby-free", async (req, res) => {
  const startedAt = Date.now();

  try {
    const qRadius = toNumber(req.query.radiusKm);
    const qLimit = toNumber(req.query.limit);
    const qLat = toNumber(req.query.lat);
    const qLng = toNumber(req.query.lng);

    const radiusKm = clamp(qRadius ?? DEFAULT_RADIUS_KM, MIN_RADIUS_KM, MAX_RADIUS_KM);
    const limit = clamp(qLimit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);

    // free-first: no enrich by default
    const enrich = String(req.query.enrich || "0") === "1";
    const wikiCount = clamp(
      toNumber(req.query.wikiCount) ?? DEFAULT_WIKI_ENRICH_COUNT,
      0,
      MAX_WIKI_ENRICH_COUNT
    );

    let loc;

    if (isValidLatLng(qLat, qLng)) {
      loc = {
        lat: qLat,
        lon: qLng,
        city: "",
        region: "",
        country: "",
        source: "query",
      };
    } else {
      const ip = getClientIp(req);

      if (isPrivateOrLocalIp(ip)) {
        return res.status(400).json({
          ok: false,
          error: "Local/private IP detected. Pass lat/lng for local testing, e.g. ?lat=3.1390&lng=101.6869",
        });
      }

      loc = await getIpLocation(ip);
    }

    const cacheKey = makeCacheKey({
      lat: loc.lat,
      lon: loc.lon,
      radiusKm,
      limit,
      enrich,
      wikiCount,
    });

    const cachedPayload = getCachedPayload(cacheKey);
    if (cachedPayload) {
      return res.json(cachedPayload);
    }

    let reverse = null;
    const tReverseStart = Date.now();

    try {
      reverse = await reverseGeocode(loc.lat, loc.lon);
    } catch (e) {
      console.warn("[reverseGeocode warning]", safeErrorMessage(e));
    }

    const reverseMs = Date.now() - tReverseStart;

    const city =
      reverse?.address?.city ||
      reverse?.address?.town ||
      reverse?.address?.village ||
      reverse?.address?.municipality ||
      loc.city ||
      "";

    const region = reverse?.address?.state || loc.region || "";
    const country = reverse?.address?.country || loc.country || "";

    let searchResult = {
      places: [],
      debug: {
        strictRawFound: 0,
        mappedStrictFound: 0,
        afterQualityFilter: 0,
        fallbackUsed: false,
        fallbackRawFound: 0,
        fallbackMappedFound: 0,
        fallbackRadiusKm: 0,
        effectiveRadiusKm: Math.min(radiusKm, MAX_OVERPASS_RADIUS_KM),
      },
    };

    let overpassError = "";
    const tOverpassStart = Date.now();

    try {
      searchResult = await searchNearbyPlaces(loc.lat, loc.lon, radiusKm);
    } catch (e) {
      overpassError = safeErrorMessage(e);
      console.warn("[nearby places warning]", overpassError);
    }

    const overpassMs = Date.now() - tOverpassStart;

    let nearby = searchResult.places;
    let wikiMs = 0;

    // enrich only very few top places when explicitly requested
    if (enrich && nearby.length > 0) {
      const tWikiStart = Date.now();
      try {
        nearby = await enrichPlacesWithWikipedia(nearby, city, country, wikiCount || 2);
      } catch (e) {
        console.warn("[wiki enrich warning]", safeErrorMessage(e));
      }
      wikiMs = Date.now() - tWikiStart;
    }

    const totalMs = Date.now() - startedAt;

    const payload = {
      ok: true,
      query: {
        radiusKm,
        limit,
        overpassSearchRadiusKm: searchResult.debug.effectiveRadiusKm,
        enrich,
        wikiCount: enrich ? (wikiCount || 2) : 0,
      },
      location: {
        lat: loc.lat,
        lon: loc.lon,
        city,
        region,
        country,
        displayName: reverse?.display_name || "",
        source: loc.source,
      },
      debug: {
        totalFound: nearby.length,
        overpassError,
        fallbackUsed: !!searchResult.debug.fallbackUsed,
        fallbackFound: searchResult.debug.fallbackMappedFound || 0,
        fallbackRadiusKm: searchResult.debug.fallbackRadiusKm || 0,
        strictRawFound: searchResult.debug.strictRawFound || 0,
        mappedStrictFound: searchResult.debug.mappedStrictFound || 0,
        afterQualityFilter: searchResult.debug.afterQualityFilter || 0,
        effectiveRadiusKm: searchResult.debug.effectiveRadiusKm,
        cacheHit: false,
        cacheAgeMs: 0,
        timingsMs: {
          reverseGeocode: reverseMs,
          overpass: overpassMs,
          wikipedia: wikiMs,
          total: totalMs,
        },
        note:
          overpassError && nearby.length === 0
            ? "Nearby search failed upstream, but location lookup succeeded."
            : nearby.length === 0
            ? "No OSM matches found after filtering. Try another location or smaller radius."
            : enrich
            ? "Fast nearby results with light enrichment."
            : "Fast nearby results without enrichment.",
      },
      nearby: nearby.slice(0, limit),
    };

    setCachedPayload(cacheKey, payload);

    return res.json(payload);
  } catch (err) {
    console.error(
      "nearby-free error:",
      safeErrorMessage(err),
      err?.code ? `code=${err.code}` : ""
    );

    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(err) || "Failed to fetch nearby locations",
    });
  }
});

export default router;