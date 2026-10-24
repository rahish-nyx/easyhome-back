import { env } from "../config/env.js";

function telegramApiUrl(method) {
  return `https://api.telegram.org/bot${env.telegramBotToken}/${method}`;
}

export function isTelegramConfigured() {
  return Boolean(env.telegramBotToken && env.adminTelegramChatId);
}

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

/**
 * Sends an uploaded document (for example a National ID) straight to the
 * admin Telegram chat. The bytes are uploaded as multipart/form-data so the
 * file never has to be stored in Firebase Storage or exposed through a public
 * URL.
 */
export async function sendTelegramDocument(
  buffer,
  {
    filename = "easyhome-document.jpg",
    contentType = "image/jpeg",
    caption = "",
    chatId = env.adminTelegramChatId,
  } = {},
) {
  if (!env.telegramBotToken || !chatId) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!buffer || !buffer.length) {
    return { ok: false, skipped: false, reason: "empty_file" };
  }

  const safeName =
    String(filename || "easyhome-document.jpg")
      .replace(/[^a-z0-9._-]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(-120) || "easyhome-document.jpg";

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", String(caption || "").slice(0, 1024));
  form.append(
    "document",
    new Blob([buffer], { type: contentType || "application/octet-stream" }),
    safeName,
  );

  try {
    const response = await fetch(telegramApiUrl("sendDocument"), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const details = sanitizeTelegramError(
        payload?.description || `HTTP ${response.status}`,
      );
      console.warn("Telegram document failed:", response.status, details);
      return {
        ok: false,
        skipped: false,
        status: response.status,
        error: details,
      };
    }

    const result = payload.result || {};
    return {
      ok: true,
      skipped: false,
      messageId: result.message_id || null,
      fileId: result.document?.file_id || "",
      fileUniqueId: result.document?.file_unique_id || "",
      chatId: String(result.chat?.id || chatId),
      fileName: result.document?.file_name || safeName,
      mimeType: result.document?.mime_type || contentType,
    };
  } catch (error) {
    console.warn("Telegram document error:", error.message);
    return { ok: false, skipped: false, error: sanitizeTelegramError(error.message) };
  }
}

/**
 * Downloads a previously sent Telegram document so an admin can review it
 * without keeping a copy in app storage. The bot token stays server-side.
 */
export async function fetchTelegramDocument(fileId) {
  if (!env.telegramBotToken) {
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  if (!fileId) {
    return { ok: false, skipped: false, reason: "missing_file_id" };
  }

  try {
    const metaResponse = await fetch(
      `${telegramApiUrl("getFile")}?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(10000) },
    );
    const meta = await metaResponse.json().catch(() => null);
    if (!metaResponse.ok || !meta?.ok || !meta.result?.file_path) {
      const details = sanitizeTelegramError(
        meta?.description || `HTTP ${metaResponse.status}`,
      );
      console.warn("Telegram getFile failed:", metaResponse.status, details);
      return {
        ok: false,
        skipped: false,
        status: metaResponse.status,
        error: details,
      };
    }

    const filePath = String(meta.result.file_path);
    if (!/^[a-z0-9_./-]+$/i.test(filePath) || filePath.includes("..")) {
      return { ok: false, skipped: false, error: "Invalid Telegram file path." };
    }

    const fileResponse = await fetch(
      `https://api.telegram.org/file/bot${env.telegramBotToken}/${filePath}`,
      { signal: AbortSignal.timeout(20000) },
    );
    if (!fileResponse.ok) {
      console.warn("Telegram file download failed:", fileResponse.status);
      return {
        ok: false,
        skipped: false,
        status: fileResponse.status,
        error: `HTTP ${fileResponse.status}`,
      };
    }

    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    return {
      ok: true,
      skipped: false,
      buffer,
      contentType:
        fileResponse.headers.get("content-type") || "application/octet-stream",
      name: filePath.split("/").pop() || "document",
      filePath,
    };
  } catch (error) {
    console.warn("Telegram file error:", error.message);
    return { ok: false, skipped: false, error: sanitizeTelegramError(error.message) };
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
    "? NEW RAZORPAY SUBSCRIPTION",
    `?? User: ${name || "Unknown"}${email ? ` (${email})` : ""}`,
    `????? Role: ${role === "worker" ? "Worker" : "Customer"}`,
    `??? Plan: ${planLabel || "Membership"} � ${months || 1} month${Number(months) > 1 ? "s" : ""}`,
    `?? Amount: ?${Number(amount) || 0}`,
    `?? Payment ID: ${paymentId || "�"}`,
    `?? Order ID: ${orderId || "�"}`,
    "? Status: Auto-verified ?",
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
    "? WORKER COMMISSION CLEARED",
    `?? Worker: ${workerName || workerId || "Unknown"}`,
    `?? Amount: ?${Number(amount) || 0}`,
    `?? Payment ID: ${paymentId || "�"}`,
    `?? Order ID: ${orderId || "�"}`,
    `??? Job: ${service || "Service job"}`,
    `?? Booking: ${bookingId || "�"}`,
    "? Status: Auto-verified ?",
  ].join("\n");
}
