import { FieldValue } from "../lib/values.js";
import { Router } from "express";
import { isIP } from "node:net";
import { collections } from "../config/store.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { appSettings, premiumActive } from "../lib/booking.js";
import { nearestServiceArea } from "../lib/geo.js";
import {
  prioritizeWorkers,
  workerDistanceKm,
  workerMatchesLocation,
} from "../lib/matching.js";
import {
  OUT_OF_ZONE_MESSAGE,
  allServiceZones,
  evaluateServiceZones,
  validateBookingZone,
} from "../lib/zones.js";
import { waitlistSchema } from "../lib/validate.js";
import { isPromoLive } from "../lib/promos.js";
import { docToJson, docsToJson } from "../lib/utils.js";

export const publicRouter = Router();
const reverseGeocodeCache = new Map();
let reverseGeocodeQueue = Promise.resolve();
let reverseGeocodeLastRequestAt = 0;

const BOOTSTRAP_CACHE_TTL_MS = 15 * 60 * 1000;
let bootstrapCache = null;
let bootstrapCachedAt = 0;
let bootstrapPromise = null;
let bootstrapVersion = 0;

/**
 * Drop the in-function bootstrap cache after an admin edit so the next public
 * request sees new folder/home settings immediately instead of waiting up to
 * 15 min. Bumping the version also prevents a load that started before the
 * edit from writing stale data back into the cache.
 */
export function invalidateBootstrapCache() {
  bootstrapCache = null;
  bootstrapCachedAt = 0;
  bootstrapPromise = null;
  bootstrapVersion += 1;
}

const TOP_RATED_CACHE_TTL_MS = 5 * 60 * 1000;
let topRatedCache = null;
let topRatedCachedAt = 0;
let topRatedPromise = null;

const WORKERS_CACHE_TTL_MS = 2 * 60 * 1000;
const workersDirectoryCache = new Map();

function coordinate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicClientIp(value) {
  const ip = String(value || "").replace(/^::ffff:/i, "").split("%")[0];
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    ) {
      return "";
    }
    return ip;
  }
  if (
    version === 6 &&
    !ip.startsWith("fc") &&
    !ip.startsWith("fd") &&
    !ip.startsWith("fe") &&
    !ip.startsWith("ff") &&
    ip !== "::" &&
    ip !== "::1"
  ) {
    return ip;
  }
  return "";
}

async function fetchReverseGeocode(url) {
  const previousRequest = reverseGeocodeQueue;
  let release;
  reverseGeocodeQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previousRequest;

  try {
    const delay = Math.max(0, 1000 - (Date.now() - reverseGeocodeLastRequestAt));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      reverseGeocodeLastRequestAt = Date.now();
      const response = await fetch(url, {
        headers: { "User-Agent": "EasyHome/1.0 (location lookup)" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ApiError(
          502,
          `Reverse geocoding provider returned ${response.status}.`,
          "GEOCODING_PROVIDER_FAILED",
        );
      }
      return await response.json();
    } catch (error) {
      if (error.name === "AbortError") {
        throw new ApiError(
          504,
          "Reverse geocoding request timed out.",
          "GEOCODING_TIMEOUT",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    release();
  }
}

function buildPublicFolders(folders, services) {
  return folders
    .filter((folder) => folder.isLive !== false && folder.active !== false)
    .map((folder) => {
      const id = String(folder._id ?? folder.id ?? "");
      const name = String(folder.name || "");
      const aliases = [...new Set([id, name].filter(Boolean))];
      const folderServices = services.filter((service) => {
        const folderId = String(service.folderId || "");
        const legacyFolder = String(service.folder || "");
        return aliases.includes(folderId) || aliases.includes(legacyFolder);
      });
      const homeOrder = Number(folder.homeOrder);
      return {
        ...folder,
        id,
        name,
        // Legacy folders have no home settings; keep them visible on home.
        showOnHome: folder.showOnHome !== false,
        homeOrder:
          Number.isFinite(homeOrder) && homeOrder > 0
            ? homeOrder
            : Number(folder.order) || 0,
        servicesCount: folderServices.length,
        serviceKeys: folderServices.map((service) => service.key).filter(Boolean),
      };
    })
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

async function loadBootstrapPayload() {
  const [servicesSnap, foldersSnap, citiesSnap, zones, promosSnap, footerLinksSnap, settings] = await Promise.all([
    collections.services.orderBy("order", "asc").get(),
    collections.serviceFolders.orderBy("order", "asc").get(),
    collections.cities.orderBy("name", "asc").get(),
    allServiceZones(),
    collections.promos.orderBy("order", "asc").get(),
    collections.footerLinks.get(),
    appSettings(),
  ]);

  const now = Date.now();
  const services = docsToJson(servicesSnap).filter(
    (service) => service.active !== false,
  );
  const folders = buildPublicFolders(docsToJson(foldersSnap), services);
  const cities = docsToJson(citiesSnap).filter((city) => city.active !== false);
  const promos = docsToJson(promosSnap).filter((promo) => {
    if (promo.active === false) return false;
    const starts = promo.startsAt ? new Date(promo.startsAt).getTime() : 0;
    const ends = promo.endsAt ? new Date(promo.endsAt).getTime() : 0;
    if (starts && starts > now) return false;
    if (ends && ends < now) return false;
    return true;
  });
  const allFooterLinks = docsToJson(footerLinksSnap);
  const footerLinks = allFooterLinks.filter((link) => link.active !== false);
  const hiddenFooterHrefs = allFooterLinks
    .filter((link) => link.active === false)
    .map((link) => link.href)
    .filter(Boolean);

  return {
    services,
    folders,
    cities,
    zones,
    promos,
    footerLinks,
    hiddenFooterHrefs,
    settings,
    version: 2,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Single round-trip bootstrap payload for the PWA shell.
 *
 * The catalogue changes rarely but is needed by every page. Caching it in
 * function memory for 15 minutes (and at the edge for 5) keeps a burst of
 * visitors from turning into one MongoDB query per page view. If a refresh
 * fails, the previous payload is still served so the shell stays usable.
 */
publicRouter.get(
  "/bootstrap",
  asyncHandler(async (_req, res) => {
    const now = Date.now();
    const fresh =
      bootstrapCache !== null &&
      now - bootstrapCachedAt < BOOTSTRAP_CACHE_TTL_MS;
    let cacheState = fresh ? "HIT" : "MISS";
    let payload = bootstrapCache;

    if (!fresh) {
      const version = bootstrapVersion;
      if (!bootstrapPromise) {
        bootstrapPromise = loadBootstrapPayload()
          .then((loaded) => {
            // Only the load started after the newest invalidation may write
            // the cache. An older in-flight load can still answer its own
            // request, but it must not repopulate stale data.
            if (version === bootstrapVersion) {
              bootstrapCache = loaded;
              bootstrapCachedAt = Date.now();
            }
            return loaded;
          })
          .finally(() => {
            if (version === bootstrapVersion) bootstrapPromise = null;
          });
      }

      try {
        payload = await bootstrapPromise;
      } catch (error) {
        if (!bootstrapCache) throw error;
        cacheState = "STALE";
        payload = bootstrapCache;
      }
    }

    res.set(
      "Cache-Control",
      "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    );
    res.set(
      "Vercel-CDN-Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=600",
    );
    res.set("X-Catalogue-Cache", cacheState);
    res.json(payload);
  }),
);

publicRouter.get(
  "/folders",
  asyncHandler(async (_req, res) => {
    const [foldersSnap, servicesSnap] = await Promise.all([
      collections.serviceFolders.orderBy("order", "asc").get(),
      collections.services.get(),
    ]);
    const services = docsToJson(servicesSnap).filter(
      (service) => service.active !== false,
    );
    const folders = buildPublicFolders(docsToJson(foldersSnap), services);
    res.set("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=120");
    res.json({ folders });
  }),
);

/**
 * Coupon rules are checked live. The bootstrap payload is cached for several
 * minutes for page speed, but an admin pausing or changing a discount must be
 * reflected the moment a customer applies the code.
 */
publicRouter.get(
  "/promos",
  asyncHandler(async (_req, res) => {
    const snap = await collections.promos.orderBy("order", "asc").get();
    const now = Date.now();
    const promos = docsToJson(snap).filter((promo) => isPromoLive(promo, now));
    res.set("Cache-Control", "no-store, max-age=0");
    res.json({ promos, fetchedAt: new Date().toISOString() });
  }),
);

publicRouter.get(
  "/service-area",
  asyncHandler(async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const cityName = req.query.city ? String(req.query.city) : "";
    const state = req.query.state ? String(req.query.state) : "";
    const zones = await allServiceZones();

    if (zones.length) {
      const result = evaluateServiceZones(zones, { lat, lng, cityName, state });
      if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && !cityName) {
        return res.status(400).json({
          allowed: false,
          configured: true,
          message: "Share your location or choose a city so we can check coverage.",
        });
      }
      return res.json({
        allowed: result.allowed,
        configured: true,
        city: result.zone?.cityName || cityName || null,
        state: result.zone?.state || state || null,
        cityId: result.zone?.id || null,
        zone: result.zone
          ? {
              id: result.zone.id,
              cityName: result.zone.cityName,
              state: result.zone.state,
              areaName: result.zone.areaName || "",
              radiusKm: result.zone.radiusKm,
              latitude: result.zone.latitude,
              longitude: result.zone.longitude,
            }
          : null,
        nearestZone: result.nearest?.zone?.cityName || null,
        distanceMeters: result.distanceMeters,
        radiusKm: result.zone?.radiusKm || null,
        message: result.allowed
          ? `We serve ${result.zone?.cityName || "your area"}.`
          : OUT_OF_ZONE_MESSAGE,
      });
    }

    const citiesSnap = await collections.cities.where("active", "==", true).get();
    const cities = docsToJson(citiesSnap);
    const result = nearestServiceArea(cities, lat, lng);

    if (result.error) {
      return res.status(400).json({ allowed: false, message: result.error });
    }

    return res.json({
      allowed: result.allowed,
      configured: false,
      city: result.city?.name || null,
      cityId: result.city?.id || null,
      nearestZone: result.nearest?.city?.name || null,
      distanceMeters: result.distanceMeters,
      radiusKm: result.radiusKm,
      message: result.allowed
        ? `We serve ${result.city?.name || "your area"}.`
        : OUT_OF_ZONE_MESSAGE,
    });
  }),
);

publicRouter.get(
  "/ip-location",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const ip = publicClientIp(req.ip);
    if (!ip) return res.json({ available: false });

    let response;
    try {
      response = await fetch(
        `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
        { signal: AbortSignal.timeout(5000) },
      );
    } catch (error) {
      const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
      throw new ApiError(
        timedOut ? 504 : 502,
        "Automatic city lookup is temporarily unavailable.",
        timedOut ? "IP_LOCATION_TIMEOUT" : "IP_LOCATION_FAILED",
      );
    }
    if (!response.ok) {
      throw new ApiError(
        502,
        "Automatic city lookup is temporarily unavailable.",
        "IP_LOCATION_FAILED",
      );
    }

    const result = await response.json();
    if (result.error || String(result.country_code || "").toUpperCase() !== "IN") {
      return res.json({ available: false });
    }

    const city = String(result.city || "").trim();
    const state = String(result.region || "").trim();
    return res.json({ available: Boolean(city), city, state, accuracy: "city" });
  }),
);

publicRouter.get(
  "/reverse-geocode",
  asyncHandler(async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lng) ||
      lng < -180 ||
      lng > 180
    ) {
      return res.status(400).json({
        error: "Provide valid latitude and longitude.",
        code: "INVALID_COORDINATES",
      });
    }

    const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    const cached = reverseGeocodeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ address: cached.address, source: "cache" });
    }

    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", "18");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lng));
    const result = await fetchReverseGeocode(url);
    const components = result.address || {};
    const address = {
      state: components.state || components.region || "",
      district:
        components.city_district ||
        components.district ||
        components.state_district ||
        components.county ||
        components.city ||
        components.town ||
        components.village ||
        "",
      city: components.city || components.town || components.village || "",
      locality:
        components.locality ||
        components.neighbourhood ||
        components.suburb ||
        components.quarter ||
        components.hamlet ||
        components.residential ||
        "",
    };
    reverseGeocodeCache.set(cacheKey, {
      address,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    });
    if (reverseGeocodeCache.size > 500) {
      const oldestKey = reverseGeocodeCache.keys().next().value;
      if (oldestKey) reverseGeocodeCache.delete(oldestKey);
    }
    res.set("Cache-Control", "private, max-age=3600");
    res.json({ address, source: "openstreetmap" });
  }),
);

publicRouter.post(
  "/waitlist",
  asyncHandler(async (req, res) => {
    const body = waitlistSchema.parse(req.body || {});
    const existing = await collections.serviceWaitlist
      .where("phone", "==", body.phone)
      .limit(10)
      .get();
    const duplicate = existing.docs.find((doc) => {
      const item = doc.data();
      return String(item.cityName || "").toLowerCase() ===
        String(body.cityName || "").toLowerCase();
    });

    if (duplicate) {
      return res.status(200).json({ ok: true, duplicate: true, id: duplicate.id });
    }

    const ref = collections.serviceWaitlist.doc();
    await ref.set({
      name: body.name,
      phone: body.phone,
      email: body.email || "",
      cityName: body.cityName || "",
      state: body.state || "",
      lat: coordinate(body.lat),
      lng: coordinate(body.lng),
      message: body.message || "",
      status: "waiting",
      source: "geofence",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    res.status(201).json({ ok: true, id: ref.id });
  }),
);

publicRouter.get(
  "/workers/nearby",
  asyncHandler(async (req, res) => {
    const cityName = String(req.query.city || "").trim();
    const state = String(req.query.state || "").trim();
    const areaName = String(req.query.areaName || "").trim();
    const lat = coordinate(req.query.lat);
    const lng = coordinate(req.query.lng);
    if (
      !cityName ||
      !state ||
      lat === null ||
      lng === null ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      throw new ApiError(
        422,
        "A city, state and precise location are required to find nearby professionals.",
        "LOCATION_REQUIRED",
      );
    }

    const zoneCheck = await validateBookingZone({
      lat,
      lng,
      cityName,
      state,
      areaName,
    });
    if (!zoneCheck.allowed) {
      res.set("Cache-Control", "private, no-store");
      return res.json({
        workers: [],
        zoneAllowed: false,
        message: zoneCheck.message || OUT_OF_ZONE_MESSAGE,
      });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    // workersPublic is the approved-worker projection. Querying it directly
    // avoids a full workers scan plus one extra read per candidate on every
    // 30-second nearby poll while preserving the same public result shape.
    // Do not pre-filter by the city label: a professional may be registered
    // under a neighbouring ward, district or legacy spelling while physically
    // inside the same live radius. Coordinates decide eligibility below.
    const snap = await collections.workersPublic
      .where("online", "==", true)
      .limit(200)
      .get();
    const eligible = prioritizeWorkers(
      docsToJson(snap).filter((worker) =>
        workerMatchesLocation(
          worker,
          {
            cityName,
            state,
            areaName: zoneCheck.zone?.areaName || areaName,
            lat,
            lng,
          },
          zoneCheck.zone,
        ),
      ),
      premiumActive,
    ).slice(0, limit);
    const workers = eligible.map((worker) => ({
      ...worker,
      distanceKm: workerDistanceKm(worker, { lat, lng }),
    }));

    res.set("Cache-Control", "private, no-store");
    res.json({ workers, zoneAllowed: true, zoneId: zoneCheck.zone?.id || null });
  }),
);

async function loadTopRatedWorkers() {
  // Read only the high-rated head of the public collection instead of scanning
  // every worker. The result is cached in memory for five minutes below.
  const snap = await collections.workersPublic
    .orderBy("rating", "desc")
    .limit(50)
    .get();
  return docsToJson(snap)
    .sort((a, b) => {
      const rating = (Number(b.rating) || 0) - (Number(a.rating) || 0);
      if (rating) return rating;
      const reviews =
        (Number(b.reviewCount) || 0) - (Number(a.reviewCount) || 0);
      if (reviews) return reviews;
      return (
        (Number(b.jobsCompleted) || 0) - (Number(a.jobsCompleted) || 0)
      );
    })
    .map((worker) => ({ ...worker, isPremium: premiumActive(worker) }));
}

publicRouter.get(
  "/workers/top-rated",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 12);
    const now = Date.now();
    const fresh =
      topRatedCache !== null &&
      now - topRatedCachedAt < TOP_RATED_CACHE_TTL_MS;
    let cacheState = fresh ? "HIT" : "MISS";

    if (!fresh) {
      if (!topRatedPromise) {
        topRatedPromise = loadTopRatedWorkers()
          .then((workers) => {
            topRatedCache = workers;
            topRatedCachedAt = Date.now();
            return workers;
          })
          .finally(() => {
            topRatedPromise = null;
          });
      }

      try {
        await topRatedPromise;
      } catch (error) {
        if (!topRatedCache) throw error;
        cacheState = "STALE";
      }
    }

    res.set(
      "Cache-Control",
      "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    );
    res.set("X-Top-Rated-Cache", cacheState);
    res.json({ workers: topRatedCache.slice(0, limit) });
  }),
);

async function loadWorkersDirectory(serviceKey) {
  const queryRef = serviceKey
    ? collections.workersPublic.where("serviceKey", "==", serviceKey)
    : collections.workersPublic;
  const snap = await queryRef.limit(500).get();
  return prioritizeWorkers(docsToJson(snap), premiumActive).map((worker) => ({
    ...worker,
    isPremium: premiumActive(worker),
  }));
}

publicRouter.get(
  "/workers",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    const serviceKey = req.query.serviceKey ? String(req.query.serviceKey) : "";
    const cacheKey = serviceKey || "__all__";
    let entry = workersDirectoryCache.get(cacheKey);
    const fresh =
      Boolean(entry?.data) &&
      Date.now() - entry.at < WORKERS_CACHE_TTL_MS;
    let cacheState = fresh ? "HIT" : "MISS";

    if (!fresh) {
      if (!entry?.promise) {
        const pending = loadWorkersDirectory(serviceKey)
          .then((workers) => {
            workersDirectoryCache.set(cacheKey, {
              data: workers,
              at: Date.now(),
              promise: null,
            });
            return workers;
          })
          .catch((error) => {
            const current = workersDirectoryCache.get(cacheKey);
            if (current) {
              workersDirectoryCache.set(cacheKey, {
                ...current,
                promise: null,
              });
            }
            throw error;
          });
        entry = {
          data: entry?.data || null,
          at: entry?.at || 0,
          promise: pending,
        };
        workersDirectoryCache.set(cacheKey, entry);
      }

      try {
        await entry.promise;
      } catch (error) {
        const stale = workersDirectoryCache.get(cacheKey);
        if (!stale?.data) throw error;
        cacheState = "STALE";
      }
      entry = workersDirectoryCache.get(cacheKey) || entry;
    }

    const workers = (entry?.data || []).slice(0, limit);
    res.set(
      "Cache-Control",
      "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    );
    res.set("X-Workers-Cache", cacheState);
    res.json({ workers });
  }),
);

publicRouter.get(
  "/workers/:id",
  asyncHandler(async (req, res) => {
    const [workerSnap, reviewsSnap] = await Promise.all([
      collections.workersPublic.doc(req.params.id).get(),
      collections.reviews
        .where("workerId", "==", req.params.id)
        .orderBy("createdAt", "desc")
        .limit(12)
        .get(),
    ]);

    if (!workerSnap.exists) {
      return res.status(404).json({ error: "Worker not found", code: "NOT_FOUND" });
    }

    const worker = docToJson(workerSnap);
    return res.json({
      worker: {
        ...worker,
        isPremium: premiumActive(worker),
      },
      reviews: docsToJson(reviewsSnap),
    });
  }),
);

publicRouter.get(
  "/urgent",
  asyncHandler(async (_req, res) => {
    const snap = await collections.urgentPublic
      .orderBy("createdAt", "desc")
      .limit(12)
      .get();

    res.set("Cache-Control", "public, max-age=20");
    res.json({ jobs: docsToJson(snap) });
  }),
);

publicRouter.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const [workers, bookings, reviews] = await Promise.all([
      collections.workersPublic.count().get(),
      collections.bookings.where("status", "==", "completed").count().get(),
      collections.reviews.count().get(),
    ]);

    res.set("Cache-Control", "public, max-age=120");
    res.json({
      workers: workers.data().count,
      completedJobs: bookings.data().count,
      reviews: reviews.data().count,
    });
  }),
);

publicRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const snap = await collections.settings.doc("app").get();
    res.json({
      ok: true,
      service: "easyhome-api",
      database: "mongodb",
      settings: snap.exists,
      time: new Date().toISOString(),
    });
  }),
);

/**
 * Marks "last seen" for online workers. Cheap write used by the worker app.
 * (Kept here because it is a non-sensitive heartbeat.)
 */
publicRouter.post(
  "/ping",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ pong: true, time: new Date().toISOString() });
  }),
);
