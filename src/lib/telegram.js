import { env } from "../config/env.js";

/**
 * Sends a plain-text alert to the EasyHome admin Telegram chat.
 *
 * Telegram is an alerting side-channel: a missing token, missing chat ID,
 * timeout or API error must never break a payment submission. Failures are
 * logged without exposing the bot token.
 */
export async function sendTelegramAlert(message, { chatId = env.adminTelegramChatId } = {}) {
  if (!env.telegramBotToken || !chatId) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message.slice(0, 4000),
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      console.warn(
        "Telegram alert failed:",
        response.status,
        sanitizeTelegramError(details),
      );
      return { ok: false, skipped: false, status: response.status };
    }

    return { ok: true, skipped: false };
  } catch (error) {
    console.warn("Telegram alert error:", error.message);
    return { ok: false, skipped: false, error: error.message };
  }
}

export async function sendTelegramDocument(
  buffer,
  { filename, mimeType = "application/octet-stream", caption = "", chatId = env.adminTelegramChatId } = {},
) {
  if (!env.telegramBotToken || !chatId) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }

  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("document", new Blob([buffer], { type: mimeType }), filename || "worker-id");
    if (caption) form.append("caption", caption.slice(0, 1024));
    const response = await fetch(
      `https://api.telegram.org/bot${env.telegramBotToken}/sendDocument`,
      { method: "POST", body: form, signal: AbortSignal.timeout(15000) },
    );
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) {
      console.warn(
        "Telegram document delivery failed:",
        response.status,
        sanitizeTelegramError(result?.description || "Invalid response"),
      );
      return { ok: false, skipped: false, status: response.status };
    }
    return { ok: true, skipped: false };
  } catch (error) {
    console.warn("Telegram document delivery error:", error.message);
    return { ok: false, skipped: false, error: error.message };
  }
}

function sanitizeTelegramError(value) {
  // Telegram error bodies are small JSON payloads. Strip the token if a proxy
  // or gateway echoes the request URL back in the error detail.
  return String(value || "")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .slice(0, 240);
}

export function subscriptionTelegramMessage({
  name,
  email,
  role,
  planLabel,
  months,
  amount,
  utrId,
  requestId,
}) {
  return [
    "🔔 NEW SUBSCRIPTION PAYMENT",
    `👤 User: ${name || "Unknown"}${email ? ` (${email})` : ""}`,
    `🧑‍💼 Role: ${role === "worker" ? "Worker" : "Customer"}`,
    `🏷️ Plan: ${planLabel || "Membership"} · ${months || 1} month${Number(months) > 1 ? "s" : ""}`,
    `💰 Amount: ₹${Number(amount) || 0}`,
    `💳 UTR ID: ${utrId || "—"}`,
    `🆔 Request: ${requestId || "—"}`,
  ].join("\n");
}

export function commissionTelegramMessage({
  workerName,
  workerId,
  service,
  bookingId,
  amount,
  utrId,
}) {
  return [
    "🔔 NEW COMMISSION PAYMENT",
    `👷 Worker: ${workerName || workerId || "Unknown"}`,
    `💰 Amount: ₹${Number(amount) || 0}`,
    `💳 UTR ID: ${utrId || "—"}`,
    `🧾 Job: ${service || "Service job"}`,
    `🆔 Booking: ${bookingId || "—"}`,
  ].join("\n");
}

export function subscriptionPaidTelegramMessage({
  name,
  email,
  role,
  planLabel,
  months,
  amount,
  paymentId,
  orderId,
}) {
  return [
    "💳 NEW RAZORPAY SUBSCRIPTION",
    `👤 User: ${name || "Unknown"}${email ? ` (${email})` : ""}`,
    `👷 Role: ${role === "worker" ? "Worker" : "Customer"}`,
    `📦 Plan: ${planLabel || "Membership"} — ${months || 1} month${Number(months) > 1 ? "s" : ""}`,
    `💰 Amount: ₹${Number(amount) || 0}`,
    `🆔 Payment ID: ${paymentId || "—"}`,
    `🧾 Order ID: ${orderId || "—"}`,
    "✅ Status: Auto-verified",
  ].join("\n");
}

export function commissionPaidTelegramMessage({
  workerName,
  workerId,
  service,
  bookingId,
  amount,
  paymentId,
  orderId,
}) {
  return [
    "✅ WORKER COMMISSION CLEARED",
    `👷 Worker: ${workerName || workerId || "Unknown"}`,
    `💰 Amount: ₹${Number(amount) || 0}`,
    `🆔 Payment ID: ${paymentId || "—"}`,
    `🧾 Order ID: ${orderId || "—"}`,
    `🔧 Job: ${service || "Service job"}`,
    `🆔 Booking: ${bookingId || "—"}`,
    "✅ Status: Auto-verified",
  ].join("\n");
}
