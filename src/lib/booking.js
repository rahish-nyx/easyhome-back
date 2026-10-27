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

export const PLAN_MONTHS = Object.freeze({
  monthly: 1,
  quarterly: 3,
  yearly: 12,
});

export const DEFAULT_CUSTOMER_PLANS = Object.freeze({
  monthly: 199,
  quarterly: 537,
  yearly: 1910,
});

// Professional membership starts at ₹250/month. Quarterly and yearly prices
// are derived with the same 10% / 20% multi-month discount used for customers.
export const DEFAULT_WORKER_PLANS = Object.freeze({
  monthly: 250,
  quarterly: 675,
  yearly: 2400,
});

export const DEFAULT_CUSTOMER_RULES = Object.freeze({
  urgentFeePct: 10,
  cancellationMinutes: 7,
  proCancellationMinutes: 20,
});

export const DEFAULT_WORKER_RULES = Object.freeze({
  feesPct: 10,
  urgentFeePct: 10,
  cancellationMinutes: 7,
});

function planPrice(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.round(number);
}

export function normalisePlanGroup(group, fallbackMonthly) {
  const monthly = planPrice(
    group?.monthly,
    planPrice(fallbackMonthly, DEFAULT_CUSTOMER_PLANS.monthly),
  );
  return {
    monthly,
    quarterly: planPrice(group?.quarterly, Math.round(monthly * 3 * 0.9)),
    yearly: planPrice(group?.yearly, Math.round(monthly * 12 * 0.8)),
  };
}

export function planMonths(plan) {
  return PLAN_MONTHS[plan] || 1;
}

/** Authoritative membership amount for a role and billing plan. */
export function subscriptionAmount(settings, role, plan) {
  const group =
    role === "worker"
      ? normalisePlanGroup(
          settings?.workerPlans,
          DEFAULT_WORKER_PLANS.monthly,
        )
      : normalisePlanGroup(
          settings?.customerPlans,
          Number(settings?.subscriptionPrice) || DEFAULT_CUSTOMER_PLANS.monthly,
        );
  return group[plan] ?? group.monthly;
}

/** Professional service fees. Falls back to the legacy commissionPct field. */
export function feesPctFor(settings) {
  const value = Number(
    settings?.workerRules?.feesPct ?? settings?.commissionPct,
  );
  return Number.isFinite(value) ? value : 0;
}

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
  "0% fees on every job",
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

const LEGACY_WORKER_BENEFIT_COPY = {
  "0% commission on every job": "0% fees on every job",
  "Zero commission on every job": "0% fees on every job",
  "No commission on every job": "0% fees on every job",
};

export function normaliseWorkerBenefits(benefits) {
  if (!Array.isArray(benefits) || benefits.length === 0) {
    return [...DEFAULT_WORKER_BENEFITS];
  }
  if (benefits.some((benefit) => LEGACY_CUSTOMER_BENEFITS.has(benefit))) {
    return [...DEFAULT_WORKER_BENEFITS];
  }
  return [
    ...new Set(
      benefits.map(
        (benefit) => LEGACY_WORKER_BENEFIT_COPY[benefit] || benefit,
      ),
    ),
  ];
}

function ruleNumber(value, fallback, { min = 0, max = 1000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function appSettingsSyncDefaults() {
  return {
    commissionPct: env.commissionPct,
    subscriptionPrice: env.subscriptionPrice,
    customerPlans: normalisePlanGroup(
      DEFAULT_CUSTOMER_PLANS,
      env.subscriptionPrice,
    ),
    workerPlans: { ...DEFAULT_WORKER_PLANS },
    customerRules: { ...DEFAULT_CUSTOMER_RULES },
    workerRules: { ...DEFAULT_WORKER_RULES, feesPct: env.commissionPct },
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
  merged.workerBenefits = normaliseWorkerBenefits(merged.workerBenefits);

  // Membership prices and role-specific rules. The legacy scalar fields are
  // still returned and written for older clients, but these groups are now the
  // source of truth for billing.
  const customerMonthly = ruleNumber(
    merged.subscriptionPrice,
    env.subscriptionPrice,
    { min: 0, max: 100000 },
  );
  merged.customerPlans = normalisePlanGroup(
    stored.customerPlans,
    customerMonthly,
  );
  merged.workerPlans = normalisePlanGroup(
    stored.workerPlans,
    DEFAULT_WORKER_PLANS.monthly,
  );
  merged.subscriptionPrice = merged.customerPlans.monthly;

  const storedCustomerRules = stored.customerRules || {};
  merged.customerRules = {
    urgentFeePct: ruleNumber(
      storedCustomerRules.urgentFeePct,
      DEFAULT_CUSTOMER_RULES.urgentFeePct,
      { min: 0, max: 100 },
    ),
    cancellationMinutes: ruleNumber(
      storedCustomerRules.cancellationMinutes,
      DEFAULT_CUSTOMER_RULES.cancellationMinutes,
      { min: 1, max: 1440 },
    ),
    proCancellationMinutes: ruleNumber(
      storedCustomerRules.proCancellationMinutes,
      DEFAULT_CUSTOMER_RULES.proCancellationMinutes,
      { min: 1, max: 1440 },
    ),
  };

  const storedWorkerRules = stored.workerRules || {};
  merged.workerRules = {
    feesPct: ruleNumber(
      storedWorkerRules.feesPct ?? merged.commissionPct,
      env.commissionPct,
      { min: 0, max: 40 },
    ),
    urgentFeePct: ruleNumber(
      storedWorkerRules.urgentFeePct,
      DEFAULT_WORKER_RULES.urgentFeePct,
      { min: 0, max: 100 },
    ),
    cancellationMinutes: ruleNumber(
      storedWorkerRules.cancellationMinutes,
      DEFAULT_WORKER_RULES.cancellationMinutes,
      { min: 1, max: 1440 },
    ),
  };
  merged.commissionPct = merged.workerRules.feesPct;

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
