import nodemailer from "nodemailer";
import { collections, db } from "../config/store.js";
import { env } from "../config/env.js";
import { FieldValue } from "./values.js";

/* ------------------- In-app notifications (MongoDB adapter) ------------------- */

export async function notify(userId, { title, body, type = "info", link = "", priority = "standard" }) {
  if (!userId) return null;
  try {
    const ref = collections.notifications.doc();
    await ref.set({
      userId,
      title,
      body,
      type,
      link,
      priority,
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (error) {
    console.warn("Notification failed:", error.message);
    return null;
  }
}

export async function notifyAdmins({ title, body, type = "admin", link = "", priority = "standard" }) {
  try {
    const admins = await collections.admins.limit(25).get();
    if (admins.empty) return;
    const batch = db.batch();
    admins.forEach((admin) => {
      const ref = collections.notifications.doc();
      batch.set(ref, {
        userId: admin.id,
        title,
        body,
        type,
        link,
        priority,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
  } catch (error) {
    console.warn("Admin notification failed:", error.message);
  }
}

/* ------------------- SMTP email (Nodemailer + Brevo) ------------------- */

const transporter = nodemailer.createTransport({
  host: env.smtpHost || "smtp-relay.brevo.com",
  port: Number(env.smtpPort || 587),
  secure: false,
  auth: {
    user: env.smtpUser || process.env.SMTP_USER || "",
    pass: env.smtpPassword || process.env.SMTP_PASSWORD || "",
  },
  tls: { rejectUnauthorized: false },
});

function parseMailFrom(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].replace(/^"+|"+$/g, "").trim() || "EasyHome",
      email: match[2].trim(),
    };
  }
  return { name: "EasyHome", email: raw || "official.easyhomeservices@gmail.com" };
}

async function sendViaBrevoApi({ to, subject, html, text }) {
  const apiKey = env.brevoApiKey || process.env.BREVO_API_KEY || "";
  if (!apiKey) return null;
  const sender = parseMailFrom(env.mailFrom);
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender,
        to: (Array.isArray(to) ? to : [to]).map((email) => ({ email })),
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { skipped: false, ok: false, error: data?.message || `Brevo API ${response.status}` };
    }
    console.log("Brevo API email sent:", data?.messageId, "to:", Array.isArray(to) ? to.join(",") : to);
    return { skipped: false, ok: true, messageId: data?.messageId, provider: "brevo-api" };
  } catch (error) {
    return { skipped: false, ok: false, error: error.message };
  }
}

export async function sendMail({ to, subject, html, text }) {
  const smtpConfigured = Boolean(env.smtpPassword || process.env.SMTP_PASSWORD);
  const apiConfigured = Boolean(env.brevoApiKey || process.env.BREVO_API_KEY);

  if (!smtpConfigured && !apiConfigured) {
    console.warn("Email transport not configured — email skipped");
    return { skipped: true };
  }

  if (smtpConfigured) {
    try {
      const info = await transporter.sendMail({
        from: env.mailFrom,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
      });
      console.log(
        "SMTP email sent:",
        info.messageId,
        "to:",
        Array.isArray(to) ? to.join(",") : to,
        "from:",
        env.mailFrom,
      );
      return { skipped: false, ok: true, messageId: info.messageId, provider: "smtp" };
    } catch (error) {
      console.warn("SMTP email error:", error.message);
      // Fall through to the Brevo HTTP API when SMTP is blocked (common on
      // hosts that throttle port 587) and an API key is available.
    }
  }

  const fallback = await sendViaBrevoApi({ to, subject, html, text });
  if (fallback) return fallback;
  return {
    skipped: false,
    ok: false,
    error: "Email could not be delivered. Configure SMTP_PASSWORD or BREVO_API_KEY.",
  };
}

/* ------------------- Email template ------------------- */

export function emailLayout({ heading, intro, body = "", ctaText, ctaUrl }) {
  return `
  <div style="font-family:Inter,Arial,sans-serif;background:#f5f5f0;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:20px;padding:28px">
      <div style="font-size:22px;font-weight:800;color:#0a0a0a;margin-bottom:18px">
        Easy<span style="color:#ffb800">Home</span>
      </div>
      <h1 style="font-size:20px;line-height:1.3;margin:0 0 10px;color:#0a0a0a">${heading}</h1>
      <p style="font-size:14px;line-height:1.6;color:#555;margin:0 0 16px">${intro}</p>
      ${body}
      ${
        ctaText && ctaUrl
          ? `<a href="${ctaUrl}" style="display:inline-block;background:#ffd60a;color:#0a0a0a;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:12px;margin-top:8px">${ctaText}</a>
      <p style="font-size:12px;line-height:1.5;color:#666;margin:18px 0 0">
        If the button above does not work, copy and paste this secure link into your browser:
      </p>
      <p style="font-size:12px;line-height:1.5;word-break:break-all;margin:6px 0 0">
        <a href="${ctaUrl}" style="color:#1d4ed8;text-decoration:underline">${ctaUrl}</a>
      </p>`
          : ""
      }
      <p style="font-size:12px;color:#999;margin-top:22px">You are receiving this because you have an EasyHome account.</p>
    </div>
  </div>`;
}
