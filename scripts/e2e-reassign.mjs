import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { collections } from "../src/config/store.js";

const BASE = "http://127.0.0.1:5000/api";

function envValue(key) {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match && match[1] === key) return match[2].replace(/^["']|["']$/g, "").trim();
  }
  return "";
}

const suffix = randomBytes(6).toString("hex");
const customerId = `e2e_customer_${suffix}`;
const workerA = `e2e_worker_a_${suffix}`;
const workerB = `e2e_worker_b_${suffix}`;
const workerC = `e2e_worker_c_${suffix}`;
const busyWorker = `e2e_worker_busy_${suffix}`;
const bookingId = `e2e_booking_${suffix}`;
const doneBookingId = `e2e_booking_done_${suffix}`;
const busyBookingId = `e2e_booking_busy_${suffix}`;
const zoneId = "5663f4a45001b7cc7dd4";

const zone = (await collections.serviceZones.doc(zoneId).get()).data();
const now = new Date();

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
    city: "Giridih",
    state: "Jharkhand",
    areaName: "Jamua",
    lat: null,
    lng: null,
    dues: 0,
    kycStatus: "approved",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function bookingDoc(id, overrides = {}) {
  return {
    customerId,
    customerName: "E2E Customer",
    serviceKey: "cleaning",
    service: "Home Cleaning",
    description: "E2E reassign fixture",
    status: "accepted",
    activeJob: true,
    workerId: workerA,
    workerName: "E2E A",
    area: "Jamua, Giridih",
    areaName: "Jamua",
    cityName: zone.cityName,
    stateName: zone.state,
    serviceZoneId: zoneId,
    location: { lat: zone.latitude, lng: zone.longitude, label: "fixture" },
    urgency: "normal",
    estimatedTotal: 299,
    pricing: { basePrice: 299, urgentFee: 0, promoDiscount: 0, originalTotal: 299, estimatedTotal: 299 },
    statusHistory: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const created = [];
const cleanup = async () => {
  const notifications = await collections.notifications
    .where("userId", "in", [customerId, workerA, workerB, workerC, busyWorker])
    .get();
  for (const doc of notifications.docs) await doc.ref.delete();
  const auditRows = await collections.audit.where("action", "==", "booking.reassign").get();
  for (const doc of auditRows.docs) {
    if (doc.data()?.details?.bookingId === bookingId) await doc.ref.delete();
  }
  for (const undo of created.reverse()) {
    try { await undo(); } catch { /* best effort */ }
  }
};

let pass = false;
try {
  await collections.users.doc(customerId).set({
    uid: customerId, role: "customer", name: "E2E Customer",
    email: `e2e.reassign.${suffix}@example.invalid`, emailVerified: true, createdAt: now, updatedAt: now,
  });
  created.push(() => collections.users.doc(customerId).delete());

  for (const [id, overrides] of [
    [workerA, {}],
    [workerB, {}],
    [workerC, { serviceKey: "plumbing", service: "Plumbing", trades: ["plumbing"] }],
    [busyWorker, { activeJobBookingId: busyBookingId }],
  ]) {
    await collections.workers.doc(id).set(workerDoc(id, overrides));
    created.push(() => collections.workers.doc(id).delete());
  }

  await collections.bookings.doc(bookingId).set(bookingDoc(bookingId));
  created.push(() => collections.bookings.doc(bookingId).delete());
  await collections.workers.doc(workerA).set({ activeJobBookingId: bookingId }, { merge: true });
  await collections.bookings.doc(doneBookingId).set(
    bookingDoc(doneBookingId, { status: "completed", activeJob: false, workerId: workerA }),
  );
  created.push(() => collections.bookings.doc(doneBookingId).delete());
  await collections.bookings.doc(busyBookingId).set(
    bookingDoc(busyBookingId, { workerId: busyWorker, workerName: "Busy" }),
  );
  created.push(() => collections.bookings.doc(busyBookingId).delete());

  const login = await fetch(BASE + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: envValue("ADMIN_EMAIL"),
      password: envValue("ADMIN_PASSWORD"),
      role: "admin",
    }),
  }).then((r) => r.json());
  if (!login.token) throw new Error("admin login failed");

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` };
  async function reassign(id, body) {
    const res = await fetch(`${BASE}/admin/bookings/${id}/reassign`, {
      method: "PATCH", headers, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.text() };
  }

  const moved = await reassign(bookingId, { workerId: workerB, reason: "E2E emergency reassignment" });
  const booking = (await collections.bookings.doc(bookingId).get()).data();
  const a = (await collections.workers.doc(workerA).get()).data();
  const b = (await collections.workers.doc(workerB).get()).data();

  const same = await reassign(bookingId, { workerId: workerB, reason: "E2E duplicate" });
  const wrongTrade = await reassign(bookingId, { workerId: workerC, reason: "E2E trade" });
  const busy = await reassign(bookingId, { workerId: busyWorker, reason: "E2E busy" });
  const completed = await reassign(doneBookingId, { workerId: workerB, reason: "E2E completed" });

  const summary = {
    reassign: { status: moved.status, body: moved.body.slice(0, 140) },
    booking: {
      workerId: booking?.workerId === workerB ? "workerB" : booking?.workerId,
      status: booking?.status,
      activeJob: booking?.activeJob,
      phase: booking?.trackingPhase,
      reassignReason: booking?.reassignReason,
      workerA_lock: a?.activeJobBookingId || null,
      workerB_lock: b?.activeJobBookingId === bookingId ? "bookingId" : b?.activeJobBookingId || null,
    },
    duplicate: { status: same.status, code: JSON.parse(same.body).code },
    wrongTrade: { status: wrongTrade.status, code: JSON.parse(wrongTrade.body).code },
    workerBusy: { status: busy.status, code: JSON.parse(busy.body).code },
    completed: { status: completed.status, code: JSON.parse(completed.body).code },
  };

  pass =
    moved.status === 200 &&
    booking?.workerId === workerB &&
    booking?.status === "accepted" &&
    booking?.activeJob === true &&
    !a?.activeJobBookingId &&
    b?.activeJobBookingId === bookingId &&
    same.status === 409 &&
    wrongTrade.status === 409 &&
    busy.status === 409 &&
    completed.status === 409;

  console.log(JSON.stringify(summary, null, 2));
  console.log(pass ? "PASS reassign path" : "FAIL reassign path");
} finally {
  await cleanup();
  console.log("cleanup done");
}
process.exit(pass ? 0 : 1);
