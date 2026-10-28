import { collections } from "../config/firebase.js";
import { verifyToken } from "../lib/auth.js";
import { ApiError } from "./errors.js";

/**
 * Reads an optional EasyHome bearer token. Never throws for missing tokens —
 * individual routes decide whether authentication is required.
 */
export async function attachUser(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    const decoded = verifyToken(token);
    const uid = decoded.uid || decoded.sub;
    if (!uid) throw new Error("Token is missing a subject");

    const snap = await collections.users.doc(uid).get();
    if (!snap.exists) {
      return next(
        new ApiError(
          401,
          "Your session is no longer valid. Please sign in again.",
          "AUTH_INVALID",
        ),
      );
    }

    const profile = snap.data();
    if (profile.disabled === true) {
      return next(
        new ApiError(403, "This account has been disabled.", "ACCOUNT_DISABLED"),
      );
    }

    req.user = {
      uid,
      email: profile.email || decoded.email || "",
      name: profile.name || decoded.name || "",
      picture: profile.photoPath || decoded.picture || "",
      role: profile.role || decoded.role || "customer",
      admin: decoded.admin === true,
      workerApproved: decoded.workerApproved === true,
      emailVerified: profile.emailVerified === true,
    };
    return next();
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    return next(
      new ApiError(
        401,
        "Your session has expired. Please sign in again.",
        "AUTH_INVALID",
      ),
    );
  }
}

export function requireAuth(req, _res, next) {
  if (!req.user) {
    return next(
      new ApiError(401, "Please sign in to continue.", "AUTH_REQUIRED"),
    );
  }
  return next();
}

export function requireVerified(req, _res, next) {
  if (!req.user) {
    return next(
      new ApiError(401, "Please sign in to continue.", "AUTH_REQUIRED"),
    );
  }
  if (!req.user.emailVerified && !req.user.admin) {
    return next(
      new ApiError(
        403,
        "Please verify your email address before continuing.",
        "EMAIL_NOT_VERIFIED",
      ),
    );
  }
  return next();
}

export function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(
        new ApiError(401, "Please sign in to continue.", "AUTH_REQUIRED"),
      );
    }
    if (req.user.role !== role && !req.user.admin) {
      return next(
        new ApiError(403, "This area is not available for your account.", "FORBIDDEN"),
      );
    }
    return next();
  };
}

export async function requireApprovedWorker(req, _res, next) {
  if (!req.user) {
    return next(new ApiError(401, "Please sign in to continue.", "AUTH_REQUIRED"));
  }
  if (req.user.role !== "worker") {
    return next(new ApiError(403, "Worker account required.", "NOT_WORKER"));
  }
  if (req.user.workerApproved) return next();

  // Fallback to MongoDB for tokens minted before a claim refresh.
  const snap = await collections.workers.doc(req.user.uid).get();
  if (snap.exists && snap.data().status === "approved") {
    req.user.workerApproved = true;
    return next();
  }

  const status = snap.exists ? snap.data().status : "missing";
  return next(
    new ApiError(
      403,
      status === "pending"
        ? "Your worker application is still under review."
        : "Your worker account has not been approved yet.",
      "WORKER_NOT_APPROVED",
      { status },
    ),
  );
}

export async function isAdmin(user) {
  if (!user) return false;
  if (user.admin) return true;
  const snap = await collections.admins.doc(user.uid).get();
  return snap.exists;
}

export async function requireAdmin(req, _res, next) {
  if (!req.user) {
    return next(new ApiError(401, "Please sign in to continue.", "AUTH_REQUIRED"));
  }
  try {
    if (!(await isAdmin(req.user))) {
      return next(
        new ApiError(403, "Admin access required.", "ADMIN_REQUIRED"),
      );
    }
    req.user.admin = true;
    return next();
  } catch (error) {
    return next(error);
  }
}
