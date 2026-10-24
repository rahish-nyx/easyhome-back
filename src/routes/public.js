import { FieldValue } from "firebase-admin/firestore";
import { Router } from "express";
import { collections } from "../config/firebase.js";
import { asyncHandler } from "../middleware/errors.js";
import { appSettings } from "../lib/booking.js";
import { nearestServiceArea } from "../lib/geo.js";
import {
  OUT_OF_ZONE_MESSAGE,
  activeServiceZones,
  evaluateServiceZones,
} from "../lib/zones.js";
import { waitlistSchema } from "../lib/validate.js";
import { docToJson, docsToJson } from "../lib/utils.js";

export const publicRouter = Router();

/**
 * Single round-trip bootstrap payload for the PWA shell.
 * Cached at the edge for 60s; the client also caches it locally.
 */
publicRouter.get(
  "/bootstrap",
  asyncHandler(async (_req, res) => {
    const [servicesSnap, citiesSnap, zonesSnap, promosSnap, settings] = await Promise.all([
      collections.services.orderBy("order", "asc").get(),
      collections.cities.orderBy("name", "asc").get(),
      collections.serviceZones.get(),
      collections.promos.orderBy("order", "asc").get(),
      appSettings(),
    ]);

    const now = Date.now();
    const services = docsToJson(servicesSnap).filter(
      (service) => service.active !== false,
    );
    const cities = docsToJson(citiesSnap).filter((city) => city.active !== false);
    const zones = docsToJson(zonesSnap)
      .filter((zone) => zone.isActive !== false)
      .map((zone) => ({
        ...zone,
        latitude: Number(zone.latitude ?? zone.lat),
        longitude: Number(zone.longitude ?? zone.lng),
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

    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json({
      services,
      cities,
      zones,
      promos,
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
    const zones = await activeServiceZones();

    if (zones.length) {
      const result = evaluateServiceZones(zones, { lat, lng, cityName, state });
      if (!Number.isFinite(lat) && !Number.isFinite(lng) && !cityName) {
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
      lat: Number.isFinite(Number(body.lat)) ? Number(body.lat) : null,
      lng: Number.isFinite(Number(body.lng)) ? Number(body.lng) : null,
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
  "/workers",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);
    const serviceKey = req.query.serviceKey ? String(req.query.serviceKey) : "";

    let queryRef = collections.workersPublic.orderBy("rating", "desc");
    if (serviceKey) {
      queryRef = collections.workersPublic
        .where("serviceKey", "==", serviceKey)
        .orderBy("rating", "desc");
    }

    const snap = await queryRef.limit(limit).get();
    res.set("Cache-Control", "public, max-age=60");
    res.json({ workers: docsToJson(snap) });
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

    return res.json({
      worker: docToJson(workerSnap),
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
