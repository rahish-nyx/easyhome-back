import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { attachUser } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { authRouter } from "./routes/auth.js";
import { publicRouter } from "./routes/public.js";
import { customerRouter } from "./routes/customer.js";
import { workerRouter } from "./routes/worker.js";
import { adminRouter } from "./routes/admin.js";
import { adminCatalogRouter } from "./routes/adminCatalog.js";
import { adminMoneyRouter } from "./routes/adminMoney.js";
import { adminZonesRouter } from "./routes/adminZones.js";
import { paymentRouter } from "./routes/payment.js";
import { referralRouter } from "./routes/referrals.js";

export const app = express();

app.disable("x-powered-by");
app.set("trust proxy", env.trustProxy);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      // Native apps and server-to-server calls have no Origin header.
      if (!origin) return callback(null, true);
      if (!env.isProd) return callback(null, true);
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);

app.use(compression({ threshold: 1024 }));
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      // Razorpay webhooks are signed over the exact raw request body.
      req.rawBody = buffer;
    },
  }),
);
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

if (!env.isProd) {
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - started;
      if (req.path !== "/api/health" && req.path !== "/health") {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
      }
    });
    next();
  });
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 80,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Too many attempts. Try again in a few minutes.", code: "AUTH_RATE_LIMITED" },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 90,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "You are doing that too quickly. Please wait a moment.", code: "RATE_LIMITED" },
});

app.use("/api", globalLimiter);
app.use("/api", attachUser);
app.use("/api/auth", authLimiter);
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  return writeLimiter(req, res, next);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "easyhome-api", version: 2, time: new Date().toISOString() });
});

app.use("/api/public", publicRouter);
app.use("/api/auth", authRouter);
app.use("/api/referrals", referralRouter);
app.use("/api", customerRouter);
app.use("/api", workerRouter);
app.use("/api/payment", paymentRouter);
app.use("/api/admin", adminRouter);
app.use("/api/admin", adminCatalogRouter);
app.use("/api/admin", adminMoneyRouter);
app.use("/api/admin", adminZonesRouter);

app.use(notFound);
app.use(errorHandler);
