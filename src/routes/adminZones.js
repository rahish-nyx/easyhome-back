import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { collections } from "../config/firebase.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  isStaleJob,
  idleMinutes,
  lastActivityAt,
  phaseForBooking,
  PHASE_META,
  sendTrackingNudge,
  trackingEta,
} from "../lib/tracking.js";
import {
  allServiceZones,
  normalizeZone,
  zonePoint,
} from "../lib/zones.js";
import { serviceZoneSchema } from "../lib/validate.js";
import { docToJson, docsToJson } from "../lib/utils.js";

export const adminZonesRouter = Router();
adminZonesRouter.use(requireAdmin);

async function audit(actorId, action, details = {}) {
  try {
    await collections.audit.add({
      actorId,
      action,
      details,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.warn("Audit write failed:", error.message);
  }
}

function pickProvided(schema, body) {
  const provided = new Set(Object.keys(body || {}));
  const parsed = schema.partial().parse(body || {});
  for (const key of Object.keys(parsed)) {
    if (!provided.has(key)) delete parsed[key];
  }
  return parsed;
}

/* ------------------------------ SERVICE ZONES ----------------------------- */

adminZonesRouter.get(
  "/zones",
  asyncHandler(async (_req, res) => {
    const [zones, waitlistSnap] = await Promise.all([
      allServiceZones(),
      collections.serviceWaitlist.limit(250).get(),
    ]);
    const waitlist = docsToJson(waitlistSnap).sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    );
    res.json({
      zones,
      waitlist,
      stats: {
        total: zones.length,
        active: zones.filter((zone) => zone.isActive !== false).length,
        waiting: waitlist.length,
      },
    });
  }),
);

adminZonesRouter.post(
  "/zones",
  asyncHandler(async (req, res) => {
    const body = serviceZoneSchema.parse(req.body || {});
    const existing = await allServiceZones();
    const duplicate = existing.find(
      (zone) =>
        String(zone.cityName || "").trim().toLowerCase() ===
          body.cityName.trim().toLowerCase() &&
        String(zone.state || "").trim().toLowerCase() ===
          body.state.trim().toLowerCase(),
    );
    if (duplicate) {
      throw new ApiError(
        409,
        "An operating zone already exists for this city and state.",
        "DUPLICATE_ZONE",
      );
    }

    const ref = collections.serviceZones.doc();
    await ref.set({
      ...body,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await audit(req.user.uid, "zone.create", { zoneId: ref.id, ...body });
    res.status(201).json({ zone: normalizeZone(docToJson(await ref.get())) });
  }),
);

adminZonesRouter.patch(
  "/zones/:id",
  asyncHandler(async (req, res) => {
    const updates = pickProvided(serviceZoneSchema, req.body);
    if (!Object.keys(updates).length) {
      throw new ApiError(422, "Nothing to update.", "NO_CHANGES");
    }
    const ref = collections.serviceZones.doc(req.params.id);
    if (!(await ref.get()).exists) {
      throw new ApiError(404, "Service zone not found.", "ZONE_NOT_FOUND");
    }
    await ref.set(
      { ...updates, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    await audit(req.user.uid, "zone.update", { zoneId: ref.id, ...updates });
    res.json({ ok: true, zone: normalizeZone(docToJson(await ref.get())) });
  }),
);

adminZonesRouter.delete(
  "/zones/:id",
  asyncHandler(async (req, res) => {
    const ref = collections.serviceZones.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new ApiError(404, "Service zone not found.", "ZONE_NOT_FOUND");
    }
    await ref.delete();
    await audit(req.user.uid, "zone.delete", {
      zoneId: req.params.id,
      cityName: snap.data().cityName || "",
    });
    res.json({ ok: true });
  }),
);

/* ----------------------------- LIVE FIELD OPS ----------------------------- */

adminZonesRouter.get(
  "/live-tracking",
  asyncHandler(async (_req, res) => {
    const snap = await collections.bookings
      .where("activeJob", "==", true)
      .limit(120)
      .get();
    const bookings = docsToJson(snap);
    const workerIds = [...new Set(bookings.map((booking) => booking.workerId).filter(Boolean))];
    const workerEntries = await Promise.all(
      workerIds.map(async (uid) => {
        const workerSnap = await collections.workers.doc(uid).get();
        return [uid, workerSnap.exists ? workerSnap.data() : null];
      }),
    );
    const workers = new Map(workerEntries);
    const now = Date.now();

    const jobs = bookings
      .map((booking) => {
        const worker = workers.get(booking.workerId) || null;
        const phase = phaseForBooking(booking);
        const lastActivity = lastActivityAt(booking);
        const eta = trackingEta(booking, worker);
        const point = zonePoint(booking.location);
        return {
          ...booking,
          phase,
          phaseLabel: PHASE_META[phase]?.label || booking.status,
          phaseHint: PHASE_META[phase]?.hint || "",
          workerPhone: worker?.phone || "",
          workerOnline: worker?.online !== false,
          workerLastSeenAt: worker?.lastSeenAt || null,
          tracker: {
            currentLat: Number.isFinite(Number(booking.currentLat))
              ? Number(booking.currentLat)
              : Number.isFinite(Number(worker?.currentLat))
                ? Number(worker.currentLat)
                : Number.isFinite(Number(worker?.lat))
                  ? Number(worker.lat)
                  : null,
            currentLng: Number.isFinite(Number(booking.currentLng))
              ? Number(booking.currentLng)
              : Number.isFinite(Number(worker?.currentLng))
                ? Number(worker.currentLng)
                : Number.isFinite(Number(worker?.lng))
                  ? Number(worker.lng)
                  : null,
            customerLat: point?.latitude ?? null,
            customerLng: point?.longitude ?? null,
            distanceMeters: eta.distanceMeters,
            etaMinutes: eta.etaMinutes,
            lastUpdatedAt: lastActivity ? lastActivity.toISOString() : null,
            lastLocationAt: booking.lastLocationAt || null,
            idleMinutes: idleMinutes(booking, now),
            inactive: isStaleJob(booking, now),
            alert: Boolean(booking.trackingAlert),
          },
        };
      })
      .sort((a, b) => {
        if (a.tracker.inactive !== b.tracker.inactive) return a.tracker.inactive ? -1 : 1;
        if (a.tracker.alert !== b.tracker.alert) return a.tracker.alert ? -1 : 1;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      });

    res.json({
      jobs,
      stats: {
        active: jobs.length,
        assigned: jobs.filter((job) => job.phase === "assigned").length,
        enRoute: jobs.filter((job) => job.phase === "en_route").length,
        arrived: jobs.filter((job) => job.phase === "arrived").length,
        working: jobs.filter((job) => job.phase === "working").length,
        inactive: jobs.filter((job) => job.tracker.inactive).length,
        alerts: jobs.filter((job) => job.tracker.alert).length,
      },
      generatedAt: new Date().toISOString(),
    });
  }),
);

adminZonesRouter.post(
  "/tracking/:id/nudge",
  asyncHandler(async (req, res) => {
    const ref = collections.bookings.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiError(404, "Booking not found.", "NOT_FOUND");
    const booking = snap.data();
    if (!booking.workerId) {
      throw new ApiError(409, "No worker is assigned to this booking.", "NO_WORKER");
    }
    if (!booking.activeJob) {
      throw new ApiError(409, "This tracking session is no longer active.", "TRACKING_INACTIVE");
    }
    const sent = await sendTrackingNudge(ref, booking, { actor: "admin" });
    await audit(req.user.uid, "tracking.nudge", { bookingId: ref.id });
    res.json({ ok: sent });
  }),
);

adminZonesRouter.get(
  "/waitlist",
  asyncHandler(async (_req, res) => {
    const snap = await collections.serviceWaitlist.limit(250).get();
    const waitlist = docsToJson(snap).sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    );
    res.json({ waitlist });
  }),
);
