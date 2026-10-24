import { Router } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { auth, collections, db } from "../config/firebase.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireAdmin } from "../middleware/auth.js";
import { streamPrivateObject } from "../lib/media.js";
import { emailLayout, notify, sendMail } from "../lib/notify.js";
import { approveWorker, syncPublicWorker } from "../lib/workers.js";
import {
  appSettings,
  commissionFor,
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
import { env } from "../config/env.js";

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
      await auth.updateUser(uid, { disabled: body.disabled }).catch(() => {});
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
      await sendMail({
        to: worker.email,
        subject: "You are approved on EasyHome",
        html: emailLayout({
          heading: "You are live on EasyHome 🎉",
          intro: `Hi ${worker.name}, your ${worker.service} application was approved. Turn on “Online” in the app to start receiving jobs in ${worker.area}.`,
          ctaText: "Open worker dashboard",
          ctaUrl: `${env.publicWebUrl}/worker`,
        }),
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
    const { kycPath } = snap.data();
    if (!kycPath) throw new ApiError(404, "No KYC document uploaded.", "KYC_MISSING");
    await streamPrivateObject(kycPath, res);
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
    await collections.jobFeed.doc(ref.id).set(
      { status: "cancelled", updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
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
    const premium = premiumActive(worker);
    const { commission, workerReceives } = commissionFor(
      finalPrice,
      settings.commissionPct,
      { premium },
    );

    const batch = db.batch();
    batch.update(ref, {
      paidAt: FieldValue.serverTimestamp(),
      paymentMode: mode,
      "pricing.finalPrice": finalPrice,
      "pricing.commission": commission,
      "pricing.workerReceives": workerReceives,
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
    res.json({ ok: true, commission, workerReceives });
  }),
);

/* ---------------------------------- CHAT --------------------------------- */

adminRouter.get(
  "/chats",
  asyncHandler(async (_req, res) => {
    const snap = await collections.chatThreads
      .orderBy("lastAt", "desc")
      .limit(60)
      .get();
    res.json({ threads: docsToJson(snap) });
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
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "EasyHome Admin").trim();
    if (!email) throw new ApiError(422, "Email is required.", "EMAIL_REQUIRED");

    let record;
    try {
      record = await auth.getUserByEmail(email);
    } catch {
      if (password.length < 8) {
        throw new ApiError(
          422,
          "New admins need a password of at least 8 characters.",
          "PASSWORD_REQUIRED",
        );
      }
      record = await auth.createUser({ email, password, displayName: name });
    }

    if ((await collections.admins.doc(record.uid).get()).exists) {
      throw new ApiError(409, "This account is already an admin.", "ALREADY_ADMIN");
    }

    const currentClaims = record.customClaims || {};
    await auth.setCustomUserClaims(record.uid, { ...currentClaims, admin: true });

    await collections.admins.doc(record.uid).set({
      uid: record.uid,
      email,
      name,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user.uid,
    });

    await audit(req.user.uid, "admin.add", { uid: record.uid, email });
    res.status(201).json({ ok: true, uid: record.uid });
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

    const record = await auth.getUser(req.params.id).catch(() => null);
    if (record) {
      const currentClaims = record.customClaims || {};
      await auth.setCustomUserClaims(req.params.id, { ...currentClaims, admin: false });
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
