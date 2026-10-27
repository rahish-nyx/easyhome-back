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
import {
  appSettings,
  canAcceptJobs,
  commissionFor,
  customerPremiumActive,
  feesPctFor,
  planMonths,
  premiumActive,
  subscriptionAmount,
} from "../lib/booking.js";
import { nearestServiceArea } from "../lib/geo.js";
import { uploadCloudinaryImage } from "../lib/media.js";
import {
  prioritizeWorkers,
  workerMatchesBooking,
} from "../lib/matching.js";
import { jobFeedDocId, updateJobFeedStatus } from "../lib/jobFeed.js";
import { notify, notifyAdmins } from "../lib/notify.js";
import { sendTelegramAlert, subscriptionTelegramMessage } from "../lib/telegram.js";
import { OUT_OF_ZONE_MESSAGE, validateBookingZone } from "../lib/zones.js";
import {
  PHASE_META,
  phaseHistoryEntry,
  trackingEta,
  trackingSnapshot,
} from "../lib/tracking.js";
import { docToJson, docsToJson, normalizePhone, toDate } from "../lib/utils.js";

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

    const hasCoords =
      body.lat !== null &&
      body.lat !== undefined &&
      body.lng !== null &&
      body.lng !== undefined &&
      Number.isFinite(Number(body.lat)) &&
      Number.isFinite(Number(body.lng));

    if (!hasCoords) {
      throw new ApiError(
        422,
        "Precise coordinates are required to verify the service radius. Use current location or select a mapped service area.",
        "BOOKING_LOCATION_REQUIRED",
      );
    }

    // Admin-managed service zones are authoritative. If no zones have been
    // configured yet, fall back to the original city-radius coverage model.
    const zoneCheck = await validateBookingZone({
      lat: hasCoords ? Number(body.lat) : null,
      lng: hasCoords ? Number(body.lng) : null,
      cityName: body.city,
      state: body.state,
      areaName: body.areaName,
    });

    if (!zoneCheck.allowed) {
      throw new ApiError(403, OUT_OF_ZONE_MESSAGE, "OUT_OF_SERVICE_AREA", {
        zoneMessage: OUT_OF_ZONE_MESSAGE,
        nearestZone: zoneCheck.nearest?.zone?.cityName || null,
        nearestDistanceMeters: zoneCheck.nearest?.distanceMeters ?? null,
        waitlistAvailable: true,
      });
    }

    if (!zoneCheck.configured) {
      const citiesSnap = await collections.cities.where("active", "==", true).get();
      const cities = docsToJson(citiesSnap);

      if (hasCoords && cities.length > 0) {
        const area = nearestServiceArea(cities, body.lat, body.lng);
        if (!area.allowed) {
          throw new ApiError(403, OUT_OF_ZONE_MESSAGE, "OUT_OF_SERVICE_AREA", {
            zoneMessage: OUT_OF_ZONE_MESSAGE,
            nearestZone: area.nearest?.city?.name || null,
            nearestDistanceMeters: area.nearest?.distanceMeters ?? null,
            waitlistAvailable: true,
          });
        }
      }
    }

    const bookingForMatching = {
      serviceKey: service.key,
      cityName: zoneCheck.zone?.cityName || body.city || "",
      stateName: zoneCheck.zone?.state || body.state || "",
      areaName: zoneCheck.zone?.areaName || body.areaName || "",
      preferredWorkerId: body.preferredWorkerId || "",
      location: {
        lat: hasCoords ? Number(body.lat) : null,
        lng: hasCoords ? Number(body.lng) : null,
      },
    };
    const warnings = [];
    const [customerSnap, settings] = await Promise.all([
      collections.users.doc(uid).get(),
      appSettings(),
    ]);
    const customer = customerSnap.exists ? customerSnap.data() : {};
    const customerPremium = customerPremiumActive(customer);
    const customerRules = settings.customerRules || {};
    const freeCancellationMinutes = customerPremium
      ? Number(customerRules.proCancellationMinutes) || 20
      : Number(customerRules.cancellationMinutes) || 7;
    const urgentFeePct = Math.max(
      0,
      Number(customerRules.urgentFeePct) || 0,
    );
    const baseBudget = Math.round(body.budget);
    const urgentFee =
      body.urgency === "urgent" && !customerPremium
        ? Math.round((baseBudget * urgentFeePct) / 100)
        : 0;
    const estimatedTotal = baseBudget + urgentFee;

    const workersSnap = await collections.workers
      .where("serviceKey", "==", service.key)
      .where("status", "==", "approved")
      .get();
    const candidates = prioritizeWorkers(
      workersSnap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .filter((worker) => {
          const premium = premiumActive(worker);
          return (
            canAcceptJobs(worker, { premium }).allowed &&
            workerMatchesBooking(worker, bookingForMatching, zoneCheck.zone)
          );
        }),
      premiumActive,
    );
    if (!candidates.length) {
      warnings.push(
        "Your request is in the service area, but no online professional currently matches this location and trade.",
      );
    }

    if (
      body.preferredWorkerId &&
      !candidates.some((worker) => worker.id === body.preferredWorkerId)
    ) {
      throw new ApiError(
        422,
        "The selected professional is not currently available in this service area.",
        "PREFERRED_WORKER_UNAVAILABLE",
      );
    }

    let imagePath = "";
    let imageCloudinaryId = "";
    if (req.file) {
      try {
        const uploaded = await uploadCloudinaryImage(req.file.buffer, {
          folder: "bookings",
        });
        imagePath = uploaded.url;
        imageCloudinaryId = uploaded.publicId;
      } catch (error) {
        console.error(
          "Optional booking image upload failed:",
          error.code || error.message,
        );
        warnings.push(
          "Your request was sent, but its photo could not be attached. You can share it with support.",
        );
      }
    }

    const bookingRef = collections.bookings.doc();
    const bookingId = bookingRef.id;
    const now = FieldValue.serverTimestamp();
    const roundedLat = hasCoords ? Math.round(Number(body.lat) * 1000) / 1000 : null;
    const roundedLng = hasCoords ? Math.round(Number(body.lng) * 1000) / 1000 : null;
    const freeCancellationUntil = Timestamp.fromDate(
      new Date(Date.now() + freeCancellationMinutes * 60_000),
    );

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
      cityName: zoneCheck.zone?.cityName || body.city || "",
      stateName: zoneCheck.zone?.state || body.state || "",
      areaName: zoneCheck.zone?.areaName || body.areaName || "",
      serviceZoneId: zoneCheck.zone?.id || null,
      serviceZoneName: zoneCheck.zone?.cityName || null,
      serviceZoneLatitude: zoneCheck.zone?.latitude ?? null,
      serviceZoneLongitude: zoneCheck.zone?.longitude ?? null,
      serviceZoneRadiusKm: zoneCheck.zone?.radiusKm ?? null,
      budget: baseBudget,
      urgency: body.urgency,
      urgentFee,
      urgentFeeWaived: body.urgency === "urgent" && customerPremium,
      estimatedTotal,
      customerPremium,
      customerPriority: customerPremium ? "pro" : "standard",
      freeCancellationMinutes,
      freeCancellationUntil,
      status: "pending",
      activeJob: false,
      trackingPhase: null,
      currentLat: null,
      currentLng: null,
      currentAccuracy: null,
      lastLocationAt: null,
      lastUpdatedTimestamp: now,
      trackingStatusUpdatedAt: now,
      trackingAlert: false,
      trackingNudgeCount: 0,
      statusHistory: [
        {
          phase: "requested",
          status: "pending",
          label: "Requested",
          actorId: uid,
          actorRole: "customer",
          lat: hasCoords ? Number(body.lat) : null,
          lng: hasCoords ? Number(body.lng) : null,
          note: "",
          at: Timestamp.now(),
        },
      ],
      imagePath,
      ...(imageCloudinaryId ? { imageCloudinaryId } : {}),
      preferredWorkerId: body.preferredWorkerId || "",
      pricing: {
        basePrice: baseBudget,
        urgentFee,
        estimatedTotal,
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
    if (body.urgency === "urgent") {
      batch.set(collections.urgentPublic.doc(bookingId), {
        service: service.name,
        serviceKey: service.key,
        area: body.area,
        cityName: bookingForMatching.cityName,
        stateName: bookingForMatching.stateName,
        areaName: bookingForMatching.areaName,
        serviceZoneId: zoneCheck.zone?.id || null,
        lat: roundedLat,
        lng: roundedLng,
        budget: Math.round(body.budget),
        createdAt: now,
      });
    }
    await batch.commit();

    try {
      if (candidates.length) {
        for (let index = 0; index < candidates.length; index += 450) {
          const feedBatch = db.batch();
          candidates.slice(index, index + 450).forEach((worker) => {
            feedBatch.set(
              collections.jobFeed.doc(jobFeedDocId(bookingId, worker.id)),
              {
                bookingId,
                workerId: worker.id,
                service: service.name,
                serviceKey: service.key,
                description: body.description.slice(0, 180),
                area: body.area,
                lat: roundedLat,
                lng: roundedLng,
                cityName: bookingForMatching.cityName,
                stateName: bookingForMatching.stateName,
                areaName: bookingForMatching.areaName,
                serviceZoneId: zoneCheck.zone?.id || null,
                serviceZoneLatitude: zoneCheck.zone?.latitude ?? null,
                serviceZoneLongitude: zoneCheck.zone?.longitude ?? null,
                serviceZoneRadiusKm: zoneCheck.zone?.radiusKm ?? null,
                priority: customerPremium ? "pro" : "standard",
                customerPremium,
                customerPriority: customerPremium ? "pro" : "standard",
                budget: baseBudget,
                urgency: body.urgency,
                status: "open",
                preferredWorkerId: body.preferredWorkerId || "",
                createdAt: now,
              },
            );
          });
          await feedBatch.commit();
        }

        const priorityGroups = [
          candidates.filter((worker) => premiumActive(worker)),
          candidates.filter((worker) => !premiumActive(worker)),
        ];
        for (const group of priorityGroups) {
          for (let index = 0; index < group.length; index += 450) {
            const notifBatch = db.batch();
            group.slice(index, index + 450).forEach((worker) => {
              const ref = collections.notifications.doc();
              notifBatch.set(ref, {
                userId: worker.id,
                title: customerPremium
                  ? body.urgency === "urgent"
                    ? "Priority urgent job near you"
                    : "Priority job near you"
                  : body.urgency === "urgent"
                    ? "Urgent job near you"
                    : "New job near you",
                body: `${service.name} · ${body.area} · ₹${baseBudget}${
                  customerPremium ? " · Pro customer" : ""
                }`,
                type: "new_job",
                priority: premiumActive(worker) ? "pro" : "standard",
                customerPriority: customerPremium ? "pro" : "standard",
                link: `/worker?job=${bookingId}`,
                read: false,
                createdAt: now,
              });
            });
            await notifBatch.commit();
          }
        }
      }
    } catch (error) {
      console.error("Booking worker notifications failed:", error.code || error.message);
      warnings.push(
        "Your request was saved, but we could not notify professionals right now. Contact support if you do not receive a response.",
      );
    }

    const saved = await bookingRef.get();
    res.status(201).json({ booking: docToJson(saved), warnings });
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
      const { commission, workerReceives } = commissionFor(
        price,
        feesPctFor(settings),
        {
          premium: premiumActive(worker),
        },
      );

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
    const settings = await appSettings();
    const rules = settings.customerRules || {};

    const result = await db.runTransaction(async (tx) => {
      const [snap, customerSnap] = await Promise.all([
        tx.get(ref),
        tx.get(collections.users.doc(req.user.uid)),
      ]);
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

      const customer = customerSnap.exists ? customerSnap.data() : {};
      const premium = customerPremiumActive(customer);
      const windowMinutes = premium
        ? Number(rules.proCancellationMinutes) || 20
        : Number(rules.cancellationMinutes) || 7;
      const createdAt = toDate(data.createdAt);
      const fallbackDeadline = toDate(data.freeCancellationUntil);
      const deadline = createdAt
        ? createdAt.getTime() + windowMinutes * 60_000
        : fallbackDeadline
          ? fallbackDeadline.getTime()
          : null;
      if (deadline && Date.now() > deadline) {
        throw new ApiError(
          409,
          `Your ${windowMinutes}-minute free cancellation window has closed. Contact support and we will help.`,
          "CANCELLATION_WINDOW_CLOSED",
          { windowMinutes, deadline: new Date(deadline).toISOString() },
        );
      }

      tx.update(ref, {
        status: "cancelled",
        activeJob: false,
        trackingAlert: false,
        cancelReason: reason || "Cancelled by customer",
        cancelledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        lastUpdatedTimestamp: FieldValue.serverTimestamp(),
        "pricing.finalPrice": null,
        statusHistory: FieldValue.arrayUnion({
          phase: "cancelled",
          status: "cancelled",
          label: "Cancelled by customer",
          actorId: req.user.uid,
          actorRole: "customer",
          note: String(reason || "").slice(0, 240),
          at: Timestamp.now(),
        }),
      });
      tx.delete(collections.urgentPublic.doc(ref.id));
      return { ...data, status: "cancelled" };
    });

    try {
      await updateJobFeedStatus(ref.id, "cancelled");
    } catch (error) {
      console.error("Could not close cancelled job-feed entries:", error.code || error.message);
    }

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
      const urgentFee = Math.max(0, Math.round(Number(booking.urgentFee) || 0));
      const paymentTotal = finalPrice + urgentFee;
      const premium = premiumActive(worker);
      const { commission, workerReceives: serviceEarnings } = commissionFor(
        finalPrice,
        feesPctFor(settings),
        { premium },
      );
      // Urgent jobs may carry a platform-set priority fee. It is paid directly
      // to the professional with the service amount; fees still apply only to
      // the agreed service price.
      const workerReceives = serviceEarnings + urgentFee;

      tx.update(ref, {
        paidAt: FieldValue.serverTimestamp(),
        paymentMode: mode,
        paymentReference: reference || "",
        status: "completed",
        "pricing.finalPrice": finalPrice,
        "pricing.urgentFee": urgentFee,
        "pricing.paymentTotal": paymentTotal,
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
          dueCommissionAmount: FieldValue.increment(commission),
          hasPendingCommission: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      return { booking, commission, workerReceives, premium, urgentFee, paymentTotal };
    });

    await notify(result.booking.workerId, {
      title: "Payment received",
      body:
        result.commission > 0
          ? `₹${result.workerReceives} is yours. ₹${result.commission} in fees is now due.`
          : `₹${result.workerReceives} is yours. Premium — no fees.`,
      type: "payment",
      link: "/worker?tab=earnings",
    });

    res.json({
      ok: true,
      commission: result.commission,
      workerReceives: result.workerReceives,
      urgentFee: result.urgentFee,
      paymentTotal: result.paymentTotal,
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
    throw new ApiError(
      410,
      "Manual UTR payments are disabled. Use the Razorpay checkout.",
      "MANUAL_PAYMENT_DISABLED",
    );
    // Legacy manual flow retained below only as historical reference.
    const { plan, note, utrId } = subscriptionRequestSchema.parse(req.body || {});
    const settings = await appSettings();
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

    const amount = subscriptionAmount(settings, user.role, plan);
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
      utrId: reference,
      paymentNote: reference,
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
          utrId: reference,
          requestedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await notifyAdmins({
      title: "Membership payment submitted",
      body: `${user.name} requested the ${plan} plan (₹${amount}). Verify UTR ${reference}.`,
      type: "subscription",
      link: "/admin/revenue",
    });

    await sendTelegramAlert(
      subscriptionTelegramMessage({
        name: user.name,
        email: user.email,
        role: user.role,
        planLabel: plan,
        months: planMonths(plan),
        amount,
        utrId: reference,
        requestId: ref.id,
      }),
    );

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
    const supportPriority =
      (user.role || "customer") === "customer" && customerPremiumActive(user)
        ? "pro"
        : "standard";

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
          photoPath: user.photoPath || "",
          lastMessage: text.slice(0, 120),
          lastAt: now,
          unreadForAdmin: FieldValue.increment(1),
          unreadForUser: 0,
          priority: supportPriority,
          customerPremium: supportPriority === "pro",
          prioritySince: supportPriority === "pro" ? now : null,
          updatedAt: now,
          createdAt: user.createdAt || now,
        },
        { merge: true },
      );
    });

    res.status(201).json({ ok: true, messageId: messageRef.id });
  }),
);

customerRouter.post(
  "/chat/request-call",
  requireAuth,
  asyncHandler(async (req, res) => {
    const uid = req.user.uid;
    const userSnap = await collections.users.doc(uid).get();
    const user = userSnap.exists ? userSnap.data() : {};
    const phone = normalizePhone(user.phone || "");
    if (!phone) {
      throw new ApiError(
        422,
        "Add a mobile number to your profile so support can call you back.",
        "PHONE_REQUIRED",
      );
    }

    const existing = await collections.callRequests
      .where("userId", "==", uid)
      .where("status", "==", "pending")
      .limit(1)
      .get();
    if (!existing.empty) {
      return res.json({ ok: true, requestId: existing.docs[0].id, duplicate: true });
    }

    const priority =
      (user.role || "customer") === "customer" && customerPremiumActive(user)
        ? "pro"
        : "standard";
    const ref = collections.callRequests.doc();
    await ref.set({
      userId: uid,
      name: user.name || "EasyHome user",
      email: user.email || req.user.email || "",
      phone,
      role: user.role || "customer",
      priority,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await collections.chatThreads.doc(uid).set(
      {
        callRequested: true,
        callRequestedAt: FieldValue.serverTimestamp(),
        priority,
        customerPremium: priority === "pro",
      },
      { merge: true },
    );

    await notifyAdmins({
      title: `${priority === "pro" ? "Priority call" : "Call"} request from ${user.name || "a user"}`,
      body: `${phone} · ${user.role === "worker" ? "Professional" : "Customer"}`,
      type: "call_request",
      link: "/admin/chats",
    });

    res.status(201).json({ ok: true, requestId: ref.id });
  }),
);

customerRouter.post(
  "/chat/end",
  requireAuth,
  asyncHandler(async (req, res) => {
    const threadRef = collections.chatThreads.doc(req.user.uid);

    for (;;) {
      const snap = await threadRef.collection("messages").limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }

    await threadRef.delete().catch(() => {});

    const pendingCalls = await collections.callRequests
      .where("userId", "==", req.user.uid)
      .where("status", "==", "pending")
      .limit(20)
      .get();
    if (!pendingCalls.empty) {
      const batch = db.batch();
      pendingCalls.docs.forEach((doc) =>
        batch.update(doc.ref, {
          status: "dismissed",
          dismissedByUser: true,
          updatedAt: FieldValue.serverTimestamp(),
        }),
      );
      await batch.commit();
    }

    res.json({ ok: true });
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

customerRouter.delete(
  "/notifications/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const ref = collections.notifications.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().userId !== req.user.uid) {
      throw new ApiError(404, "Notification not found.", "NOTIFICATION_NOT_FOUND");
    }
    await ref.delete();
    res.json({ ok: true });
  }),
);

customerRouter.get(
  "/bookings/:id/tracking",
  requireAuth,
  asyncHandler(async (req, res) => {
    const bookingSnap = await collections.bookings.doc(req.params.id).get();
    if (!bookingSnap.exists) {
      throw new ApiError(404, "Booking not found.", "BOOKING_NOT_FOUND");
    }
    const booking = bookingSnap.data();
    const isCustomer = booking.customerId === req.user.uid;
    const isWorker = booking.workerId === req.user.uid;
    const isAdmin = Boolean(req.user.admin);
    if (!isCustomer && !isWorker && !isAdmin) {
      throw new ApiError(403, "You do not have access to this tracking.", "FORBIDDEN");
    }

    const workerSnap = booking.workerId
      ? await collections.workers.doc(booking.workerId).get()
      : null;
    const worker = workerSnap?.exists ? workerSnap.data() : null;
    const eta = trackingEta(booking, worker);
    const snapshot = trackingSnapshot(booking);

    let counterpartPhone = "";
    if (isCustomer || isAdmin) {
      counterpartPhone = String(worker?.phone || "");
    } else if (isWorker) {
      const contactSnap = await bookingSnap.ref.collection("private").doc("contact").get();
      counterpartPhone = contactSnap.exists ? String(contactSnap.data().phone || "") : "";
    }

    res.json({
      booking: docToJson(bookingSnap),
      tracking: {
        ...snapshot,
        ...eta,
        counterpartPhone,
        worker: worker
          ? {
              id: booking.workerId,
              name: booking.workerName || worker.name || "EasyHome Pro",
              photoPath: booking.workerPhotoPath || worker.photoPath || "",
              phone: isCustomer || isAdmin ? String(worker.phone || "") : "",
              rating: Number(worker.rating) || 0,
              service: worker.service || booking.service,
              area: worker.area || "",
              kycStatus: worker.kycStatus || "not_submitted",
            }
          : null,
        phaseMeta: PHASE_META[snapshot.phase] || null,
      },
    });
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
