import "dotenv/config";

const asBool = (value, fallback = false) => {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const asList = (value, fallback = []) => {
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const emulator = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    process.env.FIREBASE_STORAGE_EMULATOR_HOST,
);

const missing = [];
const hasServiceAccountFile = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
if (!emulator) {
  for (const key of [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
  ]) {
    if (
      !process.env[key] &&
      !process.env.FIREBASE_SERVICE_ACCOUNT_JSON &&
      !hasServiceAccountFile
    ) {
      missing.push(key);
    }
  }
}

if (missing.length) {
  console.error(
    [
      "",
      "  EasyHome API cannot start.",
      `  Missing Firebase credentials: ${missing.join(", ")}`,
      "",
      "  Fix: copy backend/.env.example to backend/.env and fill in the",
      "  service account values from Firebase Console → Project settings.",
      "",
    ].join("\n"),
  );
  if (process.env.NODE_ENV === "production") process.exit(1);
}

const projectId =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  "demo-easyhome";

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",
  emulator,
  port: Number(process.env.PORT || 5000),
  projectId,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL || "",
  privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
  corsOrigins: asList(process.env.CORS_ORIGINS, [
    "http://localhost:5173",
    "http://localhost:4173",
    "http://localhost:3000",
  ]),
  publicWebUrl: process.env.PUBLIC_WEB_URL || "http://localhost:5173",
  resendApiKey: process.env.RESEND_API_KEY || "",
  mailFrom: process.env.MAIL_FROM || "EasyHome <official.easyhomeservices@gmail.com>",
  adminEmail: process.env.ADMIN_EMAIL || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminName: process.env.ADMIN_NAME || "EasyHome Admin",
  commissionPct: Number(process.env.DEFAULT_COMMISSION_PCT || 10),
  subscriptionPrice: Number(process.env.DEFAULT_SUBSCRIPTION_PRICE || 199),
  paymentProvider: process.env.PAYMENT_PROVIDER || "razorpay",
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || "",
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  trustProxy: Number(process.env.TRUST_PROXY || 1),
  enableDemoData: asBool(process.env.ENABLE_DEMO_DATA, false),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  adminTelegramChatId: process.env.ADMIN_TELEGRAM_CHAT_ID || "",
};
