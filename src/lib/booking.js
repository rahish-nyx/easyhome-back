import { collections } from "../config/store.js";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";
import { toDate } from "./utils.js";
import { workerMatchesBooking, prioritizeWorkers } from "./matching.js";

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
  cancellationMinutes: 5,
  proCancellationMinutes: 5,
});

export const DEFAULT_WORKER_RULES = Object.freeze({
  feesPct: 10,
  urgentFeePct: 10,
  cancellationMinutes: 7,
});

/** EasyHome Pro — discounted platform commission rate for Pro workers (7%). */
export const DEFAULT_WORKER_PRO_COMMISSION_PCT = Object.freeze(7);

/** EasyHome Pro — accidental damage assistance limit per claim (₹). */
export const DEFAULT_ACCIDENTAL_DAMAGE_LIMIT = Object.freeze(500);

/** EasyHome Pro — exclusive continuous renewal reward (3% off next purchase). */
export const DEFAULT_RENEWAL_REWARD_PCT = Object.freeze(3);
export const DEFAULT_RENEWAL_GRACE_DAYS = Object.freeze(5);

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
  return subscriptionPriceWithPromo(settings, role, plan).price;
}

/**
 * Resolves the membership price for a role/plan, applying an active admin-configured
 * promotional discount when one exists. Returns the base price, the final price and
 * the applied promo descriptor (null when no promo applies).
 */
export function subscriptionPriceWithPromo(settings, role, plan) {
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
  const base = Number(group[plan] ?? group.monthly) || 0;
  const promos =
    role === "worker"
      ? settings?.workerPlanPromos
      : settings?.customerPlanPromos;
  const promo = promos?.[plan];
  if (!promo || !promo.active) {
    return { base, price: base, promo: null };
  }
  const value = Number(promo.value) || 0;
  let price = base;
  if (promo.type === "percentage") {
    price = Math.round((base * (100 - Math.min(100, value))) / 100);
  } else if (promo.type === "flat") {
    price = Math.max(0, Math.round(value));
  }
  price = Math.max(0, price);
  return {
    base,
    price,
    promo: {
      type: promo.type,
      value,
      saved: Math.max(0, base - price),
    },
  };
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
  "Accidental Damage Assistance – Up to ₹500",
  "Active Priority Worker Matching",
  "No 10% Urgent-Job Extra Charge",
  "Exclusive EasyHome Pro Badge",
  "Extended 15-Day Service Work Warranty",
  "Monthly Pro Promo Codes (Up to 20% Off)",
  "Priority Re-Assignment & VIP Dispatch",
]);

export const DEFAULT_WORKER_BENEFITS = Object.freeze([
  "Zero Dues Penalty & Uninterrupted Work Guarantee",
  "Lower Commission Rate (Only 7%)",
  "Local Search Visibility Boost",
  "Priority Urgent Job Alerts",
  "Pro Trust Badge, Digital QR Code & Shareable Profile",
  "Multi-Service Category Unlock (Extra Earning)",
  "Top priority featured profile card visibility on customer home feed",
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
  "Accidental damage assistance up to â‚¹500": "Accidental Damage Assistance – Up to ₹500",
  "Accidental Damage Assistance â€“ Up to â‚¹500": "Accidental Damage Assistance – Up to ₹500",
  "Accidental damage assistance up to ₹500": "Accidental Damage Assistance – Up to ₹500",
  "Active priority worker matching": "Active Priority Worker Matching",
  "No 10% urgent-job extra charge": "No 10% Urgent-Job Extra Charge",
  "Exclusive EasyHome Pro badge": "Exclusive EasyHome Pro Badge",
  "Extended 15-day service work warranty": "Extended 15-Day Service Work Warranty",
  "Monthly Pro promo codes (up to 20% off)": "Monthly Pro Promo Codes (Up to 20% Off)",
  "Priority re-assignment & VIP dispatch": "Priority Re-Assignment & VIP Dispatch",
  "Priority matching": "Active Priority Worker Matching",
  "Priority worker matching": "Active Priority Worker Matching",
  "Discounted service visits": "No 10% Urgent-Job Extra Charge",
  "Member pricing": "No 10% Urgent-Job Extra Charge",
  "No 10% extra charge on urgent jobs": "No 10% Urgent-Job Extra Charge",
  "No 10% urgent-job fee": "No 10% Urgent-Job Extra Charge",
  "No urgent-job fee": "No 10% Urgent-Job Extra Charge",
  "24x7 priority support": "Priority customer support",
  "24×7 priority support": "Priority customer support",
  "Top placement in search": "Local Search Visibility Boost",
  "Free urgent-job priority": "Priority Urgent Job Alerts",
  "Verified Pro badge": "Exclusive EasyHome Pro Badge",
  "EasyHome Pro badge": "Exclusive EasyHome Pro Badge",
  "Accidental Damage Assistance – Up to ₹500": "Accidental Damage Assistance – Up to ₹500",
  "Replacement professional assistance": "Priority Re-Assignment & VIP Dispatch",
  "Exclusive 3% continuous renewal reward": "Exclusive 3% continuous renewal reward",
};

export function normaliseCustomerBenefits(benefits) {
  if (!Array.isArray(benefits) || benefits.length === 0) {
    return [...DEFAULT_CUSTOMER_BENEFITS];
  }
  // Live settings created before the benefit refresh still contain the old
  // marketing copy. Replace known entries, keep custom admin additions, drop
  // retired cancellation copy and make sure the active Pro badge remains visible.
  const result = benefits
    .map((benefit) => BENEFIT_REPLACEMENTS[benefit] || benefit)
    .filter((benefit) => !/free cancellation/i.test(benefit))
    .filter((benefit) => String(benefit || "").trim().length > 0);
  const deduped = [...new Set(result)];
  if (!deduped.some((benefit) => /exclusive easyhome pro badge|verified pro badge/i.test(benefit))) {
    deduped.push("Exclusive EasyHome Pro Badge");
  }
  return deduped;
}

const LEGACY_WORKER_BENEFIT_COPY = {
  "Zero dues penalty & uninterrupted work guarantee": "Zero Dues Penalty & Uninterrupted Work Guarantee",
  "Lower commission rate (7%)": "Lower Commission Rate (Only 7%)",
  "Local search visibility boost": "Local Search Visibility Boost",
  "Priority urgent job alerts": "Priority Urgent Job Alerts",
  "Pro trust badge, digital QR code & shareable profile": "Pro Trust Badge, Digital QR Code & Shareable Profile",
  "Multi-service category unlock": "Multi-Service Category Unlock (Extra Earning)",
  "0% commission on every job": "Lower Commission Rate (Only 7%)",
  "Zero commission on every job": "Lower Commission Rate (Only 7%)",
  "No commission on every job": "Lower Commission Rate (Only 7%)",
  "Top placement in search": "Local Search Visibility Boost",
  "Free urgent-job priority": "Priority Urgent Job Alerts",
  "Verified Pro badge": "Pro Trust Badge, Digital QR Code & Shareable Profile",
  "EasyHome Pro badge": "Pro Trust Badge, Digital QR Code & Shareable Profile",
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
    accidentalDamageAssistLimit: DEFAULT_ACCIDENTAL_DAMAGE_LIMIT,
    renewalRewardPct: DEFAULT_RENEWAL_REWARD_PCT,
    renewalGraceDays: DEFAULT_RENEWAL_GRACE_DAYS,
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

/** EasyHome Pro — accidental damage assistance limit (default ₹500). */
export function accidentalDamageAssistLimit(settings = {}) {
  const value = Number(settings?.accidentalDamageAssistLimit);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_ACCIDENTAL_DAMAGE_LIMIT;
  return Math.round(value);
}

/** EasyHome Pro — exclusive continuous renewal reward (default 3% off). */
export function renewalRewardPct(settings = {}) {
  const value = Number(settings?.renewalRewardPct);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_RENEWAL_REWARD_PCT;
  return value;
}

/** EasyHome Pro — continuous renewal grace period in days (default 5). */
export function renewalGraceDays(settings = {}) {
  const value = Number(settings?.renewalGraceDays);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_RENEWAL_GRACE_DAYS;
  return Math.round(value);
}

/**
 * EasyHome Pro — exclusive 3% continuous renewal reward.
 * A customer becomes eligible once they have completed a successful renewal;
 * the grace period preserves renewal eligibility (it does not extend benefits).
 */
export function renewalRewardDue({ renewalStreak, graceUntil, now = Date.now() } = {}) {
  const streak = Number(renewalStreak) || 0;
  const graceDeadline = graceUntil ? new Date(graceUntil).getTime() : 0;
  const withinGrace = graceDeadline > 0 ? now <= graceDeadline : true;
  return { eligible: streak >= 1 && withinGrace, streak, withinGrace };
}

export function workerDues(worker) {
  return Math.max(
    0,
    Number(worker?.dues ?? worker?.dueCommissionAmount) || 0,
  );
}

export function commissionFor(price, commissionPct, { premium = false } = {}) {
  const amount = Math.round(Number(price) || 0);
  const pct = premium
    ? Math.min(
        Number(commissionPct) || DEFAULT_WORKER_PRO_COMMISSION_PCT,
        DEFAULT_WORKER_PRO_COMMISSION_PCT,
      )
    : Number(commissionPct) || 0;
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
  if (worker.activeJobBookingId) {
    return {
      allowed: false,
      reason: "active_job",
      activeBookingId: worker.activeJobBookingId,
    };
  }
  const dues = workerDues(worker);
  if (!premium && dues > 0) {
    return { allowed: false, reason: "dues", dues };
  }
  return { allowed: true, premium, dues };
}

/**
 * EasyHome Pro — replacement professional assistance. Finds the next
 * eligible professional in the customer's service area for a booking, used
 * when the assigned professional cancels or becomes unavailable.
 */
export async function findReplacementWorker({ booking, excludeWorkerId } = {}) {
  const workersSnap = await collections.workers
    .where("status", "==", "approved")
    .limit(500)
    .get();
  const candidates = [];
  for (const doc of workersSnap.docs) {
    const worker = { id: doc.id, ...doc.data() };
    if (excludeWorkerId && worker.id === excludeWorkerId) continue;
    if (worker.activeJobBookingId) continue;
    const premium = premiumActive(worker);
    const gate = canAcceptJobs(worker, { premium });
    if (!gate.allowed) continue;
    const zoneSnap = booking?.serviceZoneId
      ? await collections.serviceZones.doc(booking.serviceZoneId).get()
      : null;
    const zone = zoneSnap?.exists
      ? { id: zoneSnap.id, ...zoneSnap.data(), isActive: zoneSnap.data().isActive !== false }
      : null;
    if (!workerMatchesBooking(worker, {
      serviceKey: booking?.serviceKey,
      cityName: booking?.cityName || "",
      stateName: booking?.stateName || "",
      areaName: booking?.areaName || "",
      location: booking?.location,
    }, zone)) continue;
    candidates.push(worker);
  }
  const sorted = prioritizeWorkers(candidates, (worker) => premiumActive(worker));
  return sorted[0]?.id || null;
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
