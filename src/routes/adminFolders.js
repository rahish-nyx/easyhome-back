import { Router } from "express";
import { getModel } from "../config/db.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";

export const adminFoldersRouter = Router();
adminFoldersRouter.use(requireAdmin);

const Folder = () => getModel("serviceFolders");
const Service = () => getModel("services");

/* GET all folders with service counts */
adminFoldersRouter.get("/", asyncHandler(async (req, res) => {
  const foldersSnap = await Folder().find().sort({ order: 1, name: 1 });
  const folderIds = foldersSnap.map((d) => d._id.toString());
  const servicesSnap = await Service().find({ folderId: { $in: folderIds } });
  const counts = {};
  for (const s of servicesSnap) {
    const fid = s.folderId ? s.folderId.toString() : null;
    if (fid) counts[fid] = (counts[fid] || 0) + 1;
  }
  const folders = foldersSnap.map((f) => ({
    ...f.toObject(),
    id: f._id.toString(),
    servicesCount: counts[f._id.toString()] || 0,
  }));
  res.json({ folders });
}));

/* POST create folder */
adminFoldersRouter.post("/", asyncHandler(async (req, res) => {
  const { name, description, icon, isLive, order } = req.body || {};
  if (!name || !name.trim()) throw new ApiError(422, "Folder name required");
  const exists = await Folder().findOne({ name: name.trim() });
  if (exists) throw new ApiError(409, "Folder name already exists");
  const folder = await Folder().create({
    name: name.trim(),
    description: description || "",
    icon: icon || "layers",
    isLive: isLive !== false,
    order: Number(order) || 0,
    createdAt: new Date(),
  });
  res.status(201).json({ folder: { ...folder.toObject(), id: folder._id.toString() } });
}));

/* PUT update folder */
adminFoldersRouter.put("/:id", asyncHandler(async (req, res) => {
  const { name, description, icon, isLive, order } = req.body || {};
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (description !== undefined) updates.description = description;
  if (icon !== undefined) updates.icon = icon;
  if (isLive !== undefined) updates.isLive = isLive;
  if (order !== undefined) updates.order = Number(order);
  if (updates.name) {
    const dup = await Folder().findOne({ name: updates.name, _id: { $ne: req.params.id } });
    if (dup) throw new ApiError(409, "Name already taken");
  }
  const folder = await Folder().findByIdAndUpdate(req.params.id, updates, { new: true });
  if (!folder) throw new ApiError(404, "Folder not found");
  res.json({ folder: { ...folder.toObject(), id: folder._id.toString() } });
}));

/* PATCH toggle isLive */
adminFoldersRouter.patch("/:id/toggle", asyncHandler(async (req, res) => {
  const folder = await Folder().findById(req.params.id);
  if (!folder) throw new ApiError(404, "Folder not found");
  folder.isLive = !folder.isLive;
  await folder.save();
  res.json({ folder: { ...folder.toObject(), id: folder._id.toString(), isLive: folder.isLive } });
}));

/* DELETE folder + unassign services */
adminFoldersRouter.delete("/:id", asyncHandler(async (req, res) => {
  const folder = await Folder().findById(req.params.id);
  if (!folder) throw new ApiError(404, "Folder not found");
  await Service().updateMany({ folderId: req.params.id }, { $set: { folderId: null, updatedAt: new Date() } });
  await Folder().deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

/* POST assign/remove service to folder */
adminFoldersRouter.post("/:id/services", asyncHandler(async (req, res) => {
  const { serviceId, action } = req.body || {}; // action = "assign" or "remove"
  if (!serviceId) throw new ApiError(422, "serviceId required");
  const folder = await Folder().findById(req.params.id);
  if (!folder) throw new ApiError(404, "Folder not found");
  const service = await Service().findById(serviceId);
  if (!service) throw new ApiError(404, "Service not found");
  if (action === "remove") {
    service.folderId = null;
  } else {
    service.folderId = req.params.id;
  }
  await service.save();
  res.json({ ok: true, service: { ...service.toObject(), id: service._id.toString() } });
}));
