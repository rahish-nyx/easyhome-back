import { Router } from "express";
import { FieldValue, Timestamp } from "../lib/firestore.js";
import { z } from "zod";
import { collections, db } from "../config/firebase.js";
import { env } from "../config/env.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireApprovedWorker, requireAuth } from "../middleware/auth.js";
import {
  appSettings,
  planMonths,
  subscriptionAmount,
  workerDues,
} from "../lib/booking.js";
import { syncPublicWorker } from "../lib/workers.js";
import { emailLayout, notify, sendMail } from "../lib/notify.js";
import {
  commissionPaidTelegramMessage,
  sendTelegramAlert,
  subscriptionPaidTelegramMessage,
} from "../lib/telegram.js";
import {
  createRazorpayOrder,
  razorpayConfigured,
  razorpayKeyId,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from "../lib/razorpay.js";

export const paymentRouter = Router();

const orderSchema = z.object({ plan: z.enum(["monthly", "quarterly", "yearly"]).default("monthly") });
const verifySchema = z.object({
  razorpay_order_id: z.string().min(4),
  razorpay_payment_id: z.string().min(4),
  razorpay_signature: z.string().min(8),
  subscriptionId: z.string().optional(),
  commissionId: z.string().optional(),
});
const commissionOrderSchema = z.object({ commissionId: z.string().min(4) });

function assertOnlinePayments() {
  if (!razorpayConfigured()) {
    throw new ApiError(
      503,
      "Online payments are temporarily unavailable. Please try again later.",
      "PAYMENT_NOT_CONFIGURED",
    );
  }
}

function assertSignature(payload) {
  const valid = verifyPaymentSignature({
    orderId: payload.razorpay_order_id,
    paymentId: payload.razorpay_payment_id,
    signature: payload.razorpay_signature,
  });
  if (!valid) {
    throw new ApiError(
      400,
      "Payment verification failed. If money was deducted, contact support with your payment ID.",
      "PAYMENT_SIGNATURE_INVALID",
    );
  }
}

async function findSubscription({ subscriptionId, orderId }) {
  if (subscriptionId) {
    const snap = await collections.subscriptions.doc(subscriptionId).get();
    if (snap.exists) return snap;
  }
  const snap = await collections.subscriptions
    .where("razorpayOrderId", "==", orderId)
    .limit(1)
    .get();
  if (!snap.empty) return snap.docs[0];
  throw new ApiError(404, "Subscription order not found.", "SUBSCRIPTION_NOT_FOUND");
}

async function findCommission({ commissionId, orderId }) {
  if (commissionId) {
    const snap = await collections.commissions.doc(commissionId).get();
    if (snap.exists) return snap;
  }
  const snap = await collections.commissions
    .where("razorpayOrderId", "==", orderId)
    .limit(1)
    .get();
  if (!snap.empty) return snap.docs[0];
  throw new ApiError(404, "Fees payment not found.", "COMMISSION_NOT_FOUND");
}

async function fulfillSubscription({ orderId, paymentId, subscriptionId, userId }) {
  const snap = await findSubscription({ subscriptionId, orderId });
  const result = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(snap.ref);
    if (!fresh.exists) throw new ApiError(404, "Subscription not found.", "NOT_FOUND");
    const sub = fresh.data();
    if (userId && sub.userId !== userId) {
      throw new ApiError(403, "This subscription belongs to another account.", "FORBIDDEN");
    }
    if (sub.razorpayOrderId && sub.razorpayOrderId !== orderId) {
      throw new ApiError(400, "Payment order does not match this subscription.", "ORDER_MISMATCH");
    }

    if (sub.status === "active") {
      return { sub, already: true };
    }
    if (sub.paymentId && sub.paymentId !== paymentId) {
      return { sub, already: true };
    }

    const start = new Date();
    const end = new Date(start);
    end.setMonth(end.getMonth() + (Number(sub.months) || 1));

    tx.update(snap.ref, {
      status: "active",
      paymentProvider: "razorpay",
      paymentStatus: "captured",
      razorpayOrderId: orderId,
      paymentId,
      paidAt: Timestamp.fromDate(start),
      startAt: Timestamp.fromDate(start),
      endAt: Timestamp.fromDate(end),
      reviewedBy: "razorpay",
      reviewedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      utrId: "",
      paymentNote: "",
    });

    tx.set(
      collections.users.doc(sub.userId),
      {
        subscription: {
          status: "active",
          plan: sub.plan,
          amount: sub.amount,
          startAt: Timestamp.fromDate(start),
          endAt: Timestamp.fromDate(end),
          paymentProvider: "razorpay",
          paymentId,
          utrId: "",
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

    tx.set(
      collections.payments.doc(paymentId),
      {
        paymentId,
        orderId,
        amount: sub.amount,
        currency: "INR",
        provider: "razorpay",
        type: "subscription",
        userId: sub.userId,
        subscriptionId: snap.id,
        status: "captured",
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { sub, end, already: false };
  });

  if (result.already) return { ok: true, already: true };
  const { sub, end } = result;

  await notify(sub.userId, {
    title: "Membership activated 🎉",
    body: `Your ${sub.plan} plan is active until ${end.toDateString()}.`,
    type: "subscription",
    link: sub.userRole === "worker" ? "/worker?tab=profile" : "/subscription",
  });
  await sendMail({
    to: sub.userEmail,
    subject: "Your EasyHome membership is active",
    html: emailLayout({
      heading: "Membership activated 🎉",
      intro: `Hi ${sub.userName}, your ${sub.plan} plan is active until ${end.toDateString()}.`,
      ctaText: "Open EasyHome",
      ctaUrl: env.publicWebUrl,
    }),
  }).catch(() => {});
  if (sub.userRole === "worker") await syncPublicWorker(sub.userId).catch(() => {});

  await sendTelegramAlert(
    subscriptionPaidTelegramMessage({
      name: sub.userName,
      email: sub.userEmail,
      role: sub.userRole,
      planLabel: sub.plan,
      months: sub.months,
      amount: sub.amount,
      paymentId,
      orderId,
    }),
  );

  return { ok: true, end: end.toISOString() };
}

async function fulfillCommission({ orderId, paymentId, commissionId, workerId }) {
  const snap = await findCommission({ commissionId, orderId });
  const result = await db.runTransaction(async (tx) => {
    const fresh = await tx.get(snap.ref);
    if (!fresh.exists) throw new ApiError(404, "Fees not found.", "NOT_FOUND");
    const commission = fresh.data();
    if (workerId && commission.workerId !== workerId) {
      throw new ApiError(403, "This fee belongs to another worker.", "FORBIDDEN");
    }
    if (commission.razorpayOrderId && commission.razorpayOrderId !== orderId) {
      throw new ApiError(400, "Payment order does not match this fee.", "ORDER_MISMATCH");
    }

    if (commission.status === "approved") {
      return { commission, already: true };
    }

    const workerRef = collections.workers.doc(commission.workerId);
    const workerSnap = await tx.get(workerRef);
    const dues = workerDues(workerSnap.data());
    const remaining = Math.max(0, dues - Number(commission.amount || 0));

    tx.update(snap.ref, {
      status: "approved",
      paymentProvider: "razorpay",
      paymentStatus: "captured",
      razorpayOrderId: orderId,
      paymentId,
      utrId: "",
      note: "",
      rejectionReason: FieldValue.delete(),
      paidAt: FieldValue.serverTimestamp(),
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: "razorpay",
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
    tx.set(
      collections.payments.doc(paymentId),
      {
        paymentId,
        orderId,
        amount: commission.amount,
        currency: "INR",
        provider: "razorpay",
        type: "commission",
        workerId: commission.workerId,
        commissionId: snap.id,
        bookingId: commission.bookingId,
        status: "captured",
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { commission, remaining, already: false };
  });

  if (result.already) return { ok: true, already: true };
  const commission = result.commission;

  await notify(commission.workerId, {
    title: "Fees cleared ✅",
    body: "Your payment was verified automatically. You can accept new jobs now.",
    type: "commission",
    link: "/worker?tab=earnings",
  });

  await sendTelegramAlert(
    commissionPaidTelegramMessage({
      workerName: commission.workerName,
      workerId: commission.workerId,
      service: commission.service,
      bookingId: commission.bookingId,
      amount: commission.amount,
      paymentId,
      orderId,
    }),
  );

  return { ok: true, remaining: result.remaining };
}

/* ------------------------------- SUBSCRIPTION ------------------------------ */

paymentRouter.post(
  "/subscription/order",
  requireAuth,
  asyncHandler(async (req, res) => {
    assertOnlinePayments();
    const { plan } = orderSchema.parse(req.body || {});
    const uid = req.user.uid;
    const settings = await appSettings();
    const userRef = collections.users.doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new ApiError(404, "Profile not found.", "PROFILE_MISSING");
    const user = userSnap.data();
    const current = user.subscription || {};
    const currentEnd = current.endAt?.toDate?.();
    if (current.status === "active" && currentEnd && currentEnd.getTime() > Date.now()) {
      throw new ApiError(409, "Your membership is already active.", "ALREADY_SUBSCRIBED");
    }

    const role = user.role === "worker" ? "worker" : "customer";
    const amount = subscriptionAmount(settings, role, plan);
    const months = planMonths(plan);
    const subRef = collections.subscriptions.doc();
    const order = await createRazorpayOrder({
      amountRupees: amount,
      receipt: `sub_${subRef.id}`.slice(0, 40),
      notes: {
        type: "subscription",
        subscriptionId: subRef.id,
        userId: uid,
        plan,
      },
    });

    await subRef.set({
      userId: uid,
      userName: user.name || req.user.name || "Customer",
      userEmail: user.email || req.user.email || "",
      userRole: user.role || req.user.role || "customer",
      plan,
      months,
      amount,
      status: "payment_pending",
      paymentProvider: "razorpay",
      paymentStatus: "created",
      razorpayOrderId: order.id,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      startAt: null,
      endAt: null,
      reviewedBy: null,
    });

    await userRef.set(
      {
        subscription: { ...current, status: "payment_pending", plan, amount },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.status(201).json({
      keyId: razorpayKeyId(),
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || "INR",
      subscriptionId: subRef.id,
      name: "EasyHome",
      description: `EasyHome Pro · ${plan} plan`,
      prefill: {
        name: user.name || req.user.name || "",
        email: user.email || req.user.email || "",
        contact: user.phone || "",
      },
    });
  }),
);

paymentRouter.post(
  "/subscription/verify",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = verifySchema.parse(req.body || {});
    assertSignature(body);
    const result = await fulfillSubscription({
      orderId: body.razorpay_order_id,
      paymentId: body.razorpay_payment_id,
      subscriptionId: body.subscriptionId,
      userId: req.user.uid,
    });
    res.json(result);
  }),
);

/* -------------------------------- COMMISSION ------------------------------- */

paymentRouter.post(
  "/commission/order",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    assertOnlinePayments();
    const { commissionId } = commissionOrderSchema.parse(req.body || {});
    const uid = req.user.uid;
    const ref = collections.commissions.doc(commissionId);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiError(404, "Fees not found.", "COMMISSION_NOT_FOUND");
    const commission = snap.data();
    if (commission.workerId !== uid) {
      throw new ApiError(403, "This fee belongs to another worker.", "FORBIDDEN");
    }
    if (commission.status === "approved") {
      throw new ApiError(409, "This fee is already cleared.", "ALREADY_APPROVED");
    }
    if (commission.status === "paid") {
      throw new ApiError(
        409,
        "This fee is already awaiting verification.",
        "PAYMENT_PENDING",
      );
    }

    const workerSnap = await collections.workers.doc(uid).get();
    const worker = workerSnap.exists ? workerSnap.data() : {};
    const order = await createRazorpayOrder({
      amountRupees: Number(commission.amount) || 0,
      receipt: `com_${commissionId}`.slice(0, 40),
      notes: {
        type: "commission",
        commissionId,
        workerId: uid,
        bookingId: commission.bookingId || "",
      },
    });

    await ref.set(
      {
        paymentProvider: "razorpay",
        paymentStatus: "created",
        razorpayOrderId: order.id,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    res.status(201).json({
      keyId: razorpayKeyId(),
      orderId: order.id,
      amount: order.amount,
      currency: order.currency || "INR",
      commissionId,
      name: "EasyHome",
      description: `Worker fees · ${commission.service || "Job"}`,
      prefill: {
        name: worker.name || req.user.name || "",
        email: worker.email || req.user.email || "",
        contact: worker.phone || "",
      },
    });
  }),
);

paymentRouter.post(
  "/commission/verify",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const body = verifySchema.parse(req.body || {});
    assertSignature(body);
    const result = await fulfillCommission({
      orderId: body.razorpay_order_id,
      paymentId: body.razorpay_payment_id,
      commissionId: body.commissionId,
      workerId: req.user.uid,
    });
    res.json(result);
  }),
);

/* --------------------------------- WEBHOOK -------------------------------- */

paymentRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const signature = req.headers["x-razorpay-signature"];
    if (!verifyWebhookSignature(raw, signature)) {
      throw new ApiError(400, "Invalid Razorpay webhook signature.", "WEBHOOK_INVALID");
    }

    const event = req.body?.event || "";
    const payment = req.body?.payload?.payment?.entity || {};
    const order = req.body?.payload?.order?.entity || {};
    const notes = payment.notes || order.notes || {};
    const orderId = payment.order_id || order.id;
    const paymentId = payment.id;

    if (!["payment.captured", "order.paid"].includes(event)) {
      return res.json({ ok: true, ignored: true, event });
    }
    if (!orderId || !paymentId) {
      return res.json({ ok: true, ignored: true, reason: "missing_ids" });
    }

    let result;
    if (notes.type === "commission") {
      result = await fulfillCommission({
        orderId,
        paymentId,
        commissionId: notes.commissionId,
      });
    } else {
      result = await fulfillSubscription({
        orderId,
        paymentId,
        subscriptionId: notes.subscriptionId,
      });
    }

    res.json({ ok: true, event, ...result });
  }),
);
