import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { env } from "./env.js";

function buildCredential() {
  if (env.serviceAccountJson) {
    return cert(JSON.parse(env.serviceAccountJson));
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return applicationDefault();
  }
  if (env.clientEmail && env.privateKey) {
    return cert({
      projectId: env.projectId,
      clientEmail: env.clientEmail,
      privateKey: env.privateKey,
    });
  }
  return null;
}

function createApp() {
  const credential = buildCredential();
  const options = {
    projectId: env.projectId,
    ...(env.storageBucket ? { storageBucket: env.storageBucket } : {}),
    ...(credential ? { credential } : {}),
  };

  if (!credential && !env.emulator) {
    throw new Error(
      "Firebase Admin credentials are missing. Set FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY in backend/.env",
    );
  }

  return initializeApp(options);
}

export const app = getApps().length ? getApps()[0] : createApp();

export const db = getFirestore(app);
// Ignore `undefined` values instead of throwing (partial updates are common).
try {
  db.settings({ ignoreUndefinedProperties: true });
} catch {
  // Settings can only be applied once per process.
}

export const auth = getAuth(app);
export const bucket = getStorage(app).bucket(env.storageBucket || undefined);

export const collections = {
  users: db.collection("users"),
  workers: db.collection("workers"),
  workersPublic: db.collection("workersPublic"),
  bookings: db.collection("bookings"),
  jobFeed: db.collection("jobFeed"),
  urgentPublic: db.collection("urgentPublic"),
  notifications: db.collection("notifications"),
  reviews: db.collection("reviews"),
  services: db.collection("services"),
  cities: db.collection("cities"),
  promos: db.collection("promos"),
  subscriptions: db.collection("subscriptions"),
  commissions: db.collection("commissions"),
  chatThreads: db.collection("chatThreads"),
  admins: db.collection("admins"),
  settings: db.collection("settings"),
  audit: db.collection("audit"),
};
