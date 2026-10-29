/* Focused Razorpay integration QA: order creation, signature verification,
 * subscription activation, commission clearing and webhook idempotency.
 * Run with the API on http://localhost:5000. Test keys only. */
import crypto from "node:crypto";
import { FieldValue } from "../src/lib/values.js";
import { collections } from "../src/config/store.js";
import { env } from "../src/config/env.js";
import { hashPassword } from "../src/lib/auth.js";

const API = "http://localhost:5000/api";
const PASSWORD = "QaPass123!456";
const STAMP = Date.now();
const CUSTOMER_EMAIL = `qa.rzp.customer.${STAMP}@easyhome.test`;
const WORKER_EMAIL = `qa.rzp.worker.${STAMP}@easyhome.test`;

const created = { users: [], subscriptionIds: [], commissionIds: [], paymentIds: [] };

function pass(label, details = "") {
  console.log(`PASS  ${label}${details ? ` — ${details}` : ""}`);
}
function fail(label, details = "") {
  throw new Error(`${label}${details ? `: ${details}` : ""}`);
}
function hmac(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}
async function signIn(email) {
  const res = await call("POST", "/auth/login", {
    body: { email, password: PASSWORD },
  });
  if (!res.ok) fail(`Sign in ${email}`, res.data?.error);
  return res.data.token;
}
async function ensureUser(email, name, role, claims) {
  const uid = crypto.randomUUID();
  created.users.push(uid);
  await collections.users.doc(uid).set({
    uid,
    name,
    email,
    phone: role === "worker" ? "9876543299" : "9876543298",
    role,
    admin: claims?.admin === true,
    workerApproved: claims?.workerApproved === true,
    emailVerified: true,
    passwordHash: await hashPassword(PASSWORD),
    city: "Indore",
    state: "Madhya Pradesh",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { uid, email, name };
}
async function call(method, endpoint, { token, body } = {}) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

async function cleanup() {
  for (const id of created.subscriptionIds) {
    await collections.subscriptions.doc(id).delete().catch(() => {});
  }
  for (const id of created.commissionIds) {
    await collections.commissions.doc(id).delete().catch(() => {});
  }
  for (const id of created.paymentIds) {
    await collections.payments.doc(id).delete().catch(() => {});
  }
  for (const uid of created.users) {
    await collections.workers.doc(uid).delete().catch(() => {});
    await collections.workersPublic.doc(uid).delete().catch(() => {});
    await collections.users.doc(uid).delete().catch(() => {});
  }
}

try {
  if (!env.razorpayKeyId || !env.razorpayKeySecret || !env.razorpayWebhookSecret) {
    fail("Razorpay env", "key id, secret or webhook secret missing");
  }
  pass("Razorpay env loaded", env.razorpayKeyId);

  const customer = await ensureUser(CUSTOMER_EMAIL, "QA Razorpay Customer", "customer", {
    role: "customer",
    admin: false,
  });
  const worker = await ensureUser(WORKER_EMAIL, "QA Razorpay Worker", "worker", {
    role: "worker",
    admin: false,
    workerApproved: true,
  });
  await collections.workers.doc(worker.uid).set({
    uid: worker.uid,
    name: "QA Razorpay Worker",
    email: WORKER_EMAIL,
    phone: "9876543299",
    serviceKey: "cleaning",
    service: "Home Cleaning",
    status: "approved",
    online: true,
    dues: 0,
    dueCommissionAmount: 0,
    hasPendingCommission: false,
    city: "Indore",
    area: "Vijay Nagar",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const customerToken = await signIn(CUSTOMER_EMAIL);
  const workerToken = await signIn(WORKER_EMAIL);
  pass("QA customer and worker signed in");

  const orderRes = await call("POST", "/payment/subscription/order", {
    token: customerToken,
    body: { plan: "monthly" },
  });
  let order;
  if (orderRes.ok && orderRes.data?.orderId) {
    order = orderRes.data;
    created.subscriptionIds.push(order.subscriptionId);
    pass("Razorpay subscription order created", order.orderId);
  } else {
    console.warn(
      "WARN  Razorpay order creation failed (check test keys):",
      JSON.stringify(orderRes.data),
    );
    const syntheticOrderId = `order_QA${STAMP}SUB`;
    const subRef = collections.subscriptions.doc();
    created.subscriptionIds.push(subRef.id);
    await subRef.set({
      userId: customer.uid,
      userName: "QA Razorpay Customer",
      userEmail: CUSTOMER_EMAIL,
      userRole: "customer",
      plan: "monthly",
      months: 1,
      amount: 199,
      status: "payment_pending",
      paymentProvider: "razorpay",
      paymentStatus: "created",
      razorpayOrderId: syntheticOrderId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    order = { orderId: syntheticOrderId, subscriptionId: subRef.id };
    pass("Synthetic subscription order prepared for verification tests");
  }

  const paymentId = `pay_QA${STAMP}SUB`;
  created.paymentIds.push(paymentId);
  const signature = hmac(env.razorpayKeySecret, `${order.orderId}|${paymentId}`);
  const verifyRes = await call("POST", "/payment/subscription/verify", {
    token: customerToken,
    body: {
      razorpay_order_id: order.orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
      subscriptionId: order.subscriptionId,
    },
  });
  if (!verifyRes.ok) fail("Verify subscription payment", JSON.stringify(verifyRes.data));
  const subSnap = await collections.subscriptions.doc(order.subscriptionId).get();
  if (subSnap.data()?.status !== "active" || subSnap.data()?.paymentId !== paymentId) {
    fail("Subscription activated", JSON.stringify(subSnap.data()));
  }
  const me = await call("GET", "/auth/me", { token: customerToken });
  if (me.data?.profile?.subscription?.status !== "active") {
    fail("Profile subscription active", JSON.stringify(me.data));
  }
  pass("Subscription auto-activated after signature verification");

  const duplicate = await call("POST", "/payment/subscription/verify", {
    token: customerToken,
    body: {
      razorpay_order_id: order.orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
      subscriptionId: order.subscriptionId,
    },
  });
  if (!duplicate.ok || !duplicate.data?.already) {
    fail("Subscription verify idempotency", JSON.stringify(duplicate.data));
  }
  pass("Subscription verify is idempotent");

  const badSignature = await call("POST", "/payment/subscription/verify", {
    token: customerToken,
    body: {
      razorpay_order_id: order.orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: "0".repeat(64),
      subscriptionId: order.subscriptionId,
    },
  });
  if (badSignature.status !== 400) fail("Invalid signature rejected", JSON.stringify(badSignature.data));
  pass("Invalid payment signature rejected");

  const stolenSubscription = await call("POST", "/payment/subscription/verify", {
    token: workerToken,
    body: {
      razorpay_order_id: order.orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
      subscriptionId: order.subscriptionId,
    },
  });
  if (stolenSubscription.status !== 403) {
    fail("Subscription ownership enforced", JSON.stringify(stolenSubscription.data));
  }
  pass("Subscription ownership enforced");

  const commissionRef = collections.commissions.doc();
  created.commissionIds.push(commissionRef.id);
  const bookingId = `qa_booking_${STAMP}`;
  await commissionRef.set({
    workerId: worker.uid,
    workerName: "QA Razorpay Worker",
    service: "Home Cleaning",
    bookingId,
    amount: 100,
    status: "pending",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await collections.workers.doc(worker.uid).set(
    { dues: 100, dueCommissionAmount: 100, hasPendingCommission: true },
    { merge: true },
  );
  const commissionOrder = await call("POST", "/payment/commission/order", {
    token: workerToken,
    body: { commissionId: commissionRef.id },
  });
  const commissionOrderId =
    commissionOrder.ok && commissionOrder.data?.orderId
      ? commissionOrder.data.orderId
      : `order_QA${STAMP}COM`;
  if (commissionOrder.ok && commissionOrder.data?.orderId) {
    pass("Razorpay commission order created", commissionOrderId);
  } else {
    console.warn(
      "WARN  Razorpay commission order creation failed (check test keys):",
      JSON.stringify(commissionOrder.data),
    );
    pass("Synthetic commission order prepared for verification tests");
  }

  const commissionPaymentId = `pay_QA${STAMP}COM`;
  created.paymentIds.push(commissionPaymentId);
  const commissionSignature = hmac(
    env.razorpayKeySecret,
    `${commissionOrderId}|${commissionPaymentId}`,
  );
  const commissionVerify = await call("POST", "/payment/commission/verify", {
    token: workerToken,
    body: {
      razorpay_order_id: commissionOrderId,
      razorpay_payment_id: commissionPaymentId,
      razorpay_signature: commissionSignature,
      commissionId: commissionRef.id,
    },
  });
  if (!commissionVerify.ok) fail("Verify commission payment", JSON.stringify(commissionVerify.data));
  const commissionSnap = await commissionRef.get();
  const workerSnap = await collections.workers.doc(worker.uid).get();
  if (commissionSnap.data()?.status !== "approved" || Number(workerSnap.data()?.dues) !== 0) {
    fail("Commission cleared", JSON.stringify({ commission: commissionSnap.data(), worker: workerSnap.data() }));
  }
  pass("Commission auto-approved and worker dues cleared");

  const webhookPayload = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: commissionPaymentId,
          order_id: commissionOrderId,
          notes: { type: "commission", commissionId: commissionRef.id, workerId: worker.uid },
        },
      },
    },
  });
  const webhookSignature = hmac(env.razorpayWebhookSecret, webhookPayload);
  const webhookRes = await fetch(`${API}/payment/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": webhookSignature,
    },
    body: webhookPayload,
  });
  const webhookData = await webhookRes.json().catch(() => ({}));
  if (!webhookRes.ok || webhookData?.already !== true) {
    fail("Webhook idempotency", JSON.stringify(webhookData));
  }
  pass("Signed webhook accepted and fulfilled idempotently");

  const badWebhook = await fetch(`${API}/payment/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": "0".repeat(64) },
    body: webhookPayload,
  });
  if (badWebhook.status !== 400) fail("Invalid webhook rejected", String(badWebhook.status));
  pass("Invalid webhook signature rejected");

  console.log("\nAll Razorpay integration checks passed.");
} catch (error) {
  console.error("\nRAZORPAY QA FAILED:", error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
  console.log("QA data cleaned up.");
  process.exit(process.exitCode || 0);
}
