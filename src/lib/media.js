import { randomUUID } from "node:crypto";
import { bucket } from "../config/firebase.js";
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
 * Uploads an image to Firebase Storage.
 * Public assets live under `public/…` and are served through /api/media.
 * Private assets (KYC documents) live under `private/…` and are admin-only.
 */
export async function uploadImage(buffer, { folder, isPublic = true }) {
  const { ext, contentType } = inspectImage(buffer);
  const safeFolder = String(folder || "misc").replace(/[^a-z0-9/_-]/gi, "");
  const objectPath = `${isPublic ? "public" : "private"}/${safeFolder}/${Date.now()}-${randomUUID()}.${ext}`;
  const file = bucket.file(objectPath);

  await file.save(buffer, {
    contentType,
    resumable: false,
    validation: "crc32c",
    metadata: {
      cacheControl: isPublic
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
      metadata: { uploadedBy: "easyhome-api" },
    },
  });

  return objectPath;
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
