import mongoose from "mongoose";
import { connectDb, getModel } from "../src/config/db.js";
import { FOLDER_NAMES, serviceGroup } from "../src/data/serviceGroups.js";

await connectDb();

const Service = getModel("services");
const Folder = getModel("serviceFolders");

const descriptions = {
  Cleaning: "Deep cleaning, kitchen, bathroom, sofa and move-in cleaning.",
  Plumbing: "Taps, toilets, drainage, water tanks and pipeline repairs.",
  Electrical: "Wiring, switches, fans, lights and inverter installation.",
  "Construction & Interiors": "Masonry, tiling, false ceilings, interiors and structural work.",
  "Appliance Repair": "AC, fridge, washing machine, microwave and TV repair.",
  "Repair & Construction": "Painting, carpentry, pest control and waterproofing.",
  "Beauty & Wellness": "Salon at home, haircuts, facials, massage and makeup.",
  Tutoring: "Maths, science, languages, music and fitness coaching.",
  "Child & Elder Care": "Nannies, elder care, nursing and physiotherapy.",
  "Pet Care": "Grooming, sitting, training and veterinary support.",
  "Garden & Landscaping": "Lawn mowing, tree trimming and plant care.",
  "Vehicle Services": "Car and bike wash, detailing, towing and drivers.",
  "Events & Catering": "Cooks, catering, photography, decor and planners.",
  "Business & Security": "Security guards, housekeeping and office staffing.",
  "Home Services": "Laundry, ironing, tailoring and everyday home help.",
};

const icons = {
  Cleaning: "sparkles",
  Plumbing: "droplets",
  Electrical: "zap",
  "Construction & Interiors": "hard-hat",
  "Appliance Repair": "wrench",
  "Repair & Construction": "hammer",
  "Beauty & Wellness": "scissors",
  Tutoring: "graduation-cap",
  "Child & Elder Care": "heart-handshake",
  "Pet Care": "paw-print",
  "Garden & Landscaping": "trees",
  "Vehicle Services": "car",
  "Events & Catering": "party-popper",
  "Business & Security": "shield-check",
  "Home Services": "home",
};

for (const [index, name] of FOLDER_NAMES.entries()) {
  const existing = await Folder.findById(name);
  if (!existing) {
    await Folder.create({
      _id: name,
      name,
      description: descriptions[name] || "",
      icon: icons[name] || "layers",
      isLive: true,
      order: index,
      createdAt: new Date(),
    });
    console.log("Created folder:", name);
  } else {
    await Folder.updateOne(
      { _id: name },
      {
        $set: {
          description: existing.description || descriptions[name] || "",
          icon: existing.icon || icons[name] || "layers",
          order: index,
        },
      },
    );
  }
}

const services = await Service.find().lean();
let linked = 0;

for (const service of services) {
  const folderName = serviceGroup(service.key || service.id);
  const folder = await Folder.findById(folderName);
  if (!folder) continue;
  await Service.updateOne(
    { _id: service._id },
    {
      $set: {
        folderId: folder._id.toString(),
        folder: folder.name,
        updatedAt: new Date(),
      },
    },
  );
  linked += 1;
}

const counts = await Promise.all(
  FOLDER_NAMES.map(async (name) => {
    const folder = await Folder.findById(name).lean();
    const count = folder
      ? await Service.countDocuments({
          $or: [{ folderId: folder._id.toString() }, { folder: folder.name }],
        })
      : 0;
    return `${name}: ${count}`;
  }),
);

console.log(`Linked ${linked} of ${services.length} services to folders.`);
console.log(counts.join("\n"));

await mongoose.disconnect();
