import "dotenv/config";
import crypto, { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { collections } from "../src/config/store.js";
import { claimsFrom, createToken } from "../src/lib/auth.js";
import { jobFeedDocId } from "../src/lib/jobFeed.js";

/**
 * End-to-end regression test for the worker-dues clearing flow.
 *
 * Covers:
 *   1. Dues > 0 locks the worker out of accepting jobs (penalty lock).
 *   2. Razorpay signature verification rejects bad signatures, wrong workers
 *      and mismatched orders without touching data.
 *   3. A valid signature clears the fee, zeroes dues and unlocks accepting.
 *   4. Replaying the same payment is idempotent (no double deduction).
 *   5. Admin manual approve/reject moves dues correctly and blocks re-approval.
 *
 * No Razorpay network calls are made: only the local signature check and the
 * MongoDB writes run. Point E2E_BASE at an API started with Telegram disabled
 * so no real alerts fire.
 *
 * Usage:
 *   E2E_BASE=http://127.0.0.1:5001/api node scripts/e2e-dues.mjs
 */

const BASE = process.env.E2E_BASE || "http://127.0.0.1:5000/api";
const suffix = randomBytes(6).toString("hex");
const zoneId = "5663f4a45001b7cc7dd4";

const payWorker = `e2e_pay_${suffix}`;
const otherWorker = `e2e_other_${suffix}`;
const adminWorker = `e2e_admin_dues_${suffix}`;
const bookingId = `e2e_dues_booking_${suffix}`;
const orderId = `order_e2e_${suffix}`;
const paymentId = `pay_e2e_${suffix}`;
const commissionId = `fee_e2e_pay_${suffix}`;
const adminFeeA = `fee_e2e_admin_a_${suffix}`;
const adminFeeB = `fee_e2e_admin_b_${suffix}`;

const zoneSnap = await collections.serviceZones.doc(zoneId).get();
if (!zoneSnap.exists) throw new Error("test zone missing");
const zone = zoneSnap.data();
const now = new Date();

function envValue(key) {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && match[1] === key) return match[2].replace(/^["']|["']$/g, "").trim();
  }
  return "";
}

const razorpaySecret = envValue("RAZORPAY_KEY_SECRET");
if (!razorpaySecret) throw new Error("RAZORPAY_KEY_SECRET missing from .env");

function sign(order, payment) {
  return crypto.createHmac("sha256", razorpaySecret).update(`${order}|${payment}`).digest("hex");
}

function workerDoc(id, overrides = {}) {
  return {
    uid: id,
    name: `E2E ${id.slice(-4)}`,
    email: `${id}@example.invalid`,
    phone: "9000000000",
    role: "worker",
    service: "Home Cleaning",
    serviceKey: "cleaning",
    trades: ["cleaning"],
    status: "approved",
    online: true,
    city: zone.cityName,
    state: zone.state,
    areaName: zone.areaName,
    lat: null,
    lng: null,
    dues: 0,
    kycStatus: "approved",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const created = [];
const extraDeletes = [];

async function cleanupAll() {
  for (const ref of extraDeletes) {
    try { await ref.delete(); } catch { /* best effort */ }
  }
  const people = [payWorker, otherWorker, adminWorker];
  const notifications = await collections.notifications.where("userId", "in", people).get();
  for (const doc of notifications.docs) await doc.ref.delete();
  for (const undo of created.reverse()) {
    try { await undo(); } catch { /* best effort */ }
  }
}

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

let pass = false;
try {
  /* ------------------------------- Fixtures ------------------------------- */
  for (const [id, overrides] of [
    [payWorker, { dues: 35, dueCommissionAmount: 35, hasPendingCommission: true }],
    [otherWorker, {}],
    [adminWorker, { dues: 70, dueCommissionAmount: 70, hasPendingCommission: true }],
  ]) {
    await collections.users.doc(id).set({
      uid: id, role: "worker", name: `E2E ${id.slice(-4)}`,
      email: `${id}@example.invalid`, emailVerified: true, createdAt: now, updatedAt: now,
    });
    created.push(() => collections.users.doc(id).delete());
    await collections.workers.doc(id).set(workerDoc(id, overrides));
    created.push(() => collections.workers.doc(id).delete());
    await collections.workersPublic.doc(id).set({
      name: `E2E ${id.slice(-4)}`, serviceKey: "cleaning", status: "approved", online: true,
    });
    created.push(() => collections.workersPublic.doc(id).delete());
  }

  await collections.commissions.doc(commissionId).set({
    workerId: payWorker, workerName: "E2E Pay", bookingId,
    service: "Home Cleaning", amount: 35, status: "pending",
    razorpayOrderId: orderId, createdAt: now, updatedAt: now,
  });
  created.push(() => collections.commissions.doc(commissionId).delete());
  for (const [id, amount] of [[adminFeeA, 35], [adminFeeB, 35]]) {
    await collections.commissions.doc(id).set({
      workerId: adminWorker, workerName: "E2E Admin Dues", bookingId: `e2e_booking_${id}`,
      service: "Home Cleaning", amount, status: "pending", createdAt: now, updatedAt: now,
    });
    created.push(() => collections.commissions.doc(id).delete());
  }

  // A pending booking dispatched to the dues-locked worker.
  await collections.bookings.doc(bookingId).set({
    customerId: `e2e_cust_${suffix}`, customerName: "E2E Customer",
    serviceKey: "cleaning", service: "Home Cleaning", description: "E2E dues gate fixture",
    status: "pending", activeJob: false, area: `${zone.areaName}, ${zone.cityName}`,
    areaName: zone.areaName, cityName: zone.cityName, stateName: zone.state,
    serviceZoneId: zoneId, serviceZoneName: zone.label || `${zone.areaName}, ${zone.cityName}`,
    serviceZoneLatitude: zone.latitude, serviceZoneLongitude: zone.longitude,
    serviceZoneRadiusKm: zone.radiusKm,
    location: { lat: zone.latitude, lng: zone.longitude, label: "fixture" },
    urgency: "normal", estimatedTotal: 299,
    pricing: { basePrice: 299, urgentFee: 0, promoDiscount: 0, originalTotal: 299, estimatedTotal: 299 },
    statusHistory: [], createdAt: now, updatedAt: now,
  });
  created.push(() => collections.bookings.doc(bookingId).delete());
  await collections.jobFeed.doc(jobFeedDocId(bookingId, payWorker)).set({
    bookingId, workerId: payWorker, service: "Home Cleaning", serviceKey: "cleaning",
    customerName: "E2E Customer", area: `${zone.areaName}, ${zone.cityName}`,
    serviceZoneId: zoneId, status: "open", createdAt: now, updatedAt: now,
  });
  created.push(() => collections.jobFeed.doc(jobFeedDocId(bookingId, payWorker)).delete());

  const payToken = createToken(claimsFrom({
    user: { uid: payWorker, _id: payWorker, role: "worker", name: "E2E Pay", email: `${payWorker}@example.invalid`, emailVerified: true },
    worker: workerDoc(payWorker, { dues: 35 }),
    isAdmin: false,
  }));
  const otherToken = createToken(claimsFrom({
    user: { uid: otherWorker, _id: otherWorker, role: "worker", name: "E2E Other", email: `${otherWorker}@example.invalid`, emailVerified: true },
    worker: workerDoc(otherWorker),
    isAdmin: false,
  }));

  /* ---------------------- 1. Penalty lock before payment ------------------- */
  const lockedAccept = await call("POST", `/worker/jobs/${bookingId}/accept`, payToken);

  /* ------------------------- 2. Signature guard rails --------------------- */
  const badSignature = await call("POST", "/payment/commission/verify", payToken, {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: "deadbeefdeadbeef",
    commissionId,
  });
  const wrongWorker = await call("POST", "/payment/commission/verify", otherToken, {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: sign(orderId, paymentId),
    commissionId,
  });
  const mismatchedOrder = await call("POST", "/payment/commission/verify", payToken, {
    razorpay_order_id: `order_wrong_${suffix}`,
    razorpay_payment_id: paymentId,
    razorpay_signature: sign(`order_wrong_${suffix}`, paymentId),
    commissionId,
  });
  const afterGuards = (await collections.workers.doc(payWorker).get()).data();
  const commissionAfterGuards = (await collections.commissions.doc(commissionId).get()).data();

  /* ------------------------- 3. Verified payment -------------------------- */
  const verified = await call("POST", "/payment/commission/verify", payToken, {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: sign(orderId, paymentId),
    commissionId,
  });
  const workerAfterPay = (await collections.workers.doc(payWorker).get()).data();
  const commissionAfterPay = (await collections.commissions.doc(commissionId).get()).data();
  const paymentRow = (await collections.payments.doc(paymentId).get()).data();

  /* --------------------------- 4. Idempotency ----------------------------- */
  const replay = await call("POST", "/payment/commission/verify", payToken, {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: sign(orderId, paymentId),
    commissionId,
  });
  const workerAfterReplay = (await collections.workers.doc(payWorker).get()).data();

  /* ---------------------- 5. Accept unlocked after clearing --------------- */
  const unlockedAccept = await call("POST", `/worker/jobs/${bookingId}/accept`, payToken);
  const workerAfterAccept = (await collections.workers.doc(payWorker).get()).data();
  const bookingAfterAccept = (await collections.bookings.doc(bookingId).get()).data();

  /* --------------------- 6. Admin manual approve / reject ----------------- */
  const login = await call("POST", "/auth/login", null, {
    email: envValue("ADMIN_EMAIL"),
    password: envValue("ADMIN_PASSWORD"),
    role: "admin",
  });
  if (!login.json?.token) throw new Error("admin login failed");
  const adminToken = login.json.token;

  const approved = await call("PATCH", `/admin/commissions/${adminFeeA}/approve`, adminToken, {});
  const workerAfterApprove = (await collections.workers.doc(adminWorker).get()).data();
  const reApproved = await call("PATCH", `/admin/commissions/${adminFeeA}/approve`, adminToken, {});
  const rejected = await call("PATCH", `/admin/commissions/${adminFeeB}/reject`, adminToken, { reason: "E2E reject check" });
  const feeB = (await collections.commissions.doc(adminFeeB).get()).data();
  const workerAfterReject = (await collections.workers.doc(adminWorker).get()).data();
  const missingFee = await call("PATCH", `/admin/commissions/does_not_exist_${suffix}/approve`, adminToken, {});

  const summary = {
    penaltyLock: { status: lockedAccept.status, code: lockedAccept.json?.code, reason: lockedAccept.json?.details?.reason },
    guards: {
      badSignature: { status: badSignature.status, code: badSignature.json?.code },
      wrongWorker: { status: wrongWorker.status, code: wrongWorker.json?.code },
      mismatchedOrder: { status: mismatchedOrder.status, code: mismatchedOrder.json?.code },
      duesUntouched: afterGuards?.dues,
      commissionUntouched: commissionAfterGuards?.status,
    },
    verified: {
      status: verified.status,
      body: verified.json,
      dues: workerAfterPay?.dues,
      dueCommissionAmount: workerAfterPay?.dueCommissionAmount,
      hasPendingCommission: workerAfterPay?.hasPendingCommission,
      commissionStatus: commissionAfterPay?.status,
      paymentStatus: commissionAfterPay?.paymentStatus,
      paymentRow: paymentRow ? { type: paymentRow.type, amount: paymentRow.amount, status: paymentRow.status } : null,
    },
    replay: {
      status: replay.status,
      already: replay.json?.already,
      dues: workerAfterReplay?.dues,
    },
    unlocked: {
      status: unlockedAccept.status,
      code: unlockedAccept.json?.code,
      bookingStatus: bookingAfterAccept?.status,
      lock: workerAfterAccept?.activeJobBookingId === bookingId ? "bookingId" : workerAfterAccept?.activeJobBookingId || null,
    },
    admin: {
      approve: approved.status,
      duesAfterApprove: workerAfterApprove?.dues,
      reApprove: { status: reApproved.status, code: reApproved.json?.code },
      reject: rejected.status,
      rejectedStatus: feeB?.status,
      duesAfterReject: workerAfterReject?.dues,
      missing: { status: missingFee.status, code: missingFee.json?.code },
    },
  };

  pass =
    lockedAccept.status === 409 &&
    lockedAccept.json?.code === "CANNOT_ACCEPT" &&
    lockedAccept.json?.details?.reason === "dues" &&
    badSignature.status === 400 &&
    badSignature.json?.code === "PAYMENT_SIGNATURE_INVALID" &&
    wrongWorker.status === 403 &&
    wrongWorker.json?.code === "FORBIDDEN" &&
    mismatchedOrder.status === 400 &&
    mismatchedOrder.json?.code === "ORDER_MISMATCH" &&
    afterGuards?.dues === 35 &&
    commissionAfterGuards?.status === "pending" &&
    verified.status === 200 &&
    workerAfterPay?.dues === 0 &&
    workerAfterPay?.dueCommissionAmount === 0 &&
    workerAfterPay?.hasPendingCommission === false &&
    commissionAfterPay?.status === "approved" &&
    commissionAfterPay?.paymentStatus === "captured" &&
    paymentRow?.type === "commission" &&
    paymentRow?.amount === 35 &&
    replay.status === 200 &&
    replay.json?.already === true &&
    workerAfterReplay?.dues === 0 &&
    unlockedAccept.status === 200 &&
    bookingAfterAccept?.status === "accepted" &&
    workerAfterAccept?.activeJobBookingId === bookingId &&
    approved.status === 200 &&
    workerAfterApprove?.dues === 35 &&
    reApproved.status === 409 &&
    reApproved.json?.code === "ALREADY_APPROVED" &&
    rejected.status === 200 &&
    feeB?.status === "rejected" &&
    workerAfterReject?.dues === 35 &&
    missingFee.status === 404 &&
    missingFee.json?.code === "NOT_FOUND";

  console.log(JSON.stringify(summary, null, 2));
  console.log(pass ? "PASS dues clearing" : "FAIL dues clearing");
} finally {
  await cleanupAll();
  console.log("cleanup done");
}
process.exit(pass ? 0 : 1);
