import { Router } from "express";
import { FieldValue, Timestamp } from "../lib/values.js";
import { collections, db } from "../config/store.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireApprovedWorker, requireAuth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  availabilitySchema,
  commissionPaidSchema,
  jobPaymentModeSchema,
  priceSchema,
  trackingLocationSchema,
  trackingPhaseSchema,
  workerProfileSchema,
} from "../lib/validate.js";
import {
  appSettings,
  canAcceptJobs,
  commissionFor,
  feesPctFor,
  premiumActive,
} from "../lib/booking.js";
import {
  deleteStoredImage,
  uploadCloudinaryImage,
} from "../lib/media.js";
import { workerDistanceKm, workerMatchesBooking } from "../lib/matching.js";
import { jobFeedDocId, updateJobFeedStatus } from "../lib/jobFeed.js";
import { markReferralServiceCompleted } from "../lib/referrals.js";
import { notify, notifyAdmins, sendMail, emailLayout } from "../lib/notify.js";
import {
  commissionTelegramMessage,
  sendTelegramAlert,
  sendTelegramDocument,
} from "../lib/telegram.js";
import {
  AUTO_ARRIVE_METERS,
  AUTO_START_MINUTES,
  PHASE_META,
  TRACKING_PHASES,
  nextPhase,
  phaseForBooking,
  phaseHistoryEntry,
} from "../lib/tracking.js";
import { distanceMeters } from "../lib/geo.js";
import { docToJson, docsToJson, lastMonths, monthKey, toDate } from "../lib/utils.js";
import { allServiceZones } from "../lib/zones.js";

export const workerRouter = Router();

async function removeCompletedBookingImage(booking, bookingRef) {
  if (!booking.imagePath && !booking.imageCloudinaryId) return;
  try {
    await deleteStoredImage({
      path: booking.imagePath,
      cloudinaryId: booking.imageCloudinaryId,
    });
  } catch (error) {
    console.warn(
      "Completed booking image cleanup failed:",
      bookingRef.id,
      error.code || error.message,
    );
  }
}

function coordinate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function loadWorker(uid) {
  const snap = await collections.workers.doc(uid).get();
  if (!snap.exists) throw new ApiError(404, "Worker profile not found.", "WORKER_NOT_FOUND");
  return { snap, worker: snap.data() };
}

async function dispatchOpenJobsToWorker(uid, worker) {
  if (!worker?.online) return 0;
  const pending = await collections.bookings
    .where("status", "==", "pending")
    .orderBy("createdAt", "desc")
    .limit(200)
    .get();
  const matches = [];

  for (const doc of pending.docs) {
    const booking = { id: doc.id, ...doc.data() };
    if (booking.preferredWorkerId && booking.preferredWorkerId !== uid) continue;
    const zoneSnap = booking.serviceZoneId
      ? await collections.serviceZones.doc(booking.serviceZoneId).get()
      : null;
    const zone = zoneSnap?.exists
      ? { id: zoneSnap.id, ...zoneSnap.data(), isActive: zoneSnap.data().isActive !== false }
      : null;
    const matchingWorker = {
      ...worker,
      registeredLat: worker.registeredLat ?? zone?.latitude ?? null,
      registeredLng: worker.registeredLng ?? zone?.longitude ?? null,
    };
    const premium = premiumActive(worker);
    if (
      canAcceptJobs(worker, { premium }).allowed &&
      workerMatchesBooking({ ...matchingWorker, id: uid }, booking, zone)
    ) {
      const existingFeed = await collections.jobFeed.doc(jobFeedDocId(booking.id, uid)).get();
      // Only create the feed entry once. A feed that is already open means the
      // worker has been notified; "taken"/"hidden" means it was handled.
      if (!existingFeed.exists) {
        matches.push({ booking, zone });
      }
    }
  }

  if (!matches.length) return 0;
  const now = FieldValue.serverTimestamp();
  const feedBatch = db.batch();
  const notificationBatch = db.batch();
  for (const { booking, zone } of matches) {
    feedBatch.set(
      collections.jobFeed.doc(jobFeedDocId(booking.id, uid)),
      {
        bookingId: booking.id,
        workerId: uid,
        service: booking.service,
        serviceKey: booking.serviceKey,
        customerName: booking.customerName || "Customer",
        customerPhotoPath: booking.customerPhotoPath || "",
        description: String(booking.description || "").slice(0, 180),
        area: booking.area,
        addressLabel: booking.location?.label || "",
        imagePath: booking.imagePath || "",
        lat: booking.location?.lat ?? null,
        lng: booking.location?.lng ?? null,
        cityName: booking.cityName || "",
        stateName: booking.stateName || "",
        areaName: booking.areaName || "",
        serviceZoneId: zone?.id || booking.serviceZoneId || null,
        serviceZoneLatitude: zone?.latitude ?? booking.serviceZoneLatitude ?? null,
        serviceZoneLongitude: zone?.longitude ?? booking.serviceZoneLongitude ?? null,
        serviceZoneRadiusKm: zone?.radiusKm ?? booking.serviceZoneRadiusKm ?? null,
        priority: booking.customerPriority || "standard",
        customerPremium: Boolean(booking.customerPremium),
        customerPriority: booking.customerPriority || "standard",
        budget: Number(booking.budget) || 0,
        urgency: booking.urgency || "normal",
        status: "open",
        preferredWorkerId: booking.preferredWorkerId || "",
        createdAt: booking.createdAt || now,
        updatedAt: now,
      },
      { merge: true },
    );
    const notificationRef = collections.notifications.doc();
    notificationBatch.set(notificationRef, {
      userId: uid,
      title: booking.customerPriority === "pro" ? "Priority job near you" : "New job near you",
      body: booking.service + " · " + booking.area + " · ₹" + (Number(booking.budget) || 0),
      type: "new_job",
      priority: booking.customerPriority || "standard",
      link: "/worker?job=" + booking.id,
      read: false,
      createdAt: now,
    });
  }
  await Promise.all([feedBatch.commit(), notificationBatch.commit()]);
  return matches.length;
}

async function assertOwnJob(tx, bookingId, uid) {
  const ref = collections.bookings.doc(bookingId);
  const snap = await tx.get(ref);
  if (!snap.exists) throw new ApiError(404, "Booking not found.", "BOOKING_NOT_FOUND");
  const booking = snap.data();
  if (booking.workerId !== uid) {
    throw new ApiError(403, "This job is assigned to another worker.", "JOB_FORBIDDEN");
  }
  return { ref, booking };
}

workerRouter.patch(
  "/worker/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = workerProfileSchema.parse(req.body || {});
    const { snap, worker } = await loadWorker(req.user.uid);

    const updates = { updatedAt: FieldValue.serverTimestamp() };
    for (const key of [
      "name",
      "service",
      "serviceKey",
      "area",
      "city",
      "state",
      "areaName",
      "bio",
      "upiId",
    ]) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.pricePerWork !== undefined) {
      updates.pricePerWork = Math.max(0, Math.round(body.pricePerWork));
    }
    if (body.lat !== undefined) {
      updates.lat = body.lat;
      updates.registeredLat = body.lat;
    }
    if (body.lng !== undefined) {
      updates.lng = body.lng;
      updates.registeredLng = body.lng;
    }
    if (body.online !== undefined) {
      if (body.online && worker.status !== "approved") {
        throw new ApiError(403, "You can go online after approval.", "NOT_APPROVED");
      }
      updates.online = body.online;
    }

    await snap.ref.set(updates, { merge: true });

    if (worker.status === "approved") {
      const publicUpdates = {
        updatedAt: FieldValue.serverTimestamp(),
      };
      for (const key of [
        "name",
        "service",
        "serviceKey",
        "area",
        "city",
        "state",
        "areaName",
        "photoPath",
        "online",
      ]) {
        if (updates[key] !== undefined) publicUpdates[key] = updates[key];
      }
      if (updates.pricePerWork !== undefined) publicUpdates.pricePerWork = updates.pricePerWork;
      if (updates.lat !== undefined) publicUpdates.lat = updates.lat;
      if (updates.lng !== undefined) publicUpdates.lng = updates.lng;
      await collections.workersPublic.doc(req.user.uid).set(publicUpdates, { merge: true });
    }

    const fresh = await snap.ref.get();
    res.json({ worker: docToJson(fresh) });
  }),
);

workerRouter.patch(
  "/worker/availability",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const { online, lat, lng } = availabilitySchema.parse(req.body || {});
    const now = FieldValue.serverTimestamp();
    const location = {};
    const workerSnap = await collections.workers.doc(req.user.uid).get();
    const worker = workerSnap.exists ? workerSnap.data() : {};
    const hasRegisteredPoint = coordinate(worker.registeredLat) !== null && coordinate(worker.registeredLng) !== null;
    if (!hasRegisteredPoint) {
      const zones = await allServiceZones();
      const zone = zones.find((candidate) => {
        const sameCity = String(candidate.cityName || "").trim().toLowerCase() === String(worker.city || "").trim().toLowerCase();
        const sameState = String(candidate.state || candidate.stateName || "").trim().toLowerCase() === String(worker.state || "").trim().toLowerCase();
        const workerArea = String(worker.areaName || "").trim().toLowerCase();
        const zoneArea = String(candidate.areaName || "").trim().toLowerCase();
        return sameCity && sameState && (!zoneArea || !workerArea || zoneArea === workerArea);
      });
      if (zone && coordinate(zone.latitude) !== null && coordinate(zone.longitude) !== null) {
        location.registeredLat = Number(zone.latitude);
        location.registeredLng = Number(zone.longitude);
      }
    }
    if (lat !== undefined) {
      location.currentLat = lat;
    }
    if (lng !== undefined) {
      location.currentLng = lng;
    }
    location.lastLocationAt = now;
    await collections.workers.doc(req.user.uid).set(
      { online, ...location, lastSeenAt: now, updatedAt: now },
      { merge: true },
    );
    await collections.workersPublic.doc(req.user.uid).set(
      { online, ...location, updatedAt: now },
      { merge: true },
    );
    if (online) {
      try {
        const freshWorker = await collections.workers.doc(req.user.uid).get();
        await dispatchOpenJobsToWorker(req.user.uid, {
          ...(freshWorker.data() || {}),
          online: true,
        });
      } catch (error) {
        console.warn("Open-job dispatch on availability change failed:", error.message);
      }
    }
    res.json({ online });
  }),
);

workerRouter.post(
  "/worker/jobs/:id/accept",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const bookingRef = collections.bookings.doc(req.params.id);
    const workerRef = collections.workers.doc(uid);
    const feedRef = collections.jobFeed.doc(jobFeedDocId(req.params.id, uid));

    // Keep the one-active-job rule authoritative on the server. The worker
    // document lock handles new jobs, while the query also catches legacy
    // bookings created before the lock field was introduced.
    const activeJobs = await collections.bookings
      .where("workerId", "==", uid)
      .where("activeJob", "==", true)
      .limit(2)
      .get();
    const legacyActiveJob = activeJobs.docs.find((doc) => doc.id !== req.params.id);
    if (legacyActiveJob) {
      throw new ApiError(
        409,
        "Complete or cancel your current active job before accepting another.",
        "ACTIVE_JOB_EXISTS",
        { activeBookingId: legacyActiveJob.id },
      );
    }

    const result = await db.runTransaction(async (tx) => {
      const bookingSnap = await tx.get(bookingRef);
      const workerSnap = await tx.get(workerRef);
      const feedSnap = await tx.get(feedRef);

      if (!bookingSnap.exists) throw new ApiError(404, "Job not found.", "BOOKING_NOT_FOUND");
      if (!workerSnap.exists) throw new ApiError(404, "Worker profile not found.", "WORKER_NOT_FOUND");
      if (
        !feedSnap.exists ||
        feedSnap.data().workerId !== uid ||
        feedSnap.data().status !== "open"
      ) {
        throw new ApiError(
          403,
          "This job was not dispatched to your service area.",
          "JOB_NOT_DISPATCHED",
        );
      }

      const booking = bookingSnap.data();
      const worker = workerSnap.data();
      if (worker.activeJobBookingId && worker.activeJobBookingId !== req.params.id) {
        throw new ApiError(
          409,
          "Complete or cancel your current active job before accepting another.",
          "ACTIVE_JOB_EXISTS",
          { activeBookingId: worker.activeJobBookingId },
        );
      }
      const zoneSnap = booking.serviceZoneId
        ? await tx.get(collections.serviceZones.doc(booking.serviceZoneId))
        : null;
      const zone = zoneSnap?.exists
        ? {
            id: zoneSnap.id,
            ...zoneSnap.data(),
            isActive: zoneSnap.data().isActive !== false,
          }
        : null;
      const premium = premiumActive(worker);
      const gate = canAcceptJobs(worker, { premium });

      if (!gate.allowed) {
        const messages = {
          offline: "Go online to accept new jobs.",
          active_job: "Complete or cancel your current active job before accepting another.",
          dues: `Pay ₹${gate.dues} in fees before accepting new jobs.`,
          not_approved: "Your worker account is not approved yet.",
          no_worker_profile: "Complete your worker profile first.",
        };
        throw new ApiError(
          409,
          messages[gate.reason] || "You cannot accept jobs right now.",
          "CANNOT_ACCEPT",
          gate,
        );
      }

      if (booking.status !== "pending") {
        throw new ApiError(409, "This job was already taken or cancelled.", "JOB_TAKEN");
      }
      const workerTrades = Array.isArray(worker.trades) ? worker.trades : [];
      if (booking.serviceKey !== worker.serviceKey && !workerTrades.includes(booking.serviceKey)) {
        throw new ApiError(403, "This job is for a different trade.", "SERVICE_MISMATCH");
      }
      if (booking.preferredWorkerId && booking.preferredWorkerId !== uid) {
        throw new ApiError(403, "This job was reserved for another worker.", "JOB_RESERVED");
      }

      if (zone && zone.isActive !== true) {
        throw new ApiError(
          403,
          "This job is outside your registered service area or its active radius.",
          "OUT_OF_SERVICE_AREA",
        );
      }

      const matchingWorker = {
        ...worker,
        registeredLat: worker.registeredLat ?? zone?.latitude ?? null,
        registeredLng: worker.registeredLng ?? zone?.longitude ?? null,
      };
      if (!workerMatchesBooking({ ...matchingWorker, id: uid }, booking, zone)) {
        throw new ApiError(
          403,
          "This job is outside your registered service zone or radius.",
          "OUT_OF_SERVICE_AREA",
        );
      }

      const now = FieldValue.serverTimestamp();
      const workerLat = coordinate(worker.currentLat) ?? coordinate(worker.lat);
      const workerLng = coordinate(worker.currentLng) ?? coordinate(worker.lng);

      await tx.update(bookingRef, {
        workerId: uid,
        workerName: worker.name,
        workerPhotoPath: worker.photoPath || "",
        status: "accepted",
        activeJob: true,
        trackingPhase: TRACKING_PHASES.ASSIGNED,
        currentLat: workerLat,
        currentLng: workerLng,
        lastLocationAt: workerLat !== null && workerLng !== null ? now : null,
        lastUpdatedTimestamp: now,
        trackingStatusUpdatedAt: now,
        trackingAlert: false,
        trackingNudgeCount: 0,
        acceptedAt: now,
        updatedAt: now,
        statusHistory: FieldValue.arrayUnion(
          phaseHistoryEntry({
            phase: TRACKING_PHASES.ASSIGNED,
            status: "accepted",
            actorId: uid,
            actorRole: "worker",
            lat: workerLat,
            lng: workerLng,
          }),
        ),
      });
      await tx.set(
        workerRef,
        { activeJobBookingId: req.params.id, updatedAt: now },
        { merge: true },
      );
      await tx.set(
        feedRef,
        { status: "taken", workerId: uid, updatedAt: now },
        { merge: true },
      );
      await tx.delete(collections.urgentPublic.doc(bookingRef.id));

      return {
        booking: {
          ...booking,
          workerId: uid,
          workerName: worker.name,
          status: "accepted",
          activeJob: true,
          trackingPhase: TRACKING_PHASES.ASSIGNED,
        },
        customerId: booking.customerId,
        service: booking.service,
      };
    });

    try {
      await updateJobFeedStatus(bookingRef.id, "taken");
    } catch (error) {
      console.error("Could not close other worker job-feed entries:", error.code || error.message);
    }

    await notify(result.customerId, {
      title: "Worker found!",
      body: `${result.booking.workerName} accepted your ${result.service} booking.`,
      type: "job_accepted",
      link: `/bookings/${req.params.id}/track`,
    });

    res.json({ ok: true, booking: { id: req.params.id, ...result.booking } });
  }),
);

workerRouter.patch(
  "/worker/jobs/:id/price",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const { price } = priceSchema.parse(req.body || {});
    const uid = req.user.uid;
    const settings = await appSettings();
    const bookingRef = collections.bookings.doc(req.params.id);

    const result = await db.runTransaction(async (tx) => {
      const { booking } = await assertOwnJob(tx, req.params.id, uid);
      if (booking.status !== "accepted") {
        throw new ApiError(409, "Set a price after accepting the job.", "STATUS_INVALID");
      }
      if (booking.pricing?.confirmedAt) {
        throw new ApiError(409, "The price is already confirmed.", "PRICE_CONFIRMED");
      }

      const workerSnap = await tx.get(collections.workers.doc(uid));
      const worker = workerSnap.data();
      const { commission, workerReceives } = commissionFor(
        price,
        feesPctFor(settings),
        {
          premium: premiumActive(worker),
        },
      );

      await tx.update(bookingRef, {
        "pricing.workerPrice": Math.round(price),
        "pricing.commission": commission,
        "pricing.workerReceives": workerReceives,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { booking, commission, workerReceives };
    });

    await notify(result.booking.customerId, {
      title: "Final price quoted",
      body: `${result.booking.workerName} quoted ₹${Math.round(price)} for ${result.booking.service}. Confirm or send a counter-offer.`,
      type: "price",
      link: "/bookings",
    });

    res.json({ ok: true, commission: result.commission, workerReceives: result.workerReceives });
  }),
);

workerRouter.patch(
  "/worker/jobs/:id/confirm",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const body = priceSchema.partial().parse(req.body || {});
    const uid = req.user.uid;
    const bookingRef = collections.bookings.doc(req.params.id);

    const result = await db.runTransaction(async (tx) => {
      const { booking } = await assertOwnJob(tx, req.params.id, uid);
      if (booking.status !== "accepted") {
        throw new ApiError(409, "This job is not in a negotiable state.", "STATUS_INVALID");
      }
      if (booking.pricing?.confirmedAt) {
        throw new ApiError(409, "The price is already confirmed.", "PRICE_CONFIRMED");
      }

      const finalPrice = Math.round(
        Number(body.price) || Number(booking.pricing?.customerOffer) || Number(booking.pricing?.workerPrice) || 0,
      );
      if (finalPrice < 99) {
        throw new ApiError(422, "Set a valid final price first.", "PRICE_REQUIRED");
      }

      await tx.update(bookingRef, {
        status: "accepted",
        "pricing.finalPrice": finalPrice,
        "pricing.confirmedAt": FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { booking, finalPrice };
    });

    await notify(result.booking.customerId, {
      title: "Price confirmed",
      body: `₹${result.finalPrice} confirmed for ${result.booking.service}. ${result.booking.workerName} will contact you shortly.`,
      type: "price",
      link: "/bookings",
    });

    res.json({ ok: true, finalPrice: result.finalPrice });
  }),
);

workerRouter.patch(
  "/worker/jobs/:id/start",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const bookingRef = collections.bookings.doc(req.params.id);

    const result = await db.runTransaction(async (tx) => {
      const { booking } = await assertOwnJob(tx, req.params.id, uid);
      if (["completed", "cancelled"].includes(booking.status)) {
        throw new ApiError(409, "This job is already closed.", "STATUS_INVALID");
      }
      if (!booking.pricing?.confirmedAt) {
        throw new ApiError(409, "Confirm the final price before starting.", "PRICE_NOT_CONFIRMED");
      }
      const currentPhase = phaseForBooking(booking);
      if (currentPhase === TRACKING_PHASES.WORKING) {
        throw new ApiError(409, "This job has already been started.", "STATUS_INVALID");
      }

      // The explicit Start button is the authoritative hand-off into the
      // working phase. Complete the preparatory milestones atomically so the
      // timer cannot start in the UI while the booking remains assigned.
      await tx.update(bookingRef, {
        status: "ongoing",
        trackingPhase: TRACKING_PHASES.WORKING,
        enRouteAt: FieldValue.serverTimestamp(),
        arrivedAt: FieldValue.serverTimestamp(),
        startedAt: FieldValue.serverTimestamp(),
        activeJob: true,
        lastUpdatedTimestamp: FieldValue.serverTimestamp(),
        trackingStatusUpdatedAt: FieldValue.serverTimestamp(),
        trackingAlert: false,
        updatedAt: FieldValue.serverTimestamp(),
        statusHistory: FieldValue.arrayUnion(
          phaseHistoryEntry({
            phase: TRACKING_PHASES.WORKING,
            status: "ongoing",
            actorId: uid,
            actorRole: "worker",
          }),
        ),
      });
      return { booking };
    });

    await notify(result.booking.customerId, {
      title: "Work has started",
      body: `${result.booking.workerName} started the ${result.booking.service} job.`,
      type: "job_started",
      link: `/bookings/${req.params.id}/track`,
    });

    res.json({ ok: true, phase: TRACKING_PHASES.WORKING });
  }),
);

workerRouter.patch(
  "/worker/jobs/:id/phase",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const body = trackingPhaseSchema.parse(req.body || {});
    const uid = req.user.uid;
    const bookingRef = collections.bookings.doc(req.params.id);
    const workerRef = collections.workers.doc(uid);
    const phase = body.phase;
    const meta = PHASE_META[phase];
    if (!meta) throw new ApiError(422, "Unknown tracking phase.", "PHASE_INVALID");

    const result = await db.runTransaction(async (tx) => {
      const { booking } = await assertOwnJob(tx, req.params.id, uid);
      if (["completed", "cancelled"].includes(booking.status)) {
        throw new ApiError(409, "This job is already closed.", "STATUS_INVALID");
      }
      if (booking.status === "pending") {
        throw new ApiError(409, "Accept this job before updating its phase.", "STATUS_INVALID");
      }

      const currentPhase = phaseForBooking(booking);
      if (currentPhase === phase) {
        const now = FieldValue.serverTimestamp();
        await tx.update(bookingRef, {
          status: meta.status,
          trackingPhase: phase,
          lastUpdatedTimestamp: now,
          trackingStatusUpdatedAt: now,
          trackingAlert: false,
          updatedAt: now,
        });
        return { booking, unchanged: true, phase };
      }
      if (phase !== nextPhase(currentPhase)) {
        const currentLabel = PHASE_META[currentPhase]?.label || currentPhase || "not started";
        throw new ApiError(
          409,
          `The job is currently ${currentLabel}. Complete the current step first.`,
          "PHASE_OUT_OF_ORDER",
          { currentPhase, requestedPhase: phase, nextPhase: nextPhase(currentPhase) },
        );
      }
      if (
        [TRACKING_PHASES.WORKING, TRACKING_PHASES.COMPLETED].includes(phase) &&
        !booking.pricing?.confirmedAt
      ) {
        throw new ApiError(409, "Confirm the final price first.", "PRICE_NOT_CONFIRMED");
      }

      const hasPoint =
        Number.isFinite(Number(body.lat)) && Number.isFinite(Number(body.lng));
      const now = FieldValue.serverTimestamp();
      const updates = {
        status: meta.status,
        trackingPhase: phase,
        activeJob: phase !== TRACKING_PHASES.COMPLETED,
        lastUpdatedTimestamp: now,
        trackingStatusUpdatedAt: now,
        trackingAlert: false,
        updatedAt: now,
        statusHistory: FieldValue.arrayUnion(
          phaseHistoryEntry({
            phase,
            status: meta.status,
            actorId: uid,
            actorRole: "worker",
            lat: hasPoint ? Number(body.lat) : null,
            lng: hasPoint ? Number(body.lng) : null,
            note: body.note || "",
          }),
        ),
      };

      if (hasPoint) {
        updates.currentLat = Number(body.lat);
        updates.currentLng = Number(body.lng);
        updates.currentAccuracy = Number.isFinite(Number(body.accuracy))
          ? Number(body.accuracy)
          : null;
        updates.lastLocationAt = now;
      }

      if (phase === TRACKING_PHASES.EN_ROUTE) updates.enRouteAt = now;
      if (phase === TRACKING_PHASES.ARRIVED) updates.arrivedAt = now;
      if (phase === TRACKING_PHASES.WORKING) {
        updates.startedAt = booking.startedAt || now;
      }
      if (phase === TRACKING_PHASES.COMPLETED) {
        updates.completedAt = now;
        updates.currentLat = null;
        updates.currentLng = null;
        updates.imagePath = FieldValue.delete();
        updates.imageCloudinaryId = FieldValue.delete();
        await tx.set(
          workerRef,
          {
            activeJobBookingId: FieldValue.delete(),
            currentLat: FieldValue.delete(),
            currentLng: FieldValue.delete(),
            lastLocationAt: FieldValue.delete(),
            jobsCompleted: FieldValue.increment(1),
            updatedAt: now,
          },
          { merge: true },
        );
        await tx.set(
          collections.workersPublic.doc(uid),
          { jobsCompleted: FieldValue.increment(1), updatedAt: now },
          { merge: true },
        );
      }

      await tx.update(bookingRef, updates);
      return { booking, phase };
    });

    if (result.phase === TRACKING_PHASES.COMPLETED) {
      await removeCompletedBookingImage(result.booking, bookingRef);
      await markReferralServiceCompleted(
        result.booking.customerId,
        req.params.id,
      ).catch((error) => {
        console.warn("Referral completion update failed:", error.message);
      });
      if (result.booking.workerId) {
        await markReferralServiceCompleted(
          result.booking.workerId,
          req.params.id,
        ).catch((error) => {
          console.warn("Worker referral completion update failed:", error.message);
        });
      }
    }

    if (!result.unchanged) {
      const notificationByPhase = {
        [TRACKING_PHASES.EN_ROUTE]: {
          title: "Worker is on the way",
          body: `${result.booking.workerName} is heading to your ${result.booking.service} job.`,
          type: "job_started",
        },
        [TRACKING_PHASES.ARRIVED]: {
          title: "Your pro has arrived",
          body: `${result.booking.workerName} reached your location for ${result.booking.service}.`,
          type: "job_arrived",
        },
        [TRACKING_PHASES.WORKING]: {
          title: "Work has started",
          body: `${result.booking.workerName} started the ${result.booking.service} job.`,
          type: "job_started",
        },
        [TRACKING_PHASES.COMPLETED]: {
          title: "Job completed",
          body: `Confirm the payment for ${result.booking.service} and leave a review.`,
          type: "job_completed",
        },
      };
      const notification = notificationByPhase[phase];
      if (notification) {
        await notify(result.booking.customerId, {
          ...notification,
          link:
            phase === TRACKING_PHASES.COMPLETED
              ? "/bookings"
              : `/bookings/${req.params.id}/track`,
        });
      }
      if (phase === TRACKING_PHASES.ARRIVED) {
        await notify(uid, {
          title: "You have arrived your destination",
          body: `Working point reached for ${result.booking.service}. Start work now, or the timer starts automatically in ${AUTO_START_MINUTES} minutes.`,
          type: "job_arrived",
          link: `/worker?tab=track&job=${req.params.id}`,
        });
      }
    }

    res.json({ ok: true, phase: result.phase });
  }),
);

workerRouter.patch(
  "/worker/jobs/:id/location",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const body = trackingLocationSchema.parse(req.body || {});
    const uid = req.user.uid;
    const bookingRef = collections.bookings.doc(req.params.id);
    const workerRef = collections.workers.doc(uid);

    const result = await db.runTransaction(async (tx) => {
      const { booking } = await assertOwnJob(tx, req.params.id, uid);
      if (!booking.activeJob || !["accepted", "ongoing"].includes(booking.status)) {
        throw new ApiError(409, "This job is not active for tracking.", "TRACKING_INACTIVE");
      }
      if (phaseForBooking(booking) === TRACKING_PHASES.COMPLETED) {
        throw new ApiError(409, "This job is already completed.", "TRACKING_INACTIVE");
      }

      const now = FieldValue.serverTimestamp();
      const currentPhase = phaseForBooking(booking);
      const targetLat = Number(booking.location?.lat);
      const targetLng = Number(booking.location?.lng);
      const meters =
        Number.isFinite(targetLat) && Number.isFinite(targetLng)
          ? distanceMeters(
              { lat: Number(body.lat), lng: Number(body.lng) },
              { lat: targetLat, lng: targetLng },
            )
          : null;
      const autoArrived =
        meters !== null &&
        meters <= AUTO_ARRIVE_METERS &&
        Boolean(booking.pricing?.confirmedAt) &&
        [TRACKING_PHASES.ASSIGNED, TRACKING_PHASES.EN_ROUTE].includes(currentPhase);

      const updates = {
        currentLat: body.lat,
        currentLng: body.lng,
        currentAccuracy: Number.isFinite(Number(body.accuracy))
          ? Number(body.accuracy)
          : null,
        currentHeading: Number.isFinite(Number(body.heading)) ? Number(body.heading) : null,
        currentSpeed: Number.isFinite(Number(body.speed)) ? Number(body.speed) : null,
        lastLocationAt: now,
        lastUpdatedTimestamp: now,
        trackingAlert: false,
        updatedAt: now,
      };

      if (autoArrived) {
        updates.trackingPhase = TRACKING_PHASES.ARRIVED;
        updates.arrivedAt = now;
        updates.trackingStatusUpdatedAt = now;
        updates.statusHistory = FieldValue.arrayUnion(
          phaseHistoryEntry({
            phase: TRACKING_PHASES.ARRIVED,
            status: "accepted",
            actorId: uid,
            actorRole: "system",
            lat: Number(body.lat),
            lng: Number(body.lng),
            note: "Auto-detected arrival inside the service geofence.",
          }),
        );
      }

      await tx.update(bookingRef, updates);
      await tx.set(
        workerRef,
        {
          currentLat: body.lat,
          currentLng: body.lng,
          lastSeenAt: now,
          updatedAt: now,
        },
        { merge: true },
      );
      return {
        booking,
        autoArrived,
        distanceMeters: meters,
        phase: autoArrived ? TRACKING_PHASES.ARRIVED : currentPhase,
      };
    });

    if (result.autoArrived) {
      await Promise.allSettled([
        notify(result.booking.customerId, {
          title: "Your pro has arrived",
          body: `${result.booking.workerName || "Your professional"} reached the working point for ${result.booking.service}.`,
          type: "job_arrived",
          link: `/bookings/${req.params.id}/track`,
        }),
        notify(uid, {
          title: "You have arrived your destination",
          body: `Working point reached for ${result.booking.service}. Start work now, or the job timer starts automatically in ${AUTO_START_MINUTES} minutes.`,
          type: "job_arrived",
          link: `/worker?tab=track&job=${req.params.id}`,
        }),
      ]);
    }

    res.json({
      ok: true,
      bookingId: req.params.id,
      activeJob: Boolean(result.booking.activeJob),
      autoArrived: result.autoArrived,
      phase: result.phase,
      distanceMeters: result.distanceMeters,
      receivedAt: new Date().toISOString(),
    });
  }),
);

workerRouter.patch(
  "/worker/jobs/:id/complete",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const bookingRef = collections.bookings.doc(req.params.id);
    const workerRef = collections.workers.doc(uid);
    const settings = await appSettings();

    const result = await db.runTransaction(async (tx) => {
      const { booking } = await assertOwnJob(tx, req.params.id, uid);
      // Accept all started phases so legacy bookings that were left in
      // en-route/arrived state can still be completed from the worker card.
      const currentPhase = phaseForBooking(booking);
      const hasStarted =
        booking.status === "ongoing" ||
        Boolean(booking.startedAt) ||
        [TRACKING_PHASES.EN_ROUTE, TRACKING_PHASES.ARRIVED, TRACKING_PHASES.WORKING].includes(
          currentPhase,
        );
      if (!hasStarted) {
        throw new ApiError(409, "Only ongoing jobs can be completed.", "STATUS_INVALID");
      }
      if (!booking.pricing?.confirmedAt) {
        throw new ApiError(409, "Confirm the final price first.", "PRICE_NOT_CONFIRMED");
      }
      const workerSnap = await tx.get(workerRef);
      const worker = workerSnap.exists ? workerSnap.data() : {};
      const finalPrice = Math.round(
        Number(booking.pricing?.finalPrice) ||
          Number(booking.pricing?.workerPrice) ||
          Number(booking.budget) ||
          0,
      );
      const { commission } = commissionFor(finalPrice, feesPctFor(settings), {
        premium: premiumActive(worker),
      });
      const now = FieldValue.serverTimestamp();
      await tx.update(bookingRef, {
        status: "completed",
        trackingPhase: TRACKING_PHASES.COMPLETED,
        activeJob: false,
        currentLat: null,
        currentLng: null,
        imagePath: FieldValue.delete(),
        imageCloudinaryId: FieldValue.delete(),
        trackingAlert: false,
        completedAt: now,
        lastUpdatedTimestamp: now,
        trackingStatusUpdatedAt: now,
        updatedAt: now,
        "pricing.commission": commission,
        statusHistory: FieldValue.arrayUnion(
          phaseHistoryEntry({
            phase: TRACKING_PHASES.COMPLETED,
            status: "completed",
            actorId: uid,
            actorRole: "worker",
          }),
        ),
      });
      await tx.set(
        workerRef,
        {
          activeJobBookingId: FieldValue.delete(),
          jobsCompleted: FieldValue.increment(1),
          updatedAt: now,
        },
        { merge: true },
      );
      await tx.set(
        collections.workersPublic.doc(uid),
        { jobsCompleted: FieldValue.increment(1), updatedAt: now },
        { merge: true },
      );

      // Non-Pro platform fees are raised the moment the job is completed, so
      // the worker sees "Fees Due" immediately instead of waiting for the
      // customer to confirm payment. The deterministic document id keeps the
      // later customer payment confirmation idempotent.
      let feesRaised = 0;
      if (commission > 0) {
        const commissionRef = collections.commissions.doc(`fee_${bookingRef.id}`);
        const existing = await tx.get(commissionRef);
        if (!existing.exists) {
          await tx.set(commissionRef, {
            workerId: uid,
            workerName: booking.workerName || worker.name || "Worker",
            bookingId: bookingRef.id,
            service: booking.service,
            amount: commission,
            status: "pending",
            note: "",
            createdAt: now,
            updatedAt: now,
          });
          await tx.set(
            workerRef,
            {
              dues: FieldValue.increment(commission),
              dueCommissionAmount: FieldValue.increment(commission),
              hasPendingCommission: true,
              updatedAt: now,
            },
            { merge: true },
          );
          feesRaised = commission;
        }
      }
      return { booking, commission, feesRaised };
    });

    await removeCompletedBookingImage(result.booking, bookingRef);

    await notify(result.booking.customerId, {
      title: "Job completed",
      body: `Confirm the payment for ${result.booking.service} and leave a review.`,
      type: "job_completed",
      link: "/bookings",
    });

    if (result.feesRaised > 0) {
      await notify(uid, {
        title: "Platform fee due",
        body: `₹${result.feesRaised} platform fee is now due for ${result.booking.service}. Pay from Fees Due to keep accepting jobs.`,
        type: "commission",
        link: "/worker?tab=earnings",
      });
    }

    await markReferralServiceCompleted(
      result.booking.customerId,
      bookingRef.id,
    ).catch((error) => {
      console.warn("Referral completion update failed:", error.message);
    });
    if (result.booking.workerId) {
      await markReferralServiceCompleted(
        result.booking.workerId,
        bookingRef.id,
      ).catch((error) => {
        console.warn("Worker referral completion update failed:", error.message);
      });
    }

    res.json({
      ok: true,
      phase: TRACKING_PHASES.COMPLETED,
      commission: result.commission,
      feesDue: result.feesRaised,
      paymentOptions: ["upi", "cash"],
    });
  }),
);

workerRouter.post(
  "/worker/jobs/:id/hide-history",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const ref = collections.bookings.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().workerId !== uid) {
      throw new ApiError(404, "Job not found.", "JOB_NOT_FOUND");
    }
    if (snap.data().status !== "completed") {
      throw new ApiError(409, "Only completed jobs can be removed from history.", "STATUS_INVALID");
    }
    await ref.set(
      { workerHidden: true, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    res.json({ ok: true });
  }),
);

workerRouter.post(
  "/worker/jobs/:id/payment-mode",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const body = jobPaymentModeSchema.parse(req.body || {});
    const uid = req.user.uid;
    const bookingRef = collections.bookings.doc(req.params.id);

    const result = await db.runTransaction(async (tx) => {
      const { booking } = await assertOwnJob(tx, req.params.id, uid);
      if (booking.status !== "completed") {
        throw new ApiError(
          409,
          "Complete the job before recording how payment was collected.",
          "STATUS_INVALID",
        );
      }
      const now = FieldValue.serverTimestamp();
      await tx.update(bookingRef, {
        workerPaymentMode: body.mode,
        workerPaymentReference: body.reference || "",
        workerPaymentRecordedAt: now,
        paymentStatus: "awaiting_customer",
        updatedAt: now,
      });
      return { booking };
    });

    await notify(result.booking.customerId, {
      title: body.mode === "upi" ? "UPI payment requested" : "Cash payment requested",
      body: `${result.booking.workerName || "Your pro"} marked this job as payable by ${
        body.mode === "upi" ? "UPI" : "cash"
      }. Confirm the payment once done.`,
      type: "payment",
      link: `/bookings/${req.params.id}/track`,
    });

    res.json({ ok: true, mode: body.mode });
  }),
);

workerRouter.post(
  "/worker/commission/:bookingId/paid",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    throw new ApiError(
      410,
      "Manual UTR payments are disabled. Use the Razorpay checkout.",
      "MANUAL_PAYMENT_DISABLED",
    );
    // Legacy manual flow retained below only as historical reference.
    const { note, utrId } = commissionPaidSchema.parse(req.body || {});
    const uid = req.user.uid;
    const reference = String(utrId || note || "")
      .replace(/\s+/g, "")
      .toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{5,63}$/.test(reference)) {
      throw new ApiError(
        422,
        "Enter a valid UTR / transaction reference from your payment app.",
        "UTR_REQUIRED",
      );
    }

    const snap = await collections.commissions
      .where("workerId", "==", uid)
      .where("bookingId", "==", req.params.bookingId)
      .limit(1)
      .get();

    if (snap.empty) {
      throw new ApiError(404, "No fees are due for this job.", "COMMISSION_NOT_FOUND");
    }

    const commissionDoc = snap.docs[0];
    const commission = commissionDoc.data();
    if (commission.status === "approved") {
      throw new ApiError(409, "This fee is already approved.", "ALREADY_APPROVED");
    }
    if (commission.status === "paid") {
      throw new ApiError(
        409,
        "This payment is already submitted and waiting for admin approval.",
        "PAYMENT_PENDING",
      );
    }

    await commissionDoc.ref.update({
      status: "paid",
      utrId: reference,
      note: reference,
      rejectionReason: FieldValue.delete(),
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await notifyAdmins({
      title: "Fees payment submitted",
      body: `${req.user.name || "A worker"} submitted ₹${commission.amount} for ${commission.service}. UTR: ${reference}`,
      type: "commission",
      link: "/admin/revenue",
    });

    await sendTelegramAlert(
      commissionTelegramMessage({
        workerName: commission.workerName || req.user.name,
        workerId: uid,
        service: commission.service,
        bookingId: commission.bookingId,
        amount: commission.amount,
        utrId: reference,
      }),
    );

    res.json({ ok: true });
  }),
);

workerRouter.get(
  "/worker/bookings",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const snap = await collections.bookings
      .where("workerId", "==", req.user.uid)
      .orderBy("createdAt", "desc")
      .limit(80)
      .get();
    const bookings = await Promise.all(
      docsToJson(snap).map(async (booking) => {
        if (!["accepted", "ongoing", "completed"].includes(booking.status)) {
          return { ...booking, customerPhone: "" };
        }
        const contactSnap = await collections.bookings
          .doc(booking.id)
          .collection("private")
          .doc(booking.id)
          .get()
          .catch(() => null);
        return {
          ...booking,
          customerPhone: contactSnap?.exists
            ? String(contactSnap.data().phone || "")
            : "",
        };
      }),
    );
    res.set("Cache-Control", "private, no-store");
    res.json({ bookings });
  }),
);

workerRouter.get(
  "/worker/job-feed",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const serviceKey = req.query.serviceKey ? String(req.query.serviceKey) : "";
    const workerSnap = await collections.workers.doc(req.user.uid).get();
    if (workerSnap.exists && workerSnap.data().online === true) {
      await dispatchOpenJobsToWorker(req.user.uid, {
        ...workerSnap.data(),
        id: req.user.uid,
      }).catch((error) =>
        console.warn("Open-job dispatch on feed refresh failed:", error.message),
      );
    }
    let queryRef = collections.jobFeed
      .where("workerId", "==", req.user.uid)
      .where("status", "==", "open");
    // Matching includes the worker's primary trade and saved trades. The
    // booking was already radius-checked before this feed entry was created.
    const snap = await queryRef.orderBy("createdAt", "desc").limit(80).get();
    const worker = workerSnap.exists ? { ...workerSnap.data(), id: req.user.uid } : null;
    const jobs = docsToJson(snap).map((job) => ({
      ...job,
      distanceKm: worker ? workerDistanceKm(worker, job) : null,
      customerPhone: "",
    }));
    res.set("Cache-Control", "private, no-store");
    res.json({ jobs });
  }),
);

workerRouter.get(
  "/worker/earnings",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const [workerSnap, bookingsSnap] = await Promise.all([
      collections.workers.doc(uid).get(),
      collections.bookings
        .where("workerId", "==", uid)
        .where("status", "==", "completed")
        .orderBy("completedAt", "desc")
        .limit(200)
        .get(),
    ]);

    const worker = workerSnap.exists ? workerSnap.data() : {};
    const bookingDocs = bookingsSnap.docs;
    const bookings = bookingDocs.map((doc) => doc.data());

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

    let today = 0;
    let week = 0;
    let month = 0;
    let total = 0;
    const months = lastMonths(6);

    for (const booking of bookings) {
      const price = Number(booking.pricing?.finalPrice) || 0;
      const earned = Number(booking.pricing?.workerReceives);
      const net = Number.isFinite(earned) ? earned : price;
      const completedAt = toDate(booking.completedAt) || toDate(booking.createdAt);
      if (!completedAt) continue;

      total += net;
      if (completedAt >= startOfDay) today += net;
      if (completedAt >= startOfWeek) week += net;
      if (
        completedAt.getMonth() === now.getMonth() &&
        completedAt.getFullYear() === now.getFullYear()
      ) {
        month += net;
      }

      const key = monthKey(completedAt);
      const bucket = months.find((item) => item.key === key);
      if (bucket) bucket.amount += net;
    }

    res.json({
      today,
      week,
      month,
      total,
      jobsCompleted: bookings.length,
      dues: Math.max(0, Number(worker.dues) || 0),
      premium: premiumActive(worker),
      premiumUntil: worker.premiumUntil ? toDate(worker.premiumUntil)?.toISOString() : null,
      chart: months,
      recent: bookingDocs.slice(0, 10).map((doc) => {
        const booking = doc.data();
        return {
          bookingId: doc.id,
          service: booking.service,
          amount: Number(booking.pricing?.finalPrice) || 0,
          net:
            Number(booking.pricing?.workerReceives) ||
            Number(booking.pricing?.finalPrice) ||
            0,
          completedAt: toDate(booking.completedAt)?.toISOString() || null,
          paid: Boolean(booking.paidAt),
        };
      }),
    });
  }),
);

workerRouter.post(
  "/worker/kyc",
  requireAuth,
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, "Upload a government ID image.", "FILE_REQUIRED");
    const workerSnap = await collections.workers.doc(req.user.uid).get();
    if (!workerSnap.exists) {
      throw new ApiError(404, "Worker profile not found. Apply as a worker first.", "WORKER_NOT_FOUND");
    }
    const cloudinaryUpload = await uploadCloudinaryImage(req.file.buffer, {
      folder: "worker-kyc",
      isPublic: false,
    });

    await collections.workers.doc(req.user.uid).set(
      {
        kycPath: FieldValue.delete(),
        kycCloudinaryId: cloudinaryUpload.publicId,
        kycCloudinaryFormat: cloudinaryUpload.format,
        kycStatus: "pending",
        kycSubmittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await notifyAdmins({
      title: "KYC submitted",
      body: `${req.user.name || "A worker"} uploaded an ID for verification.`,
      type: "kyc",
      link: "/admin/approvals",
    });

    const extension =
      req.file.mimetype === "image/png"
        ? "png"
        : req.file.mimetype === "image/webp"
          ? "webp"
          : req.file.mimetype === "image/gif"
            ? "gif"
            : "jpg";
    const delivery = await sendTelegramDocument(req.file.buffer, {
      filename: `worker-id-${req.user.uid}.${extension}`,
      mimeType: req.file.mimetype,
      caption: `Worker ID verification\nName: ${req.user.name || workerSnap.data().name || "Worker"}\nWorker UID: ${req.user.uid}`,
    });
    res.json({
      ok: true,
      status: "pending",
      cloudinaryStored: true,
      telegramForwarded: delivery.ok,
      telegramConfigured: !delivery.skipped,
    });
  }),
);

workerRouter.get(
  "/worker/commission",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const snap = await collections.commissions
      .where("workerId", "==", req.user.uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    res.json({
      commissions: snap.docs.map((doc) => docToJson(doc)),
      serverTime: Timestamp.now().toDate().toISOString(),
    });
  }),
);

workerRouter.post(
  "/worker/welcome-email",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const { worker } = await loadWorker(req.user.uid);
    await sendMail({
      to: worker.email,
      subject: "You are approved on EasyHome",
      html: emailLayout({
        heading: "You are live on EasyHome 🎉",
        intro: `Hi ${worker.name}, your ${worker.service} account is approved. Go online to start receiving jobs in ${worker.area}.`,
        ctaText: "Open worker dashboard",
        ctaUrl: `${process.env.PUBLIC_WEB_URL || ""}/worker`,
      }),
    });
    res.json({ ok: true });
  }),
);
