import "dotenv/config";
import { randomBytes } from "node:crypto";
import { collections } from "../src/config/store.js";
import { claimsFrom, createToken } from "../src/lib/auth.js";
import { jobFeedDocId } from "../src/lib/jobFeed.js";

const BASE = "http://127.0.0.1:5000/api";
const suffix = randomBytes(6).toString("hex");
const customerId = `e2e_customer_${suffix}`;
const workerId = `e2e_worker_${suffix}`;
const bookingA = `e2e_booking_a_${suffix}`;
const bookingB = `e2e_booking_b_${suffix}`;
const zoneId = "5663f4a45001b7cc7dd4";

const zoneSnap = await collections.serviceZones.doc(zoneId).get();
if (!zoneSnap.exists) throw new Error("test zone missing");
const zone = zoneSnap.data();

const now = new Date();
const customerUser = {
  uid: customerId,
  role: "customer",
  name: "E2E Customer",
  email: `e2e.customer.${suffix}@example.invalid`,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};
const workerUser = {
  uid: workerId,
  role: "worker",
  name: "E2E Worker",
  email: `e2e.worker.${suffix}@example.invalid`,
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
};
const workerProfile = {
  uid: workerId,
  name: "E2E Worker",
  email: workerUser.email,
  phone: "9000000000",
  role: "worker",
  service: "Home Cleaning",
  serviceKey: "cleaning",
  trades: ["cleaning"],
  status: "approved",
  online: true,
  city: "Giridih",
  state: "Jharkhand",
  areaName: "Jamua",
  lat: null,
  lng: null,
  dues: 0,
  rating: 0,
  reviewCount: 0,
  jobsCompleted: 0,
  kycStatus: "approved",
  createdAt: now,
  updatedAt: now,
};

function booking(id) {
  return {
    customerId,
    customerName: "E2E Customer",
    serviceKey: "cleaning",
    service: "Home Cleaning",
    description: "E2E accept-path fixture",
    status: "pending",
    activeJob: false,
    area: "Jamua, Giridih",
    areaName: "Jamua",
    cityName: zone.cityName,
    stateName: zone.state,
    serviceZoneId: zoneId,
    serviceZoneName: zone.label || `${zone.areaName}, ${zone.cityName}`,
    serviceZoneLatitude: zone.latitude,
    serviceZoneLongitude: zone.longitude,
    serviceZoneRadiusKm: zone.radiusKm,
    location: { lat: zone.latitude, lng: zone.longitude, label: "E2E fixture" },
    urgency: "normal",
    estimatedTotal: 299,
    pricing: { basePrice: 299, urgentFee: 0, promoDiscount: 0, originalTotal: 299, estimatedTotal: 299 },
    statusHistory: [],
    createdAt: now,
    updatedAt: now,
  };
}

function feed(bookingId) {
  return {
    bookingId,
    workerId,
    service: "Home Cleaning",
    serviceKey: "cleaning",
    customerName: "E2E Customer",
    area: "Jamua, Giridih",
    serviceZoneId: zoneId,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
}

const created = [];
try {
  await collections.users.doc(customerId).set(customerUser);
  created.push(() => collections.users.doc(customerId).delete());
  await collections.users.doc(workerId).set(workerUser);
  created.push(() => collections.users.doc(workerId).delete());
  await collections.workers.doc(workerId).set(workerProfile);
  created.push(() => collections.workers.doc(workerId).delete());
  await collections.workersPublic.doc(workerId).set({ name: "E2E Worker", serviceKey: "cleaning", status: "approved", online: true });
  created.push(() => collections.workersPublic.doc(workerId).delete());

  for (const [id, b] of [[bookingA, booking(bookingA)], [bookingB, booking(bookingB)]]) {
    await collections.bookings.doc(id).set(b);
    created.push(() => collections.bookings.doc(id).delete());
    await collections.jobFeed.doc(jobFeedDocId(id, workerId)).set(feed(id));
    created.push(() => collections.jobFeed.doc(jobFeedDocId(id, workerId)).delete());
  }

  const token = createToken(claimsFrom({ user: { ...workerUser, _id: workerId }, worker: workerProfile, isAdmin: false }));
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  async function accept(id) {
    const res = await fetch(`${BASE}/worker/jobs/${id}/accept`, { method: "POST", headers });
    return { status: res.status, body: await res.text() };
  }

  const first = await accept(bookingA);
  const bookingSnap = await collections.bookings.doc(bookingA).get();
  const workerSnap = await collections.workers.doc(workerId).get();
  const feedSnap = await collections.jobFeed.doc(jobFeedDocId(bookingA, workerId)).get();

  const second = await accept(bookingB);

  const result = {
    firstAccept: { status: first.status, body: first.body.slice(0, 160) },
    booking: {
      status: bookingSnap.data()?.status,
      workerId: bookingSnap.data()?.workerId,
      activeJob: bookingSnap.data()?.activeJob,
      phase: bookingSnap.data()?.trackingPhase,
    },
    worker: {
      activeJobBookingId: workerSnap.data()?.activeJobBookingId,
    },
    feed: { status: feedSnap.data()?.status },
    secondAccept: { status: second.status, body: second.body.slice(0, 200) },
  };

  const pass =
    first.status === 200 &&
    result.booking.status === "accepted" &&
    result.booking.workerId === workerId &&
    result.booking.activeJob === true &&
    result.worker.activeJobBookingId === bookingA &&
    result.feed.status === "taken" &&
    second.status === 409;
  console.log(JSON.stringify(result, null, 2));
  console.log(pass ? "PASS accept path" : "FAIL accept path");
  globalThis.__exitCode = pass ? 0 : 1;
} finally {
  const notifications = await collections.notifications.where("userId", "==", customerId).get();
  for (const doc of notifications.docs) await doc.ref.delete();
  for (const undo of created.reverse()) {
    try { await undo(); } catch { /* best effort cleanup */ }
  }
  console.log("cleanup done");
}
process.exit(globalThis.__exitCode || 0);
