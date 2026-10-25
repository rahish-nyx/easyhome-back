import { z } from "zod";
import { normalizePhone } from "./utils.js";

const phone = z
  .string()
  .trim()
  .transform((value) => normalizePhone(value))
  .refine((value) => /^[6-9]\d{9}$/.test(value), {
    message: "Enter a valid 10-digit Indian mobile number",
  });

const coord = z.coerce.number().finite();

const utr = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, "").toUpperCase())
  .refine((value) => /^[A-Z0-9][A-Z0-9._-]{5,63}$/.test(value), {
    message: "Enter a valid UTR / transaction reference (6–64 characters)",
  });

/**
 * Multipart form fields arrive as strings. These helpers keep the same schemas
 * usable for both JSON requests and FormData (promo/settings image uploads).
 */
const formBoolean = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "on", "yes"].includes(normalized)) return true;
    if (["false", "0", "off", "no", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const formStringArray = z.preprocess((value) => {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return text;
      }
    }
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return value;
}, z.array(z.string().trim().max(120)).max(8));

export const sessionSchema = z.object({
  role: z.enum(["customer", "worker"]).optional(),
  name: z.string().trim().min(2).max(80).optional(),
  phone: phone.optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  areaName: z.string().trim().max(80).optional(),
  service: z.string().trim().max(60).optional(),
  serviceKey: z.string().trim().max(40).optional(),
  area: z.string().trim().max(120).optional(),
  pricePerWork: z.coerce.number().int().min(0).max(100000).optional(),
  lat: coord.nullable().optional(),
  lng: coord.nullable().optional(),
});

export const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: phone.optional(),
  city: z.string().trim().max(80).optional(),
  addresses: z
    .array(
      z.object({
        id: z.string().max(40).optional(),
        label: z.string().trim().max(30).default("Home"),
        line: z.string().trim().min(3).max(200),
        area: z.string().trim().max(80).optional().default(""),
        pincode: z
          .string()
          .trim()
          .regex(/^\d{6}$/, "Enter a valid 6-digit pincode")
          .optional()
          .or(z.literal("")),
        lat: coord.nullable().optional(),
        lng: coord.nullable().optional(),
      }),
    )
    .max(5)
    .optional(),
});

export const workerProfileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: phone.optional(),
  service: z.string().trim().max(60).optional(),
  serviceKey: z.string().trim().max(40).optional(),
  area: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  areaName: z.string().trim().max(80).optional(),
  bio: z.string().trim().max(400).optional(),
  pricePerWork: z.coerce.number().int().min(0).max(100000).optional(),
  upiId: z.string().trim().max(80).optional(),
  lat: coord.nullable().optional(),
  lng: coord.nullable().optional(),
  online: z.boolean().optional(),
});

export const availabilitySchema = z.object({
  online: z.boolean(),
});

export const bookingSchema = z.object({
  service: z.string().trim().min(2).max(60),
  serviceKey: z.string().trim().min(2).max(40).optional(),
  description: z.string().trim().min(10).max(600),
  area: z.string().trim().min(2).max(160),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  areaName: z.string().trim().max(80).optional(),
  lat: coord.min(-90).max(90).nullable().optional(),
  lng: coord.min(-180).max(180).nullable().optional(),
  phone: phone,
  budget: z.coerce.number().int().min(99).max(100000),
  urgency: z.enum(["normal", "urgent"]).default("normal"),
  preferredWorkerId: z.string().max(80).optional().or(z.literal("")),
  addressLabel: z.string().trim().max(40).optional(),
});

export const offerSchema = z.object({
  price: z.coerce.number().int().min(99).max(100000),
});

export const priceSchema = z.object({
  price: z.coerce.number().int().min(99).max(100000),
});

export const cancelSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export const reviewSchema = z.object({
  stars: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional().default(""),
});

export const paymentSchema = z.object({
  mode: z.enum(["cash", "upi", "online", "card"]),
  reference: z.string().trim().max(120).optional(),
});

export const subscriptionRequestSchema = z.object({
  plan: z.enum(["monthly", "quarterly", "yearly"]).default("monthly"),
  utrId: utr.optional(),
  note: z.string().trim().max(200).optional(),
});

export const commissionPaidSchema = z.object({
  utrId: utr.optional(),
  note: z.string().trim().max(200).optional(),
});

export const chatSchema = z.object({
  text: z.string().trim().min(1).max(1000),
});

export const adminUserUpdateSchema = z.object({
  disabled: z.boolean().optional(),
  role: z.enum(["customer", "worker"]).optional(),
});

export const adminWorkerReviewSchema = z.object({
  action: z.enum(["approve", "reject", "suspend", "reinstate"]),
  reason: z.string().trim().max(300).optional(),
});

export const citySchema = z.object({
  name: z.string().trim().min(2).max(80),
  lat: coord,
  lng: coord,
  radiusKm: z.coerce.number().min(1).max(200).default(10),
  active: formBoolean.default(true),
});

export const serviceSchema = z.object({
  name: z.string().trim().min(2).max(60),
  key: z.string().trim().min(2).max(40),
  icon: z.string().trim().max(40).default("wrench"),
  description: z.string().trim().max(180).optional().default(""),
  fromPrice: z.coerce.number().int().min(0).max(100000).default(199),
  active: formBoolean.default(true),
  order: z.coerce.number().int().min(0).max(999).default(0),
});

export const promoSchema = z.object({
  title: z.string().trim().min(2).max(80),
  subtitle: z.string().trim().max(140).optional().default(""),
  ctaText: z.string().trim().max(30).optional().default("Book now"),
  ctaLink: z
    .string()
    .trim()
    .max(200)
    .optional()
    .default("/")
    .refine(
      (path) => !path || (path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")),
      "Promo destinations must be internal paths.",
    ),
  placement: z.enum(["customer_home", "worker_dashboard"]).default("customer_home"),
  theme: z.enum(["yellow", "dark", "blue", "orange"]).default("yellow"),
  imagePath: z.string().trim().max(300).optional().default(""),
  active: formBoolean.default(true),
  order: z.coerce.number().int().min(0).max(99).default(0),
  startsAt: z.string().datetime().optional().or(z.literal("")),
  endsAt: z.string().datetime().optional().or(z.literal("")),
});

export const footerLinkSchema = z.object({
  label: z.string().trim().min(2).max(50),
  href: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (path) => path.startsWith("/") && !path.startsWith("//") && !path.includes("\\"),
      "Footer links must use an internal path.",
    )
    .refine((href) => {
      const path = href.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
      return (
        ["/", "/services", "/search", "/book", "/bookings", "/profile", "/subscription", "/chat", "/faq", "/auth", "/worker", "/worker/support"].includes(path) ||
        /^\/services\/[a-zA-Z0-9_-]+$/.test(path) ||
        /^\/workers\/[a-zA-Z0-9_-]+$/.test(path) ||
        /^\/bookings\/[a-zA-Z0-9_-]+\/track$/.test(path) ||
        /^\/legal\/[a-zA-Z0-9_-]+$/.test(path)
      );
    }, "Choose a supported EasyHome page destination."),
  group: z.enum(["company", "legal", "support", "services", "professionals"]).default("legal"),
  active: formBoolean.default(true),
  order: z.coerce.number().int().min(0).max(999).default(0),
});

export const serviceZoneSchema = z.object({
  state: z.string().trim().min(2).max(80),
  cityName: z.string().trim().min(2).max(80),
  areaName: z.string().trim().max(80).optional().default(""),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(0.5).max(200).default(10),
  isActive: formBoolean.default(true),
});

export const waitlistSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone,
  email: z.string().trim().email().max(160).optional().or(z.literal("")),
  cityName: z.string().trim().max(80).optional().or(z.literal("")),
  state: z.string().trim().max(80).optional().or(z.literal("")),
  lat: coord.nullable().optional(),
  lng: coord.nullable().optional(),
  message: z.string().trim().max(300).optional().or(z.literal("")),
});

export const trackingLocationSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(100000).optional(),
  heading: z.coerce.number().min(0).max(360).optional().nullable(),
  speed: z.coerce.number().min(0).max(200).optional().nullable(),
});

export const trackingPhaseSchema = z.object({
  phase: z.enum(["assigned", "en_route", "arrived", "working", "completed"]),
  lat: z.coerce.number().min(-90).max(90).optional().nullable(),
  lng: z.coerce.number().min(-180).max(180).optional().nullable(),
  accuracy: z.coerce.number().min(0).max(100000).optional().nullable(),
  note: z.string().trim().max(240).optional().or(z.literal("")),
});

export const settingsSchema = z.object({
  commissionPct: z.coerce.number().min(0).max(40).optional(),
  subscriptionPrice: z.coerce.number().int().min(0).max(100000).optional(),
  customerBenefits: formStringArray.optional(),
  workerBenefits: formStringArray.optional(),
  upiId: z.string().trim().max(100).optional(),
  qrImageUrl: z.string().trim().max(500).optional(),
  supportPhone: z.string().trim().max(20).optional(),
  maintenanceMode: formBoolean.optional(),
});

export function parse(schema, data) {
  return schema.parse(data);
}
