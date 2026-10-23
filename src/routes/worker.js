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
  workerProfileSchema,
} from "../lib/validate.js";
import {
  appSettings,
  canAcceptJobs,
  commissionFor,
  premiumActive,
} from "../lib/booking.js";
import { distanceMeters, hasCoords } from "../lib/geo.js";
import { uploadImage } from "../lib/media.js";
import { notify, notifyAdmins, sendMail, emailLayout } from "../lib/notify.js";
import { docToJson, lastMonths, monthKey, toDate } from "../lib/utils.js";

export const workerRouter = Router();

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
    for (const key of ["name", "service", "serviceKey", "area", "bio", "upiId"]) {
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
      for (const key of ["name", "service", "serviceKey", "area", "photoPath", "online"]) {
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

    const result = await db.runTransaction(async (tx) => {
      const bookingSnap = await tx.get(bookingRef);
      const workerSnap = await tx.get(workerRef);

      if (!bookingSnap.exists) throw new ApiError(404, "Job not found.", "BOOKING_NOT_FOUND");
      if (!workerSnap.exists) throw new ApiError(404, "Worker profile not found.", "WORKER_NOT_FOUND");

      const booking = bookingSnap.data();
      const worker = workerSnap.data();
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

      if (hasCoords(worker) && hasCoords(booking.location)) {
        const distance = distanceMeters(worker, booking.location);
        const radiusKm = Number(worker.radiusKm) || 25;
        if (distance !== null && distance > radiusKm * 1000) {
          throw new ApiError(
            403,
            `This job is ${Math.round(distance / 1000)} km away — outside your ${radiusKm} km service radius.`,
            "OUT_OF_RADIUS",
          );
        }
      }

      const now = FieldValue.serverTimestamp();
      tx.update(bookingRef, {
        workerId: uid,
        workerName: worker.name,
        workerPhotoPath: worker.photoPath || "",
        status: "accepted",
        acceptedAt: now,
        updatedAt: now,
      });
      tx.set(
        collections.jobFeed.doc(bookingRef.id),
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

    await notify(result.customerId, {
      title: "Worker found!",
      body: `${result.booking.workerName} accepted your ${result.service} booking.`,
      type: "job_accepted",
      link: "/bookings",
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
      if (booking.status !== "accepted") {
        throw new ApiError(409, "Only accepted jobs can be started.", "STATUS_INVALID");
      }
      if (!booking.pricing?.confirmedAt) {
        throw new ApiError(409, "Confirm the final price before starting.", "PRICE_NOT_CONFIRMED");
      }
      tx.update(bookingRef, {
        status: "ongoing",
        startedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { booking };
    });

    await notify(result.booking.customerId, {
      title: "Worker is on the way",
      body: `${result.booking.workerName} started your ${result.booking.service} job.`,
      type: "job_started",
      link: "/bookings",
    });

    res.json({ ok: true });
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
      tx.update(bookingRef, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(
        workerRef,
        { jobsCompleted: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      tx.set(
        collections.workersPublic.doc(uid),
        { jobsCompleted: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return { booking };
    });

    await notify(result.booking.customerId, {
      title: "Job completed",
      body: `Confirm the payment for ${result.booking.service} and leave a review.`,
      type: "job_completed",
      link: "/bookings",
    });

    res.json({ ok: true });
  }),
);

workerRouter.post(
  "/worker/commission/:bookingId/paid",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const { note } = commissionPaidSchema.parse(req.body || {});
    const uid = req.user.uid;

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

    await commissionDoc.ref.update({
      status: "paid",
      note,
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await notifyAdmins({
      title: "Commission payment submitted",
      body: `${req.user.name || "A worker"} submitted ₹${commission.amount} for ${commission.service}. Ref: ${note}`,
      type: "commission",
      link: "/admin/revenue",
    });

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
    const objectPath = await uploadImage(req.file.buffer, {
      folder: "kyc",
      isPublic: false,
    });

    await collections.workers.doc(req.user.uid).set(
      {
        kycPath: objectPath,
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

    res.json({ ok: true, status: "pending" });
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
