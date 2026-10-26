import { Router } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { collections, db } from "../config/firebase.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireApprovedWorker, requireAuth } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  availabilitySchema,
  commissionPaidSchema,
  priceSchema,
  trackingLocationSchema,
  trackingPhaseSchema,
  workerProfileSchema,
} from "../lib/validate.js";
import {
  appSettings,
  canAcceptJobs,
  commissionFor,
  premiumActive,
} from "../lib/booking.js";
import {
  deleteStoredImage,
  uploadCloudinaryImage,
} from "../lib/media.js";
import { workerMatchesBooking } from "../lib/matching.js";
import { jobFeedDocId, updateJobFeedStatus } from "../lib/jobFeed.js";
import { markReferralServiceCompleted } from "../lib/referrals.js";
import { notify, notifyAdmins, sendMail, emailLayout } from "../lib/notify.js";
import {
  commissionTelegramMessage,
  sendTelegramAlert,
  sendTelegramDocument,
} from "../lib/telegram.js";
import {
  PHASE_META,
  TRACKING_PHASES,
  nextPhase,
  phaseForBooking,
  phaseHistoryEntry,
} from "../lib/tracking.js";
import { docToJson, lastMonths, monthKey, toDate } from "../lib/utils.js";

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
    if (body.lat !== undefined) updates.lat = body.lat;
    if (body.lng !== undefined) updates.lng = body.lng;
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
    const { online } = availabilitySchema.parse(req.body || {});
    const now = FieldValue.serverTimestamp();
    await collections.workers.doc(req.user.uid).set(
      { online, lastSeenAt: now, updatedAt: now },
      { merge: true },
    );
    await collections.workersPublic.doc(req.user.uid).set(
      { online, updatedAt: now },
      { merge: true },
    );
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
          dues: `Pay ₹${gate.dues} in commission before accepting new jobs.`,
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
      if (booking.serviceKey !== worker.serviceKey) {
        throw new ApiError(403, "This job is for a different trade.", "SERVICE_MISMATCH");
      }
      if (booking.preferredWorkerId && booking.preferredWorkerId !== uid) {
        throw new ApiError(403, "This job was reserved for another worker.", "JOB_RESERVED");
      }

      if (
        (booking.serviceZoneId && !zone) ||
        !workerMatchesBooking({ ...worker, id: uid }, booking, zone)
      ) {
        throw new ApiError(
          403,
          "This job is outside your registered service area or its active radius.",
          "OUT_OF_SERVICE_AREA",
        );
      }

      const now = FieldValue.serverTimestamp();
      const workerLat = coordinate(worker.currentLat) ?? coordinate(worker.lat);
      const workerLng = coordinate(worker.currentLng) ?? coordinate(worker.lng);

      tx.update(bookingRef, {
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
      tx.set(
        feedRef,
        { status: "taken", workerId: uid, updatedAt: now },
        { merge: true },
      );
      tx.delete(collections.urgentPublic.doc(bookingRef.id));

      return {
        booking: { ...booking, workerId: uid, workerName: worker.name, status: "accepted" },
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
      const { commission, workerReceives } = commissionFor(price, settings.commissionPct, {
        premium: premiumActive(worker),
      });

      tx.update(bookingRef, {
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

      tx.update(bookingRef, {
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
      if (currentPhase && currentPhase !== TRACKING_PHASES.ASSIGNED) {
        throw new ApiError(409, "This job has already been started.", "STATUS_INVALID");
      }

      tx.update(bookingRef, {
        trackingPhase: TRACKING_PHASES.EN_ROUTE,
        enRouteAt: FieldValue.serverTimestamp(),
        lastUpdatedTimestamp: FieldValue.serverTimestamp(),
        trackingStatusUpdatedAt: FieldValue.serverTimestamp(),
        trackingAlert: false,
        updatedAt: FieldValue.serverTimestamp(),
        statusHistory: FieldValue.arrayUnion(
          phaseHistoryEntry({
            phase: TRACKING_PHASES.EN_ROUTE,
            status: "accepted",
            actorId: uid,
            actorRole: "worker",
          }),
        ),
      });
      return { booking };
    });

    await notify(result.booking.customerId, {
      title: "Worker is on the way",
      body: `${result.booking.workerName} started your ${result.booking.service} job and is heading to you.`,
      type: "job_started",
      link: `/bookings/${req.params.id}/track`,
    });

    res.json({ ok: true, phase: TRACKING_PHASES.EN_ROUTE });
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
        tx.set(
          workerRef,
          {
            currentLat: FieldValue.delete(),
            currentLng: FieldValue.delete(),
            lastLocationAt: FieldValue.delete(),
            jobsCompleted: FieldValue.increment(1),
            updatedAt: now,
          },
          { merge: true },
        );
        tx.set(
          collections.workersPublic.doc(uid),
          { jobsCompleted: FieldValue.increment(1), updatedAt: now },
          { merge: true },
        );
      }

      tx.update(bookingRef, updates);
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
      tx.update(bookingRef, {
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
      });
      tx.set(
        workerRef,
        {
          currentLat: body.lat,
          currentLng: body.lng,
          lastSeenAt: now,
          updatedAt: now,
        },
        { merge: true },
      );
      return { booking };
    });

    res.json({
      ok: true,
      bookingId: req.params.id,
      activeJob: Boolean(result.booking.activeJob),
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

    const result = await db.runTransaction(async (tx) => {
      const { booking } = await assertOwnJob(tx, req.params.id, uid);
      if (booking.status !== "ongoing") {
        throw new ApiError(409, "Only ongoing jobs can be completed.", "STATUS_INVALID");
      }
      if (!booking.pricing?.confirmedAt) {
        throw new ApiError(409, "Confirm the final price first.", "PRICE_NOT_CONFIRMED");
      }
      const now = FieldValue.serverTimestamp();
      tx.update(bookingRef, {
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
        statusHistory: FieldValue.arrayUnion(
          phaseHistoryEntry({
            phase: TRACKING_PHASES.COMPLETED,
            status: "completed",
            actorId: uid,
            actorRole: "worker",
          }),
        ),
      });
      tx.set(
        workerRef,
        { jobsCompleted: FieldValue.increment(1), updatedAt: now },
        { merge: true },
      );
      tx.set(
        collections.workersPublic.doc(uid),
        { jobsCompleted: FieldValue.increment(1), updatedAt: now },
        { merge: true },
      );
      return { booking };
    });

    await removeCompletedBookingImage(result.booking, bookingRef);

    await notify(result.booking.customerId, {
      title: "Job completed",
      body: `Confirm the payment for ${result.booking.service} and leave a review.`,
      type: "job_completed",
      link: "/bookings",
    });

    await markReferralServiceCompleted(
      result.booking.customerId,
      bookingRef.id,
    ).catch((error) => {
      console.warn("Referral completion update failed:", error.message);
    });

    res.json({ ok: true, phase: TRACKING_PHASES.COMPLETED });
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
      throw new ApiError(404, "No commission is due for this job.", "COMMISSION_NOT_FOUND");
    }

    const commissionDoc = snap.docs[0];
    const commission = commissionDoc.data();
    if (commission.status === "approved") {
      throw new ApiError(409, "This commission is already approved.", "ALREADY_APPROVED");
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
      title: "Commission payment submitted",
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
