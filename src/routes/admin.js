import { Router } from "express";
import { FieldValue, Timestamp } from "../lib/values.js";
import { collections, db } from "../config/store.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  defaultNameFromEmail,
  hashPassword,
  normalizeEmail,
} from "../lib/auth.js";
import { privateCloudinaryDownloadUrl } from "../lib/media.js";
import { updateJobFeedStatus } from "../lib/jobFeed.js";
import { promoPaymentTotal } from "../lib/promos.js";
import { notify } from "../lib/notify.js";
import { approveWorker, syncPublicWorker } from "../lib/workers.js";
import {
  appSettings,
  commissionFor,
  feesPctFor,
  premiumActive,
} from "../lib/booking.js";
import {
  adminUserUpdateSchema,
  adminWorkerReviewSchema,
} from "../lib/validate.js";
import {
  docToJson,
  docsToJson,
  lastMonths,
  monthKey,
  toDate,
} from "../lib/utils.js";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

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

/* -------------------------------- OVERVIEW -------------------------------- */

adminRouter.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      customersCount,
      approvedWorkersCount,
      pendingWorkersCount,
      bookingsTodayCount,
      pendingCount,
      acceptedCount,
      ongoingCount,
      completedCount,
      cancelledCount,
      pendingSubsSnap,
      pendingCommissionsSnap,
      activeSubsSnap,
      chatSnap,
      recentBookingsSnap,
      pendingWorkersSnap,
      recentUsersSnap,
      paidBookingsSnap,
      subsRevenueSnap,
      commissionsRevenueSnap,
    ] = await Promise.all([
      collections.users.where("role", "==", "customer").count().get(),
      collections.workers.where("status", "==", "approved").count().get(),
      collections.workers.where("status", "==", "pending").count().get(),
      collections.bookings.where("createdAt", ">=", Timestamp.fromDate(startOfDay)).count().get(),
      collections.bookings.where("status", "==", "pending").count().get(),
      collections.bookings.where("status", "==", "accepted").count().get(),
      collections.bookings.where("status", "==", "ongoing").count().get(),
      collections.bookings.where("status", "==", "completed").count().get(),
      collections.bookings.where("status", "==", "cancelled").count().get(),
      collections.subscriptions.where("status", "==", "pending").limit(50).get(),
      collections.commissions.where("status", "==", "paid").limit(100).get(),
      collections.subscriptions.where("status", "==", "active").limit(300).get(),
      collections.chatThreads.where("unreadForAdmin", ">", 0).limit(50).get(),
      collections.bookings.orderBy("createdAt", "desc").limit(10).get(),
      collections.workers.where("status", "==", "pending").orderBy("createdAt", "asc").limit(8).get(),
      collections.users.orderBy("createdAt", "desc").limit(6).get(),
      collections.bookings.where("status", "==", "completed").limit(400).get(),
      collections.subscriptions.where("status", "==", "active").limit(400).get(),
      collections.commissions.where("status", "==", "approved").limit(400).get(),
    ]);

    const revenue30d = paidBookingsSnap.docs.reduce((sum, doc) => {
      const booking = doc.data();
      const paidAt = toDate(booking.paidAt);
      if (!paidAt || paidAt < thirtyDaysAgo) return sum;
      return sum + (Number(booking.pricing?.finalPrice) || 0);
    }, 0);

    const pendingCommissionAmount = pendingCommissionsSnap.docs.reduce(
      (sum, doc) => sum + (Number(doc.data().amount) || 0),
      0,
    );

    const activeSubs = activeSubsSnap.docs.filter((doc) => {
      const end = toDate(doc.data().endAt);
      return end && end.getTime() > Date.now();
    });

    const months = lastMonths(6);
    subsRevenueSnap.docs.forEach((doc) => {
      const sub = doc.data();
      const date = toDate(sub.startAt) || toDate(sub.createdAt);
      const bucket = months.find((month) => month.key === monthKey(date));
      if (bucket) bucket.subscriptions = (bucket.subscriptions || 0) + (Number(sub.amount) || 0);
    });
    commissionsRevenueSnap.docs.forEach((doc) => {
      const commission = doc.data();
      const date = toDate(commission.approvedAt) || toDate(commission.createdAt);
      const bucket = months.find((month) => month.key === monthKey(date));
      if (bucket) bucket.commissions = (bucket.commissions || 0) + (Number(commission.amount) || 0);
    });
    months.forEach((month) => {
      month.amount = (month.subscriptions || 0) + (month.commissions || 0);
    });

    res.json({
      stats: {
        customers: customersCount.data().count,
        workers: approvedWorkersCount.data().count,
        pendingWorkers: pendingWorkersCount.data().count,
        bookingsToday: bookingsTodayCount.data().count,
        bookings: {
          pending: pendingCount.data().count,
          accepted: acceptedCount.data().count,
          ongoing: ongoingCount.data().count,
          completed: completedCount.data().count,
          cancelled: cancelledCount.data().count,
        },
        revenue30d,
        pendingCommissions: pendingCommissionAmount,
        pendingCommissionCount: pendingCommissionsSnap.size,
        pendingSubscriptions: pendingSubsSnap.size,
        activeSubscriptions: activeSubs.length,
        unreadChats: chatSnap.size,
      },
      charts: { months },
      recentBookings: docsToJson(recentBookingsSnap),
      pendingWorkerList: docsToJson(pendingWorkersSnap),
      recentUsers: docsToJson(recentUsersSnap),
    });
  }),
);

/* --------------------------------- USERS --------------------------------- */

adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    const role = req.query.role ? String(req.query.role) : "";
    const q = req.query.q ? String(req.query.q).toLowerCase() : "";
    const snap = await collections.users.orderBy("createdAt", "desc").limit(150).get();
    let users = docsToJson(snap);
    if (role) users = users.filter((user) => user.role === role);
    if (q) {
      users = users.filter(
        (user) =>
          String(user.name || "").toLowerCase().includes(q) ||
          String(user.email || "").toLowerCase().includes(q) ||
          String(user.phone || "").includes(q),
      );
    }
    res.json({ users });
  }),
);

adminRouter.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const body = adminUserUpdateSchema.parse(req.body || {});
    const uid = req.params.id;

    if (body.disabled !== undefined) {
      await collections.users.doc(uid).set(
        { disabled: body.disabled, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      if (body.disabled) {
        await collections.workers.doc(uid).set(
          { online: false, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        await collections.workersPublic.doc(uid).delete().catch(() => {});
      } else {
        await syncPublicWorker(uid).catch(() => {});
      }
    }

    await audit(req.user.uid, "user.update", { uid, ...body });
    res.json({ ok: true });
  }),
);

/* -------------------------------- WORKERS -------------------------------- */

adminRouter.get(
  "/workers",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "pending";
    let queryRef = collections.workers;
    if (status !== "all") queryRef = queryRef.where("status", "==", status);
    const snap = await queryRef.limit(150).get();
    const workers = docsToJson(snap).sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    );
    res.json({ workers });
  }),
);

adminRouter.patch(
  "/workers/:id/review",
  asyncHandler(async (req, res) => {
    const body = adminWorkerReviewSchema.parse(req.body || {});
    const uid = req.params.id;
    const workerSnap = await collections.workers.doc(uid).get();
    if (!workerSnap.exists) throw new ApiError(404, "Worker not found.", "NOT_FOUND");
    const worker = workerSnap.data();

    if (body.action === "approve" || body.action === "reinstate") {
      await collections.workers.doc(uid).set(
        {
          status: "approved",
          approvedAt: FieldValue.serverTimestamp(),
          rejectionReason: "",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      await collections.users.doc(uid).set(
        { role: "worker", updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      await approveWorker(uid, { approved: true });

      await notify(uid, {
        title: "You are approved 🎉",
        body: "Your EasyHome worker account is live. Go online to receive jobs.",
        type: "worker_approved",
        link: "/worker",
      });
    }

    if (body.action === "reject") {
      await collections.workers.doc(uid).set(
        {
          status: "rejected",
          rejectionReason: body.reason || "Application did not meet our verification requirements.",
          online: false,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      await approveWorker(uid, { approved: false });
      await notify(uid, {
        title: "Worker application update",
        body: body.reason || "Your application was not approved. You can update your details and re-apply.",
        type: "worker_rejected",
        link: "/auth?role=worker",
      });
    }

    if (body.action === "suspend") {
      await collections.workers.doc(uid).set(
        {
          status: "suspended",
          online: false,
          suspensionReason: body.reason || "Temporarily suspended by EasyHome.",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      await approveWorker(uid, { approved: false });
      await notify(uid, {
        title: "Account suspended",
        body: body.reason || "Your worker account has been suspended. Contact support.",
        type: "worker_suspended",
        link: "/chat",
      });
    }

    await audit(req.user.uid, `worker.${body.action}`, { uid, reason: body.reason || "" });
    res.json({ ok: true });
  }),
);

adminRouter.patch(
  "/workers/:id/kyc",
  asyncHandler(async (req, res) => {
    const action = req.body?.action === "reject" ? "rejected" : "verified";
    await collections.workers.doc(req.params.id).set(
      {
        kycStatus: action,
        kycReviewedAt: FieldValue.serverTimestamp(),
        ...(action === "rejected"
          ? { kycRejectionReason: String(req.body?.reason || "Document unclear").slice(0, 200) }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await notify(req.params.id, {
      title: action === "verified" ? "ID verified ✅" : "ID verification failed",
      body:
        action === "verified"
          ? "Your identity document was verified. Your profile now shows the verified badge."
          : String(req.body?.reason || "Please upload a clearer government ID."),
      type: "kyc",
      link: "/worker?tab=profile",
    });
    await audit(req.user.uid, `worker.kyc.${action}`, { uid: req.params.id });
    res.json({ ok: true });
  }),
);

adminRouter.get(
  "/workers/:id/kyc-file",
  asyncHandler(async (req, res) => {
    const snap = await collections.workers.doc(req.params.id).get();
    if (!snap.exists) throw new ApiError(404, "Worker not found.", "NOT_FOUND");
    const { kycCloudinaryId, kycCloudinaryFormat } = snap.data();
    if (!kycCloudinaryId || !kycCloudinaryFormat) {
      throw new ApiError(404, "No KYC document uploaded.", "KYC_MISSING");
    }
    res.redirect(
      302,
      privateCloudinaryDownloadUrl(kycCloudinaryId, kycCloudinaryFormat),
    );
  }),
);

/* -------------------------------- BOOKINGS ------------------------------- */

adminRouter.get(
  "/bookings",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "";
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    let queryRef = collections.bookings.orderBy("createdAt", "desc");
    if (status) {
      queryRef = collections.bookings
        .where("status", "==", status)
        .orderBy("createdAt", "desc");
    }
    const snap = await queryRef.limit(limit).get();
    res.json({ bookings: docsToJson(snap) });
  }),
);

adminRouter.patch(
  "/bookings/:id/cancel",
  asyncHandler(async (req, res) => {
    const reason = String(req.body?.reason || "Cancelled by EasyHome support").slice(0, 300);
    const ref = collections.bookings.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiError(404, "Booking not found.", "NOT_FOUND");
    const booking = snap.data();
    if (["completed", "cancelled"].includes(booking.status)) {
      throw new ApiError(409, "This booking can no longer be cancelled.", "STATUS_INVALID");
    }

    await ref.update({
      status: "cancelled",
      cancelReason: reason,
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledBy: "admin",
      updatedAt: FieldValue.serverTimestamp(),
    });
    try {
      await updateJobFeedStatus(ref.id, "cancelled");
    } catch (error) {
      console.error("Could not close admin-cancelled job-feed entries:", error.code || error.message);
    }
    await collections.urgentPublic.doc(ref.id).delete().catch(() => {});

    await notify(booking.customerId, {
      title: "Booking cancelled",
      body: `${booking.service} was cancelled by EasyHome. Reason: ${reason}`,
      type: "cancelled",
      link: "/bookings",
    });
    if (booking.workerId) {
      await notify(booking.workerId, {
        title: "Job cancelled",
        body: `${booking.service} at ${booking.area} was cancelled by support.`,
        type: "cancelled",
        link: "/worker",
      });
    }

    await audit(req.user.uid, "booking.cancel", { bookingId: ref.id, reason });
    res.json({ ok: true });
  }),
);

adminRouter.patch(
  "/bookings/:id/payment",
  asyncHandler(async (req, res) => {
    const mode = String(req.body?.mode || "cash");
    const ref = collections.bookings.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiError(404, "Booking not found.", "NOT_FOUND");
    const booking = snap.data();
    if (booking.status !== "completed") {
      throw new ApiError(409, "Only completed jobs can be marked paid.", "STATUS_INVALID");
    }
    if (booking.paidAt) throw new ApiError(409, "Already marked paid.", "ALREADY_PAID");

    const settings = await appSettings();
    const existing = await collections.commissions
      .where("bookingId", "==", ref.id)
      .limit(1)
      .get();
    const workerSnap = booking.workerId
      ? await collections.workers.doc(booking.workerId).get()
      : null;
    const worker = workerSnap?.exists ? workerSnap.data() : null;
    const finalPrice = Math.round(
      Number(booking.pricing?.finalPrice) || Number(booking.budget) || 0,
    );
    const urgentFee = Math.max(0, Math.round(Number(booking.urgentFee) || 0));
    const { baseTotal, promoDiscount, paymentTotal } = promoPaymentTotal({
      finalPrice,
      urgentFee,
      promoDiscount: booking.promoDiscount ?? booking.pricing?.promoDiscount,
    });
    const premium = premiumActive(worker);
    const { commission, workerReceives: serviceEarnings } = commissionFor(
      finalPrice,
      feesPctFor(settings),
      { premium },
    );
    // The urgent-job fee belongs to the worker; fees apply only to the agreed
    // service price (and are zero for Pro workers).
    const workerReceives = serviceEarnings + urgentFee;

    const batch = db.batch();
    batch.update(ref, {
      paidAt: FieldValue.serverTimestamp(),
      paymentMode: mode,
      "pricing.finalPrice": finalPrice,
      "pricing.urgentFee": urgentFee,
      "pricing.baseTotal": baseTotal,
      "pricing.promoCode": booking.promoCode || "",
      "pricing.promoDiscount": promoDiscount,
      "pricing.paymentTotal": paymentTotal,
      "pricing.commission": commission,
      "pricing.workerReceives": workerReceives,
      promoDiscount,
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (booking.workerId && commission > 0) {
      if (existing.empty) {
        batch.set(collections.commissions.doc(), {
          workerId: booking.workerId,
          workerName: booking.workerName,
          bookingId: ref.id,
          service: booking.service,
          amount: commission,
          status: "pending",
          note: "Marked paid by admin",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        batch.set(
          collections.workers.doc(booking.workerId),
          {
            dues: FieldValue.increment(commission),
            dueCommissionAmount: FieldValue.increment(commission),
            hasPendingCommission: true,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    }

    await batch.commit();
    await audit(req.user.uid, "booking.markPaid", { bookingId: ref.id, mode });
    res.json({ ok: true, commission, workerReceives, urgentFee, paymentTotal });
  }),
);

/* ---------------------------------- CHAT --------------------------------- */

adminRouter.get(
  "/chats",
  asyncHandler(async (_req, res) => {
    const snap = await collections.chatThreads
      .orderBy("lastAt", "desc")
      .limit(200)
      .get();
    const threads = docsToJson(snap).sort((a, b) => {
      const aPro = a.priority === "pro" ? 1 : 0;
      const bPro = b.priority === "pro" ? 1 : 0;
      if (aPro !== bPro) return bPro - aPro;
      return 0;
    });
    res.json({ threads });
  }),
);

adminRouter.get(
  "/chats/:uid",
  asyncHandler(async (req, res) => {
    const uid = req.params.uid;
    const threadRef = collections.chatThreads.doc(uid);
    const messagesSnap = await threadRef
      .collection("messages")
      .orderBy("createdAt", "asc")
      .limit(150)
      .get();

    await threadRef.set({ unreadForAdmin: 0 }, { merge: true }).catch(() => {});
    const unread = messagesSnap.docs.filter((doc) => doc.data().senderRole !== "admin" && !doc.data().read);
    if (unread.length) {
      const batch = db.batch();
      unread.forEach((doc) => batch.update(doc.ref, { read: true }));
      await batch.commit();
    }

    const threadSnap = await threadRef.get();
    res.json({
      thread: docToJson(threadSnap),
      messages: docsToJson(messagesSnap),
    });
  }),
);

adminRouter.post(
  "/chats/:uid",
  asyncHandler(async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) throw new ApiError(422, "Message is required.", "MESSAGE_REQUIRED");
    const uid = req.params.uid;
    const threadRef = collections.chatThreads.doc(uid);
    const messageRef = threadRef.collection("messages").doc();
    const now = FieldValue.serverTimestamp();

    await db.runTransaction(async (tx) => {
      tx.set(messageRef, {
        senderId: "admin",
        senderRole: "admin",
        senderName: "EasyHome Support",
        text,
        read: false,
        createdAt: now,
      });
      tx.set(
        threadRef,
        {
          lastMessage: text.slice(0, 120),
          lastAt: now,
          unreadForAdmin: 0,
          unreadForUser: FieldValue.increment(1),
          updatedAt: now,
        },
        { merge: true },
      );
    });

    await notify(uid, {
      title: "EasyHome Support",
      body: text.slice(0, 120),
      type: "chat",
      link: "/chat",
    });

    res.status(201).json({ ok: true, messageId: messageRef.id });
  }),
);

adminRouter.post(
  "/chats/:uid/end",
  asyncHandler(async (req, res) => {
    const uid = req.params.uid;
    const threadRef = collections.chatThreads.doc(uid);

    for (;;) {
      const snap = await threadRef.collection("messages").limit(400).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }

    await threadRef.delete().catch(() => {});
    await collections.callRequests
      .where("userId", "==", uid)
      .where("status", "==", "pending")
      .limit(20)
      .get()
      .then((snap) => {
        if (snap.empty) return null;
        const batch = db.batch();
        snap.docs.forEach((doc) =>
          batch.update(doc.ref, {
            status: "dismissed",
            handledBy: req.user.uid,
            handledAt: FieldValue.serverTimestamp(),
          }),
        );
        return batch.commit();
      })
      .catch(() => {});

    await audit(req.user.uid, "chat.end", { uid });
    res.json({ ok: true });
  }),
);

/* ------------------------------ CALL REQUESTS ----------------------------- */

adminRouter.get(
  "/call-requests",
  asyncHandler(async (_req, res) => {
    const snap = await collections.callRequests
      .where("status", "==", "pending")
      .limit(100)
      .get();
    const requests = docsToJson(snap).sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    );
    res.json({ requests });
  }),
);

adminRouter.patch(
  "/call-requests/:id",
  asyncHandler(async (req, res) => {
    const action = String(req.body?.action || "").trim();
    if (!["done", "cancel"].includes(action)) {
      throw new ApiError(422, "Choose done or cancel.", "ACTION_REQUIRED");
    }
    const ref = collections.callRequests.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiError(404, "Call request not found.", "NOT_FOUND");
    if (snap.data().status !== "pending") {
      return res.json({ ok: true, already: true });
    }

    await ref.set(
      {
        status: action === "done" ? "done" : "dismissed",
        handledBy: req.user.uid,
        handledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await audit(req.user.uid, `callRequest.${action}`, { requestId: ref.id });
    res.json({ ok: true });
  }),
);

/* -------------------------------- REFERRALS ------------------------------- */

adminRouter.get(
  "/referrals",
  asyncHandler(async (_req, res) => {
    const snap = await collections.referrals
      .orderBy("createdAt", "desc")
      .limit(250)
      .get();
    const referrals = docsToJson(snap);
    const stats = referrals.reduce(
      (result, item) => {
        result.total += 1;
        if (item.status === "pending") result.pending += 1;
        if (item.status === "service_completed") result.awaitingVerification += 1;
        if (item.status === "approved") result.approved += 1;
        if (item.status === "rejected") result.rejected += 1;
        if (item.status === "approved") result.approvedRewards += Number(item.rewardAmount) || 0;
        return result;
      },
      {
        total: 0,
        pending: 0,
        awaitingVerification: 0,
        approved: 0,
        rejected: 0,
        approvedRewards: 0,
      },
    );
    res.json({ referrals, stats });
  }),
);

adminRouter.patch(
  "/referrals/:id",
  asyncHandler(async (req, res) => {
    const action = String(req.body?.action || "").trim();
    const note = String(req.body?.note || "").slice(0, 500);
    if (!["approve", "reject"].includes(action)) {
      throw new ApiError(422, "Choose approve or reject.", "ACTION_REQUIRED");
    }

    const ref = collections.referrals.doc(req.params.id);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, "Referral not found.", "NOT_FOUND");
      const referral = snap.data();
      if (["approved", "rejected"].includes(referral.status)) {
        return { referral, already: true };
      }
      if (action === "approve" && !referral.serviceCompleted) {
        throw new ApiError(
          409,
          referral.referredRole === "worker"
            ? "This professional has not completed their first job yet."
            : "This friend has not completed their first service yet.",
          "REFERRAL_NOT_ELIGIBLE",
        );
      }

      const update = {
        status: action === "approve" ? "approved" : "rejected",
        rewardStatus: action === "approve" ? "approved" : "rejected",
        adminNote: note,
        reviewedBy: req.user.uid,
        reviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        ...(action === "approve"
          ? { approvedAt: FieldValue.serverTimestamp() }
          : { rejectedAt: FieldValue.serverTimestamp() }),
      };
      tx.update(ref, update);
      return { referral: { ...referral, ...update }, already: false };
    });

    if (!result.already) {
      const { referral } = result;
      const reward = Number(referral.rewardAmount) || 51;
      const isWorker = referral.referredRole === "worker";
      const referralLink = isWorker ? "/worker?tab=refer" : "/refer";
      const title =
        action === "approve"
          ? isWorker
            ? "Professional referral approved 🎉"
            : "Referral approved 🎉"
          : isWorker
            ? "Professional referral could not be approved"
            : "Referral could not be approved";
      const referrerBody =
        action === "approve"
          ? `₹${reward} for you and ₹${reward} for ${referral.referredName || "your friend"} are approved. Our team will process the reward — it is not auto-credited.`
          : "A referral was reviewed and could not be approved. Open Refer & Earn for details.";
      const referredBody =
        action === "approve"
          ? `Your ₹${reward} welcome reward is approved. Our team will process it separately — it is not auto-credited.`
          : "Your welcome referral was reviewed and could not be approved. Contact support if you need help.";
      await Promise.allSettled([
        notify(referral.referrerId, {
          title,
          body: referrerBody,
          type: "referral",
          link: referralLink,
        }),
        notify(referral.referredId, {
          title,
          body: referredBody,
          type: "referral",
          link: referralLink,
        }),
      ]);
      await audit(req.user.uid, `referral.${action}`, {
        referralId: ref.id,
        note,
      });
    }

    res.json({ ok: true, already: result.already });
  }),
);

/* --------------------------------- ADMINS -------------------------------- */

adminRouter.get(
  "/admins",
  asyncHandler(async (_req, res) => {
    const snap = await collections.admins.orderBy("createdAt", "asc").get();
    res.json({ admins: docsToJson(snap) });
  }),
);

adminRouter.post(
  "/admins",
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "EasyHome Admin").trim();
    if (!email) throw new ApiError(422, "Email is required.", "EMAIL_REQUIRED");

    const snap = await collections.users
      .where("email", "==", email)
      .limit(1)
      .get();

    let uid;
    if (!snap.empty) {
      uid = snap.docs[0].id;
    } else {
      if (password.length < 8) {
        throw new ApiError(
          422,
          "New admins need a password of at least 8 characters.",
          "PASSWORD_REQUIRED",
        );
      }
      uid = collections.users.doc().id;
      await collections.users.doc(uid).set({
        uid,
        email,
        name: name || defaultNameFromEmail(email),
        phone: "",
        role: "customer",
        photoPath: "",
        city: "",
        addresses: [],
        emailVerified: true,
        disabled: false,
        subscription: { status: "none", plan: null, startAt: null, endAt: null },
        referralCode: "",
        referredBy: "",
        authProvider: "password",
        passwordHash: await hashPassword(password),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        lastLoginAt: null,
      });
    }

    if ((await collections.admins.doc(uid).get()).exists) {
      throw new ApiError(409, "This account is already an admin.", "ALREADY_ADMIN");
    }

    await collections.admins.doc(uid).set({
      uid,
      email,
      name,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user.uid,
    });

    await audit(req.user.uid, "admin.add", { uid, email });
    res.status(201).json({ ok: true, uid });
  }),
);

adminRouter.delete(
  "/admins/:id",
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user.uid) {
      throw new ApiError(409, "You cannot remove your own admin access.", "SELF_REMOVE");
    }
    const snap = await collections.admins.get();
    if (snap.size <= 1) {
      throw new ApiError(409, "At least one admin must remain.", "LAST_ADMIN");
    }

    await collections.admins.doc(req.params.id).delete();
    await audit(req.user.uid, "admin.remove", { uid: req.params.id });
    res.json({ ok: true });
  }),
);

/* --------------------------------- AUDIT --------------------------------- */

adminRouter.get(
  "/audit",
  asyncHandler(async (_req, res) => {
    const snap = await collections.audit.orderBy("createdAt", "desc").limit(100).get();
    res.json({ audit: docsToJson(snap) });
  }),
);
