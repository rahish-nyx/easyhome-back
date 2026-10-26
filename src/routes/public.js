import { FieldValue } from "firebase-admin/firestore";
import { Router } from "express";
import { isIP } from "node:net";
import { collections } from "../config/firebase.js";
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
import { docToJson, docsToJson } from "../lib/utils.js";

export const publicRouter = Router();
const reverseGeocodeCache = new Map();
let reverseGeocodeQueue = Promise.resolve();
let reverseGeocodeLastRequestAt = 0;

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

/**
 * Single round-trip bootstrap payload for the PWA shell.
 * Cached at the edge for 60s; the client also caches it locally.
 */
publicRouter.get(
  "/bootstrap",
  asyncHandler(async (_req, res) => {
    const [servicesSnap, citiesSnap, zonesSnap, promosSnap, footerLinksSnap, settings] = await Promise.all([
      collections.services.orderBy("order", "asc").get(),
      collections.cities.orderBy("name", "asc").get(),
      collections.serviceZones.get(),
      collections.promos.orderBy("order", "asc").get(),
      collections.footerLinks.get(),
      appSettings(),
    ]);

    const now = Date.now();
    const services = docsToJson(servicesSnap).filter(
      (service) => service.active !== false,
    );
    const cities = docsToJson(citiesSnap).filter((city) => city.active !== false);
    const zones = docsToJson(zonesSnap)
      .map((zone) => ({
        ...zone,
        latitude:
          zone.latitude == null && zone.lat == null
            ? null
            : Number(zone.latitude ?? zone.lat),
        longitude:
          zone.longitude == null && zone.lng == null
            ? null
            : Number(zone.longitude ?? zone.lng),
        radiusKm: Number(zone.radiusKm) || 10,
      }));
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

    res.set("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
    res.json({
      services,
      cities,
      zones,
      promos,
      footerLinks,
      hiddenFooterHrefs,
      settings,
      version: 2,
      fetchedAt: new Date().toISOString(),
    });
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
      return res.json({ workers: [], zoneAllowed: false });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    const snap = await collections.workers
      .where("city", "==", cityName)
      .where("status", "==", "approved")
      .where("online", "==", true)
      .limit(1000)
      .get();
    const eligible = prioritizeWorkers(
      docsToJson(snap).filter(
        (worker) =>
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
    const publicSnapshots = await Promise.all(
      eligible.map((worker) => collections.workersPublic.doc(worker.id).get()),
    );
    const workers = publicSnapshots.flatMap((snapshot, index) =>
      snapshot.exists
        ? [
            {
              ...docToJson(snapshot),
              distanceKm: workerDistanceKm(eligible[index], { lat, lng }),
            },
          ]
        : [],
    );

    res.set("Cache-Control", "private, no-store");
    res.json({ workers, zoneAllowed: true, zoneId: zoneCheck.zone?.id || null });
  }),
);

publicRouter.get(
  "/workers",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    const serviceKey = req.query.serviceKey ? String(req.query.serviceKey) : "";

    let queryRef = collections.workersPublic;
    if (serviceKey) {
      queryRef = collections.workersPublic.where("serviceKey", "==", serviceKey);
    }

    const snap = await queryRef.limit(500).get();
    const workers = prioritizeWorkers(docsToJson(snap), premiumActive)
      .map((worker) => ({ ...worker, isPremium: premiumActive(worker) }))
      .slice(0, limit);
    res.set("Cache-Control", "public, max-age=60");
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
      firestore: true,
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
