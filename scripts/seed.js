/**
 * Seeds the Firebase project with an admin account, service catalogue,
 * cities, promo banners and site settings. Safe to run multiple times.
 *
 * Usage: npm run seed
 */
import { FieldValue } from "firebase-admin/firestore";
import { auth, collections } from "../src/config/firebase.js";
import { env } from "../src/config/env.js";

const services = [
  {
    key: "cleaning",
    name: "Home Cleaning",
    icon: "sparkles",
    description: "Deep cleaning, bathrooms, kitchens and full-home refresh.",
    fromPrice: 299,
    order: 1,
  },
  {
    key: "plumbing",
    name: "Plumbing",
    icon: "wrench",
    description: "Leaks, taps, tanks, pipelines and bathroom fittings.",
    fromPrice: 199,
    order: 2,
  },
  {
    key: "electrical",
    name: "Electrical",
    icon: "zap",
    description: "Wiring, fans, lights, switches, MCB and inverters.",
    fromPrice: 199,
    order: 3,
  },
  {
    key: "carpentry",
    name: "Carpentry",
    icon: "hammer",
    description: "Doors, hinges, furniture repair and custom fittings.",
    fromPrice: 249,
    order: 4,
  },
  {
    key: "appliance",
    name: "Appliance Repair",
    icon: "plug-zap",
    description: "AC, fridge, washing machine, microwave and geyser.",
    fromPrice: 299,
    order: 5,
  },
  {
    key: "salon",
    name: "Salon & Beauty",
    icon: "scissors",
    description: "At-home haircuts, grooming, facials and bridal prep.",
    fromPrice: 299,
    order: 6,
  },
  {
    key: "painting",
    name: "Painting",
    icon: "paintbrush",
    description: "Room painting, touch-ups, waterproofing and texture.",
    fromPrice: 499,
    order: 7,
  },
  {
    key: "pest",
    name: "Pest Control",
    icon: "bug",
    description: "Cockroaches, termites, mosquitoes and rodent control.",
    fromPrice: 399,
    order: 8,
  },
  {
    key: "moving",
    name: "Packers & Movers",
    icon: "truck",
    description: "Local shifting, packing, loading and safe transport.",
    fromPrice: 999,
    order: 9,
  },
  {
    key: "tutoring",
    name: "Home Tutoring",
    icon: "graduation-cap",
    description: "Verified tutors for school, maths, science and languages.",
    fromPrice: 349,
    order: 10,
  },
];

const cities = [
  { id: "indore", name: "Indore", lat: 22.7196, lng: 75.8577, radiusKm: 30 },
  { id: "bhopal", name: "Bhopal", lat: 23.2599, lng: 77.4126, radiusKm: 30 },
  { id: "ujjain", name: "Ujjain", lat: 23.1765, lng: 75.7885, radiusKm: 25 },
  { id: "dewas", name: "Dewas", lat: 22.9676, lng: 76.0534, radiusKm: 20 },
  { id: "jaipur", name: "Jaipur", lat: 26.9124, lng: 75.7873, radiusKm: 35 },
  { id: "pune", name: "Pune", lat: 18.5204, lng: 73.8567, radiusKm: 35 },
  { id: "mumbai", name: "Mumbai", lat: 19.076, lng: 72.8777, radiusKm: 35 },
  { id: "delhi", name: "Delhi", lat: 28.6139, lng: 77.209, radiusKm: 35 },
];

const promos = [
  {
    id: "monsoon-refresh",
    title: "Monsoon home refresh",
    subtitle: "Flat 20% off deep cleaning this week. Verified pros, 60-minute arrival.",
    ctaText: "Book cleaning",
    ctaLink: "/services/cleaning",
    theme: "yellow",
    order: 1,
  },
  {
    id: "easyhome-pro",
    title: "EasyHome Pro",
    subtitle: "Zero commission, priority jobs and a verified Pro badge for ₹199/month.",
    ctaText: "Go Pro",
    ctaLink: "/subscription",
    theme: "dark",
    order: 2,
  },
  {
    id: "refer-earn",
    title: "Refer & earn ₹100",
    subtitle: "Share EasyHome with a neighbour. You both get ₹100 after their first booking.",
    ctaText: "Invite a friend",
    ctaLink: "/profile",
    theme: "blue",
    order: 3,
  },
];

async function seedAdmin() {
  if (!env.adminEmail || !env.adminPassword) {
    console.log("⚠  ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin account.");
    return;
  }
  if (env.adminPassword.length < 12) {
    console.log("⚠  ADMIN_PASSWORD must be at least 12 characters — skipping admin account.");
    return;
  }

  let user;
  try {
    user = await auth.getUserByEmail(env.adminEmail);
    console.log(`• Admin account exists: ${env.adminEmail}`);
  } catch {
    user = await auth.createUser({
      email: env.adminEmail,
      password: env.adminPassword,
      displayName: env.adminName,
      emailVerified: true,
    });
    console.log(`• Created admin account: ${env.adminEmail}`);
  }

  await auth.setCustomUserClaims(user.uid, {
    role: "admin",
    admin: true,
    workerApproved: false,
  });

  await collections.admins.doc(user.uid).set(
    {
      uid: user.uid,
      email: env.adminEmail,
      name: env.adminName,
      createdAt: FieldValue.serverTimestamp(),
      seeded: true,
    },
    { merge: true },
  );

  await collections.users.doc(user.uid).set(
    {
      uid: user.uid,
      name: env.adminName,
      email: env.adminEmail,
      phone: "",
      role: "admin",
      photoPath: "",
      city: "",
      addresses: [],
      emailVerified: true,
      disabled: false,
      subscription: { status: "none", plan: null, startAt: null, endAt: null },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function main() {
  console.log("\nSeeding EasyHome Firebase…\n");

  try {
    await seedAdmin();
  } catch (error) {
    console.log(
      `⚠  Could not create the admin account: ${error.message}\n` +
        "   Enable Email/Password Authentication in the Firebase console, then run `npm run seed` again.",
    );
  }

  const batch = [];

  for (const service of services) {
    await collections.services.doc(service.key).set(
      {
        ...service,
        active: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    batch.push(`service:${service.key}`);
  }

  for (const city of cities) {
    await collections.cities.doc(city.id).set(
      {
        ...city,
        active: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    batch.push(`city:${city.id}`);
  }

  for (const promo of promos) {
    const { id, ...data } = promo;
    await collections.promos.doc(id).set(
      {
        ...data,
        imagePath: "",
        active: true,
        startsAt: null,
        endsAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    batch.push(`promo:${id}`);
  }

  await collections.settings.doc("app").set(
    {
      commissionPct: env.commissionPct,
      subscriptionPrice: env.subscriptionPrice,
      customerBenefits: [
        "Priority worker matching",
        "Discounted service visits",
        "24×7 priority support",
        "Free cancellation up to 1 hour",
      ],
      workerBenefits: [
        "0% commission on every job",
        "Top placement in search",
        "Free urgent-job priority",
        "Verified Pro badge",
      ],
      upiId: "easyhome@upi",
      supportPhone: "",
      qrImagePath: "",
      maintenanceMode: false,
      announcement: { title: "", body: "", active: false },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  console.log(`• ${services.length} services, ${cities.length} cities, ${promos.length} promos`);
  console.log("• settings/app updated");
  console.log(`\nDone. ${batch.length} catalogue documents are ready.\n`);
  console.log("Next: sign in at /admin with the seeded admin email.\n");
}

main().catch((error) => {
  console.error("\nSeed failed:", error.message);
  process.exit(1);
});
