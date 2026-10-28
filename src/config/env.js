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

function cloudinaryCredentials() {
  let cloudinaryCloudName = process.env.CLOUDINARY_CLOUD_NAME || "";
  let cloudinaryApiKey = process.env.CLOUDINARY_API_KEY || "";
  let cloudinaryApiSecret = process.env.CLOUDINARY_API_SECRET || "";
  const cloudinaryUrl = process.env.CLOUDINARY_URL || "";

  if ((!cloudinaryCloudName || !cloudinaryApiKey || !cloudinaryApiSecret) && cloudinaryUrl) {
    try {
      const parsed = new URL(cloudinaryUrl);
      if (parsed.protocol === "cloudinary:") {
        cloudinaryCloudName ||= parsed.hostname;
        cloudinaryApiKey ||= decodeURIComponent(parsed.username);
        cloudinaryApiSecret ||= decodeURIComponent(parsed.password);
      }
    } catch {
      console.warn(
        "CLOUDINARY_URL is invalid; explicit Cloudinary variables may be used instead.",
      );
    }
  }

  return { cloudinaryCloudName, cloudinaryApiKey, cloudinaryApiSecret };
}

const missing = [];
if (!process.env.MONGODB_URI) missing.push("MONGODB_URI");
if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");

if (missing.length) {
  console.error(
    [
      "",
      "  EasyHome API cannot start.",
      `  Missing MongoDB/auth settings: ${missing.join(", ")}`,
      "",
      "  Fix: copy backend/.env.example to backend/.env and fill in the",
      "  MongoDB Atlas connection string and a strong JWT secret.",
      "",
    ].join("\n"),
  );
  if (process.env.NODE_ENV === "production") process.exit(1);
}

const cloudinary = cloudinaryCredentials();

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",
  emulator: false,
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGODB_URI || "",
  jwtSecret: process.env.JWT_SECRET || "easyhome-dev-only-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "30d",
  googleClientId:
    process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || "",
  corsOrigins: asList(process.env.CORS_ORIGINS, [
    "https://easyhome-front.vercel.app",
    "http://localhost:5173",
    "http://localhost:4173",
    "http://localhost:3000",
  ]),
  publicWebUrl: (process.env.PUBLIC_WEB_URL || "https://easyhome-front.vercel.app").replace(
    /\/+$/,
    "",
  ),
  resendApiKey: process.env.RESEND_API_KEY || "",
  mailFrom:
    (process.env.MAIL_FROM || "EasyHome <official.easyhomeservices@gmail.com>")
      .replace(/^"+|"+$/g, "")
      .trim(),
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
  ...cloudinary,
};
