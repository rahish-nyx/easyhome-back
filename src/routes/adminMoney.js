import { Router } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { collections, db } from "../config/firebase.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireAdmin } from "../middleware/auth.js";
import { sendMail, emailLayout, notify } from "../lib/notify.js";
import { premiumActive, workerDues } from "../lib/booking.js";
import { syncPublicWorker } from "../lib/workers.js";
import { docToJson, docsToJson, lastMonths, monthKey, toDate } from "../lib/utils.js";
import { env } from "../config/env.js";

export const adminMoneyRouter = Router();
adminMoneyRouter.use(requireAdmin);

/* ----------------------------- SUBSCRIPTIONS ----------------------------- */

adminMoneyRouter.get(
  "/subscriptions",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "";
    let queryRef = collections.subscriptions.orderBy("createdAt", "desc");
    if (status) {
      queryRef = collections.subscriptions
        .where("status", "==", status)
        .orderBy("createdAt", "desc");
    }
    const snap = await queryRef.limit(100).get();
    const subscriptions = docsToJson(snap).map((sub) => ({
      ...sub,
      utrId: sub.utrId || sub.paymentNote || "",
      isPremiumNow:
        sub.status === "active" &&
        sub.endAt &&
        new Date(sub.endAt).getTime() > Date.now(),
    }));
    res.json({ subscriptions });
  }),
);

adminMoneyRouter.patch(
  "/subscriptions/:id/approve",
  asyncHandler(async (req, res) => {
    const ref = collections.subscriptions.doc(req.params.id);

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, "Subscription not found.", "NOT_FOUND");
      const sub = snap.data();
      if (sub.status === "active") {
        throw new ApiError(409, "This membership is already active.", "ALREADY_ACTIVE");
      }

      const start = new Date();
      const end = new Date(start);
      end.setMonth(end.getMonth() + (Number(sub.months) || 1));

      tx.update(ref, {
        status: "active",
        startAt: Timestamp.fromDate(start),
        endAt: Timestamp.fromDate(end),
        reviewedBy: req.user.uid,
        reviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const userRef = collections.users.doc(sub.userId);
      tx.set(
        userRef,
        {
          subscription: {
            status: "active",
            plan: sub.plan,
            amount: sub.amount,
            startAt: Timestamp.fromDate(start),
            endAt: Timestamp.fromDate(end),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      if (sub.userRole === "worker") {
        tx.set(
          collections.workers.doc(sub.userId),
          {
            premiumUntil: Timestamp.fromDate(end),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        tx.set(
          collections.workersPublic.doc(sub.userId),
          {
            premiumUntil: Timestamp.fromDate(end),
            isPremium: true,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      return { sub, end };
    });

    await syncPublicWorker(result.sub.userId).catch(() => {});

    await notify(result.sub.userId, {
      title: "Membership activated 👑",
      body: `Your ${result.sub.plan} plan is active until ${result.end.toDateString()}.`,
      type: "subscription",
      link: result.sub.userRole === "worker" ? "/worker?tab=profile" : "/subscription",
    });

    await sendMail({
      to: result.sub.userEmail,
      subject: "Your EasyHome membership is active",
      html: emailLayout({
        heading: "Membership activated 👑",
        intro: `Hi ${result.sub.userName}, your ${result.sub.plan} plan is active until ${result.end.toDateString()}.`,
        ctaText: "Open EasyHome",
        ctaUrl: env.publicWebUrl,
      }),
    });

    res.json({ ok: true });
  }),
);

adminMoneyRouter.patch(
  "/subscriptions/:id/reject",
  asyncHandler(async (req, res) => {
    const reason = String(req.body?.reason || "Payment could not be verified").slice(0, 200);
    const ref = collections.subscriptions.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiError(404, "Subscription not found.", "NOT_FOUND");
    const sub = snap.data();

    await ref.update({
      status: "rejected",
      rejectionReason: reason,
      reviewedBy: req.user.uid,
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await collections.users.doc(sub.userId).set(
      {
        subscription: { status: "rejected", plan: sub.plan },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await notify(sub.userId, {
      title: "Membership payment not verified",
      body: reason,
      type: "subscription",
      link: "/subscription",
    });

    res.json({ ok: true });
  }),
);

/* ------------------------------ COMMISSIONS ------------------------------ */

adminMoneyRouter.get(
  "/commissions",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "";
    let queryRef = collections.commissions.orderBy("createdAt", "desc");
    if (status) {
      queryRef = collections.commissions
        .where("status", "==", status)
        .orderBy("createdAt", "desc");
    }
    const snap = await queryRef.limit(100).get();
    res.json({
      commissions: docsToJson(snap).map((commission) => ({
        ...commission,
        utrId: commission.utrId || commission.note || "",
      })),
    });
  }),
);

adminMoneyRouter.patch(
  "/commissions/:id/approve",
  asyncHandler(async (req, res) => {
    const ref = collections.commissions.doc(req.params.id);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new ApiError(404, "Commission not found.", "NOT_FOUND");
      const commission = snap.data();
      if (commission.status === "approved") {
        throw new ApiError(409, "Already approved.", "ALREADY_APPROVED");
      }
      const workerRef = collections.workers.doc(commission.workerId);
      const workerSnap = await tx.get(workerRef);
      const dues = workerDues(workerSnap.data());
      const remaining = Math.max(0, dues - Number(commission.amount || 0));

      tx.update(ref, {
        status: "approved",
        approvedBy: req.user.uid,
        approvedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(
        workerRef,
        {
          dues: remaining,
          dueCommissionAmount: remaining,
          hasPendingCommission: remaining > 0,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return { commission };
    });

    await notify(result.commission.workerId, {
      title: "Commission approved ✅",
      body: "Your payment was verified. You can accept new jobs now.",
      type: "commission",
      link: "/worker",
    });

    res.json({ ok: true });
  }),
);

adminMoneyRouter.patch(
  "/commissions/:id/reject",
  asyncHandler(async (req, res) => {
    const ref = collections.commissions.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiError(404, "Commission not found.", "NOT_FOUND");
    const commission = snap.data();

    await ref.update({
      status: "rejected",
      rejectionReason: String(req.body?.reason || "Payment reference could not be verified").slice(0, 200),
      reviewedBy: req.user.uid,
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await notify(commission.workerId, {
      title: "Commission payment rejected",
      body: "Please re-check the UPI reference and submit again.",
      type: "commission",
      link: "/worker?tab=earnings",
    });

    res.json({ ok: true });
  }),
);

/* -------------------------------- REVENUE -------------------------------- */

adminMoneyRouter.get(
  "/revenue",
  asyncHandler(async (_req, res) => {
    const [subsSnap, commissionsSnap] = await Promise.all([
      collections.subscriptions.where("status", "==", "active").limit(500).get(),
      collections.commissions.where("status", "==", "approved").limit(500).get(),
    ]);

    const months = lastMonths(6);
    let subscriptionTotal = 0;
    let commissionTotal = 0;

    docsToJson(subsSnap).forEach((sub) => {
      const date = toDate(sub.startAt) || toDate(sub.createdAt);
      const amount = Number(sub.amount) || 0;
      subscriptionTotal += amount;
      const bucket = months.find((month) => month.key === monthKey(date));
      if (bucket) bucket.subscriptions = (bucket.subscriptions || 0) + amount;
    });

    docsToJson(commissionsSnap).forEach((commission) => {
      const date = toDate(commission.approvedAt) || toDate(commission.createdAt);
      const amount = Number(commission.amount) || 0;
      commissionTotal += amount;
      const bucket = months.find((month) => month.key === monthKey(date));
      if (bucket) bucket.commissions = (bucket.commissions || 0) + amount;
    });

    months.forEach((month) => {
      month.amount = (month.subscriptions || 0) + (month.commissions || 0);
    });

    res.json({
      months,
      subscriptionTotal,
      commissionTotal,
      total: subscriptionTotal + commissionTotal,
    });
  }),
);

/* ---------------------------- PREMIUM EXPIRY ---------------------------- */

adminMoneyRouter.post(
  "/maintenance/expire-premium",
  asyncHandler(async (_req, res) => {
    const snap = await collections.workers.where("status", "==", "approved").limit(500).get();
    let expired = 0;
    for (const doc of snap.docs) {
      const worker = doc.data();
      if (!premiumActive(worker) && worker.premiumUntil) {
        await doc.ref.set(
          { premiumUntil: null, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        await collections.workersPublic.doc(doc.id).set(
          { isPremium: false, premiumUntil: null, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        expired += 1;
      }
    }
    res.json({ ok: true, expired });
  }),
);
