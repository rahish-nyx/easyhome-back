import { Router } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { collections, db } from "../config/firebase.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  bookingSchema,
  cancelSchema,
  chatSchema,
  offerSchema,
  paymentSchema,
  reviewSchema,
  subscriptionRequestSchema,
} from "../lib/validate.js";
import { appSettings, commissionFor, premiumActive } from "../lib/booking.js";
import { nearestServiceArea } from "../lib/geo.js";
import { uploadImage } from "../lib/media.js";
import { notify, notifyAdmins } from "../lib/notify.js";
import { docToJson, docsToJson, normalizePhone } from "../lib/utils.js";

export const customerRouter = Router();

async function resolveService(serviceName, serviceKey) {
  const snap = await collections.services.where("active", "==", true).get();
  const services = docsToJson(snap);
  return (
    services.find(
      (service) =>
        (serviceKey && service.key === serviceKey) ||
        service.name.toLowerCase() === String(serviceName || "").toLowerCase(),
    ) || null
  );
}

function planAmount(plan, monthly) {
  if (plan === "quarterly") return Math.round(monthly * 3 * 0.9);
  if (plan === "yearly") return Math.round(monthly * 12 * 0.8);
  return monthly;
}

function planMonths(plan) {
  if (plan === "quarterly") return 3;
  if (plan === "yearly") return 12;
  return 1;
}

customerRouter.post(
  "/bookings",
  requireAuth,
  requireVerified,
  upload.single("image"),
  asyncHandler(async (req, res) => {
    const body = bookingSchema.parse(req.body || {});
    const uid = req.user.uid;

    const service = await resolveService(body.service, body.serviceKey);
    if (!service) {
      throw new ApiError(
        422,
        "That service is not available right now. Please pick another.",
        "SERVICE_UNAVAILABLE",
      );
    }

    const minimum = Math.max(99, Number(service.fromPrice) || 199);
    if (body.budget < minimum) {
      throw new ApiError(
        422,
        `The minimum budget for ${service.name} is ₹${minimum}.`,
        "BUDGET_TOO_LOW",
      );
    }

    const citiesSnap = await collections.cities.where("active", "==", true).get();
    const cities = docsToJson(citiesSnap);
    const hasCoords =
      Number.isFinite(Number(body.lat)) && Number.isFinite(Number(body.lng));

    if (hasCoords && cities.length > 0) {
      const area = nearestServiceArea(cities, body.lat, body.lng);
      if (!area.allowed) {
        throw new ApiError(
          403,
          `We are not serving this area yet. Nearest hub: ${area.nearest?.city?.name || "—"}.`,
          "OUT_OF_SERVICE_AREA",
          { nearestCity: area.nearest?.city?.name || null },
        );
      }
    }

    let imagePath = "";
    if (req.file) {
      imagePath = await uploadImage(req.file.buffer, { folder: "bookings" });
    }

    const customerSnap = await collections.users.doc(uid).get();
    const customer = customerSnap.exists ? customerSnap.data() : {};

    const bookingRef = collections.bookings.doc();
    const bookingId = bookingRef.id;
    const now = FieldValue.serverTimestamp();
    const roundedLat = hasCoords ? Math.round(Number(body.lat) * 1000) / 1000 : null;
    const roundedLng = hasCoords ? Math.round(Number(body.lng) * 1000) / 1000 : null;

    const bookingDoc = {
      customerId: uid,
      customerName: customer.name || req.user.name || "Customer",
      customerPhotoPath: customer.photoPath || "",
      workerId: null,
      workerName: null,
      workerPhotoPath: null,
      service: service.name,
      serviceKey: service.key,
      description: body.description,
      area: body.area,
      location: {
        lat: hasCoords ? Number(body.lat) : null,
        lng: hasCoords ? Number(body.lng) : null,
        label: body.addressLabel || "",
        verified: hasCoords,
      },
      budget: Math.round(body.budget),
      urgency: body.urgency,
      status: "pending",
      imagePath,
      preferredWorkerId: body.preferredWorkerId || "",
      pricing: {
        workerPrice: null,
        customerOffer: null,
        finalPrice: null,
        commission: 0,
        workerReceives: null,
        confirmedAt: null,
      },
      paymentMode: null,
      paidAt: null,
      reviewId: null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
      acceptedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
    };

    const batch = db.batch();
    batch.set(bookingRef, bookingDoc);
    batch.set(bookingRef.collection("private").doc("contact"), {
      phone: normalizePhone(body.phone),
      createdAt: now,
    });
    batch.set(collections.jobFeed.doc(bookingId), {
      bookingId,
      service: service.name,
      serviceKey: service.key,
      description: body.description.slice(0, 180),
      area: body.area,
      lat: roundedLat,
      lng: roundedLng,
      budget: Math.round(body.budget),
      urgency: body.urgency,
      status: "open",
      workerId: null,
      preferredWorkerId: body.preferredWorkerId || "",
      createdAt: now,
    });
    if (body.urgency === "urgent") {
      batch.set(collections.urgentPublic.doc(bookingId), {
        service: service.name,
        serviceKey: service.key,
        area: body.area,
        budget: Math.round(body.budget),
        createdAt: now,
      });
    }
    await batch.commit();

    // Notify matching approved workers (preferred worker first).
    const workersSnap = await collections.workers
      .where("serviceKey", "==", service.key)
      .limit(50)
      .get();

    const candidates = workersSnap.docs
      .filter((doc) => doc.data().status === "approved")
      .sort((a, b) => {
        const aPreferred = a.id === body.preferredWorkerId ? -1 : 0;
        const bPreferred = b.id === body.preferredWorkerId ? -1 : 0;
        return aPreferred - bPreferred;
      })
      .slice(0, 30);

    if (candidates.length) {
      const notifBatch = db.batch();
      candidates.forEach((worker) => {
        const ref = collections.notifications.doc();
        notifBatch.set(ref, {
          userId: worker.id,
          title: body.urgency === "urgent" ? "Urgent job near you" : "New job near you",
          body: `${service.name} · ${body.area} · ₹${Math.round(body.budget)}`,
          type: "new_job",
          link: `/worker?job=${bookingId}`,
          read: false,
          createdAt: now,
        });
      });
      await notifBatch.commit();
    }

    const saved = await bookingRef.get();
    res.status(201).json({ booking: docToJson(saved) });
  }),
);

customerRouter.patch(
  "/bookings/:id/offer",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { price } = offerSchema.parse(req.body || {});
    const ref = collections.bookings.doc(req.params.id);
    const booking = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, "Booking not found.", "BOOKING_NOT_FOUND");
      const data = snap.data();
      if (data.customerId !== req.user.uid) {
        throw new ApiError(403, "This is not your booking.", "BOOKING_FORBIDDEN");
      }
      if (data.status !== "accepted") {
        throw new ApiError(409, "You can only negotiate after a worker accepts.", "STATUS_INVALID");
      }
      if (data.pricing?.confirmedAt) {
        throw new ApiError(409, "The price is already confirmed.", "PRICE_CONFIRMED");
      }
      if (data.pricing?.customerOffer) {
        throw new ApiError(409, "You already sent one counter-offer.", "OFFER_EXISTS");
      }
      tx.update(ref, {
        "pricing.customerOffer": Math.round(price),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { ...data, pricing: { ...data.pricing, customerOffer: Math.round(price) } };
    });

    await notify(booking.workerId, {
      title: "Customer counter-offer",
      body: `${booking.customerName} offered ₹${Math.round(price)} for ${booking.service}.`,
      type: "offer",
      link: "/worker",
    });

    const saved = await ref.get();
    res.json({ ok: true, booking: docToJson(saved) });
  }),
);

/**
 * Customer accepts the worker's quoted price. This is the customer-side
 * mirror of the worker confirm endpoint, so a booking can be unlocked even
 * when the worker is waiting on the customer.
 */
customerRouter.patch(
  "/bookings/:id/accept-price",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const ref = collections.bookings.doc(req.params.id);
    const settings = await appSettings();

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, "Booking not found.", "BOOKING_NOT_FOUND");
      const booking = snap.data();
      if (booking.customerId !== uid) {
        throw new ApiError(403, "This is not your booking.", "BOOKING_FORBIDDEN");
      }
      if (booking.status !== "accepted") {
        throw new ApiError(409, "This job is not in a negotiable state.", "STATUS_INVALID");
      }
      if (booking.pricing?.confirmedAt) {
        throw new ApiError(409, "The price is already confirmed.", "PRICE_CONFIRMED");
      }

      const price = Math.round(
        Number(booking.pricing?.workerPrice) || Number(booking.pricing?.customerOffer) || 0,
      );
      if (price < 99) {
        throw new ApiError(422, "The worker has not quoted a price yet.", "PRICE_REQUIRED");
      }

      const workerSnap = booking.workerId
        ? await tx.get(collections.workers.doc(booking.workerId))
        : null;
      const worker = workerSnap?.exists ? workerSnap.data() : null;
      const { commission, workerReceives } = commissionFor(price, settings.commissionPct, {
        premium: premiumActive(worker),
      });

      tx.update(ref, {
        "pricing.finalPrice": price,
        "pricing.commission": commission,
        "pricing.workerReceives": workerReceives,
        "pricing.confirmedAt": FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { booking, price, commission, workerReceives };
    });

    if (result.booking.workerId) {
      await notify(result.booking.workerId, {
        title: "Price accepted ✅",
        body: `${result.booking.customerName} accepted ₹${result.price} for ${result.booking.service}. You can start the job now.`,
        type: "price",
        link: "/worker",
      });
    }

    res.json({
      ok: true,
      finalPrice: result.price,
      commission: result.commission,
      workerReceives: result.workerReceives,
    });
  }),
);

customerRouter.patch(
  "/bookings/:id/cancel",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { reason } = cancelSchema.parse(req.body || {});
    const ref = collections.bookings.doc(req.params.id);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, "Booking not found.", "BOOKING_NOT_FOUND");
      const data = snap.data();
      if (data.customerId !== req.user.uid) {
        throw new ApiError(403, "This is not your booking.", "BOOKING_FORBIDDEN");
      }
      if (["completed", "cancelled"].includes(data.status)) {
        throw new ApiError(409, "This booking can no longer be cancelled.", "STATUS_INVALID");
      }
      if (data.status === "ongoing") {
        throw new ApiError(
          409,
          "The job has already started. Contact support to resolve it.",
          "JOB_STARTED",
        );
      }
      tx.update(ref, {
        status: "cancelled",
        cancelReason: reason || "Cancelled by customer",
        cancelledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        "pricing.finalPrice": null,
      });
      tx.set(
        collections.jobFeed.doc(ref.id),
        { status: "cancelled", updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      tx.delete(collections.urgentPublic.doc(ref.id));
      return { ...data, status: "cancelled" };
    });

    if (result.workerId) {
      await notify(result.workerId, {
        title: "Job cancelled",
        body: `${result.customerName} cancelled the ${result.service} booking.`,
        type: "cancelled",
        link: "/worker",
      });
    }

    res.json({ ok: true });
  }),
);

customerRouter.patch(
  "/bookings/:id/payment",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { mode, reference } = paymentSchema.parse(req.body || {});
    const settings = await appSettings();
    const ref = collections.bookings.doc(req.params.id);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, "Booking not found.", "BOOKING_NOT_FOUND");
      const booking = snap.data();
      if (booking.customerId !== req.user.uid) {
        throw new ApiError(403, "Only the customer can confirm payment.", "BOOKING_FORBIDDEN");
      }
      if (booking.status !== "completed") {
        throw new ApiError(409, "The job must be completed before payment.", "STATUS_INVALID");
      }
      if (booking.paidAt) {
        throw new ApiError(409, "Payment is already recorded.", "ALREADY_PAID");
      }

      const workerRef = collections.workers.doc(booking.workerId);
      const workerSnap = await tx.get(workerRef);
      const worker = workerSnap.exists ? workerSnap.data() : null;
      const finalPrice = Math.round(
        booking.pricing?.finalPrice || booking.pricing?.workerPrice || booking.budget,
      );
      const premium = premiumActive(worker);
      const { commission, workerReceives } = commissionFor(
        finalPrice,
        settings.commissionPct,
        { premium },
      );

      tx.update(ref, {
        paidAt: FieldValue.serverTimestamp(),
        paymentMode: mode,
        paymentReference: reference || "",
        status: "completed",
        "pricing.finalPrice": finalPrice,
        "pricing.commission": commission,
        "pricing.workerReceives": workerReceives,
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (worker && commission > 0) {
        const commissionRef = collections.commissions.doc();
        tx.set(commissionRef, {
          workerId: booking.workerId,
          workerName: booking.workerName,
          bookingId: ref.id,
          service: booking.service,
          amount: commission,
          status: "pending",
          note: "",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(workerRef, {
          dues: FieldValue.increment(commission),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      return { booking, commission, workerReceives, premium };
    });

    await notify(result.booking.workerId, {
      title: "Payment received",
      body:
        result.commission > 0
          ? `₹${result.workerReceives} is yours. ₹${result.commission} commission is now due.`
          : `₹${result.workerReceives} is yours. Premium — no commission.`,
      type: "payment",
      link: "/worker?tab=earnings",
    });

    res.json({
      ok: true,
      commission: result.commission,
      workerReceives: result.workerReceives,
    });
  }),
);

customerRouter.post(
  "/bookings/:id/review",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { stars, comment } = reviewSchema.parse(req.body || {});
    const bookingRef = collections.bookings.doc(req.params.id);
    const reviewRef = collections.reviews.doc();

    const result = await db.runTransaction(async (tx) => {
      const bookingSnap = await tx.get(bookingRef);
      if (!bookingSnap.exists) throw new ApiError(404, "Booking not found.", "BOOKING_NOT_FOUND");
      const booking = bookingSnap.data();
      if (booking.customerId !== req.user.uid) {
        throw new ApiError(403, "This is not your booking.", "BOOKING_FORBIDDEN");
      }
      if (booking.status !== "completed") {
        throw new ApiError(409, "You can review after the job is completed.", "STATUS_INVALID");
      }
      if (booking.reviewId) {
        throw new ApiError(409, "You already reviewed this job.", "ALREADY_REVIEWED");
      }
      if (!booking.workerId) {
        throw new ApiError(409, "No worker is attached to this booking.", "NO_WORKER");
      }

      const workerRef = collections.workers.doc(booking.workerId);
      const workerSnap = await tx.get(workerRef);
      const worker = workerSnap.exists ? workerSnap.data() : null;
      const count = Number(worker?.reviewCount) || 0;
      const current = Number(worker?.rating) || 0;
      const nextCount = count + 1;
      const nextRating = Math.round(((current * count + stars) / nextCount) * 10) / 10;

      tx.set(reviewRef, {
        bookingId: bookingRef.id,
        workerId: booking.workerId,
        workerName: booking.workerName,
        customerId: req.user.uid,
        customerName: booking.customerName,
        service: booking.service,
        stars,
        comment: comment || "",
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(bookingRef, {
        reviewId: reviewRef.id,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(
        workerRef,
        { rating: nextRating, reviewCount: nextCount, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      tx.set(
        collections.workersPublic.doc(booking.workerId),
        { rating: nextRating, reviewCount: nextCount, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );

      return { workerId: booking.workerId, workerName: booking.workerName, nextRating };
    });

    await notify(result.workerId, {
      title: `New ${stars}-star review`,
      body: `${result.nextRating}★ average · ${comment ? `"${comment}"` : "Great work!"}`,
      type: "review",
      link: "/worker?tab=profile",
    });

    res.status(201).json({ ok: true, reviewId: reviewRef.id });
  }),
);

customerRouter.post(
  "/subscriptions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { plan, note } = subscriptionRequestSchema.parse(req.body || {});
    const settings = await appSettings();
    const uid = req.user.uid;

    const userRef = collections.users.doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new ApiError(404, "Profile not found.", "PROFILE_MISSING");

    const user = userSnap.data();
    const current = user.subscription || {};
    const end = current.endAt?.toDate?.();
    if (current.status === "active" && end && end.getTime() > Date.now()) {
      throw new ApiError(409, "Your membership is already active.", "ALREADY_SUBSCRIBED");
    }

    const pendingSnap = await collections.subscriptions
      .where("userId", "==", uid)
      .where("status", "==", "pending")
      .limit(1)
      .get();
    if (!pendingSnap.empty) {
      throw new ApiError(409, "You already have a payment request under review.", "REQUEST_PENDING");
    }

    const amount = planAmount(plan, settings.subscriptionPrice);
    const ref = collections.subscriptions.doc();
    await ref.set({
      userId: uid,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      plan,
      months: planMonths(plan),
      amount,
      status: "pending",
      paymentNote: note || "",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      startAt: null,
      endAt: null,
      reviewedBy: null,
    });

    await userRef.set(
      {
        subscription: {
          ...current,
          status: "pending",
          plan,
          amount,
          requestedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await notifyAdmins({
      title: "Membership payment submitted",
      body: `${user.name} requested the ${plan} plan (₹${amount}). Verify the UPI reference.`,
      type: "subscription",
      link: "/admin/revenue",
    });

    res.status(201).json({ ok: true, subscriptionId: ref.id, amount });
  }),
);

customerRouter.post(
  "/chat",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { text } = chatSchema.parse(req.body || {});
    const uid = req.user.uid;
    const threadRef = collections.chatThreads.doc(uid);
    const messageRef = threadRef.collection("messages").doc();
    const now = FieldValue.serverTimestamp();

    const userSnap = await collections.users.doc(uid).get();
    const user = userSnap.exists ? userSnap.data() : {};

    await db.runTransaction(async (tx) => {
      tx.set(messageRef, {
        senderId: uid,
        senderRole: user.role || "customer",
        senderName: user.name || "User",
        text,
        read: false,
        createdAt: now,
      });
      tx.set(
        threadRef,
        {
          userId: uid,
          name: user.name || "User",
          role: user.role || "customer",
          email: user.email || req.user.email,
          lastMessage: text.slice(0, 120),
          lastAt: now,
          unreadForAdmin: FieldValue.increment(1),
          unreadForUser: 0,
          updatedAt: now,
          createdAt: user.createdAt || now,
        },
        { merge: true },
      );
    });

    res.status(201).json({ ok: true, messageId: messageRef.id });
  }),
);

customerRouter.patch(
  "/chat/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    const threadRef = collections.chatThreads.doc(req.user.uid);
    const unreadSnap = await threadRef
      .collection("messages")
      .where("senderRole", "==", "admin")
      .where("read", "==", false)
      .limit(100)
      .get();

    if (!unreadSnap.empty) {
      const batch = db.batch();
      unreadSnap.forEach((doc) => batch.update(doc.ref, { read: true }));
      batch.set(threadRef, { unreadForUser: 0, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await batch.commit();
    } else {
      await threadRef.set({ unreadForUser: 0 }, { merge: true });
    }

    res.json({ ok: true });
  }),
);

customerRouter.patch(
  "/notifications/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    const snap = await collections.notifications
      .where("userId", "==", req.user.uid)
      .where("read", "==", false)
      .limit(100)
      .get();

    if (!snap.empty) {
      const batch = db.batch();
      snap.forEach((doc) => batch.update(doc.ref, { read: true }));
      await batch.commit();
    }

    res.json({ ok: true, updated: snap.size });
  }),
);

customerRouter.get(
  "/bookings/:id/contact",
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookingSnap = await collections.bookings.doc(req.params.id).get();
    if (!bookingSnap.exists) throw new ApiError(404, "Booking not found.", "BOOKING_NOT_FOUND");
    const booking = bookingSnap.data();
    const isCustomer = booking.customerId === req.user.uid;
    const isWorker = booking.workerId === req.user.uid;
    if (!isCustomer && !isWorker && !req.user.admin) {
      throw new ApiError(403, "You do not have access to this contact.", "FORBIDDEN");
    }
    if (isWorker && !booking.pricing?.confirmedAt) {
      throw new ApiError(403, "Confirm the price to see the customer's phone number.", "PRICE_NOT_CONFIRMED");
    }
    const contactSnap = await collections.bookings
      .doc(req.params.id)
      .collection("private")
      .doc("contact")
      .get();
    res.json({ phone: contactSnap.exists ? contactSnap.data().phone : "" });
  }),
);

/**
 * Server-generated time stamp used by the client for clock-skew checks
 * (mostly useful on flaky mobile networks).
 */
customerRouter.get(
  "/server-time",
  asyncHandler(async (_req, res) => {
    res.json({ now: Timestamp.now().toDate().toISOString() });
  }),
);
