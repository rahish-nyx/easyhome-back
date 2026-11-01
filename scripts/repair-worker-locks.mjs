import "dotenv/config";
import { collections } from "../src/config/store.js";
import { Timestamp } from "../src/lib/values.js";

/**
 * Repairs the worker-side active-job lock so the "one active job" rule is
 * enforced against the worker document again.
 *
 * Source of truth is the bookings collection:
 *   - status "accepted" or "ongoing" with activeJob === true
 *
 * Workers whose lock is missing or stale are aligned to their active booking.
 * Locks that point at a finished/cancelled/unrelated booking are cleared.
 *
 * Usage:
 *   node scripts/repair-worker-locks.mjs           # dry run
 *   node scripts/repair-worker-locks.mjs --apply   # write changes
 */

const apply = process.argv.includes("--apply");

const activeSnap = await collections.bookings
  .where("activeJob", "==", true)
  .limit(1000)
  .get();

const activeByWorker = new Map();
const bookingById = new Map();
for (const doc of activeSnap.docs) {
  const booking = doc.data();
  bookingById.set(doc.id, booking);
  if (!["accepted", "ongoing"].includes(booking.status)) continue;
  if (!booking.workerId) continue;
  const list = activeByWorker.get(booking.workerId) || [];
  list.push({ id: doc.id, acceptedAt: booking.acceptedAt, status: booking.status });
  activeByWorker.set(booking.workerId, list);
}

const workerSnap = await collections.workers.limit(2000).get();
const changes = [];

function pickLatest(list) {
  return list
    .slice()
    .sort((a, b) => {
      const at = a.acceptedAt?.toMillis?.() || 0;
      const bt = b.acceptedAt?.toMillis?.() || 0;
      return bt - at;
    })[0];
}

for (const doc of workerSnap.docs) {
  const worker = doc.data();
  const currentLock = worker.activeJobBookingId || null;
  const actives = activeByWorker.get(doc.id) || [];

  if (actives.length > 1) {
    console.warn(
      `WARN worker ${doc.id.slice(0, 8)} has ${actives.length} active bookings: ${actives
        .map((b) => b.id.slice(0, 8))
        .join(", ")} — keeping the latest lock only.`,
    );
  }

  if (actives.length) {
    const target = pickLatest(actives);
    if (currentLock !== target.id) {
      changes.push({
        workerId: doc.id,
        from: currentLock,
        to: target.id,
        reason: currentLock ? "stale lock" : "missing lock",
      });
    }
    continue;
  }

  if (currentLock) {
    const lockBooking = bookingById.get(currentLock);
    const stillActive =
      lockBooking &&
      ["accepted", "ongoing"].includes(lockBooking.status) &&
      lockBooking.activeJob === true;
    if (!stillActive) {
      changes.push({
        workerId: doc.id,
        from: currentLock,
        to: null,
        reason: "lock points to inactive booking",
      });
    }
  }
}

console.log(`${changes.length} worker lock change(s)${apply ? "" : " (dry run)"}`);
for (const change of changes) {
  console.log(
    [
      change.workerId.slice(0, 8),
      change.from ? change.from.slice(0, 8) : "none",
      "->",
      change.to ? change.to.slice(0, 8) : "none",
      `(${change.reason})`,
    ].join(" "),
  );
}

if (apply && changes.length) {
  const now = Timestamp.now();
  for (const change of changes) {
    await collections.workers.doc(change.workerId).set(
      {
        activeJobBookingId: change.to || null,
        updatedAt: now,
      },
      { merge: true },
    );
  }
  console.log(`applied ${changes.length} change(s)`);
}

process.exit(0);
