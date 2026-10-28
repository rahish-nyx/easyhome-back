import { connectDb } from './config/db.js';
import { getModel } from './config/db.js';
// Since serviceGroups is frontend, replicate grouping logic here
const GROUP_MAP = {
  cleaning: "Cleaning", "deep-cleaning": "Cleaning", "bathroom-cleaning": "Cleaning",
  "kitchen-cleaning": "Cleaning", "sofa-cleaning": "Cleaning", "carpet-cleaning": "Cleaning",
  "window-cleaning": "Cleaning", "office-cleaning": "Cleaning", "move-in-cleaning": "Cleaning",
  disinfection: "Cleaning",
  plumbing: "Plumbing", "tap-repair": "Plumbing", "toilet-repair": "Plumbing",
  "water-tank-cleaning": "Plumbing", "pipeline-repair": "Plumbing", "water-purifier": "Plumbing",
  drainage: "Plumbing", "borewell-repair": "Plumbing",
  electrical: "Electrical", wiring: "Electrical", "fan-install": "Electrical",
  "light-install": "Electrical", inverter: "Electrical", switchboard: "Electrical",
  appliance: "Appliance Repair", "ac-repair": "Appliance Repair", "fridge-repair": "Appliance Repair",
  "washing-machine-repair": "Appliance Repair", "microwave-repair": "Appliance Repair",
  "geyser-repair": "Appliance Repair", "tv-repair": "Appliance Repair", "chimney-cleaning": "Appliance Repair",
  beauty: "Beauty & Wellness", salon: "Beauty & Wellness", haircut: "Beauty & Wellness",
  "beard-grooming": "Beauty & Wellness", facial: "Beauty & Wellness", waxing: "Beauty & Wellness",
  massage: "Beauty & Wellness", "bridal-makeup": "Beauty & Wellness", mehndi: "Beauty & Wellness",
  tutoring: "Tutoring", "maths-tutor": "Tutoring", "science-tutor": "Tutoring",
  "english-tutor": "Tutoring", "music-teacher": "Tutoring", "dance-teacher": "Tutoring",
  "fitness-trainer": "Tutoring", "yoga-trainer": "Tutoring",
  childcare: "Child & Elder Care", nanny: "Child & Elder Care", "elder-care": "Child & Elder Care",
  "patient-care": "Child & Elder Care", nursing: "Child & Elder Care", physiotherapy: "Child & Elder Care",
  pet: "Pet Care", "dog-grooming": "Pet Care", "pet-sitting": "Pet Care",
  "pet-training": "Pet Care", veterinary: "Pet Care",
  gardening: "Garden & Landscaping", "lawn-mowing": "Garden & Landscaping",
  "tree-trimming": "Garden & Landscaping", "plant-care": "Garden & Landscaping",
  landscaping: "Garden & Landscaping",
  car: "Vehicle Services", "car-wash": "Vehicle Services", "bike-wash": "Vehicle Services",
  "car-detailing": "Vehicle Services", "puncture-repair": "Vehicle Services",
  "battery-jumpstart": "Vehicle Services", towing: "Vehicle Services", driver: "Vehicle Services",
  taxi: "Vehicle Services",
  event: "Events & Catering", catering: "Events & Catering", cook: "Events & Catering",
  "party-catering": "Events & Catering", bartender: "Events & Catering",
  waiter: "Events & Catering", "event-photography": "Events & Catering",
  videography: "Events & Catering", dj: "Events & Catering", "tent-house": "Events & Catering",
  decoration: "Events & Catering", "wedding-planner": "Events & Catering",
  repair: "Repair & Construction", painting: "Repair & Construction",
  "wall-painting": "Repair & Construction", waterproofing: "Repair & Construction",
  "texture-painting": "Repair & Construction", "wood-polishing": "Repair & Construction",
  "pest-control": "Repair & Construction", "termite-control": "Repair & Construction",
  "mosquito-control": "Repair & Construction", "rodent-control": "Repair & Construction",
  carpentry: "Repair & Construction", "door-repair": "Repair & Construction",
  "furniture-assembly": "Repair & Construction", "modular-kitchen": "Repair & Construction",
  wardrobe: "Repair & Construction", "bed-repair": "Repair & Construction",
  business: "Business & Security", "security-guard": "Business & Security",
  bouncer: "Business & Security", housekeeping: "Business & Security", maid: "Business & Security",
  laundry: "Home Services", ironing: "Home Services", tailoring: "Home Services",
  alterations: "Home Services", embroidery: "Home Services",
};

function serviceGroup(key) { return GROUP_MAP[key] || "Other"; }

await connectDb();
const Service = getModel("services");
const Folder = getModel("serviceFolders");

// Create folders from existing groups
const services = await Service().find().lean();
const groupNames = new Set();
for (const s of services) {
  const g = serviceGroup(s.key || s.id);
  if (g) groupNames.add(g);
}
console.log("Folders to create:", Array.from(groupNames));

for (const name of groupNames) {
  const exists = await Folder().findOne({ name });
  if (!exists) {
    await Folder().create({ name, description: "", icon: "layers", isLive: true, order: 0, createdAt: new Date() });
    console.log("Created folder:", name);
  }
}

// Link services to folders by group name
for (const s of services) {
  const g = serviceGroup(s.key || s.id);
  if (g) {
    const folder = await Folder().findOne({ name: g });
    if (folder) {
      s.folderId = folder._id.toString();
      await Service().updateOne({ _id: s._id }, { $set: { folderId: folder._id.toString() } });
    }
  }
}
console.log("Linked", services.length, "services to folders");
process.exit(0);
