import "dotenv/config";
import { randomBytes } from "node:crypto";
import { collections } from "../src/config/store.js";
import { claimsFrom, createToken } from "../src/lib/auth.js";
import { jobFeedDocId } from "../src/lib/jobFeed.js";

/**
 * End-to-end lifecycle regression test against a running API.
 *
 * Creates throwaway customer/worker documents, drives the real HTTP routes,
 * asserts the money and lock invariants, then deletes every fixture row.
 * Nothing is sent to email, Telegram or the admin console.
 *
 * Usage: npm run test:e2e:lifecycle  (API must be running on :5000)
 */

const BASE = "http://127.0.0.1:5000/api";
const suffix = randomBytes(6).toString("hex");
const customerId = `e2e_cust_${suffix}`;
const workerId = `e2e_pro_${suffix}`;
const zoneId = "5663f4a45001b7cc7dd4";

const zoneSnap = await collections.serviceZones.doc(zoneId).get();
if (!zoneSnap.exists) throw new Error("test zone missing");
const zone = zoneSnap.data();
const now = new Date();

const customer = {
  uid: customerId,
  role: "customer",
  name: "E2E Customer",
  email: `e2e.lifecycle.${suffix}@example.invalid`,
  phone: "9999999999",
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};
const worker = {
  uid: workerId,
  name: "E2E Professional",
  email: `e2e.pro.${suffix}@example.invalid`,
  phone: "9999999999",
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
  rating: 0,
  reviewCount: 0,
  jobsCompleted: 0,
  kycStatus: "approved",
  pricePerWork: 199,
  createdAt: now,
  updatedAt: now,
};

const cleanup = [];
let bookingId = null;

async function cleanupAll() {
  if (bookingId) {
    const feed = await collections.jobFeed.where("bookingId", "==", bookingId).get();
    for (const doc of feed.docs) await doc.ref.delete();
    const reviews = await collections.reviews.where("bookingId", "==", bookingId).get();
    for (const doc of reviews.docs) await doc.ref.delete();
    await collections.commissions.doc(`fee_${bookingId}`).delete().catch(() => {});
    await collections.bookings.doc(bookingId).delete().catch(() => {});
  }
  const notifications = await collections.notifications
    .where("userId", "in", [customerId, workerId])
    .get();
  for (const doc of notifications.docs) await doc.ref.delete();
  for (const undo of cleanup.reverse()) {
    try { await undo(); } catch { /* best effort */ }
  }
}

function authHeaders(token) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

let pass = false;
try {
  await collections.users.doc(customerId).set(customer);
  cleanup.push(() => collections.users.doc(customerId).delete());
  await collections.users.doc(workerId).set(worker);
  cleanup.push(() => collections.users.doc(workerId).delete());
  await collections.workers.doc(workerId).set(worker);
  cleanup.push(() => collections.workers.doc(workerId).delete());
  await collections.workersPublic.doc(workerId).set({
    name: worker.name, serviceKey: "cleaning", status: "approved", online: true, areaName: zone.areaName,
  });
  cleanup.push(() => collections.workersPublic.doc(workerId).delete());

  const customerToken = createToken(claimsFrom({ user: { ...customer, _id: customerId }, worker: null, isAdmin: false }));
  const workerToken = createToken(claimsFrom({ user: { ...worker, _id: workerId }, worker, isAdmin: false }));

  // 1. Customer creates a booking inside the active zone.
  const created = await call("POST", "/bookings", customerToken, {
    service: "Home Cleaning",
    serviceKey: "cleaning",
    description: "E2E lifecycle: two bedroom deep clean please.",
    area: `${zone.areaName}, ${zone.cityName}`,
    city: zone.cityName,
    state: zone.state,
    areaName: zone.areaName,
    lat: zone.latitude,
    lng: zone.longitude,
    phone: "9999999999",
    budget: 299,
    urgency: "normal",
  });
  bookingId = created.json?.booking?.id || null;
  const feedAfterCreate = bookingId
    ? await collections.jobFeed.doc(jobFeedDocId(bookingId, workerId)).get()
    : null;

  // 2. Worker accepts.
  const accepted = bookingId ? await call("POST", `/worker/jobs/${bookingId}/accept`, workerToken) : null;

  // 3. Worker quotes and confirms the final price.
  const priced = bookingId ? await call("PATCH", `/worker/jobs/${bookingId}/price`, workerToken, { price: 350 }) : null;
  const confirmed = bookingId ? await call("PATCH", `/worker/jobs/${bookingId}/confirm`, workerToken) : null;

  // 4. Worker starts and completes.
  const started = bookingId ? await call("PATCH", `/worker/jobs/${bookingId}/start`, workerToken) : null;
  const completed = bookingId ? await call("PATCH", `/worker/jobs/${bookingId}/complete`, workerToken) : null;

  const bookingAfterComplete = bookingId ? (await collections.bookings.doc(bookingId).get()).data() : null;
  const workerAfterComplete = (await collections.workers.doc(workerId).get()).data();
  const feeAfterComplete = bookingId
    ? (await collections.commissions.doc(`fee_${bookingId}`).get()).data()
    : null;

  // 5. Customer confirms payment — must not double-count dues.
  const paid = bookingId
    ? await call("PATCH", `/bookings/${bookingId}/payment`, customerToken, { mode: "cash" })
    : null;
  const workerAfterPay = (await collections.workers.doc(workerId).get()).data();
  const bookingAfterPay = bookingId ? (await collections.bookings.doc(bookingId).get()).data() : null;

  // 6. Customer reviews; worker rating aggregates.
  const reviewed = bookingId
    ? await call("POST", `/bookings/${bookingId}/review`, customerToken, { stars: 5, comment: "E2E great work" })
    : null;
  const workerAfterReview = (await collections.workers.doc(workerId).get()).data();
  const bookingAfterReview = bookingId ? (await collections.bookings.doc(bookingId).get()).data() : null;

  const summary = {
    create: { status: created.status, id: bookingId?.slice(0, 8), warningCount: created.json?.warnings?.length ?? 0 },
    feedCreated: feedAfterCreate?.exists === true && feedAfterCreate.data().status === "open",
    accept: accepted?.status,
    price: priced?.status,
    confirm: confirmed?.status,
    start: started?.status,
    complete: completed?.status,
    completedState: {
      status: bookingAfterComplete?.status,
      phase: bookingAfterComplete?.trackingPhase,
      activeJob: bookingAfterComplete?.activeJob,
      lock: workerAfterComplete?.activeJobBookingId || null,
      jobsCompleted: workerAfterComplete?.jobsCompleted,
      dues: workerAfterComplete?.dues,
      feeDoc: feeAfterComplete ? { amount: feeAfterComplete.amount, status: feeAfterComplete.status } : null,
    },
    payment: {
      status: paid?.status,
      commission: paid?.json?.commission,
      workerReceives: paid?.json?.workerReceives,
      paidAt: Boolean(bookingAfterPay?.paidAt),
      duesAfterPay: workerAfterPay?.dues,
      commissionStatus: (await collections.commissions.doc(`fee_${bookingId}`).get()).data()?.status,
    },
    review: {
      status: reviewed?.status,
      rating: workerAfterReview?.rating,
      reviewCount: workerAfterReview?.reviewCount,
      onBooking: Boolean(bookingAfterReview?.reviewId),
    },
  };

  pass =
    created.status === 201 &&
    Boolean(bookingId) &&
    summary.feedCreated === true &&
    accepted?.status === 200 &&
    priced?.status === 200 &&
    confirmed?.status === 200 &&
    started?.status === 200 &&
    completed?.status === 200 &&
    bookingAfterComplete?.status === "completed" &&
    bookingAfterComplete?.activeJob === false &&
    !workerAfterComplete?.activeJobBookingId &&
    workerAfterComplete?.jobsCompleted === 1 &&
    workerAfterComplete?.dues === 35 &&
    feeAfterComplete?.amount === 35 &&
    feeAfterComplete?.status === "pending" &&
    paid?.status === 200 &&
    paid?.json?.commission === 35 &&
    paid?.json?.workerReceives === 315 &&
    bookingAfterPay?.paidAt &&
    workerAfterPay?.dues === 35 &&
    reviewed?.status === 201 &&
    workerAfterReview?.rating === 5 &&
    workerAfterReview?.reviewCount === 1 &&
    Boolean(bookingAfterReview?.reviewId);

  console.log(JSON.stringify(summary, null, 2));
  console.log(pass ? "PASS lifecycle" : "FAIL lifecycle");
} finally {
  await cleanupAll();
  console.log("cleanup done");
}
process.exit(pass ? 0 : 1);
