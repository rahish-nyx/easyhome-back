import mongoose from "mongoose";
import { connectDb, getModel } from "../src/config/db.js";
import { FOLDER_NAMES } from "../src/data/serviceGroups.js";

await connectDb();

const Folder = getModel("serviceFolders");
const Service = getModel("services");

for (const [index, name] of FOLDER_NAMES.entries()) {
  const exists = await Folder.findById(name);
  if (!exists) {
    await Folder.create({
      _id: name,
      name,
      description: "",
      icon: "layers",
      isLive: true,
      order: index,
      createdAt: new Date(),
    });
    console.log("Created folder:", name);
  }
}

const total = await Service.countDocuments();
console.log(`Folders ready: ${FOLDER_NAMES.length}. Services: ${total}.`);

await mongoose.disconnect();
