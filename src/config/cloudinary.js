import { v2 as cloudinary } from "cloudinary";
import { env } from "./env.js";

let configured = false;

export function isCloudinaryConfigured() {
  return Boolean(
    env.cloudinaryCloudName && env.cloudinaryApiKey && env.cloudinaryApiSecret,
  );
}

/**
 * Lazily configures the Cloudinary SDK. Keeping this lazy means the API can
 * still boot (and serve Firebase/Razorpay traffic) if image uploads are not
 * configured yet.
 */
export function configureCloudinary() {
  if (!isCloudinaryConfigured()) return false;

  if (!configured) {
    cloudinary.config({
      cloud_name: env.cloudinaryCloudName,
      api_key: env.cloudinaryApiKey,
      api_secret: env.cloudinaryApiSecret,
      secure: true,
    });
    configured = true;
  }

  return true;
}

export { cloudinary };
