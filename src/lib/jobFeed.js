import { createHash } from "node:crypto";
import { collections, db } from "../config/store.js";

export function jobFeedDocId(bookingId, workerId) {
  return createHash("sha256")
    .update(`${bookingId}:${workerId}`)
    .digest("hex");
}

export async function updateJobFeedStatus(bookingId, status) {
  const snapshot = await collections.jobFeed
    .where("bookingId", "==", bookingId)
    .get();

  for (let index = 0; index < snapshot.docs.length; index += 450) {
    const batch = db.batch();
    snapshot.docs.slice(index, index + 450).forEach((doc) => {
      batch.set(
        doc.ref,
        { status, updatedAt: new Date() },
        { merge: true },
      );
    });
    await batch.commit();
  }
}
