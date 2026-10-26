import { collections } from "../config/firebase.js";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";
import { toDate } from "./utils.js";

export const BOOKING_STATUS = Object.freeze({
  PENDING: "pending",
  ACCEPTED: "accepted",
  ONGOING: "ongoing",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});

export const COMMISSION_STATUS = Object.freeze({
  PENDING: "pending",
  PAID: "paid",
  APPROVED: "approved",
  REJECTED: "rejected",
});

export const WORKER_STATUS = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  SUSPENDED: "suspended",
});

let cachedSettings = null;
let cachedAt = 0;

export const DEFAULT_CUSTOMER_BENEFITS = Object.freeze([
  "Active priority worker matching",
  "No 10% urgent-job extra charge",
  "24×7 priority support",
  "Free cancellation for 20 minutes (7 for non-Pro)",
  "Verified Pro badge",
]);

export const DEFAULT_WORKER_BENEFITS = Object.freeze([
  "0% commission on every job",
  "Top placement in search",
  "Free urgent-job priority",
  "Verified Pro badge",
]);

const LEGACY_CUSTOMER_BENEFITS = new Set([
  "Discounted service visits",
  "Free cancellation up to 1 hour",
  "Free cancellation up to 20 minutes",
  "Free cancellation up to 7 minutes",
  "Priority matching",
  "Priority worker matching",
  "Member pricing",
  "No 10% extra charge on urgent jobs",
  "No 10% urgent-job fee",
  "No urgent-job fee",
  "20-minute free cancellation",
  "24x7 priority support",
]);

const BENEFIT_REPLACEMENTS = {
  "Priority matching": "Active priority worker matching",
  "Priority worker matching": "Active priority worker matching",
  "Discounted service visits": "No 10% urgent-job extra charge",
  "Member pricing": "No 10% urgent-job extra charge",
  "No 10% extra charge on urgent jobs": "No 10% urgent-job extra charge",
  "No 10% urgent-job fee": "No 10% urgent-job extra charge",
  "No urgent-job fee": "No 10% urgent-job extra charge",
  "Free cancellation up to 1 hour": "Free cancellation for 20 minutes (7 for non-Pro)",
  "Free cancellation up to 20 minutes": "Free cancellation for 20 minutes (7 for non-Pro)",
  "Free cancellation up to 7 minutes": "Free cancellation for 20 minutes (7 for non-Pro)",
  "20-minute free cancellation": "Free cancellation for 20 minutes (7 for non-Pro)",
  "24x7 priority support": "24×7 priority support",
};

export function normaliseCustomerBenefits(benefits) {
  if (!Array.isArray(benefits) || benefits.length === 0) {
    return [...DEFAULT_CUSTOMER_BENEFITS];
  }
  // Live settings created before the benefit refresh still contain the old
  // marketing copy. Replace known entries, keep custom admin additions and
  // make sure the active Pro badge remains visible.
  const result = benefits.map(
    (benefit) => BENEFIT_REPLACEMENTS[benefit] || benefit,
  );
  if (!result.some((benefit) => /verified pro badge/i.test(benefit))) {
    result.push("Verified Pro badge");
  }
  return [...new Set(result)];
}

export function appSettingsSyncDefaults() {
  return {
    commissionPct: env.commissionPct,
    subscriptionPrice: env.subscriptionPrice,
    customerBenefits: [...DEFAULT_CUSTOMER_BENEFITS],
    workerBenefits: [...DEFAULT_WORKER_BENEFITS],
    upiId: "rahishcnrb@ybl",
    qrImagePath: "",
    qrImageUrl: "",
    supportPhone: "",
    maintenanceMode: false,
  };
}

export async function appSettings({ fresh = false } = {}) {
  if (!fresh && cachedSettings && Date.now() - cachedAt < 30_000) {
    return cachedSettings;
  }
  const snap = await collections.settings.doc("app").get();
  const stored = snap.exists ? snap.data() : {};
  const merged = {
    ...appSettingsSyncDefaults(),
    ...stored,
  };
  merged.customerBenefits = normaliseCustomerBenefits(merged.customerBenefits);
  if (!Array.isArray(merged.workerBenefits) || merged.workerBenefits.length === 0) {
    merged.workerBenefits = [...DEFAULT_WORKER_BENEFITS];
  } else if (merged.workerBenefits.some((benefit) => LEGACY_CUSTOMER_BENEFITS.has(benefit))) {
    merged.workerBenefits = [...DEFAULT_WORKER_BENEFITS];
  }
  cachedSettings = merged;
  cachedAt = Date.now();
  return cachedSettings;
}

export function invalidateSettings() {
  cachedAt = 0;
}

export function premiumActive(worker) {
  const until = toDate(worker?.premiumUntil);
  return Boolean(until && until.getTime() > Date.now());
}

/** Active paid membership on a customer profile. */
export function customerPremiumActive(user) {
  const subscription = user?.subscription || {};
  if (subscription.status !== "active") return false;
  const until = toDate(subscription.endAt);
  return Boolean(until && until.getTime() > Date.now());
}

export function customerPremiumUntil(user) {
  const until = toDate(user?.subscription?.endAt);
  return until && until.getTime() > Date.now() ? until : null;
}

export function workerDues(worker) {
  return Math.max(
    0,
    Number(worker?.dues ?? worker?.dueCommissionAmount) || 0,
  );
}

export function commissionFor(price, commissionPct, { premium = false } = {}) {
  const amount = Math.round(Number(price) || 0);
  if (premium || amount <= 0) {
    return { commission: 0, workerReceives: amount };
  }
  const pct = Number(commissionPct) || 0;
  const commission = Math.round((amount * pct) / 100);
  return { commission, workerReceives: amount - commission };
}

/**
 * A worker can accept a job when approved, online, with no outstanding
 * commission dues (premium members skip the dues rule).
 */
export function canAcceptJobs(worker, { premium = premiumActive(worker) } = {}) {
  if (!worker) {
    return { allowed: false, reason: "no_worker_profile" };
  }
  if (worker.status !== WORKER_STATUS.APPROVED) {
    return { allowed: false, reason: "not_approved", status: worker.status };
  }
  if (worker.online === false) {
    return { allowed: false, reason: "offline" };
  }
  const dues = workerDues(worker);
  if (!premium && dues > 0) {
    return { allowed: false, reason: "dues", dues };
  }
  return { allowed: true, premium, dues };
}

export function assertBookingOwner(booking, user, roles = ["customer"]) {
  if (!booking) {
    throw new ApiError(404, "Booking not found.", "BOOKING_NOT_FOUND");
  }
  const isCustomer = roles.includes("customer") && booking.customerId === user.uid;
  const isWorker = roles.includes("worker") && booking.workerId === user.uid;
  const isAdmin = roles.includes("admin") && user.admin;
  if (!isCustomer && !isWorker && !isAdmin) {
    throw new ApiError(403, "You do not have access to this booking.", "BOOKING_FORBIDDEN");
  }
  return { isCustomer, isWorker, isAdmin };
}

export function assertBookingStatus(booking, allowed) {
  if (!allowed.includes(booking.status)) {
    throw new ApiError(
      409,
      `This action is not available while the booking is ${booking.status}.`,
      "BOOKING_STATUS_INVALID",
      { status: booking.status, allowed },
    );
  }
}

export function bookingPublicId() {
  return collections.bookings.doc().id;
}
