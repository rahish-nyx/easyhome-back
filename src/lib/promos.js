import { collections } from "../config/store.js";
import { docsToJson } from "./utils.js";

export function normalizePromoCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

export function isPromoLive(promo, now = Date.now()) {
  if (!promo || promo.active === false) return false;
  const starts = promo.startsAt ? new Date(promo.startsAt).getTime() : 0;
  const ends = promo.endsAt ? new Date(promo.endsAt).getTime() : 0;
  if (Number.isFinite(starts) && starts > now) return false;
  if (Number.isFinite(ends) && ends > 0 && ends < now) return false;
  return true;
}

export function hasCustomerDiscount(promo) {
  if (!promo || promo.placement === "worker_dashboard") return false;
  const type = String(promo.discountType || "");
  const value = Number(promo.discountValue) || 0;
  return (
    Boolean(normalizePromoCode(promo.couponCode)) &&
    (type === "percentage" || type === "flat") &&
    value > 0
  );
}

export function promoAppliesToService(promo, service) {
  if (!promo) return false;
  if (!service) return true;

  const targetService = String(promo.targetServiceId || "").trim();
  if (targetService) {
    const aliases = [service.id, service.key]
      .map((value) => String(value || ""))
      .filter(Boolean);
    if (!aliases.includes(targetService)) return false;
  }

  const targetFolder = String(promo.targetFolderId || "").trim();
  if (targetFolder) {
    const aliases = [service.folderId, service.folder]
      .map((value) => String(value || ""))
      .filter(Boolean);
    if (!aliases.includes(targetFolder)) return false;
  }

  return true;
}

export function calculatePromoDiscount(promo, basePrice) {
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  if (!promo || !base) return 0;
  const type = String(promo.discountType || "");
  const value = Math.max(0, Number(promo.discountValue) || 0);
  if (type === "percentage") {
    return Math.min(base, Math.round((base * Math.min(value, 100)) / 100));
  }
  if (type === "flat") {
    return Math.min(base, Math.round(value));
  }
  return 0;
}

export function promoPaymentTotal({ finalPrice, urgentFee, promoDiscount }) {
  const baseTotal =
    Math.max(0, Math.round(Number(finalPrice) || 0)) +
    Math.max(0, Math.round(Number(urgentFee) || 0));
  const appliedDiscount = Math.min(
    baseTotal,
    Math.max(0, Math.round(Number(promoDiscount) || 0)),
  );
  return {
    baseTotal,
    promoDiscount: appliedDiscount,
    paymentTotal: Math.max(0, baseTotal - appliedDiscount),
  };
}

export async function findActivePromoByCode(code, service) {
  const normalized = normalizePromoCode(code);
  if (!normalized) return null;

  const snap = await collections.promos
    .where("couponCode", "==", normalized)
    .get();
  return (
    docsToJson(snap)
      .filter(
        (promo) =>
          isPromoLive(promo) &&
          hasCustomerDiscount(promo) &&
          promoAppliesToService(promo, service),
      )
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))[0] || null
  );
}
