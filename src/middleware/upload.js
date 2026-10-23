import multer from "multer";
import { ApiError } from "./errors.js";

const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)) {
      return callback(
        new ApiError(
          415,
          "Only JPG, PNG, WEBP or GIF images are allowed.",
          "UNSUPPORTED_IMAGE",
        ),
      );
    }
    return callback(null, true);
  },
});
