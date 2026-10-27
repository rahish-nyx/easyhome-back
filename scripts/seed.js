/**
 * Seeds the Firebase project with an admin account, service catalogue,
 * promo banners, footer links and site settings. Service zones and cities are admin-managed. Safe to run multiple times.
 *
 * Usage: npm run seed
 */
import { FieldValue } from "firebase-admin/firestore";
import { auth, collections } from "../src/config/firebase.js";
import { env } from "../src/config/env.js";
import { SERVICE_SUBHEADINGS } from "./serviceSubheadings.js";

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
    subtitle: "Zero fees, priority jobs and a verified Pro badge for ₹199/month.",
    ctaText: "Go Pro",
    ctaLink: "/subscription",
    theme: "dark",
    order: 2,
  },
  {
    id: "refer-earn",
    title: "Refer & earn ₹51 each",
    subtitle: "Invite a new customer. After their first completed service and admin verification, you both get ₹51 approved.",
    ctaText: "Refer a friend",
    ctaLink: "/refer",
    theme: "blue",
    order: 3,
  },
];

const footerLinks = [
  { id: "footer-about", label: "About us", href: "/legal/about", group: "company", order: 1 },
  { id: "footer-faq", label: "FAQ", href: "/faq", group: "support", order: 1 },
  { id: "footer-terms", label: "Terms and Conditions", href: "/legal/terms", group: "legal", order: 1 },
  { id: "footer-privacy", label: "Privacy policy", href: "/legal/privacy", group: "legal", order: 2 },
  { id: "footer-refunds", label: "Refund & cancellation policy", href: "/legal/refunds", group: "legal", order: 3 },
  { id: "footer-disclaimer", label: "Disclaimer", href: "/legal/disclaimer", group: "legal", order: 4 },
  { id: "footer-support", label: "Help & support", href: "/chat", group: "support", order: 2 },
  { id: "footer-refer", label: "Refer & Earn", href: "/refer", group: "support", order: 3 },
  { id: "footer-become-pro", label: "Become a pro", href: "/auth?role=worker", group: "professionals", order: 1 },
  { id: "footer-worker", label: "Worker dashboard", href: "/worker", group: "professionals", order: 2 },
  { id: "footer-membership", label: "EasyHome Pro", href: "/subscription", group: "professionals", order: 3 },
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
        subheading:
          service.subheading ||
          SERVICE_SUBHEADINGS[service.key] ||
          `${service.name} by verified pros`,
        active: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    batch.push(`service:${service.key}`);
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

  for (const link of footerLinks) {
    const { id, ...data } = link;
    const ref = collections.footerLinks.doc(id);
    if (!(await ref.get()).exists) {
      await ref.set({
        ...data,
        active: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.push(`footer-link:${id}`);
    }
  }

  const settingsRef = collections.settings.doc("app");
  const settingsSnap = await settingsRef.get();
  const existingSettings = settingsSnap.exists ? settingsSnap.data() : {};
  const customerMonthly = Number(env.subscriptionPrice) || 199;
  const defaultSettings = {
    commissionPct: env.commissionPct,
    subscriptionPrice: customerMonthly,
    customerPlans: {
      monthly: customerMonthly,
      quarterly: Math.round(customerMonthly * 3 * 0.9),
      yearly: Math.round(customerMonthly * 12 * 0.8),
    },
    workerPlans: { monthly: 250, quarterly: 675, yearly: 2400 },
    customerRules: {
      urgentFeePct: 10,
      cancellationMinutes: 7,
      proCancellationMinutes: 20,
    },
    workerRules: {
      feesPct: env.commissionPct,
      urgentFeePct: 10,
      cancellationMinutes: 7,
    },
    customerBenefits: [
      "Active priority worker matching",
      "No 10% urgent-job extra charge",
      "24×7 priority support",
      "Free cancellation for 20 minutes (7 for non-Pro)",
      "Verified Pro badge",
    ],
    workerBenefits: [
      "0% fees on every job",
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
      customerBenefits: defaultSettings.customerBenefits,
      workerBenefits: defaultSettings.workerBenefits,
      upiId:
        currentUpi && currentUpi !== "easyhome@upi"
          ? currentUpi
          : defaultSettings.upiId,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  console.log(
    `• ${services.length} services, ${promos.length} promos, admin-managed zones only`,
  );
  console.log("• settings/app updated");
  console.log(`\nDone. ${batch.length} catalogue documents are ready.\n`);
  console.log("Next: sign in at /admin with the seeded admin email.\n");
}

main().catch((error) => {
  console.error("\nSeed failed:", error.message);
  process.exit(1);
});
