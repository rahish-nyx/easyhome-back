import { Router } from "express";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { collections, db } from "../config/firebase.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import { requireAdmin } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { uploadCloudinaryImage } from "../lib/media.js";
import { notify } from "../lib/notify.js";
import {
  citySchema,
  footerLinkSchema,
  promoSchema,
  servicePricingBulkSchema,
  serviceSchema,
  settingsSchema,
} from "../lib/validate.js";
import { invalidateSettings } from "../lib/booking.js";
import { docToJson, docsToJson } from "../lib/utils.js";

export const adminCatalogRouter = Router();
adminCatalogRouter.use(requireAdmin);

function pickProvided(schema, body) {
  const provided = new Set(Object.keys(body || {}));
  const parsed = schema.partial().parse(body || {});
  for (const key of Object.keys(parsed)) {
    if (!provided.has(key)) delete parsed[key];
  }
  return parsed;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

/* ------------------------------- SERVICES ------------------------------- */

adminCatalogRouter.get(
  "/services",
  asyncHandler(async (_req, res) => {
    const snap = await collections.services.orderBy("order", "asc").get();
    res.json({ services: docsToJson(snap) });
  }),
);

adminCatalogRouter.post(
  "/services",
  asyncHandler(async (req, res) => {
    const body = serviceSchema.parse(req.body || {});
    const exists = await collections.services.where("key", "==", body.key).limit(1).get();
    if (!exists.empty) {
      throw new ApiError(409, "A service with this key already exists.", "DUPLICATE_SERVICE");
    }
    const ref = collections.services.doc();
    await ref.set({
      ...body,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.status(201).json({ service: docToJson(await ref.get()) });
  }),
);

adminCatalogRouter.patch(
  "/services/pricing",
  asyncHandler(async (req, res) => {
    const { updates } = servicePricingBulkSchema.parse(req.body || {});
    const snap = await collections.services.get();
    const existing = new Set(snap.docs.map((doc) => doc.id));
    const missing = updates.filter((item) => !existing.has(item.id));
    if (missing.length) {
      throw new ApiError(
        404,
        "One or more services no longer exist. Refresh and try again.",
        "SERVICE_NOT_FOUND",
      );
    }
    const batch = db.batch();
    updates.forEach((item) => {
      batch.set(
        collections.services.doc(item.id),
        {
          fromPrice: item.fromPrice,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
    await batch.commit();
    res.json({ ok: true, updated: updates.length });
  }),
);

adminCatalogRouter.patch(
  "/services/:id",
  asyncHandler(async (req, res) => {
    const updates = pickProvided(serviceSchema, req.body);
    if (!Object.keys(updates).length) {
      throw new ApiError(422, "Nothing to update.", "NO_CHANGES");
    }
    await collections.services.doc(req.params.id).set(
      { ...updates, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    res.json({ ok: true });
  }),
);

adminCatalogRouter.delete(
  "/services/:id",
  asyncHandler(async (req, res) => {
    await collections.services.doc(req.params.id).set(
      { active: false, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    res.json({ ok: true });
  }),
);

/* -------------------------------- CITIES -------------------------------- */

adminCatalogRouter.get(
  "/cities",
  asyncHandler(async (_req, res) => {
    const snap = await collections.cities.orderBy("name", "asc").get();
    res.json({ cities: docsToJson(snap) });
  }),
);

adminCatalogRouter.post(
  "/cities",
  asyncHandler(async (req, res) => {
    const body = citySchema.parse(req.body || {});
    const exists = await collections.cities
      .where("name", "==", body.name)
      .limit(1)
      .get();
    if (!exists.empty) {
      throw new ApiError(409, "This city already exists.", "DUPLICATE_CITY");
    }
    const ref = collections.cities.doc();
    await ref.set({
      ...body,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.status(201).json({ city: docToJson(await ref.get()) });
  }),
);

adminCatalogRouter.patch(
  "/cities/:id",
  asyncHandler(async (req, res) => {
    const updates = pickProvided(citySchema, req.body);
    if (!Object.keys(updates).length) {
      throw new ApiError(422, "Nothing to update.", "NO_CHANGES");
    }
    await collections.cities.doc(req.params.id).set(
      { ...updates, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    res.json({ ok: true });
  }),
);

adminCatalogRouter.delete(
  "/cities/:id",
  asyncHandler(async (req, res) => {
    await collections.cities.doc(req.params.id).delete();
    res.json({ ok: true });
  }),
);

/* -------------------------------- PROMOS -------------------------------- */

adminCatalogRouter.get(
  "/promos",
  asyncHandler(async (_req, res) => {
    const snap = await collections.promos.orderBy("order", "asc").get();
    res.json({ promos: docsToJson(snap) });
  }),
);

adminCatalogRouter.post(
  "/promos",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    const body = promoSchema.parse(req.body || {});
    let imagePath = body.imagePath || "";
    if (req.file) {
      imagePath = (
        await uploadCloudinaryImage(req.file.buffer, { folder: "promos" })
      ).url;
    }
    const ref = collections.promos.doc();
    await ref.set({
      ...body,
      imagePath,
      startsAt: parseDate(body.startsAt),
      endsAt: parseDate(body.endsAt),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.status(201).json({ promo: docToJson(await ref.get()) });
  }),
);

adminCatalogRouter.patch(
  "/promos/:id",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    const updates = pickProvided(promoSchema, req.body);
    if (req.file) {
      updates.imagePath = (
        await uploadCloudinaryImage(req.file.buffer, { folder: "promos" })
      ).url;
    }
    if (updates.startsAt !== undefined) updates.startsAt = parseDate(updates.startsAt);
    if (updates.endsAt !== undefined) updates.endsAt = parseDate(updates.endsAt);
    if (!Object.keys(updates).length) {
      throw new ApiError(422, "Nothing to update.", "NO_CHANGES");
    }
    await collections.promos.doc(req.params.id).set(
      { ...updates, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    res.json({ ok: true });
  }),
);

adminCatalogRouter.delete(
  "/promos/:id",
  asyncHandler(async (req, res) => {
    await collections.promos.doc(req.params.id).delete();
    res.json({ ok: true });
  }),
);

/* ----------------------------- FOOTER LINKS ------------------------------ */

adminCatalogRouter.get(
  "/footer-links",
  asyncHandler(async (_req, res) => {
    const snap = await collections.footerLinks.get();
    const links = docsToJson(snap).sort(
      (a, b) => (Number(a.order) || 0) - (Number(b.order) || 0),
    );
    res.json({ links });
  }),
);

adminCatalogRouter.post(
  "/footer-links",
  asyncHandler(async (req, res) => {
    const body = footerLinkSchema.parse(req.body || {});
    const ref = collections.footerLinks.doc();
    await ref.set({
      ...body,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.status(201).json({ link: docToJson(await ref.get()) });
  }),
);

adminCatalogRouter.patch(
  "/footer-links/:id",
  asyncHandler(async (req, res) => {
    const updates = pickProvided(footerLinkSchema, req.body);
    if (!Object.keys(updates).length) {
      throw new ApiError(422, "Nothing to update.", "NO_CHANGES");
    }
    const ref = collections.footerLinks.doc(req.params.id);
    if (!(await ref.get()).exists) {
      throw new ApiError(404, "Footer link not found.", "FOOTER_LINK_NOT_FOUND");
    }
    await ref.set({ ...updates, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    res.json({ link: docToJson(await ref.get()) });
  }),
);

adminCatalogRouter.delete(
  "/footer-links/:id",
  asyncHandler(async (req, res) => {
    const ref = collections.footerLinks.doc(req.params.id);
    if (!(await ref.get()).exists) {
      throw new ApiError(404, "Footer link not found.", "FOOTER_LINK_NOT_FOUND");
    }
    await ref.delete();
    res.json({ ok: true });
  }),
);

/* ------------------------------- SETTINGS ------------------------------- */

adminCatalogRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    const snap = await collections.settings.doc("app").get();
    res.json({ settings: docToJson(snap) || {} });
  }),
);

adminCatalogRouter.patch(
  "/settings",
  upload.single("qr"),
  asyncHandler(async (req, res) => {
    const body = settingsSchema.parse(req.body || {});
    const updates = { ...body, updatedAt: FieldValue.serverTimestamp() };
    // Keep the legacy scalar fields in sync for older clients and reports.
    if (body.customerPlans?.monthly !== undefined) {
      updates.subscriptionPrice = body.customerPlans.monthly;
    }
    if (body.workerRules?.feesPct !== undefined) {
      updates.commissionPct = body.workerRules.feesPct;
    }
    if (req.file) {
      updates.qrImagePath = (
        await uploadCloudinaryImage(req.file.buffer, { folder: "settings" })
      ).url;
    }
    await collections.settings.doc("app").set(updates, { merge: true });
    invalidateSettings();
    const snap = await collections.settings.doc("app").get();
    res.json({ settings: docToJson(snap) });
  }),
);

adminCatalogRouter.post(
  "/settings/announcement",
  asyncHandler(async (req, res) => {
    const title = String(req.body?.title || "").trim();
    const body = String(req.body?.body || "").trim();
    if (!title) throw new ApiError(422, "Announcement title is required.", "TITLE_REQUIRED");

    await collections.settings.doc("app").set(
      {
        announcement: {
          title,
          body,
          active: req.body?.active !== false,
          updatedAt: new Date().toISOString(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    invalidateSettings();

    if (req.body?.push === true) {
      const users = await collections.users.limit(500).get();
      const batch = users.docs.length;
      let sent = 0;
      for (const user of users.docs) {
        await notify(user.id, {
          title,
          body,
          type: "announcement",
          link: "/",
        });
        sent += 1;
      }
      return res.json({ ok: true, notified: sent, batch });
    }

    res.json({ ok: true });
  }),
);
