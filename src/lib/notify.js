import nodemailer from "nodemailer";
import { collections, db } from "../config/firebase.js";
import { env } from "../config/env.js";
import { FieldValue } from "./firestore.js";

/* ------------------- In-app notifications (MongoDB adapter) ------------------- */

export async function notify(userId, { title, body, type = "info", link = "" }) {
  if (!userId) return null;
  try {
    const ref = collections.notifications.doc();
    await ref.set({
      userId,
      title,
      body,
      type,
      link,
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (error) {
    console.warn("Notification failed:", error.message);
    return null;
  }
}

export async function notifyAdmins({ title, body, type = "admin", link = "" }) {
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

export async function sendMail({ to, subject, html, text }) {
  if (!env.smtpPassword && !process.env.SMTP_PASSWORD) {
    console.warn("SMTP not configured — email skipped");
    return { skipped: true };
  }
  try {
    const info = await transporter.sendMail({
      from: env.mailFrom,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
    });
    console.log("SMTP email sent:", info.messageId, "to:", Array.isArray(to) ? to.join(",") : to, "from:", env.mailFrom);
    return { skipped: false, ok: true, messageId: info.messageId };
  } catch (error) {
    console.warn("SMTP email error:", error.message);
    return { skipped: false, ok: false, error: error.message };
  }
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
          ? `<a href="${ctaUrl}" style="display:inline-block;background:#ffd60a;color:#0a0a0a;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:12px;margin-top:8px">${ctaText}</a>`
          : ""
      }
      <p style="font-size:12px;color:#999;margin-top:22px">You are receiving this because you have an EasyHome account.</p>
    </div>
  </div>`;
}
