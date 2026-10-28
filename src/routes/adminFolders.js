import { Router } from "express";
import { getModel } from "../config/db.js";
import { requireAdmin } from "../middleware/auth.js";
import { asyncHandler, ApiError } from "../middleware/errors.js";

export const adminFoldersRouter = Router();
adminFoldersRouter.use(requireAdmin);

const Folder = () => getModel("serviceFolders");
const Service = () => getModel("services");

adminFoldersRouter.get("/", asyncHandler(async (_req, res) => {
  const folders = await Folder().find().sort({ order: 1, name: 1 }).lean();
  const folderIds = folders.map((f) => f._id.toString());
  const counts = await Service().aggregate([
    { $match: { folderId: { $in: folderIds instanceof Array ? folderIds : [folderIds] } } },
    { $group: { _id: "$folderId", count: { $sum: 1 } } },
  ]);
  const countMap = {};
  for (const c of counts) countMap[c._id] = c.count;
  res.json({ folders: folders.map((f) => ({ ...f, id: f._id.toString(), servicesCount: countMap[f._id.toString()] || 0 })) });
}));

adminFoldersRouter.post("/", asyncHandler(async (req, res) => {
  const { name, description, icon, isLive, order } = req.body || {};
  if (!name || !name.trim()) throw new ApiError(422, "Folder name required");
  const exists = await Folder().findOne({ name: name.trim() });
  if (exists) throw new ApiError(409, "Folder name already exists");
  const folder = await Folder().create({
    name: name.trim(), description: description || "", icon: icon || "layers",
    isLive: isLive !== false, order: Number(order) || 0, createdAt: new Date(),
  });
  res.status(201).json({ folder: { ...folder.toObject(), id: folder._id.toString() } });
}));

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

adminFoldersRouter.patch("/:id/toggle", asyncHandler(async (req, res) => {
  const folder = await Folder().findById(req.params.id);
  if (!folder) throw new ApiError(404, "Folder not found");
  folder.isLive = !folder.isLive;
  await folder.save();
  res.json({ folder: { ...folder.toObject(), id: folder._id.toString(), isLive: folder.isLive } });
}));

adminFoldersRouter.delete("/:id", asyncHandler(async (req, res) => {
  const folder = await Folder().findById(req.params.id);
  if (!folder) throw new ApiError(404, "Folder not found");
  await Service().updateMany({ folderId: req.params.id }, { $set: { folderId: null, updatedAt: new Date() } });
  await Folder().deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

adminFoldersRouter.post("/:id/services", asyncHandler(async (req, res) => {
  const { serviceId, action } = req.body || {};
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
