import crypto from "node:crypto";
import Razorpay from "razorpay";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";

let client = null;

export function razorpayConfigured() {
  return Boolean(env.razorpayKeyId && env.razorpayKeySecret);
}

export function razorpayKeyId() {
  return env.razorpayKeyId;
}

function getClient() {
  if (!razorpayConfigured()) {
    throw new ApiError(
      503,
      "Online payments are not configured yet. Please contact support.",
      "PAYMENT_NOT_CONFIGURED",
    );
  }
  if (!client) {
    client = new Razorpay({
      key_id: env.razorpayKeyId,
      key_secret: env.razorpayKeySecret,
    });
  }
  return client;
}

export async function createRazorpayOrder({ amountRupees, receipt, notes }) {
  const amount = Math.round(Number(amountRupees) * 100);
  if (!Number.isFinite(amount) || amount < 100) {
    throw new ApiError(422, "Invalid payment amount.", "AMOUNT_INVALID");
  }
  try {
    return await getClient().orders.create({
      amount,
      currency: "INR",
      receipt,
      notes,
    });
  } catch (error) {
    const details = error?.error || error;
    console.error("[razorpay] order creation failed:", {
      code: details?.code,
      description: details?.description,
      statusCode: details?.statusCode,
    });
    throw new ApiError(
      502,
      "The payment gateway is temporarily unavailable. Please try again in a moment.",
      "PAYMENT_GATEWAY_ERROR",
    );
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature || !env.razorpayKeySecret) return false;
  const expected = crypto
    .createHmac("sha256", env.razorpayKeySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return safeEqual(expected, signature);
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!rawBody || !signature || !env.razorpayWebhookSecret) return false;
  const expected = crypto
    .createHmac("sha256", env.razorpayWebhookSecret)
    .update(rawBody)
    .digest("hex");
  return safeEqual(expected, signature);
}
