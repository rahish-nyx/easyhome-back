import { Router } from "express";
import { getModel } from "../config/db.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";

export const adminFoldersRouter = Router();
adminFoldersRouter.use(requireAdmin);

const Folder = () => getModel("serviceFolders");
const Service = () => getModel("services");

function folderIdFrom(folder) {
  return String(folder._id ?? folder.id ?? "");
}

function folderAliases(folder) {
  const id = folderIdFrom(folder);
  return [...new Set([id, String(folder.name || "")].filter(Boolean))];
}

function matchesFolder(service, aliases) {
  const folderId = String(service.folderId || "");
  const legacyFolder = String(service.folder || "");
  return aliases.includes(folderId) || aliases.includes(legacyFolder);
}

function serialize(folder, servicesCount = 0) {
  return {
    ...folder,
    id: folderIdFrom(folder),
    servicesCount,
  };
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Mongo returns folder `_id` values as strings (the seeded folders use the
 * folder name as their id). We intentionally keep that id stable when the
 * folder is renamed so service references never break.
 */
adminFoldersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const folders = await Folder().find().sort({ order: 1, name: 1 }).lean();
    const services = await Service().find({}, { folderId: 1, folder: 1 }).lean();

    const counts = new Map();
    for (const folder of folders) {
      const aliases = folderAliases(folder);
      const count = services.filter((service) => matchesFolder(service, aliases)).length;
      counts.set(folderIdFrom(folder), count);
    }

    res.json({
      folders: folders.map((folder) =>
        serialize(folder, counts.get(folderIdFrom(folder)) || 0),
      ),
    });
  }),
);

adminFoldersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const name = normalizeSlug(req.body?.name);
    if (!name) throw new ApiError(422, "Folder name required", "FOLDER_NAME_REQUIRED");

    const exists = await Folder().findOne({ name });
    if (exists) throw new ApiError(409, "Folder name already exists", "FOLDER_EXISTS");

    const folder = await Folder().create({
      _id: name,
      name,
      description: req.body?.description || "",
      icon: req.body?.icon || "layers",
      isLive: req.body?.isLive !== false,
      order: Number(req.body?.order) || 0,
      createdAt: new Date(),
    });

    res.status(201).json({ folder: serialize(folder.toObject(), 0) });
  }),
);

adminFoldersRouter.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const folder = await Folder().findById(req.params.id);
    if (!folder) throw new ApiError(404, "Folder not found", "FOLDER_NOT_FOUND");

    const updates = {};
    if (req.body?.name !== undefined) {
      const nextName = normalizeSlug(req.body.name);
      if (!nextName) throw new ApiError(422, "Folder name required", "FOLDER_NAME_REQUIRED");
      const duplicate = await Folder().findOne({
        name: nextName,
        _id: { $ne: folder._id },
      });
      if (duplicate) throw new ApiError(409, "Name already taken", "FOLDER_EXISTS");
      updates.name = nextName;
    }
    if (req.body?.description !== undefined) updates.description = req.body.description;
    if (req.body?.icon !== undefined) updates.icon = req.body.icon;
    if (req.body?.isLive !== undefined) updates.isLive = Boolean(req.body.isLive);
    if (req.body?.order !== undefined) updates.order = Number(req.body.order) || 0;

    if (Object.keys(updates).length) {
      const updated = await Folder().findByIdAndUpdate(folder._id, updates, { new: true });
      if (!updated) throw new ApiError(404, "Folder not found", "FOLDER_NOT_FOUND");
      folder.set(updated.toObject());
    }

    const aliases = folderAliases(folder);
    const servicesCount = await Service().countDocuments({
      $or: [{ folderId: { $in: aliases } }, { folder: { $in: aliases } }],
    });
    res.json({ folder: serialize(folder.toObject(), servicesCount) });
  }),
);

adminFoldersRouter.patch(
  "/:id/toggle",
  asyncHandler(async (req, res) => {
    const folder = await Folder().findById(req.params.id);
    if (!folder) throw new ApiError(404, "Folder not found", "FOLDER_NOT_FOUND");

    folder.isLive = !folder.isLive;
    await folder.save();

    const aliases = folderAliases(folder);
    const servicesCount = await Service().countDocuments({
      $or: [{ folderId: { $in: aliases } }, { folder: { $in: aliases } }],
    });
    res.json({ folder: serialize(folder.toObject(), servicesCount) });
  }),
);

adminFoldersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const folder = await Folder().findById(req.params.id);
    if (!folder) throw new ApiError(404, "Folder not found", "FOLDER_NOT_FOUND");

    const aliases = folderAliases(folder);
    await Service().updateMany(
      { $or: [{ folderId: { $in: aliases } }, { folder: { $in: aliases } }] },
      { $set: { folderId: null, folder: null, updatedAt: new Date() } },
    );
    await Folder().deleteOne({ _id: folder._id });
    res.json({ ok: true });
  }),
);

adminFoldersRouter.get(
  "/:id/services",
  asyncHandler(async (req, res) => {
    const folder = await Folder().findById(req.params.id).lean();
    if (!folder) throw new ApiError(404, "Folder not found", "FOLDER_NOT_FOUND");
    const aliases = folderAliases(folder);
    const services = await Service()
      .find({ $or: [{ folderId: { $in: aliases } }, { folder: { $in: aliases } }] })
      .sort({ order: 1, name: 1 })
      .lean();
    res.json({
      services: services.map((service) => ({
        ...service,
        id: String(service._id),
      })),
    });
  }),
);

adminFoldersRouter.post(
  "/:id/services",
  asyncHandler(async (req, res) => {
    const { serviceId, action } = req.body || {};
    if (!serviceId) throw new ApiError(422, "serviceId required", "SERVICE_REQUIRED");

    const folder = await Folder().findById(req.params.id);
    if (!folder) throw new ApiError(404, "Folder not found", "FOLDER_NOT_FOUND");

    const service = await Service().findById(serviceId);
    if (!service) throw new ApiError(404, "Service not found", "SERVICE_NOT_FOUND");

    if (action === "remove") {
      service.folderId = null;
      service.folder = null;
    } else {
      service.folderId = folderIdFrom(folder);
      service.folder = folder.name;
    }
    service.updatedAt = new Date();
    await service.save();

    res.json({
      ok: true,
      service: { ...service.toObject(), id: String(service._id) },
    });
  }),
);
