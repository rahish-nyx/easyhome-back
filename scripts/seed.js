/**
 * Seeds the Firebase project with an admin account, service catalogue,
 * cities, promo banners and site settings. Safe to run multiple times.
 *
 * Usage: npm run seed
 */
import { FieldValue } from "firebase-admin/firestore";
import { auth, collections } from "../src/config/firebase.js";
import { env } from "../src/config/env.js";

import { WORK_CATEGORIES } from "../src/lib/catalog.js";
import { SEED_CITIES } from "../src/lib/cities.js";

const serviceZones = [
  {
    id: "zone-indore",
    state: "Madhya Pradesh",
    cityName: "Indore",
    latitude: 22.7196,
    longitude: 75.8577,
    radiusKm: 30,
    isActive: true,
  },
  {
    id: "zone-bhopal",
    state: "Madhya Pradesh",
    cityName: "Bhopal",
    latitude: 23.2599,
    longitude: 77.4126,
    radiusKm: 30,
    isActive: true,
  },
  {
    id: "zone-ujjain",
    state: "Madhya Pradesh",
    cityName: "Ujjain",
    latitude: 23.1765,
    longitude: 75.7885,
    radiusKm: 25,
    isActive: true,
  },
  {
    id: "zone-dewas",
    state: "Madhya Pradesh",
    cityName: "Dewas",
    latitude: 22.9676,
    longitude: 76.0534,
    radiusKm: 20,
    isActive: true,
  },
  {
    id: "zone-jaipur",
    state: "Rajasthan",
    cityName: "Jaipur",
    latitude: 26.9124,
    longitude: 75.7873,
    radiusKm: 35,
    isActive: false,
  },
  {
    id: "zone-pune",
    state: "Maharashtra",
    cityName: "Pune",
    latitude: 18.5204,
    longitude: 73.8567,
    radiusKm: 35,
    isActive: false,
  },
  {
    id: "zone-mumbai",
    state: "Maharashtra",
    cityName: "Mumbai",
    latitude: 19.076,
    longitude: 72.8777,
    radiusKm: 35,
    isActive: false,
  },
  {
    id: "zone-delhi",
    state: "Delhi",
    cityName: "Delhi",
    latitude: 28.6139,
    longitude: 77.209,
    radiusKm: 35,
    isActive: false,
  },
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

  for (const service of WORK_CATEGORIES) {
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

  for (const city of SEED_CITIES) {
    await collections.cities.doc(city.id).set(
      {
        ...city,
        localAreas: city.localAreas || [],
        active: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    batch.push(`city:${city.id}`);
  }

  // Service zones are admin-managed. Seed creates demo zones once and never
  // overwrites later edits, so activating a city in the console is durable.
  for (const zone of serviceZones) {
    const { id, ...data } = zone;
    const ref = collections.serviceZones.doc(id);
    const existing = await ref.get();
    if (!existing.exists) {
      await ref.set({
        ...data,
        areaName: data.areaName || "",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.push(`zone:${id}`);
    }
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

  const settingsRef = collections.settings.doc("app");
  const settingsSnap = await settingsRef.get();
  const existingSettings = settingsSnap.exists ? settingsSnap.data() : {};
  const defaultSettings = {
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
    upiId: "rahishcnrb@ybl",
    supportPhone: "",
    qrImagePath: "",
    qrImageUrl: "",
    maintenanceMode: false,
    announcement: { title: "", body: "", active: false },
  };
  const currentUpi = String(existingSettings.upiId || "").trim();
  await settingsRef.set(
    {
      ...defaultSettings,
      ...existingSettings,
      upiId:
        currentUpi && currentUpi !== "easyhome@upi"
          ? currentUpi
          : defaultSettings.upiId,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  console.log(
    `• ${WORK_CATEGORIES.length} services, ${SEED_CITIES.length} cities, ${serviceZones.length} service zones, ${promos.length} promos`,
  );
  console.log("• settings/app updated");
  console.log(`\nDone. ${batch.length} catalogue documents are ready.\n`);
  console.log("Next: sign in at /admin with the seeded admin email.\n");
}

main().catch((error) => {
  console.error("\nSeed failed:", error.message);
  process.exit(1);
});
