import { ZodError } from "zod";
import { env } from "../config/env.js";

export class ApiError extends Error {
  constructor(status, message, code = "ERROR", details = undefined, expose = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    // Operational failures (storage, Telegram, payment provider) are safe to
    // show to the client even in production. Unexpected 5xx errors stay masked.
    this.expose = expose;
  }
}

export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

export function notFound(req, res) {
  res.status(404).json({
    error: "Endpoint not found",
    code: "NOT_FOUND",
    path: req.originalUrl,
  });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: "Please check the highlighted fields.",
      code: "VALIDATION_ERROR",
      details: err.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "Image is too large. Maximum size is 5 MB.",
      code: "FILE_TOO_LARGE",
    });
  }

  if (err?.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({
      error: "Unexpected file upload.",
      code: "UNEXPECTED_FILE",
    });
  }

  const status = err.status || 500;

  if (status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, err);
  }

  res.status(status).json({
    error:
      status >= 500 && env.isProd && !err.expose
        ? "Something went wrong on our side. Please try again."
        : err.message || "Something went wrong",
    code: err.code || (status >= 500 ? "INTERNAL" : "REQUEST_ERROR"),
    ...(err.details ? { details: err.details } : {}),
    ...(!env.isProd && status >= 500 && err.stack
      ? { stack: err.stack.split("\n").slice(0, 5) }
      : {}),
  });
}
