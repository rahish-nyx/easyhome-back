import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";

const googleClient = new OAuth2Client(env.googleClientId || undefined);

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export async function hashPassword(password) {
  return bcrypt.hash(String(password), 12);
}

export async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(password), hash);
}

export function createToken(claims) {
  return jwt.sign(claims, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

export function verifyToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function tokenExpiry(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export async function verifyGoogleIdToken(credential) {
  if (!env.googleClientId) {
    throw Object.assign(
      new Error("Google sign-in is not configured on the server."),
      { status: 503, code: "GOOGLE_NOT_CONFIGURED" },
    );
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: env.googleClientId,
  });
  const payload = ticket.getPayload();
  if (!payload?.email) {
    throw Object.assign(new Error("Google did not return an email address."), {
      status: 422,
      code: "GOOGLE_EMAIL_MISSING",
    });
  }
  return payload;
}

export async function verifyGoogleAccessToken(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw Object.assign(new Error("Google sign-in could not be verified."), {
      status: 401,
      code: "GOOGLE_TOKEN_INVALID",
    });
  }
  const payload = await response.json();
  if (!payload?.email) {
    throw Object.assign(new Error("Google did not return an email address."), {
      status: 422,
      code: "GOOGLE_EMAIL_MISSING",
    });
  }
  return payload;
}

export function defaultNameFromEmail(email = "") {
  return String(email)
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function claimsFrom({ user, worker, isAdmin }) {
  return {
    uid: user?._id || user?.uid,
    email: user?.email || "",
    name: user?.name || "",
    picture: user?.photoPath || "",
    role: user?.role || "customer",
    admin: isAdmin === true,
    workerApproved: worker?.status === "approved",
    emailVerified: user?.emailVerified === true,
  };
}
