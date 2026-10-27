/**
 * Backfills service subheadings and fills missing descriptions without
 * deleting or replacing the production catalogue. Safe to run repeatedly.
 *
 * Usage: node scripts/backfill-service-copy.js
 */
import { collections, db } from "../src/config/firebase.js";
import { FieldValue } from "firebase-admin/firestore";
import {
  SERVICE_DESCRIPTION_FIXES,
  SERVICE_SUBHEADINGS,
} from "./serviceSubheadings.js";

async function main() {
  const snap = await collections.services.get();
  let updated = 0;
  const batch = db.batch();

  snap.docs.forEach((doc) => {
    const service = doc.data();
    const key = String(service.key || doc.id || "").trim();
    const subheading =
      String(service.subheading || "").trim() ||
      SERVICE_SUBHEADINGS[key] ||
      `${service.name || "Home service"} by verified pros`;
    const currentDescription = String(service.description || "").trim();
    const description =
      currentDescription ||
      SERVICE_DESCRIPTION_FIXES[key] ||
      `${service.name || "This service"} handled by verified EasyHome professionals.`;

    if (
      subheading !== String(service.subheading || "") ||
      description !== String(service.description || "")
    ) {
      batch.set(
        doc.ref,
        {
          subheading,
          description,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      updated += 1;
    }
  });

  if (updated > 0) await batch.commit();
  console.log(`Service copy backfill complete. Updated ${updated} of ${snap.size} services.`);
}

main().catch((error) => {
  console.error("Backfill failed:", error.message);
  process.exit(1);
});
