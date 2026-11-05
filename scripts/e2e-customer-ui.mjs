import "dotenv/config";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import mongoose from "mongoose";
import { collections } from "../src/config/store.js";
import { claimsFrom, createToken, hashPassword } from "../src/lib/auth.js";
import { jobFeedDocId } from "../src/lib/jobFeed.js";

/**
 * Throwaway fixtures + driver for the customer-side UI lifecycle test.
 *
 * Modes:
 *   create                  create a verified customer + approved worker
 *   book                    create a booking as the customer (prints id + token)
 *   ongoing <bookingId>     accept, start, ping location
 *   ping <bookingId> [dLat] [dLng]
 *                           move the worker relative to the zone centre
 *   finish <bookingId>      mark the job complete (worker side)
 *   drive <bookingId>       worker accepts, starts, completes
 *   status <bookingId>      print booking/payment/review state
 *   cleanup <bookingId>     delete the booking and every fixture row
 *
 * State is kept in a temp JSON file between calls.
 */

const STATE_FILE = new URL("./.e2e-customer-fixture.json", import.meta.url);
const mode = process.argv[2] || "create";
const zoneId = "5663f4a45001b7cc7dd4";

function loadState() {
  if (!existsSync(STATE_FILE)) throw new Error("fixture state missing — run create first");
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function workerToken(state) {
  const user = {
    uid: state.workerId, _id: state.workerId, role: "worker",
    name: state.workerName, email: state.workerEmail, emailVerified: true,
  };
  return createToken(claimsFrom({
    user,
    worker: { status: "approved" },
    isAdmin: false,
  }));
}

function customerToken(state) {
  return createToken(claimsFrom({
    user: {
      uid: state.customerId, _id: state.customerId, role: "customer",
      name: "UI Test Customer", email: state.customerEmail, emailVerified: true,
    },
    worker: null,
    isAdmin: false,
  }));
}

async function api(method, path, token, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  const result = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: 5000,
        path: `/api${path}`,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
  let json = null;
  try { json = result.text ? JSON.parse(result.text) : null; } catch { json = { raw: result.text.slice(0, 200) }; }
  return { status: result.status, json };
}

if (mode === "create") {
  const suffix = randomBytes(5).toString("hex");
  const zoneSnap = await collections.serviceZones.doc(zoneId).get();
  if (!zoneSnap.exists) throw new Error("zone missing");
  const zone = zoneSnap.data();
  const now = new Date();

  const customerId = `e2e_ui_cust_${suffix}`;
  const workerId = `e2e_ui_pro_${suffix}`;
  const customerEmail = `e2e.ui.${suffix}@example.invalid`;
  const password = `E2e!${randomBytes(8).toString("hex")}`;
  const workerEmail = `e2e.ui.pro.${suffix}@example.invalid`;

  await collections.users.doc(customerId).set({
    uid: customerId, role: "customer", name: "UI Test Customer",
    email: customerEmail, phone: "9999999999", emailVerified: true,
    passwordHash: await hashPassword(password),
    addresses: [{
      label: "Home",
      area: `${zone.areaName}, ${zone.cityName}`,
      city: zone.cityName,
      state: zone.state,
      lat: zone.latitude,
      lng: zone.longitude,
    }],
    createdAt: now, updatedAt: now,
  });
  await collections.users.doc(workerId).set({
    uid: workerId, role: "worker", name: "UI Test Pro",
    email: workerEmail, phone: "9000000000", emailVerified: true,
    createdAt: now, updatedAt: now,
  });
  await collections.workers.doc(workerId).set({
    uid: workerId, name: "UI Test Pro", email: workerEmail,
    phone: "9000000000", role: "worker",
    service: "Home Cleaning", serviceKey: "cleaning", trades: ["cleaning"],
    status: "approved", online: true,
    city: zone.cityName, state: zone.state, areaName: zone.areaName,
    lat: null, lng: null, dues: 0, rating: 0, reviewCount: 0, jobsCompleted: 0,
    kycStatus: "approved", pricePerWork: 199,
    createdAt: now, updatedAt: now,
  });
  await collections.workersPublic.doc(workerId).set({
    name: "UI Test Pro", serviceKey: "cleaning", status: "approved",
    online: true, areaName: zone.areaName, cityName: zone.cityName,
    createdAt: now, updatedAt: now,
  });

  const state = {
    suffix, customerId, customerEmail, password, workerId, workerEmail,
    workerName: "UI Test Pro", zoneId,
    zone: {
      name: zone.cityName, state: zone.state, areaName: zone.areaName,
      lat: zone.latitude, lng: zone.longitude, radiusKm: zone.radiusKm,
    },
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(JSON.stringify(state, null, 2));
} else if (mode === "book") {
  const state = loadState();
  const token = customerToken(state);
  const created = await api("POST", "/bookings", token, {
    service: "Home Cleaning",
    serviceKey: "cleaning",
    description: "Tracking page fixture: two bedroom deep clean please.",
    area: "House 12, Jamua main road, Giridih",
    city: state.zone.name,
    state: state.zone.state,
    areaName: state.zone.areaName,
    lat: state.zone.lat,
    lng: state.zone.lng,
    phone: "9999999999",
    budget: 299,
    urgency: "normal",
  });
  if (created.status !== 201) {
    console.error(JSON.stringify(created.json, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    bookingId: created.json.booking.id,
    customerToken: token,
  }, null, 2));
} else if (mode === "ongoing") {
  const state = loadState();
  const bookingId = process.argv[3];
  if (!bookingId) throw new Error("bookingId required");
  const token = workerToken(state);
  const steps = {};
  steps.accept = await api("POST", `/worker/jobs/${bookingId}/accept`, token);
  steps.start = await api("PATCH", `/worker/jobs/${bookingId}/start`, token);
  steps.location = await api("PATCH", `/worker/jobs/${bookingId}/location`, token, {
    lat: state.zone.lat + 0.004,
    lng: state.zone.lng + 0.003,
    accuracy: 12,
  });
  console.log(JSON.stringify(
    Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { status: v.status, code: v.json?.code || null }])),
    null,
    2,
  ));
  if (!Object.values(steps).every((s) => s.status === 200)) {
    console.error(JSON.stringify(Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.json])), null, 2));
    process.exit(1);
  }
} else if (mode === "ping") {
  const state = loadState();
  const bookingId = process.argv[3];
  if (!bookingId) throw new Error("bookingId required");
  const dLat = Number(process.argv[4] ?? 0.0025);
  const dLng = Number(process.argv[5] ?? 0.0015);
  const token = workerToken(state);
  const res = await api("PATCH", `/worker/jobs/${bookingId}/location`, token, {
    lat: state.zone.lat + dLat,
    lng: state.zone.lng + dLng,
    accuracy: 10,
  });
  console.log(JSON.stringify({ status: res.status, code: res.json?.code || null }, null, 2));
  if (res.status !== 200) {
    console.error(JSON.stringify(res.json, null, 2));
    process.exit(1);
  }
} else if (mode === "finish") {
  const state = loadState();
  const bookingId = process.argv[3];
  if (!bookingId) throw new Error("bookingId required");
  const token = workerToken(state);
  const res = await api("PATCH", `/worker/jobs/${bookingId}/complete`, token);
  console.log(JSON.stringify({ status: res.status, code: res.json?.code || null }, null, 2));
  if (res.status !== 200) {
    console.error(JSON.stringify(res.json, null, 2));
    process.exit(1);
  }
} else if (mode === "drive") {
  const state = loadState();
  const bookingId = process.argv[3];
  if (!bookingId) throw new Error("bookingId required");
  const token = workerToken(state);
  const steps = {};
  steps.accept = await api("POST", `/worker/jobs/${bookingId}/accept`, token);
  steps.start = await api("PATCH", `/worker/jobs/${bookingId}/start`, token);
  steps.complete = await api("PATCH", `/worker/jobs/${bookingId}/complete`, token);
  console.log(JSON.stringify(
    Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { status: v.status, code: v.json?.code || null }])),
    null,
    2,
  ));
  if (!Object.values(steps).every((s) => s.status === 200)) {
    console.error(JSON.stringify(Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.json])), null, 2));
    process.exit(1);
  }
} else if (mode === "status") {
  const state = loadState();
  const bookingId = process.argv[3];
  const booking = (await collections.bookings.doc(bookingId).get()).data();
  const worker = (await collections.workers.doc(state.workerId).get()).data();
  const reviews = await collections.reviews.where("bookingId", "==", bookingId).get();
  console.log(JSON.stringify({
    booking: {
      status: booking?.status, paidAt: Boolean(booking?.paidAt),
      paymentMode: booking?.paymentMode, reviewId: Boolean(booking?.reviewId),
      finalPrice: booking?.pricing?.finalPrice, commission: booking?.pricing?.commission,
      workerReceives: booking?.pricing?.workerReceives,
      trackingPhase: booking?.trackingPhase, activeJob: booking?.activeJob,
    },
    worker: {
      dues: worker?.dues, jobsCompleted: worker?.jobsCompleted,
      rating: worker?.rating, reviewCount: worker?.reviewCount,
      activeJobBookingId: worker?.activeJobBookingId || null,
    },
    reviews: reviews.docs.map((doc) => ({ stars: doc.data().stars, comment: doc.data().comment })),
  }, null, 2));
} else if (mode === "cleanup") {
  const state = loadState();
  const bookingId = process.argv[3];
  if (bookingId) {
    const feed = await collections.jobFeed.where("bookingId", "==", bookingId).get();
    for (const doc of feed.docs) await doc.ref.delete();
    const reviews = await collections.reviews.where("bookingId", "==", bookingId).get();
    for (const doc of reviews.docs) await doc.ref.delete();
    await collections.commissions.doc(`fee_${bookingId}`).delete().catch(() => {});
    await collections.bookings.doc(bookingId).delete().catch(() => {});
  }
  const people = [state.customerId, state.workerId];
  const notifications = await collections.notifications.where("userId", "in", people).get();
  for (const doc of notifications.docs) await doc.ref.delete();
  await collections.workers.doc(state.workerId).delete().catch(() => {});
  await collections.workersPublic.doc(state.workerId).delete().catch(() => {});
  await collections.users.doc(state.workerId).delete().catch(() => {});
  await collections.users.doc(state.customerId).delete().catch(() => {});
  try { unlinkSync(STATE_FILE); } catch { /* already gone */ }
  console.log("cleanup done");
} else {
  throw new Error(`unknown mode ${mode}`);
}

// Close the Mongo connection cleanly; Windows otherwise aborts in libuv teardown
// when a fixture mode finishes right after its last query. Flush stdout first so
// piped output is not truncated, then exit explicitly to avoid the undici close
// assertion on Windows.
await mongoose.disconnect().catch(() => {});
await new Promise((resolve) => process.stdout.write("", resolve));
process.exit(0);
process.exit(0);
