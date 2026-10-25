import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { auth, collections } from "../config/firebase.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import {
  isAdmin,
  requireAuth,
  requireApprovedWorker,
} from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import { sessionSchema, profileSchema, workerProfileSchema } from "../lib/validate.js";
import { uploadCloudinaryImage } from "../lib/media.js";
import { notify, notifyAdmins } from "../lib/notify.js";
import { docToJson, normalizePhone } from "../lib/utils.js";
import { WORKER_STATUS } from "../lib/booking.js";

export const authRouter = Router();

function coordinate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function defaultName(email = "") {
  return email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function loadProfile(uid) {
  const [userSnap, workerSnap, adminSnap] = await Promise.all([
    collections.users.doc(uid).get(),
    collections.workers.doc(uid).get(),
    collections.admins.doc(uid).get(),
  ]);
  return {
    profile: docToJson(userSnap),
    worker: docToJson(workerSnap),
    isAdmin: adminSnap.exists,
  };
}

function claimsFor({ role, admin, workerApproved }) {
  return {
    role: role || "customer",
    admin: admin === true,
    workerApproved: workerApproved === true,
  };
}

/**
 * Called by the client right after sign-in/sign-up.
 * Idempotent: creates the Firestore profile on first call only.
 */
authRouter.post(
  "/session",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = sessionSchema.parse(req.body || {});
    const { uid, email } = req.user;
    const userRef = collections.users.doc(uid);
    const userSnap = await userRef.get();

    const adminNow = await isAdmin(req.user);

    if (userSnap.exists) {
      const data = userSnap.data();
      const updates = {
        lastLoginAt: FieldValue.serverTimestamp(),
        emailVerified: req.user.emailVerified,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!data.photoPath && req.user.picture) updates.photoPath = req.user.picture;
      await userRef.set(updates, { merge: true });

      const claims = claimsFor({
        role: data.role,
        admin: adminNow,
        workerApproved: req.user.workerApproved,
      });
      if (
        req.user.role !== claims.role ||
        req.user.admin !== claims.admin ||
        req.user.workerApproved !== claims.workerApproved
      ) {
        await auth.setCustomUserClaims(uid, claims);
      }

      const payload = await loadProfile(uid);
      return res.json({ ...payload, created: false });
    }

    const role = body.role === "worker" ? "worker" : "customer";
    const name = body.name || req.user.name || defaultName(email);
    const phone = body.phone ? normalizePhone(body.phone) : "";

    if (role === "worker") {
      if (!body.service || !body.area) {
        throw new ApiError(
          422,
          "Tell us your trade and service area to apply as a worker.",
          "WORKER_DETAILS_REQUIRED",
        );
      }
    }

    const subscription = { status: "none", plan: null, startAt: null, endAt: null };
    const userDoc = {
      uid,
      name,
      email,
      phone,
      role,
      photoPath: req.user.picture || "",
      city: body.city || "",
      addresses: [],
      emailVerified: req.user.emailVerified,
      disabled: false,
      subscription,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastLoginAt: FieldValue.serverTimestamp(),
    };

    await userRef.set(userDoc);

    if (role === "worker") {
      const workerDoc = {
        uid,
        name,
        email,
        phone,
        photoPath: req.user.picture || "",
        service: body.service,
        serviceKey: body.serviceKey || body.service,
        pricePerWork: Math.max(0, Number(body.pricePerWork) || 199),
        area: body.area,
        city: body.city || "",
        state: body.state || "",
        areaName: body.areaName || "",
        lat: coordinate(body.lat),
        lng: coordinate(body.lng),
        online: false,
        status: WORKER_STATUS.PENDING,
        rating: 0,
        reviewCount: 0,
        jobsCompleted: 0,
        premiumUntil: null,
        upiId: "",
        bio: "",
        kycStatus: "not_submitted",
        dues: 0,
        radiusKm: 25,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      await collections.workers.doc(uid).set(workerDoc);
      await notifyAdmins({
        title: "New worker application",
        body: `${name} applied as ${body.service} in ${body.area}.`,
        type: "worker_application",
        link: "/admin/approvals",
      });
    }

    await auth.setCustomUserClaims(uid, claimsFor({ role, admin: adminNow }));

    const payload = await loadProfile(uid);
    return res.json({
      ...payload,
      isAdmin: adminNow,
      created: true,
      needsClaimRefresh: true,
    });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const payload = await loadProfile(req.user.uid);
    if (!payload.profile) {
      throw new ApiError(404, "Profile not found. Please sign in again.", "PROFILE_MISSING");
    }
    res.json({ ...payload, claims: req.user });
  }),
);

authRouter.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = profileSchema.parse(req.body || {});
    const { uid } = req.user;
    const userRef = collections.users.doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new ApiError(404, "Profile not found.", "PROFILE_MISSING");
    }

    const updates = { updatedAt: FieldValue.serverTimestamp() };
    if (body.name) updates.name = body.name;
    if (body.phone) updates.phone = body.phone;
    if (body.city !== undefined) updates.city = body.city;
    if (body.addresses) {
      updates.addresses = body.addresses.map((address) => ({
        ...address,
        id: address.id || `addr_${Math.random().toString(36).slice(2, 10)}`,
      }));
    }

    await userRef.set(updates, { merge: true });

    if (body.name || body.phone) {
      const workerRef = collections.workers.doc(uid);
      const workerSnap = await workerRef.get();
      if (workerSnap.exists) {
        await workerRef.set(
          {
            ...(body.name ? { name: body.name } : {}),
            ...(body.phone ? { phone: body.phone } : {}),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        await collections.workersPublic.doc(uid).set(
          {
            ...(body.name ? { name: body.name } : {}),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    }

    const payload = await loadProfile(uid);
    res.json(payload);
  }),
);

authRouter.post(
  "/avatar",
  requireAuth,
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, "Choose an image to upload.", "FILE_REQUIRED");
    const cloudinaryUpload = await uploadCloudinaryImage(req.file.buffer, {
      folder: "avatars",
    });
    const objectPath = cloudinaryUpload.url;

    await collections.users.doc(req.user.uid).set(
      {
        photoPath: objectPath,
        photoCloudinaryId: cloudinaryUpload.publicId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const workerRef = collections.workers.doc(req.user.uid);
    const workerSnap = await workerRef.get();
    if (workerSnap.exists) {
      await workerRef.set(
        {
          photoPath: objectPath,
          photoCloudinaryId: cloudinaryUpload.publicId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      await collections.workersPublic.doc(req.user.uid).set(
        {
          photoPath: objectPath,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    res.json({ photoPath: objectPath, cloudinaryStored: true });
  }),
);

/**
 * Worker application / re-application (e.g. after a rejection).
 */
authRouter.post(
  "/worker/apply",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = workerProfileSchema.parse(req.body || {});
    if (!body.service || !body.area) {
      throw new ApiError(422, "Service and area are required.", "WORKER_DETAILS_REQUIRED");
    }
    const uid = req.user.uid;
    const userRef = collections.users.doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new ApiError(404, "Profile not found.", "PROFILE_MISSING");
    }

    const workerRef = collections.workers.doc(uid);
    const workerSnap = await workerRef.get();
    const existing = workerSnap.exists ? workerSnap.data() : null;

    if (existing && existing.status === WORKER_STATUS.APPROVED) {
      throw new ApiError(409, "Your worker account is already approved.", "ALREADY_APPROVED");
    }

    await userRef.set(
      { role: "worker", ...(body.name ? { name: body.name } : {}) },
      { merge: true },
    );

    await workerRef.set(
      {
        uid,
        name: body.name || userSnap.data().name,
        email: req.user.email,
        phone: body.phone || userSnap.data().phone || "",
        service: body.service,
        serviceKey: body.serviceKey || body.service,
        pricePerWork: Math.max(0, Number(body.pricePerWork) || 199),
        area: body.area,
        city: body.city || "",
        state: body.state || "",
        areaName: body.areaName || "",
        lat: coordinate(body.lat),
        lng: coordinate(body.lng),
        status: WORKER_STATUS.PENDING,
        online: false,
        kycStatus: existing?.kycStatus || "not_submitted",
        dues: existing?.dues || 0,
        rating: existing?.rating || 0,
        reviewCount: existing?.reviewCount || 0,
        jobsCompleted: existing?.jobsCompleted || 0,
        premiumUntil: existing?.premiumUntil || null,
        createdAt: existing?.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await auth.setCustomUserClaims(uid, {
      role: "worker",
      admin: req.user.admin === true,
      workerApproved: false,
    });

    await notifyAdmins({
      title: "Worker application",
      body: `${body.name || userSnap.data().name} applied as ${body.service}.`,
      type: "worker_application",
      link: "/admin/approvals",
    });

    res.json({ status: WORKER_STATUS.PENDING });
  }),
);

/**
 * Dev helper: lets an approved worker fetch their secure KYC document link base.
 * (The admin-only stream endpoint lives in the admin router.)
 */
authRouter.get(
  "/worker/status",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const snap = await collections.workers.doc(req.user.uid).get();
    res.json({ approved: true, worker: docToJson(snap) });
  }),
);
