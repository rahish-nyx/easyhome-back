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

export async function appSettings({ fresh = false } = {}) {
  if (!fresh && cachedSettings && Date.now() - cachedAt < 30_000) {
    return cachedSettings;
  }
  const snap = await collections.settings.doc("app").get();
  cachedSettings = {
    commissionPct: env.commissionPct,
    subscriptionPrice: env.subscriptionPrice,
    customerBenefits: [
      "Priority worker matching",
      "Discounted service visits",
      "24×7 priority support",
      "Free cancellation up to 1 hour",
    ],
    workerBenefits: [
      "0% commission on every job",
      "Top placement in search",
      "Free urgent-job priority",
      "Verified Pro badge",
    ],
    upiId: "rahishcnrb@ybl",
    qrImagePath: "",
    qrImageUrl: "",
    supportPhone: "",
    maintenanceMode: false,
    ...(snap.exists ? snap.data() : {}),
  };
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
