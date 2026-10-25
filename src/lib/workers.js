import { auth, collections } from "../config/firebase.js";
import { premiumActive } from "./booking.js";
import { docToJson } from "./utils.js";

function coordinate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Keeps the public worker directory in sync with the private worker document.
 * Public docs intentionally contain no phone, email, UPI or KYC data.
 */
export async function syncPublicWorker(uid) {
  const snap = await collections.workers.doc(uid).get();
  if (!snap.exists) {
    await collections.workersPublic.doc(uid).delete().catch(() => {});
    return null;
  }

  const worker = snap.data();
  if (worker.status !== "approved") {
    await collections.workersPublic.doc(uid).delete().catch(() => {});
    return null;
  }

  const publicDoc = {
    uid,
    name: worker.name || "EasyHome Pro",
    photoPath: worker.photoPath || "",
    service: worker.service || "",
    serviceKey: worker.serviceKey || "",
    pricePerWork: Number(worker.pricePerWork) || 0,
    area: worker.area || "",
    city: worker.city || "",
    state: worker.state || "",
    areaName: worker.areaName || "",
    lat: coordinate(worker.lat),
    lng: coordinate(worker.lng),
    online: worker.online === true,
    rating: Number(worker.rating) || 0,
    reviewCount: Number(worker.reviewCount) || 0,
    jobsCompleted: Number(worker.jobsCompleted) || 0,
    premiumUntil: worker.premiumUntil || null,
    isPremium: premiumActive(worker),
    updatedAt: new Date(),
  };

  await collections.workersPublic.doc(uid).set(publicDoc, { merge: true });
  return docToJson({ id: uid, exists: true, data: () => publicDoc });
}

export async function setClaimsPatch(uid, patch) {
  const user = await auth.getUser(uid);
  const current = user.customClaims || {};
  await auth.setCustomUserClaims(uid, { ...current, ...patch });
}

export async function approveWorker(uid, { approved }) {
  await setClaimsPatch(uid, { role: "worker", workerApproved: approved === true });
  await syncPublicWorker(uid);
}

export async function isAdminUid(uid) {
  if (!uid) return false;
  const snap = await collections.admins.doc(uid).get();
  return snap.exists;
}
