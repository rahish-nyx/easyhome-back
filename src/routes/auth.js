import { Router } from "express";
import { collections } from "../config/firebase.js";
import { env } from "../config/env.js";
import { ApiError, asyncHandler } from "../middleware/errors.js";
import {
  isAdmin,
  requireAuth,
  requireApprovedWorker,
} from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";
import {
  emailSchema,
  forgotPasswordSchema,
  googleAuthSchema,
  loginSchema,
  profileSchema,
  registerSchema,
  resetPasswordSchema,
  sessionSchema,
  tokenSchema,
  workerProfileSchema,
} from "../lib/validate.js";
import { FieldValue } from "../lib/firestore.js";
import { uploadCloudinaryImage } from "../lib/media.js";
import { emailLayout, notifyAdmins, sendMail } from "../lib/notify.js";
import { applyReferralForNewUser } from "../lib/referrals.js";
import { docToJson, normalizePhone } from "../lib/utils.js";
import { WORKER_STATUS } from "../lib/booking.js";
import {
  claimsFrom,
  createToken,
  defaultNameFromEmail,
  hashPassword,
  hashToken,
  normalizeEmail,
  randomToken,
  tokenExpiry,
  verifyGoogleAccessToken,
  verifyGoogleIdToken,
  verifyPassword,
} from "../lib/auth.js";

export const authRouter = Router();

function coordinate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function defaultSubscription() {
  return { status: "none", plan: null, startAt: null, endAt: null };
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

async function sessionPayload(uid) {
  const payload = await loadProfile(uid);
  if (!payload.profile) {
    throw new ApiError(
      404,
      "Profile not found. Please sign in again.",
      "PROFILE_MISSING",
    );
  }

  const userSnap = await collections.users.doc(uid).get();
  const workerSnap = await collections.workers.doc(uid).get();
  const user = { ...(userSnap.data() || {}), _id: uid };
  const worker = workerSnap.exists
    ? { ...workerSnap.data(), _id: uid }
    : null;
  const claims = claimsFrom({ user, worker, isAdmin: payload.isAdmin });
  return {
    token: createToken(claims),
    claims,
    ...payload,
  };
}

async function issueVerification(uid, email, name) {
  const token = randomToken(32);
  const tokenHash = hashToken(token);
  await collections.users.doc(uid).set(
    {
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: tokenExpiry(60 * 24),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const url = `${env.publicWebUrl}/auth?verify=${encodeURIComponent(token)}`;
  const result = await sendMail({
    to: email,
    subject: "Verify your EasyHome email",
    html: emailLayout({
      heading: "Verify your EasyHome email",
      intro: "Please confirm your email to unlock bookings, payments, and full account access.",
      body: `<p style="font-size:13px;color:#777">This verification link expires in 24 hours.</p><p>After verifying, return to the app and tap <strong>"I have verified my email"</strong>.</p>`,
      ctaText: "Verify email",
      ctaUrl: url,
    }),
    text: `Verify your EasyHome email: ${url}`,
  });

  return {
    emailSent: result.ok === true,
    emailSkipped: result.skipped === true,
    verificationUrl: env.isProd ? undefined : url,
  };
}

async function issuePasswordReset(uid, email, name) {
  const token = randomToken(32);
  const tokenHash = hashToken(token);
  await collections.users.doc(uid).set(
    {
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: tokenExpiry(60),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  const url = `${env.publicWebUrl}/auth?reset=${encodeURIComponent(token)}`;
  const result = await sendMail({
    to: email,
    subject: "Reset your EasyHome password",
    html: emailLayout({
      heading: "Reset your password",
      intro: `Hi${name ? ` ${name.split(" ")[0]}` : ""}, use the button below to choose a new password. This link expires in one hour.`,
      ctaText: "Reset password",
      ctaUrl: url,
    }),
    text: `Reset your EasyHome password: ${url}`,
  });

  return {
    emailSent: result.ok === true,
    emailSkipped: result.skipped === true,
    resetUrl: env.isProd ? undefined : url,
  };
}

async function ensureUniqueEmail(email, exceptUid = "") {
  const snap = await collections.users
    .where("email", "==", email)
    .limit(2)
    .get();
  const conflict = snap.docs.find((doc) => doc.id !== exceptUid);
  if (conflict) {
    throw new ApiError(
      409,
      "An account with this email already exists. Sign in instead.",
      "EMAIL_IN_USE",
    );
  }
}

async function createUserRecord({
  uid,
  email,
  name,
  phone = "",
  role = "customer",
  city = "",
  passwordHash = "",
  googleId = "",
  emailVerified = false,
  photoPath = "",
}) {
  const userDoc = {
    uid,
    name: name || defaultNameFromEmail(email),
    email,
    phone: phone ? normalizePhone(phone) : "",
    role,
    photoPath,
    city,
    addresses: [],
    emailVerified: emailVerified === true,
    disabled: false,
    subscription: defaultSubscription(),
    referralCode: "",
    referredBy: "",
    authProvider: googleId ? "google" : "password",
    ...(passwordHash ? { passwordHash } : {}),
    ...(googleId ? { googleId } : {}),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastLoginAt: FieldValue.serverTimestamp(),
  };
  await collections.users.doc(uid).set(userDoc);
  return userDoc;
}

async function saveWorkerRecord(uid, body, user, existing = null) {
  if (!body.service || !body.area) {
    throw new ApiError(
      422,
      "Tell us your trade and service area to apply as a worker.",
      "WORKER_DETAILS_REQUIRED",
    );
  }

  const name = body.name || user.name || "EasyHome Pro";
  const phone = body.phone ? normalizePhone(body.phone) : user.phone || "";
  await collections.workers.doc(uid).set(
    {
      uid,
      name,
      email: user.email,
      phone,
      photoPath: user.photoPath || "",
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
      rating: existing?.rating || 0,
      reviewCount: existing?.reviewCount || 0,
      jobsCompleted: existing?.jobsCompleted || 0,
      premiumUntil: existing?.premiumUntil || null,
      upiId: existing?.upiId || "",
      bio: body.bio || existing?.bio || "",
      kycStatus: existing?.kycStatus || "not_submitted",
      dues: existing?.dues || 0,
      radiusKm: existing?.radiusKm || 25,
      createdAt: existing?.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await notifyAdmins({
    title: "New worker application",
    body: `${name} applied as ${body.service} in ${body.area}.`,
    type: "worker_application",
    link: "/admin/approvals",
  });
}

function friendlyGoogleName(payload) {
  return payload.name || defaultNameFromEmail(payload.email);
}

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body || {});
    const email = normalizeEmail(body.email);
    await ensureUniqueEmail(email);

    const uid = collections.users.doc().id;
    const passwordHash = await hashPassword(body.password);
    const role = body.role === "worker" ? "worker" : "customer";
    const name = body.name.trim();

    if (role === "worker" && (!body.service || !body.area)) {
      throw new ApiError(
        422,
        "Tell us your trade and service area to apply as a worker.",
        "WORKER_DETAILS_REQUIRED",
      );
    }

    const user = await createUserRecord({
      uid,
      email,
      name,
      phone: body.phone,
      role,
      city: body.city,
      passwordHash,
    });

    let referral = null;
    if (body.referralCode) {
      referral = await applyReferralForNewUser({
        code: body.referralCode,
        uid,
        name,
        email,
        role,
      }).catch((error) => {
        console.warn("Referral capture failed:", error.message);
        return null;
      });
    }

    if (role === "worker") {
      await saveWorkerRecord(uid, { ...body, name }, user);
    }

    const verification = await issueVerification(uid, email, name);
    const payload = await sessionPayload(uid);
    res.status(201).json({
      ...payload,
      created: true,
      needsClaimRefresh: false,
      referralApplied: Boolean(referral?.applied),
      verificationSent: verification.emailSent,
      verificationUrl: verification.verificationUrl,
    });
  }),
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body || {});
    const email = normalizeEmail(body.email);
    const snap = await collections.users
      .where("email", "==", email)
      .limit(1)
      .get();

    if (snap.empty) {
      throw new ApiError(401, "Incorrect email or password.", "AUTH_INVALID");
    }

    const userSnap = snap.docs[0];
    const user = userSnap.data();
    if (user.disabled === true) {
      throw new ApiError(403, "This account has been disabled.", "ACCOUNT_DISABLED");
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      throw new ApiError(401, "Incorrect email or password.", "AUTH_INVALID");
    }

    await collections.users.doc(userSnap.id).set(
      { lastLoginAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    const payload = await sessionPayload(userSnap.id);
    res.json({ ...payload, created: false, needsClaimRefresh: false });
  }),
);

authRouter.post(
  "/google",
  asyncHandler(async (req, res) => {
    const body = googleAuthSchema.parse(req.body || {});
    const google = body.credential
      ? await verifyGoogleIdToken(body.credential)
      : await verifyGoogleAccessToken(body.accessToken);

    if (google.email_verified === false) {
      throw new ApiError(
        403,
        "Please verify your Google email address before continuing.",
        "GOOGLE_EMAIL_NOT_VERIFIED",
      );
    }

    const email = normalizeEmail(google.email);
    const googleId = String(google.sub || google.user_id || "");
    let snap = await collections.users
      .where("email", "==", email)
      .limit(1)
      .get();

    if (snap.empty && googleId) {
      snap = await collections.users
        .where("googleId", "==", googleId)
        .limit(1)
        .get();
    }

    let uid;
    let created = false;
    let user;

    if (!snap.empty) {
      uid = snap.docs[0].id;
      user = snap.docs[0].data();
      if (user.disabled === true) {
        throw new ApiError(403, "This account has been disabled.", "ACCOUNT_DISABLED");
      }
      await collections.users.doc(uid).set(
        {
          googleId: googleId || user.googleId || "",
          emailVerified: true,
          photoPath: user.photoPath || google.picture || "",
          lastLoginAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } else {
      uid = collections.users.doc().id;
      created = true;
      const role = body.role === "worker" ? "worker" : "customer";
      if (role === "worker" && (!body.service || !body.area)) {
        throw new ApiError(
          422,
          "Tell us your trade and service area to apply as a worker.",
          "WORKER_DETAILS_REQUIRED",
        );
      }
      user = await createUserRecord({
        uid,
        email,
        name: body.name || friendlyGoogleName(google),
        phone: body.phone,
        role,
        city: body.city,
        googleId,
        emailVerified: true,
        photoPath: google.picture || "",
      });
      if (role === "worker") {
        await saveWorkerRecord(uid, { ...body, name: user.name }, user);
      }
      if (body.referralCode) {
        await applyReferralForNewUser({
          code: body.referralCode,
          uid,
          name: user.name,
          email,
          role,
        }).catch((error) => {
          console.warn("Referral capture failed:", error.message);
          return null;
        });
      }
    }

    const payload = await sessionPayload(uid);
    res.status(created ? 201 : 200).json({
      ...payload,
      created,
      needsClaimRefresh: false,
    });
  }),
);

authRouter.post(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const { token } = tokenSchema.parse(req.body || {});
    const tokenHash = hashToken(token);
    const snap = await collections.users
      .where("emailVerificationTokenHash", "==", tokenHash)
      .limit(1)
      .get();

    if (snap.empty) {
      throw new ApiError(
        400,
        "This verification link is invalid or has already been used.",
        "VERIFICATION_INVALID",
      );
    }

    const uid = snap.docs[0].id;
    const user = snap.docs[0].data();
    const expires = user.emailVerificationExpiresAt;
    const expiryDate = expires?.toDate ? expires.toDate() : expires ? new Date(expires) : null;
    if (expiryDate && expiryDate.getTime() < Date.now()) {
      throw new ApiError(
        410,
        "This verification link has expired. Request a new one.",
        "VERIFICATION_EXPIRED",
      );
    }

    await collections.users.doc(uid).set(
      {
        emailVerified: true,
        emailVerificationTokenHash: FieldValue.delete(),
        emailVerificationExpiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const payload = await sessionPayload(uid);
    res.json({ ...payload, verified: true });
  }),
);

authRouter.get(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const token = String(req.query.token || "");
    if (!token) throw new ApiError(400, "Verification token is required.", "TOKEN_REQUIRED");
    const tokenHash = hashToken(token);
    const snap = await collections.users
      .where("emailVerificationTokenHash", "==", tokenHash)
      .limit(1)
      .get();
    if (snap.empty) {
      throw new ApiError(400, "This verification link is invalid.", "VERIFICATION_INVALID");
    }
    const uid = snap.docs[0].id;
    await collections.users.doc(uid).set(
      {
        emailVerified: true,
        emailVerificationTokenHash: FieldValue.delete(),
        emailVerificationExpiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    const payload = await sessionPayload(uid);
    res.json({ ...payload, verified: true });
  }),
);

authRouter.post(
  "/resend-verification",
  requireAuth,
  asyncHandler(async (req, res) => {
    const snap = await collections.users.doc(req.user.uid).get();
    if (!snap.exists) {
      throw new ApiError(404, "Profile not found.", "PROFILE_MISSING");
    }
    const user = snap.data();
    if (user.emailVerified === true) {
      return res.json({ ok: true, alreadyVerified: true });
    }
    const result = await issueVerification(
      req.user.uid,
      user.email || req.user.email,
      user.name || "",
    );
    res.json({
      ok: true,
      emailSent: result.emailSent,
      emailSkipped: result.emailSkipped,
      verificationUrl: result.verificationUrl,
    });
  }),
);

authRouter.post(
  "/forgot-password",
  asyncHandler(async (req, res) => {
    const body = forgotPasswordSchema.parse(req.body || {});
    const email = normalizeEmail(body.email);
    const snap = await collections.users
      .where("email", "==", email)
      .limit(1)
      .get();

    if (!snap.empty) {
      const uid = snap.docs[0].id;
      const user = snap.docs[0].data();
      if (user.disabled !== true) {
        await issuePasswordReset(uid, email, user.name || "").catch((error) => {
          console.warn("Password reset email failed:", error.message);
        });
      }
    }

    res.json({
      ok: true,
      message: "If an account exists for that email, a reset link has been sent.",
    });
  }),
);

authRouter.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const body = resetPasswordSchema.parse(req.body || {});
    const tokenHash = hashToken(body.token);
    const snap = await collections.users
      .where("passwordResetTokenHash", "==", tokenHash)
      .limit(1)
      .get();

    if (snap.empty) {
      throw new ApiError(
        400,
        "This reset link is invalid or has already been used.",
        "RESET_INVALID",
      );
    }

    const uid = snap.docs[0].id;
    const user = snap.docs[0].data();
    const expires = user.passwordResetExpiresAt;
    const expiryDate = expires?.toDate ? expires.toDate() : expires ? new Date(expires) : null;
    if (expiryDate && expiryDate.getTime() < Date.now()) {
      throw new ApiError(
        410,
        "This reset link has expired. Request a new one.",
        "RESET_EXPIRED",
      );
    }

    const passwordHash = await hashPassword(body.password);
    await collections.users.doc(uid).set(
      {
        passwordHash,
        authProvider: "password",
        passwordResetTokenHash: FieldValue.delete(),
        passwordResetExpiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const payload = await sessionPayload(uid);
    res.json({ ...payload, reset: true });
  }),
);

authRouter.get(
  "/token",
  requireAuth,
  asyncHandler(async (req, res) => {
    const payload = await sessionPayload(req.user.uid);
    res.json({ token: payload.token, claims: payload.claims });
  }),
);

authRouter.post(
  "/refresh",
  requireAuth,
  asyncHandler(async (req, res) => {
    const payload = await sessionPayload(req.user.uid);
    res.json({ token: payload.token, claims: payload.claims });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (_req, res) => {
    res.json({ ok: true });
  }),
);

/**
 * Called by the client right after sign-in/sign-up. Kept for backwards
 * compatibility with existing clients; creates the profile for legacy users.
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
      await userRef.set(
        {
          lastLoginAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      const payload = await sessionPayload(uid);
      return res.json({ ...payload, created: false });
    }

    const role = body.role === "worker" ? "worker" : "customer";
    const name = body.name || req.user.name || defaultNameFromEmail(email);
    if (role === "worker" && (!body.service || !body.area)) {
      throw new ApiError(
        422,
        "Tell us your trade and service area to apply as a worker.",
        "WORKER_DETAILS_REQUIRED",
      );
    }
    const user = await createUserRecord({
      uid,
      email,
      name,
      phone: body.phone,
      role,
      city: body.city,
    });

    let referral = null;
    if (body.referralCode) {
      referral = await applyReferralForNewUser({
        code: body.referralCode,
        uid,
        name,
        email,
        role,
      }).catch((error) => {
        console.warn("Referral capture failed:", error.message);
        return null;
      });
    }

    if (role === "worker") {
      await saveWorkerRecord(uid, { ...body, name }, user);
    }

    const payload = await sessionPayload(uid);
    return res.json({
      ...payload,
      isAdmin: adminNow,
      created: true,
      needsClaimRefresh: false,
      referralApplied: Boolean(referral?.applied),
    });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const payload = await sessionPayload(req.user.uid);
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

    const payload = await sessionPayload(uid);
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
    const user = userSnap.data();

    const workerRef = collections.workers.doc(uid);
    const workerSnap = await workerRef.get();
    const existing = workerSnap.exists ? workerSnap.data() : null;
    if (existing && existing.status === WORKER_STATUS.APPROVED) {
      throw new ApiError(409, "Your worker account is already approved.", "ALREADY_APPROVED");
    }

    await userRef.set(
      {
        role: "worker",
        ...(body.name ? { name: body.name } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await saveWorkerRecord(uid, { ...body, name: body.name || user.name }, user, existing);

    const payload = await sessionPayload(uid);
    res.json({ status: WORKER_STATUS.PENDING, token: payload.token, claims: payload.claims });
  }),
);

authRouter.get(
  "/worker/status",
  requireAuth,
  requireApprovedWorker,
  asyncHandler(async (req, res) => {
    const snap = await collections.workers.doc(req.user.uid).get();
    res.json({ approved: true, worker: docToJson(snap) });
  }),
);
