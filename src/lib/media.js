import { createHash, randomUUID } from "node:crypto";
import cloudinaryPackage from "cloudinary";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";

const MAX_BYTES = 4 * 1024 * 1024;

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
    throw new ApiError(413, "Image is too large. Maximum size is 4 MB.", "FILE_TOO_LARGE");
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

export const cloudinaryConfigured = () =>
  Boolean(
    env.cloudinaryCloudName &&
      env.cloudinaryApiKey &&
      env.cloudinaryApiSecret,
  );

export async function uploadCloudinaryImage(buffer, { folder, isPublic = true }) {
  if (!cloudinaryConfigured()) {
    throw new ApiError(
      503,
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET on the API.",
      "CLOUDINARY_NOT_CONFIGURED",
    );
  }

  const { contentType } = inspectImage(buffer);
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = randomUUID();
  const safeFolder = String(folder || "misc").replace(/[^a-z0-9/_-]/gi, "");
  const type = isPublic ? "upload" : "private";
  const signatureText = [
    `folder=${safeFolder}`,
    `public_id=${publicId}`,
    `timestamp=${timestamp}`,
    `type=${type}`,
  ].join("&");
  const signature = createHash("sha1")
    .update(`${signatureText}${env.cloudinaryApiSecret}`)
    .digest("hex");
  const form = new FormData();
  const { ext } = inspectImage(buffer);
  form.append("file", new Blob([buffer], { type: contentType }), `${publicId}.${ext}`);
  form.append("api_key", env.cloudinaryApiKey);
  form.append("timestamp", String(timestamp));
  form.append("folder", safeFolder);
  form.append("public_id", publicId);
  form.append("type", type);
  form.append("signature", signature);

  let response;
  try {
    response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(env.cloudinaryCloudName)}/image/upload`,
      { method: "POST", body: form, signal: AbortSignal.timeout(20000) },
    );
  } catch {
    throw new ApiError(
      502,
      "Could not connect to Cloudinary. Please try again.",
      "CLOUDINARY_UNAVAILABLE",
    );
  }

  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.secure_url || !result?.public_id) {
    console.error("Cloudinary image upload failed:", response.status, result?.error?.message || "Invalid response");
    throw new ApiError(
      "Cloudinary could not store this image. Please try again.",
      { status: 502, code: "CLOUDINARY_UPLOAD_FAILED" },
    );
  }

  return {
    url: result.secure_url,
    publicId: result.public_id,
    resourceType: result.resource_type || "image",
    format: result.format || "",
  };
}

export async function deleteCloudinaryImage(publicId) {
  if (!cloudinaryConfigured()) {
    throw new ApiError(
      503,
      "Cloudinary is not configured.",
      "CLOUDINARY_NOT_CONFIGURED",
    );
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const type = "upload";
  const signature = createHash("sha1")
    .update(
      `public_id=${publicId}&timestamp=${timestamp}&type=${type}${env.cloudinaryApiSecret}`,
    )
    .digest("hex");
  const body = new URLSearchParams({
    public_id: publicId,
    api_key: env.cloudinaryApiKey,
    timestamp: String(timestamp),
    type,
    signature,
  });

  let response;
  try {
    response = await fetch(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(env.cloudinaryCloudName)}/image/destroy`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10000),
      },
    );
  } catch {
    throw new ApiError(
      502,
      "Could not connect to Cloudinary to remove the completed-job image.",
      "CLOUDINARY_UNAVAILABLE",
    );
  }

  const result = await response.json().catch(() => null);
  if (!response.ok || !["ok", "not found"].includes(result?.result)) {
    throw new ApiError(
      "Cloudinary could not remove the completed-job image.",
      { status: 502, code: "CLOUDINARY_DELETE_FAILED" },
    );
  }
}

export function privateCloudinaryDownloadUrl(publicId, format) {
  if (!cloudinaryConfigured()) {
    throw new ApiError(
      503,
      "Cloudinary is not configured.",
      "CLOUDINARY_NOT_CONFIGURED",
    );
  }
  if (!publicId || !format) {
    throw new ApiError(404, "Document not found.", "MEDIA_NOT_FOUND");
  }

  const cloudinary = cloudinaryPackage.v2;
  cloudinary.config({
    cloud_name: env.cloudinaryCloudName,
    api_key: env.cloudinaryApiKey,
    api_secret: env.cloudinaryApiSecret,
    secure: true,
  });
  return cloudinary.utils.private_download_url(publicId, format, {
    resource_type: "image",
    expires_at: Math.floor(Date.now() / 1000) + 300,
    attachment: false,
  });
}

export async function deleteStoredImage({ path, cloudinaryId }) {
  if (cloudinaryId) {
    await deleteCloudinaryImage(cloudinaryId);
  }
  if (path && !cloudinaryId) {
    console.warn("Skipping cleanup for an image without a Cloudinary asset ID.");
  }
}
