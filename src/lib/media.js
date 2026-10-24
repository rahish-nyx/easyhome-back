import { bucket } from "../config/firebase.js";
import {
  cloudinary,
  configureCloudinary,
} from "../config/cloudinary.js";
import { ApiError } from "../middleware/errors.js";

const MAX_BYTES = 5 * 1024 * 1024;

const SIGNATURES = [
  {
    ext: "jpg",
    contentType: "image/jpeg",
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "png",
    contentType: "image/png",
    test: (b) =>
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    ext: "webp",
    contentType: "image/webp",
    test: (b) =>
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
  {
    ext: "gif",
    contentType: "image/gif",
    test: (b) => b.toString("ascii", 0, 3) === "GIF",
  },
];

function inspectImage(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new ApiError(400, "The uploaded file is empty.", "EMPTY_FILE");
  }
  if (buffer.length > MAX_BYTES) {
    throw new ApiError(413, "Image is too large. Maximum size is 5 MB.", "FILE_TOO_LARGE");
  }
  const match = SIGNATURES.find((signature) => signature.test(buffer));
  if (!match) {
    throw new ApiError(
      415,
      "Only JPG, PNG, WEBP or GIF images are allowed.",
      "UNSUPPORTED_IMAGE",
    );
  }
  return match;
}

/**
 * Uploads a public image to Cloudinary and returns its secure URL.
 *
 * New uploads deliberately do not touch Firebase Storage. Existing Firebase
 * object paths remain readable through streamObject()/the /api/media proxy.
 * Private KYC documents are sent to Telegram instead (see lib/telegram.js).
 */
export async function uploadImage(buffer, { folder, isPublic = true } = {}) {
  if (!isPublic) {
    throw new ApiError(
      400,
      "Private documents must be sent to the verification team, not stored as media.",
      "PRIVATE_UPLOAD_DISABLED",
      undefined,
      true,
    );
  }

  inspectImage(buffer);

  if (!configureCloudinary()) {
    throw new ApiError(
      503,
      "Photo uploads are temporarily unavailable. Please try again shortly.",
      "MEDIA_NOT_CONFIGURED",
      undefined,
      true,
    );
  }

  const safeFolder =
    String(folder || "misc")
      .replace(/[^a-z0-9/_-]/gi, "")
      .replace(/^\/+|\/+$/g, "") || "misc";

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `easyhome/${safeFolder}`,
          resource_type: "image",
          unique_filename: true,
          overwrite: false,
        },
        (error, uploaded) => {
          if (error) reject(error);
          else resolve(uploaded);
        },
      );
      stream.end(buffer);
    });

    if (!result?.secure_url) {
      throw new Error("Cloudinary did not return a secure URL.");
    }

    return result.secure_url;
  } catch (error) {
    console.warn(
      "Cloudinary upload failed:",
      sanitizeProviderError(error?.message || error),
    );
    throw new ApiError(
      502,
      "We couldn't upload that photo right now. Please try again.",
      "MEDIA_UPLOAD_FAILED",
      undefined,
      true,
    );
  }
}

function sanitizeProviderError(value) {
  return String(value || "")
    .replace(/api_secret=[^&\s]+/gi, "api_secret=<redacted>")
    .replace(/api_key=[^&\s]+/gi, "api_key=<redacted>")
    .slice(0, 240);
}

export async function streamObject(objectPath, res, { cache = true } = {}) {
  const cleanPath = String(objectPath || "").replace(/^\/+/, "");

  if (!cleanPath || cleanPath.includes("..")) {
    throw new ApiError(400, "Invalid media path.", "INVALID_MEDIA_PATH");
  }
  if (cleanPath.startsWith("private/")) {
    throw new ApiError(403, "This media is private.", "MEDIA_FORBIDDEN");
  }

  const file = bucket.file(cleanPath);
  const [exists] = await file.exists();
  if (!exists) throw new ApiError(404, "Image not found.", "MEDIA_NOT_FOUND");

  const [metadata] = await file.getMetadata();

  res.set("Content-Type", metadata.contentType || "application/octet-stream");
  res.set(
    "Cache-Control",
    cache
      ? "public, max-age=31536000, immutable"
      : "private, no-store",
  );

  await new Promise((resolve, reject) => {
    const stream = file.createReadStream();
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

export async function streamPrivateObject(objectPath, res) {
  const cleanPath = String(objectPath || "").replace(/^\/+/, "");
  if (!cleanPath || !cleanPath.startsWith("private/")) {
    throw new ApiError(404, "Document not found.", "MEDIA_NOT_FOUND");
  }

  const file = bucket.file(cleanPath);
  const [exists] = await file.exists();
  if (!exists) throw new ApiError(404, "Document not found.", "MEDIA_NOT_FOUND");

  const [metadata] = await file.getMetadata();
  res.set("Content-Type", metadata.contentType || "application/octet-stream");
  res.set("Cache-Control", "private, no-store");
  res.set("Content-Disposition", "inline");

  await new Promise((resolve, reject) => {
    const stream = file.createReadStream();
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

export async function deleteObject(objectPath) {
  if (!objectPath) return;
  try {
    await bucket.file(objectPath).delete({ ignoreNotFound: true });
  } catch (error) {
    console.warn("Failed to delete object", objectPath, error.message);
  }
}
