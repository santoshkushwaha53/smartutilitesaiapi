const express = require("express");
const axios = require("axios");

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
const OVERPASS_TIMEOUT_MS = 15000;
const NOMINATIM_TIMEOUT_MS = 8000;
const IPAPI_TIMEOUT_MS = 5000;
const WIKI_TIMEOUT_MS = 3500;
const GEOAPIFY_TIMEOUT_MS = 6500;
const TOMTOM_TIMEOUT_MS = 6500;

// Wikipedia enrichment
const DEFAULT_WIKI_ENRICH_COUNT = 0;
const MAX_WIKI_ENRICH_COUNT = 4;

// Cache
const nearbyCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;

// Provider categories
const GEOAPIFY_VISIT_CATEGORIES = [
  "tourism.attraction",
  "tourism.attraction.viewpoint",
  "tourism.sights",
  "entertainment.museum",
  "entertainment.culture",
  "entertainment.theme_park",
  "entertainment.zoo",
  "natural",
  "national_park",
  "beach",
  "religion.place_of_worship",
].join(",");

const TOMTOM_VISIT_KEYWORDS = [
  "tourist attraction",
  "important tourist attraction",
  "museum",
  "park",
  "recreation area",
  "historical park",
  "historic site",
  "memorial",
  "monument",
  "castle",
  "fort",
  "palace",
  "tower",
  "viewpoint",
  "lighthouse",
  "planetarium",
  "cultural center",
  "theater",
  "theatre",
  "place of worship",
  "temple",
  "mosque",
  "church",
  "monastery",
  "zoo",
  "wildlife park",
  "botanical garden",
  "garden",
  "nature reserve",
  "beach",
  "waterfall",
  "amusement park",
];

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
    return (
      err.response?.data?.remark ||
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message ||
      "Request failed"
    );
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

  if (!entry.data || !Array.isArray(entry.data.nearby)) return null;
  if (entry.data.nearby.length === 0) return null;

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
    national_park: "National Park",
    garden: "Garden",
    nature_reserve: "Nature Reserve",
    historic: "Historic Site",
    memorial: "Memorial",
    castle: "Castle",
    fort: "Fort",
    palace: "Palace",
    place_of_worship: "Place of Worship",
    temple: "Temple",
    mosque: "Mosque",
    church: "Church",
    theatre: "Theatre",
    arts_centre: "Arts Centre",
    tower: "Tower",
    observatory: "Observatory",
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
    ["museum", "historic", "memorial", "castle", "fort", "palace"].includes(t) ||
    n.includes("museum") ||
    n.includes("heritage") ||
    n.includes("fort") ||
    n.includes("palace")
  ) {
    return { key: "heritage", label: "Heritage", badge: "Cultural spot" };
  }

  if (
    ["park", "national_park", "garden", "beach", "waterfall", "peak", "nature_reserve"].includes(t) ||
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

function isRateLimitLikeError(err, provider = "") {
  const status = err?.response?.status;
  const text = JSON.stringify(err?.response?.data || "").toLowerCase();

  if (status === 429) return true;

  if (
    provider === "tomtom" &&
    status === 403 &&
    /(rate|volume limit exceeded|qps|too many requests|quota)/.test(text)
  ) {
    return true;
  }

  if (
    provider === "geoapify" &&
    (status === 402 || status === 403 || status === 429) &&
    /(rate|quota|too many requests|daily limit|request limit)/.test(text)
  ) {
    return true;
  }

  return false;
}

function makeProviderSkipError(message) {
  const err = new Error(message);
  err.isProviderSkip = true;
  return err;
}

function sortPlaces(places = []) {
  places.sort((a, b) => {
    const sa = scorePlace(a);
    const sb = scorePlace(b);
    if (sb !== sa) return sb - sa;
    return (a.distanceKm ?? 999) - (b.distanceKm ?? 999);
  });
  return places;
}

function dedupePlaces(places = []) {
  const seen = new Set();

  return places.filter((p) => {
    const key = [
      (p.name || "").toLowerCase(),
      p.type || "",
      Math.round((p.lat || 0) * 1000),
      Math.round((p.lon || 0) * 1000),
    ].join("|");

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildNearbyItem(p) {
  const type = p.type || "place";
  const typeLabel = p.typeLabel || prettyType(type);
  const cat = getCategoryInfo(type, p.name);

  return {
    id: p.id,
    name: p.name || typeLabel,
    type,
    typeLabel,
    categoryKey: cat.key,
    categoryLabel: cat.label,
    badge: cat.badge,
    distanceBadge: distanceBadge(p.distanceKm),
    lat: p.lat,
    lon: p.lon,
    address: p.address || "",
    shortDescription: trimText(
      p.shortDescription || p.address || `${typeLabel} nearby`,
      100
    ),
    distanceKm: Number((p.distanceKm ?? 0).toFixed(2)),
    hasImage: false,
    placeDescription: "",
    placeSummary: "",
    placeImage: null,
    wikipediaUrl: null,
    openStreetMapUrl: `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=15/${p.lat}/${p.lon}`,
    googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${p.lat},${p.lon}`
    )}`,
  };
}

function normalizeGeoapifyType(categories = [], name = "") {
  const joined = Array.isArray(categories)
    ? categories.join(" ").toLowerCase()
    : "";

  const lowerName = String(name || "").toLowerCase();

  if (joined.includes("entertainment.museum") || lowerName.includes("museum")) return "museum";
  if (joined.includes("entertainment.culture.gallery")) return "gallery";
  if (joined.includes("entertainment.theme_park")) return "theme_park";
  if (joined.includes("entertainment.zoo")) return "zoo";
  if (joined.includes("tourism.attraction.viewpoint")) return "viewpoint";
  if (joined.includes("tourism.attraction")) return "attraction";
  if (joined.includes("tourism.sights.memorial")) return "memorial";
  if (joined.includes("tourism.sights.place_of_worship.temple")) return "temple";
  if (joined.includes("tourism.sights.place_of_worship.mosque")) return "mosque";
  if (joined.includes("tourism.sights.place_of_worship.church")) return "church";
  if (joined.includes("tourism.sights.place_of_worship")) return "place_of_worship";
  if (joined.includes("religion.place_of_worship.hinduism")) return "temple";
  if (joined.includes("religion.place_of_worship.islam")) return "mosque";
  if (joined.includes("religion.place_of_worship.christianity")) return "church";
  if (joined.includes("religion.place_of_worship")) return "place_of_worship";
  if (joined.includes("beach")) return "beach";
  if (joined.includes("national_park")) return "national_park";
  if (joined.includes("natural.mountain.peak")) return "peak";
  if (joined.includes("natural.water")) return "waterfall";
  if (joined.includes("natural")) return "nature_reserve";

  if (lowerName.includes("temple")) return "temple";
  if (lowerName.includes("mosque")) return "mosque";
  if (lowerName.includes("church")) return "church";
  if (lowerName.includes("park")) return "park";
  if (lowerName.includes("beach")) return "beach";
  if (lowerName.includes("zoo")) return "zoo";
  if (lowerName.includes("museum")) return "museum";

  return "attraction";
}

function mapGeoapifyFeatures(features, lat, lon) {
  const mapped = (Array.isArray(features) ? features : [])
    .map((feature) => {
      const props = feature?.properties || {};
      const coords = feature?.geometry?.coordinates || [];
      const lonVal = Number(coords[0]);
      const latVal = Number(coords[1]);

      if (!Number.isFinite(latVal) || !Number.isFinite(lonVal)) return null;

      const name =
        String(props.name || props.address_line1 || props.formatted || "").trim();

      const type = normalizeGeoapifyType(props.categories || [], name);
      const address = String(
        props.formatted ||
          [props.address_line1, props.address_line2].filter(Boolean).join(", ")
      ).trim();

      const distanceKm = Number.isFinite(props.distance)
        ? Number(props.distance) / 1000
        : haversineKm(lat, lon, latVal, lonVal);

      return {
        id: `geoapify-${props.place_id || `${latVal},${lonVal}`}`,
        name,
        type,
        typeLabel: prettyType(type),
        lat: latVal,
        lon: lonVal,
        address,
        distanceKm,
        shortDescription: address || prettyType(type),
      };
    })
    .filter(Boolean);

  return dedupePlaces(mapped);
}

function collectTomTomKeywords(result) {
  const tokens = [];

  if (result?.poi?.name) tokens.push(result.poi.name);
  if (Array.isArray(result?.poi?.categories)) {
    tokens.push(...result.poi.categories);
  }

  if (Array.isArray(result?.poi?.classifications)) {
    for (const classification of result.poi.classifications) {
      if (Array.isArray(classification?.names)) {
        for (const item of classification.names) {
          if (item?.name) tokens.push(item.name);
        }
      }
      if (classification?.code) tokens.push(classification.code);
    }
  }

  return tokens.join(" ").toLowerCase();
}

function isTomTomVisitPlace(result) {
  const text = collectTomTomKeywords(result);
  if (!text) return false;

  return TOMTOM_VISIT_KEYWORDS.some((keyword) => text.includes(keyword));
}

function normalizeTomTomType(result) {
  const text = collectTomTomKeywords(result);
  const lowerName = String(result?.poi?.name || "").toLowerCase();

  if (text.includes("museum") || lowerName.includes("museum")) return "museum";
  if (text.includes("zoo")) return "zoo";
  if (text.includes("theme park") || text.includes("amusement park")) return "theme_park";
  if (text.includes("beach")) return "beach";
  if (text.includes("botanical garden") || text.includes("garden")) return "garden";
  if (text.includes("nature reserve") || text.includes("wildlife park")) return "nature_reserve";
  if (text.includes("park") || text.includes("recreation area")) return "park";
  if (text.includes("memorial") || text.includes("monument")) return "memorial";
  if (text.includes("castle")) return "castle";
  if (text.includes("fort")) return "fort";
  if (text.includes("palace")) return "palace";
  if (text.includes("tower")) return "tower";
  if (text.includes("viewpoint")) return "viewpoint";
  if (text.includes("place of worship")) return "place_of_worship";
  if (text.includes("temple") || lowerName.includes("temple")) return "temple";
  if (text.includes("mosque") || lowerName.includes("mosque")) return "mosque";
  if (text.includes("church") || lowerName.includes("church")) return "church";
  if (text.includes("cultural center") || text.includes("theater") || text.includes("theatre")) {
    return "theatre";
  }

  return "attraction";
}

function mapTomTomResults(results, lat, lon) {
  const mapped = (Array.isArray(results) ? results : [])
    .filter((item) => item?.type === "POI")
    .filter(isTomTomVisitPlace)
    .map((item) => {
      const poi = item.poi || {};
      const position = item.position || {};
      const latVal = Number(position.lat);
      const lonVal = Number(position.lon);

      if (!Number.isFinite(latVal) || !Number.isFinite(lonVal)) return null;

      const name = String(poi.name || "").trim();
      const type = normalizeTomTomType(item);
      const address = String(item?.address?.freeformAddress || "").trim();

      const distanceKm = Number.isFinite(item.dist)
        ? Number(item.dist) / 1000
        : haversineKm(lat, lon, latVal, lonVal);

      return {
        id: `tomtom-${item.id || `${latVal},${lonVal}`}`,
        name,
        type,
        typeLabel: prettyType(type),
        lat: latVal,
        lon: lonVal,
        address,
        distanceKm,
        shortDescription: address || prettyType(type),
      };
    })
    .filter(Boolean);

  return dedupePlaces(mapped);
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

  if (
    [
      "theme_park",
      "museum",
      "attraction",
      "zoo",
      "viewpoint",
      "beach",
      "waterfall",
      "castle",
      "fort",
      "palace",
      "national_park",
    ].includes(t)
  ) {
    score += 50;
  }

  if (
    ["historic", "park", "garden", "memorial", "nature_reserve"].includes(t)
  ) {
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
   PREMIUM PROVIDERS
========================================================= */
async function searchGeoapifyPlaces(lat, lon, radiusKm, limit) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) throw makeProviderSkipError("GEOAPIFY_API_KEY missing");

  const radiusMeters = Math.round(radiusKm * 1000);
  const requestLimit = clamp(Math.max(limit * 3, 20), 1, 60);

  const { data } = await axios.get("https://api.geoapify.com/v2/places", {
    timeout: GEOAPIFY_TIMEOUT_MS,
    params: {
      categories: GEOAPIFY_VISIT_CATEGORIES,
      filter: `circle:${lon},${lat},${radiusMeters}`,
      bias: `proximity:${lon},${lat}`,
      limit: requestLimit,
      lang: "en",
      apiKey,
    },
    headers: { "User-Agent": UA },
  });

  const raw = Array.isArray(data?.features) ? data.features : [];
  const mapped = sortPlaces(
    mapGeoapifyFeatures(raw, lat, lon).filter(isUsefulPlace)
  ).slice(0, MAX_PROCESS_RESULTS);

  return {
    provider: "geoapify",
    places: mapped.map(buildNearbyItem),
    debug: {
      provider: "geoapify",
      providerRawFound: raw.length,
      providerMappedFound: mapped.length,
      effectiveRadiusKm: radiusKm,
      fallbackUsed: false,
      fallbackRawFound: 0,
      fallbackMappedFound: 0,
      fallbackRadiusKm: 0,
      strictRawFound: 0,
      mappedStrictFound: 0,
      afterQualityFilter: mapped.length,
      providerChain: [],
      premiumFallbackUsed: false,
    },
  };
}

async function searchTomTomPlaces(lat, lon, radiusKm, limit) {
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) throw makeProviderSkipError("TOMTOM_API_KEY missing");

  const radiusMeters = Math.round(radiusKm * 1000);
  const requestLimit = clamp(Math.max(limit * 4, 25), 1, 100);

  const { data } = await axios.get(
    "https://api.tomtom.com/search/2/nearbySearch/.json",
    {
      timeout: TOMTOM_TIMEOUT_MS,
      params: {
        key: apiKey,
        lat,
        lon,
        radius: radiusMeters,
        limit: requestLimit,
        relatedPois: "off",
      },
      headers: { "User-Agent": UA },
    }
  );

  const raw = Array.isArray(data?.results) ? data.results : [];
  const mapped = sortPlaces(
    mapTomTomResults(raw, lat, lon).filter(isUsefulPlace)
  ).slice(0, MAX_PROCESS_RESULTS);

  return {
    provider: "tomtom",
    places: mapped.map(buildNearbyItem),
    debug: {
      provider: "tomtom",
      providerRawFound: raw.length,
      providerMappedFound: mapped.length,
      effectiveRadiusKm: radiusKm,
      fallbackUsed: false,
      fallbackRawFound: 0,
      fallbackMappedFound: 0,
      fallbackRadiusKm: 0,
      strictRawFound: 0,
      mappedStrictFound: 0,
      afterQualityFilter: mapped.length,
      providerChain: [],
      premiumFallbackUsed: false,
    },
  };
}

/* =========================================================
   OVERPASS / OSM FALLBACK
========================================================= */
async function runOverpassQuery(query) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
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

async function searchNominatimPlaces(lat, lon, radiusMeters) {
  const degreeRadius = radiusMeters / 111000;
  const viewbox = [
    lon - degreeRadius,
    lat - degreeRadius,
    lon + degreeRadius,
    lat + degreeRadius,
  ]
    .map((value) => Number(value).toFixed(6))
    .join(",");

  const { data } = await axios.get("https://nominatim.openstreetmap.org/search", {
    timeout: NOMINATIM_TIMEOUT_MS,
    params: {
      format: "jsonv2",
      q: "attraction",
      viewbox,
      bounded: 1,
      limit: 30,
      addressdetails: 1,
      extratags: 1,
    },
    headers: { "User-Agent": UA },
  });

  return Array.isArray(data) ? data : [];
}

function mapNominatimElements(elements, lat, lon) {
  return elements
    .map((item) => {
      const elLat = Number(item.lat);
      const elLon = Number(item.lon);
      if (!Number.isFinite(elLat) || !Number.isFinite(elLon)) return null;

      const rawName = String(item.display_name || item.name || "");
      const name = rawName.split(",")[0].trim();
      const type = String(item.type || item.category || "place").toLowerCase();
      const address = item.display_name || "";

      return {
        id: `nominatim-${item.place_id}`,
        name: name || type,
        type,
        typeLabel: prettyType(type),
        lat: elLat,
        lon: elLon,
        address,
        distanceKm: haversineKm(lat, lon, elLat, elLon),
        osmType: "nominatim",
        osmId: item.place_id,
        placeDescription: "",
        placeSummary: "",
        placeImage: null,
        wikipediaUrl: item.extratags?.wikidata
          ? `https://www.wikidata.org/wiki/${item.extratags.wikidata}`
          : null,
      };
    })
    .filter(Boolean);
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

  return dedupePlaces(mapped);
}

function buildStrictOverpassQuery(lat, lon, radiusMeters) {
  return `
[out:json][timeout:15];
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
[out:json][timeout:12];
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

  let strictRaw = [];
  let strictError = null;
  try {
    strictRaw = await runOverpassQuery(buildStrictOverpassQuery(lat, lon, radiusMeters));
  } catch (e) {
    strictError = e;
    console.warn("[Overpass strict failed]", safeErrorMessage(e));
  }

  const strictMapped = mapOverpassElements(strictRaw, lat, lon);
  let filtered = strictMapped.filter(isUsefulPlace);

  let fallbackUsed = false;
  let fallbackRawCount = 0;
  let fallbackMappedCount = 0;
  let fallbackRadiusKm = 0;
  let fallbackError = null;

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
      fallbackError = e;
      console.warn("[Overpass fallback failed]", safeErrorMessage(e));
    }
  }

  if (filtered.length === 0) {
    try {
      const nominatimRaw = await searchNominatimPlaces(lat, lon, radiusMeters);
      const nominatimMapped = mapNominatimElements(nominatimRaw, lat, lon);
      const nominatimFiltered = nominatimMapped.filter(isUsefulPlace);

      if (nominatimFiltered.length > 0) {
        fallbackUsed = true;
        fallbackRawCount += nominatimMapped.length;
        fallbackMappedCount += nominatimFiltered.length;
        filtered = nominatimFiltered;
      }
    } catch (e) {
      console.warn("[Nominatim fallback failed]", safeErrorMessage(e));
    }
  }

  if (filtered.length === 0 && strictError && fallbackError) {
    throw fallbackError;
  }

  sortPlaces(filtered);
  filtered = filtered.slice(0, MAX_PROCESS_RESULTS);

  return {
    provider: "osm",
    places: filtered.map(buildNearbyItem),
    debug: {
      provider: "osm",
      strictRawFound: strictRaw.length,
      mappedStrictFound: strictMapped.length,
      afterQualityFilter: filtered.length,
      fallbackUsed,
      fallbackRawFound: fallbackRawCount,
      fallbackMappedFound: fallbackMappedCount,
      fallbackRadiusKm,
      effectiveRadiusKm: radiusKm,
      providerRawFound: strictRaw.length + fallbackRawCount,
      providerMappedFound: filtered.length,
      providerChain: [],
      premiumFallbackUsed: false,
    },
  };
}

async function searchNearbyPlacesOsm(lat, lon, userRadiusKm) {
  const cappedRadiusKm = Math.min(userRadiusKm, MAX_OVERPASS_RADIUS_KM);
  const radiusSteps = [cappedRadiusKm, 2]
    .filter((v, i, arr) => v >= MIN_RADIUS_KM && arr.indexOf(v) === i)
    .sort((a, b) => b - a);

  let lastErr = null;

  for (const radiusKm of radiusSteps) {
    try {
      console.log(`[Nearby OSM search] trying radius=${radiusKm}km`);
      return await executeNearbySearch(lat, lon, radiusKm);
    } catch (e) {
      lastErr = e;
      console.warn(`[Nearby OSM retry] radius=${radiusKm}km failed: ${safeErrorMessage(e)}`);
    }
  }

  throw lastErr || new Error("Nearby place search failed");
}

/* =========================================================
   PROVIDER ORCHESTRATION
========================================================= */
async function searchNearbyPlaces(lat, lon, userRadiusKm, limit) {
  const attempts = [];
  const premiumProviders = [
    { name: "geoapify", fn: () => searchGeoapifyPlaces(lat, lon, userRadiusKm, limit) },
    { name: "tomtom", fn: () => searchTomTomPlaces(lat, lon, userRadiusKm, limit) },
  ];

  for (const provider of premiumProviders) {
    try {
      const result = await provider.fn();

      attempts.push({
        provider: provider.name,
        status: result.places.length > 0 ? "ok" : "empty",
        count: result.places.length,
      });

      if (result.places.length > 0) {
        return {
          ...result,
          debug: {
            ...result.debug,
            providerChain: attempts,
            premiumFallbackUsed: attempts.length > 1,
          },
        };
      }
    } catch (err) {
      attempts.push({
        provider: provider.name,
        status: err.isProviderSkip
          ? "skipped"
          : isRateLimitLikeError(err, provider.name)
          ? "rate_limited"
          : "failed",
        reason: safeErrorMessage(err),
      });
    }
  }

  const fallback = await searchNearbyPlacesOsm(lat, lon, userRadiusKm);
  attempts.push({
    provider: "osm",
    status: fallback.places.length > 0 ? "ok" : "empty",
    count: fallback.places.length,
  });

  return {
    ...fallback,
    debug: {
      ...fallback.debug,
      providerChain: attempts,
      premiumFallbackUsed: true,
    },
  };
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
          error:
            "Local/private IP detected. Pass lat/lng for local testing, e.g. ?lat=3.1390&lng=101.6869",
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
      provider: "none",
      places: [],
      debug: {
        provider: "none",
        strictRawFound: 0,
        mappedStrictFound: 0,
        afterQualityFilter: 0,
        fallbackUsed: false,
        fallbackRawFound: 0,
        fallbackMappedFound: 0,
        fallbackRadiusKm: 0,
        effectiveRadiusKm: Math.min(radiusKm, MAX_OVERPASS_RADIUS_KM),
        providerRawFound: 0,
        providerMappedFound: 0,
        providerChain: [],
        premiumFallbackUsed: false,
      },
    };

    let searchError = "";
    const tSearchStart = Date.now();

    try {
      searchResult = await searchNearbyPlaces(loc.lat, loc.lon, radiusKm, limit);
    } catch (e) {
      searchError = safeErrorMessage(e);
      console.warn("[nearby places warning]", searchError);
    }

    const searchMs = Date.now() - tSearchStart;

    let nearby = searchResult.places;
    let wikiMs = 0;

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
        provider: searchResult.provider || "none",
        providerChain: searchResult.debug.providerChain || [],
        premiumFallbackUsed: !!searchResult.debug.premiumFallbackUsed,

        totalFound: nearby.length,
        providerError: searchError,
        overpassError: searchResult.provider === "osm" ? searchError : "",

        fallbackUsed: !!searchResult.debug.fallbackUsed,
        fallbackFound: searchResult.debug.fallbackMappedFound || 0,
        fallbackRadiusKm: searchResult.debug.fallbackRadiusKm || 0,

        strictRawFound: searchResult.debug.strictRawFound || 0,
        mappedStrictFound: searchResult.debug.mappedStrictFound || 0,
        afterQualityFilter: searchResult.debug.afterQualityFilter || 0,
        effectiveRadiusKm: searchResult.debug.effectiveRadiusKm,

        providerRawFound: searchResult.debug.providerRawFound || 0,
        providerMappedFound: searchResult.debug.providerMappedFound || 0,

        cacheHit: false,
        cacheAgeMs: 0,
        timingsMs: {
          reverseGeocode: reverseMs,
          providerSearch: searchMs,
          overpass: searchMs, // kept for backward compatibility
          wikipedia: wikiMs,
          total: totalMs,
        },
        note:
          searchError && nearby.length === 0
            ? "All provider searches failed, but location lookup succeeded."
            : nearby.length === 0
            ? "No nearby places found after filtering. Try another location or smaller radius."
            : searchResult.provider === "geoapify"
            ? "Geoapify primary results."
            : searchResult.provider === "tomtom"
            ? "TomTom fallback results."
            : enrich
            ? "OSM fallback results with light enrichment."
            : "OSM fallback results.",
      },
      nearby: nearby.slice(0, limit),
    };

    if (nearby.length > 0) {
      setCachedPayload(cacheKey, payload);
    }

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

module.exports = router;