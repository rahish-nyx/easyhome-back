/**
 * Seeds MongoDB with the EasyHome admin account, the full 181-service
 * catalogue, promo banners, footer links and site settings. Service zones and
 * cities remain admin-managed. Safe to run multiple times.
 *
 * Usage: npm run seed
 */
import { connectDb } from "../src/config/db.js";
import { collections } from "../src/config/firebase.js";
import { env } from "../src/config/env.js";
import { FieldValue } from "../src/lib/firestore.js";
import { hashPassword, normalizeEmail } from "../src/lib/auth.js";
import { DEFAULT_SERVICES } from "../src/data/catalogue.js";
import { SERVICE_SUBHEADINGS } from "./serviceSubheadings.js";

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
    subtitle: "Zero fees, priority jobs and a verified Pro badge for ₹1,199/month.",
    ctaText: "Go Pro",
    ctaLink: "/subscription",
    theme: "dark",
    order: 2,
  },
  {
    id: "refer-earn",
    title: "Refer & earn ₹151 each",
    subtitle:
      "Invite a new customer. After their first completed service and admin verification, you both get ₹151 approved.",
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
    return null;
  }
  if (env.adminPassword.length < 8) {
    console.log("⚠  ADMIN_PASSWORD must be at least 8 characters — skipping admin account.");
    return null;
  }

  const email = normalizeEmail(env.adminEmail);
  const snap = await collections.users.where("email", "==", email).limit(1).get();
  let uid;
  let existing = null;

  if (!snap.empty) {
    uid = snap.docs[0].id;
    existing = snap.docs[0].data();
    console.log(`ℹ Admin account exists: ${email}`);
  } else {
    uid = collections.users.doc().id;
    console.log(`✓ Creating admin account: ${email}`);
  }

  const passwordHash = await hashPassword(env.adminPassword);
  await collections.users.doc(uid).set(
    {
      uid,
      name: env.adminName,
      email,
      phone: existing?.phone || "",
      role: "admin",
      photoPath: existing?.photoPath || "",
      city: existing?.city || "",
      addresses: existing?.addresses || [],
      emailVerified: true,
      disabled: false,
      authProvider: "password",
      passwordHash,
      subscription: existing?.subscription || {
        status: "none",
        plan: null,
        startAt: null,
        endAt: null,
      },
      referralCode: existing?.referralCode || "",
      referredBy: existing?.referredBy || "",
      createdAt: existing?.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastLoginAt: existing?.lastLoginAt || null,
    },
    { merge: true },
  );

  await collections.admins.doc(uid).set(
    {
      uid,
      email,
      name: env.adminName,
      createdAt: FieldValue.serverTimestamp(),
      seeded: true,
    },
    { merge: true },
  );

  return uid;
}

async function seedCatalogue() {
  for (const service of DEFAULT_SERVICES) {
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
  }
}

async function seedPromos() {
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
  }
}

async function seedFooterLinks() {
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
    }
  }
}

async function seedSettings() {
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
}

async function main() {
  console.log("\nSeeding EasyHome MongoDB…\n");
  await connectDb();

  const adminUid = await seedAdmin();
  await seedCatalogue();
  await seedPromos();
  await seedFooterLinks();
  await seedSettings();

  console.log(
    `✓ ${DEFAULT_SERVICES.length} services, ${promos.length} promos, ${footerLinks.length} footer links`,
  );
  console.log("✓ settings/app updated");
  if (adminUid) console.log(`✓ admin ready (${env.adminEmail})`);
  console.log("\nNext: sign in at /admin with the seeded admin email.\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\nSeed failed:", error.message);
    process.exit(1);
  });
