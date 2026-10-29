import "dotenv/config";
import mongoose from "mongoose";

/**
 * MongoDB Atlas is the single source of truth for EasyHome.
 *
 * The application stores every document in MongoDB through the small
 * store adapter in `config/store.js`. Keeping the connection here means the
 * rest of the codebase never needs to know whether it runs locally or on
 * Vercel.
 */
const uri = process.env.MONGODB_URI || "";
let connectionPromise = null;

export async function connectDb() {
  if (!uri) {
    throw new Error(
      "MONGODB_URI is missing. Add the MongoDB Atlas connection string to backend/.env.",
    );
  }

  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (mongoose.connection.readyState === 2 && connectionPromise) {
    return connectionPromise;
  }

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(uri, {
        maxPoolSize: 10,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 12_000,
        socketTimeoutMS: 45_000,
        family: 4,
      })
      .then(() => {
        console.log("MongoDB connected");
        return mongoose.connection;
      })
      .catch((error) => {
        connectionPromise = null;
        console.error("MongoDB connection failed:", error.message);
        throw error;
      });
  }

  return connectionPromise;
}

export function isDbReady() {
  return mongoose.connection.readyState === 1;
}

const MODELS = new Map();

const baseOptions = {
  strict: false,
  versionKey: false,
  timestamps: false,
  minimize: false,
  collection: undefined,
};

function schema(definition = {}, collection) {
  return new mongoose.Schema(
    { _id: String, ...definition },
    {
      ...baseOptions,
      collection,
    },
  );
}

function register(name, collection, definition = {}, indexes = []) {
  const modelSchema = schema(definition, collection);
  for (const index of indexes) {
    if (Array.isArray(index)) modelSchema.index(index[0], index[1] || {});
    else modelSchema.index(index);
  }
  const model = mongoose.models[name] || mongoose.model(name, modelSchema);
  MODELS.set(collection, model);
  return model;
}

// Core business models. They are deliberately permissive (`strict: false`) so
// historical documents and newer admin-managed fields continue to work, while
// the fields used for filtering and sorting are indexed for fast reads.
register("User", "users", {
  uid: String,
  name: String,
  email: String,
  phone: String,
  role: String,
  city: String,
  photoPath: String,
  emailVerified: Boolean,
  disabled: Boolean,
  passwordHash: String,
  googleId: String,
  createdAt: Date,
  updatedAt: Date,
  lastLoginAt: Date,
}, [
  { email: 1 },
  { role: 1, createdAt: -1 },
  { createdAt: -1 },
  { googleId: 1 },
]);

register("Worker", "workers", {
  uid: String,
  name: String,
  email: String,
  phone: String,
  service: String,
  serviceKey: String,
  status: String,
  online: Boolean,
  city: String,
  state: String,
  areaName: String,
  lat: Number,
  lng: Number,
  rating: Number,
  reviewCount: Number,
  jobsCompleted: Number,
  premiumUntil: Date,
  dues: Number,
  createdAt: Date,
  updatedAt: Date,
}, [
  { status: 1, createdAt: -1 },
  { serviceKey: 1, status: 1, online: 1 },
  { rating: -1 },
  { premiumUntil: 1 },
  { createdAt: -1 },
]);

register("WorkerPublic", "workersPublic", {
  uid: String,
  name: String,
  serviceKey: String,
  city: String,
  state: String,
  areaName: String,
  lat: Number,
  lng: Number,
  online: Boolean,
  rating: Number,
  reviewCount: Number,
  jobsCompleted: Number,
  premiumUntil: Date,
}, [
  { serviceKey: 1, rating: -1 },
  { rating: -1 },
  { city: 1, serviceKey: 1 },
]);

register("Booking", "bookings", {
  customerId: String,
  workerId: String,
  serviceKey: String,
  status: String,
  activeJob: Boolean,
  cityName: String,
  createdAt: Date,
  updatedAt: Date,
  lastUpdatedTimestamp: Date,
  paidAt: Date,
}, [
  { customerId: 1, createdAt: -1 },
  { workerId: 1, createdAt: -1 },
  { status: 1, createdAt: -1 },
  { activeJob: 1, updatedAt: -1 },
  { createdAt: -1 },
  { "pricing.finalPrice": 1 },
]);

register("JobFeed", "jobFeed", {
  bookingId: String,
  workerId: String,
  serviceKey: String,
  status: String,
  createdAt: Date,
  updatedAt: Date,
}, [
  { workerId: 1, status: 1, createdAt: -1 },
  { serviceKey: 1, status: 1, createdAt: -1 },
  { bookingId: 1 },
]);

register("UrgentPublic", "urgentPublic", {
  bookingId: String,
  serviceKey: String,
  cityName: String,
  createdAt: Date,
}, [{ createdAt: -1 }, { cityName: 1, serviceKey: 1 }]);

register("Notification", "notifications", {
  userId: String,
  read: Boolean,
  createdAt: Date,
}, [{ userId: 1, createdAt: -1 }, { read: 1 }]);

register("Review", "reviews", {
  workerId: String,
  customerId: String,
  rating: Number,
  createdAt: Date,
}, [{ workerId: 1, createdAt: -1 }, { customerId: 1 }]);

register("Service", "services", {
  key: String,
  name: String,
  icon: String,
  order: Number,
  active: Boolean,
  folderId: String,
  isLive: Boolean,
}, [{ key: 1 }, { order: 1 }, { active: 1 }, { folderId: 1 }, { isLive: 1 }]);

register("ServiceFolder", "serviceFolders", {
  name: { type: String, required: true, unique: true },
  description: String,
  icon: String,
  isLive: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
  // Home-page visibility is separate from `isLive`: a folder can stay public
  // and browseable from /services while being hidden from the home page.
  // Missing values on legacy documents mean "visible on home".
  showOnHome: Boolean,
  homeOrder: Number,
  createdAt: Date,
}, [{ isLive: 1 }, { order: 1 }, { showOnHome: 1, homeOrder: 1 }]);

register("City", "cities", {
  name: String,
  state: String,
  active: Boolean,
}, [{ name: 1 }, { active: 1 }]);

register("ServiceZone", "service_zones", {
  cityName: String,
  state: String,
  isActive: Boolean,
  latitude: Number,
  longitude: Number,
  radiusKm: Number,
  createdAt: Date,
  updatedAt: Date,
}, [
  { isActive: 1, cityName: 1 },
  { cityName: 1 },
  { latitude: 1, longitude: 1 },
]);

register("ServiceWaitlist", "service_waitlist", {
  email: String,
  cityName: String,
  createdAt: Date,
}, [{ email: 1 }, { cityName: 1 }, { createdAt: -1 }]);

register("Promo", "promos", {
  title: String,
  order: Number,
  active: Boolean,
  startsAt: Date,
  endsAt: Date,
  couponCode: String,
  discountType: String,
  discountValue: Number,
  targetFolderId: String,
  targetServiceId: String,
}, [{ order: 1 }, { active: 1 }, { couponCode: 1 }]);

register("FooterLink", "footer_links", {
  label: String,
  href: String,
  active: Boolean,
}, [{ href: 1 }, { active: 1 }]);

register("Subscription", "subscriptions", {
  userId: String,
  email: String,
  plan: String,
  status: String,
  amount: Number,
  startAt: Date,
  endAt: Date,
  premiumUntil: Date,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  createdAt: Date,
  updatedAt: Date,
}, [
  { userId: 1, createdAt: -1 },
  { status: 1, createdAt: -1 },
  { razorpayOrderId: 1 },
  { email: 1 },
]);

register("Commission", "commissions", {
  workerId: String,
  bookingId: String,
  amount: Number,
  status: String,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  createdAt: Date,
  updatedAt: Date,
  approvedAt: Date,
}, [
  { workerId: 1, bookingId: 1 },
  { status: 1, createdAt: -1 },
  { razorpayOrderId: 1 },
  { createdAt: -1 },
]);

register("Payment", "payments", {
  userId: String,
  bookingId: String,
  amount: Number,
  status: String,
  razorpayOrderId: String,
  razorpayPaymentId: String,
  createdAt: Date,
}, [
  { userId: 1, createdAt: -1 },
  { razorpayOrderId: 1 },
  { bookingId: 1 },
]);

register("ChatThread", "chatThreads", {
  userId: String,
  lastMessage: String,
  lastAt: Date,
  unreadForAdmin: Number,
  unreadForUser: Number,
  createdAt: Date,
  updatedAt: Date,
}, [
  { lastAt: -1 },
  { unreadForAdmin: -1 },
  { userId: 1 },
]);

register("CallRequest", "callRequests", {
  userId: String,
  status: String,
  createdAt: Date,
  updatedAt: Date,
}, [{ status: 1, createdAt: -1 }, { userId: 1, status: 1 }]);

register("Referral", "referrals", {
  referrerId: String,
  referredId: String,
  referralCode: String,
  status: String,
  createdAt: Date,
  updatedAt: Date,
}, [
  { referralCode: 1 },
  { referrerId: 1, createdAt: -1 },
  { referredId: 1 },
  { status: 1 },
]);

register("Admin", "admins", {
  uid: String,
  email: String,
  name: String,
  createdAt: Date,
}, [{ uid: 1 }, { email: 1 }, { createdAt: 1 }]);

register("Setting", "settings", {
  key: String,
  updatedAt: Date,
}, []);

register("Audit", "audit", {
  actorId: String,
  action: String,
  details: Object,
  createdAt: Date,
}, [{ createdAt: -1 }, { actorId: 1 }]);

// Subcollections are stored in a flattened collection and linked with
// `_parentId`, which keeps document paths simple without nested arrays.
const SUBCOLLECTIONS = {
  "chatThreads.messages": "chatThreads__messages",
  "bookings.private": "bookings__private",
};

export function collectionNameFor(parentCollection, subcollection) {
  const key = `${parentCollection}.${subcollection}`;
  return SUBCOLLECTIONS[key] || `${parentCollection}__${subcollection}`;
}

export function getModel(collectionName) {
  const existing = MODELS.get(collectionName);
  if (existing) return existing;

  const safeName = `C_${collectionName.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const model =
    mongoose.models[safeName] ||
    mongoose.model(safeName, schema({}, collectionName));
  MODELS.set(collectionName, model);
  return model;
}

export const dbReady = isDbReady;
