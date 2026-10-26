import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { collections } from "../config/firebase.js";
import { notify, notifyAdmins } from "./notify.js";

export const REFERRAL_REWARD = 51;

const CODE_PATTERN = /^[A-Z0-9]{6,12}$/;

export function normaliseReferralCode(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 12);
}

async function codeTaken(code) {
  const snap = await collections.users
    .where("referralCode", "==", code)
    .limit(1)
    .get();
  return !snap.empty;
}

/**
 * Every customer gets a short, unique code. Existing accounts receive one the
 * first time they open Refer & Earn; new accounts receive one at sign-up.
 */
export async function ensureReferralCode(uid) {
  const ref = collections.users.doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return "";

  const existing = normaliseReferralCode(snap.data().referralCode);
  if (CODE_PATTERN.test(existing)) return existing;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    if (!(await codeTaken(code))) {
      await ref.set(
        { referralCode: code, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      return code;
    }
  }

  // Extremely unlikely fallback: a uid-derived code that is still unique.
  const fallback = normaliseReferralCode(uid).slice(0, 10);
  await ref.set(
    { referralCode: fallback, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  return fallback;
}

/**
 * Called only while creating a brand-new profile. Existing accounts can never
 * claim a referral, which prevents self-referrals and repeat claims.
 */
export async function applyReferralForNewUser({
  code,
  uid,
  name,
  email,
  role,
}) {
  const referralCode = normaliseReferralCode(code);
  if (!CODE_PATTERN.test(referralCode)) {
    return { applied: false, reason: "invalid_code" };
  }
  if (role && role !== "customer") {
    return { applied: false, reason: "customers_only" };
  }

  const referrerSnap = await collections.users
    .where("referralCode", "==", referralCode)
    .limit(1)
    .get();
  if (referrerSnap.empty) {
    return { applied: false, reason: "invalid_code" };
  }

  const referrerDoc = referrerSnap.docs[0];
  if (referrerDoc.id === uid) {
    return { applied: false, reason: "self_referral" };
  }

  const referrer = referrerDoc.data();
  if (referrer.role && referrer.role !== "customer") {
    return { applied: false, reason: "customers_only" };
  }
  if (referrer.disabled === true) {
    return { applied: false, reason: "referrer_inactive" };
  }
  const referrerEmail = String(referrer.email || "").trim().toLowerCase();
  if (referrerEmail && referrerEmail === String(email || "").trim().toLowerCase()) {
    return { applied: false, reason: "self_referral" };
  }

  const referralRef = collections.referrals.doc(uid);
  const existing = await referralRef.get();
  if (existing.exists) {
    return { applied: false, reason: "already_referred" };
  }

  await referralRef.set({
    referrerId: referrerDoc.id,
    referrerName: referrer.name || "EasyHome customer",
    referrerEmail: referrer.email || "",
    referredId: uid,
    referredName: name || "EasyHome customer",
    referredEmail: email || "",
    status: "pending",
    serviceCompleted: false,
    firstBookingId: null,
    rewardAmount: REFERRAL_REWARD,
    currency: "INR",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await collections.users.doc(uid).set(
    {
      referredBy: referrerDoc.id,
      referralCode: await ensureReferralCode(uid),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await Promise.allSettled([
    notify(referrerDoc.id, {
      title: "Your friend joined EasyHome",
      body: `${name || "Your friend"} signed up with your code. You both unlock ₹${REFERRAL_REWARD} after their first completed service and admin verification.`,
      type: "referral",
      link: "/refer",
    }),
    notifyAdmins({
      title: "New referral sign-up",
      body: `${name || "A customer"} joined with ${referrer.name || "a customer"}'s code. Reward is pending their first completed service.`,
      type: "referral",
      link: "/admin/referrals",
    }),
  ]);

  return { applied: true, referralId: uid, referrerId: referrerDoc.id };
}

/**
 * Marks the referral as ready for admin review after the referred customer's
 * first completed job. It never credits a wallet automatically.
 */
export async function markReferralServiceCompleted(uid, bookingId) {
  const ref = collections.referrals.doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return false;

  const referral = snap.data();
  if (referral.serviceCompleted || referral.status !== "pending") return false;

  await ref.set(
    {
      status: "service_completed",
      serviceCompleted: true,
      serviceCompletedAt: FieldValue.serverTimestamp(),
      firstBookingId: bookingId || referral.firstBookingId || null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await Promise.allSettled([
    notify(referral.referrerId, {
      title: "Referral ready for verification",
      body: `${referral.referredName || "Your friend"} completed their first service. EasyHome will verify the referral before approving ₹${referral.rewardAmount || REFERRAL_REWARD}.`,
      type: "referral",
      link: "/refer",
    }),
    notifyAdmins({
      title: "Referral ready to verify",
      body: `${referral.referredName || "A new customer"} completed their first service. Review the referral before approving rewards.`,
      type: "referral",
      link: "/admin/referrals",
    }),
  ]);

  return true;
}
