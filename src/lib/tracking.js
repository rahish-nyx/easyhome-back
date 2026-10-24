import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { collections } from "../config/firebase.js";
import { distanceMeters } from "./geo.js";
import { notify, notifyAdmins } from "./notify.js";
import { toDate } from "./utils.js";

export const TRACKING_PHASES = Object.freeze({
  ASSIGNED: "assigned",
  EN_ROUTE: "en_route",
  ARRIVED: "arrived",
  WORKING: "working",
  COMPLETED: "completed",
});

export const PHASE_META = Object.freeze({
  assigned: {
    label: "Assigned",
    short: "Assigned",
    status: "accepted",
    hint: "A professional has accepted this job.",
  },
  en_route: {
    label: "En route to location",
    short: "En route",
    status: "accepted",
    hint: "Your professional is on the way.",
  },
  arrived: {
    label: "Arrived",
    short: "Arrived",
    status: "accepted",
    hint: "Your professional has reached the location.",
  },
  working: {
    label: "Work in progress",
    short: "Working",
    status: "ongoing",
    hint: "The job is now in progress.",
  },
  completed: {
    label: "Completed",
    short: "Completed",
    status: "completed",
    hint: "The job has been completed.",
  },
});

export const INACTIVITY_MS = 10 * 60 * 1000;
export const NUDGE_REPEAT_MS = 10 * 60 * 1000;
export const ACTIVE_PHASES = [
  TRACKING_PHASES.ASSIGNED,
  TRACKING_PHASES.EN_ROUTE,
  TRACKING_PHASES.ARRIVED,
  TRACKING_PHASES.WORKING,
];

export function phaseForBooking(booking) {
  if (booking?.trackingPhase && PHASE_META[booking.trackingPhase]) {
    return booking.trackingPhase;
  }
  if (booking?.status === "completed") return TRACKING_PHASES.COMPLETED;
  if (booking?.status === "ongoing") return TRACKING_PHASES.WORKING;
  if (booking?.status === "accepted") return TRACKING_PHASES.ASSIGNED;
  return null;
}

export function phaseMeta(phase) {
  return PHASE_META[phase] || null;
}

export function nextPhase(phase) {
  const order = ACTIVE_PHASES;
  const index = order.indexOf(phase);
  if (index === -1 || index === order.length - 1) return null;
  return order[index + 1];
}

export function phaseHistoryEntry({
  phase,
  status,
  actorId = "",
  actorRole = "system",
  lat = null,
  lng = null,
  note = "",
}) {
  const meta = PHASE_META[phase] || {};
  return {
    phase,
    status: status || meta.status || "",
    label: meta.label || phase,
    actorId,
    actorRole,
    note: String(note || "").slice(0, 240),
    lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
    lng: Number.isFinite(Number(lng)) ? Number(lng) : null,
    at: Timestamp.now(),
  };
}

export function lastActivityAt(booking) {
  const values = [
    booking?.lastUpdatedTimestamp,
    booking?.lastLocationAt,
    booking?.trackingStatusUpdatedAt,
    booking?.acceptedAt,
  ]
    .map(toDate)
    .filter(Boolean);
  if (!values.length) return null;
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

export function idleMinutes(booking, now = Date.now()) {
  const last = lastActivityAt(booking);
  if (!last) return 0;
  return Math.max(0, Math.floor((now - last.getTime()) / 60000));
}

export function isStaleJob(booking, now = Date.now()) {
  if (!booking?.activeJob) return false;
  if (!["accepted", "ongoing"].includes(booking.status)) return false;
  const last = lastActivityAt(booking);
  if (!last) return false;
  return now - last.getTime() >= INACTIVITY_MS;
}

export function trackingEta(booking, worker) {
  const lat = Number(booking?.currentLat ?? worker?.lat);
  const lng = Number(booking?.currentLng ?? worker?.lng);
  const targetLat = Number(booking?.location?.lat);
  const targetLng = Number(booking?.location?.lng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !Number.isFinite(targetLat) ||
    !Number.isFinite(targetLng)
  ) {
    return { distanceMeters: null, etaMinutes: null };
  }

  const meters = distanceMeters(
    { lat, lng },
    { lat: targetLat, lng: targetLng },
  );
  if (meters === null) return { distanceMeters: null, etaMinutes: null };

  // A conservative city travel speed keeps ETAs useful without pretending to
  // be a live traffic engine. The UI labels this as an estimate.
  const etaMinutes =
    meters < 180 ? 0 : Math.max(1, Math.round(((meters / 1000) / 20) * 60));
  return { distanceMeters: meters, etaMinutes };
}

export function trackingSnapshot(booking) {
  const phase = phaseForBooking(booking);
  const meta = phaseMeta(phase);
  const last = lastActivityAt(booking);
  return {
    phase,
    label: meta?.label || booking?.status || "Pending",
    hint: meta?.hint || "",
    active: Boolean(booking?.activeJob),
    inactive: isStaleJob(booking),
    idleMinutes: idleMinutes(booking),
    alert: Boolean(booking?.trackingAlert),
    currentLat: Number.isFinite(Number(booking?.currentLat))
      ? Number(booking.currentLat)
      : null,
    currentLng: Number.isFinite(Number(booking?.currentLng))
      ? Number(booking.currentLng)
      : null,
    accuracyMeters: Number.isFinite(Number(booking?.currentAccuracy))
      ? Math.round(Number(booking.currentAccuracy))
      : null,
    lastUpdatedTimestamp: last ? last.toISOString() : null,
    lastLocationAt: toDate(booking?.lastLocationAt)?.toISOString() || null,
    history: Array.isArray(booking?.statusHistory)
      ? booking.statusHistory.slice(-12)
      : [],
  };
}

/**
 * Persists the alert and sends the worker an in-app high-priority notification.
 * The worker app also watches `trackingAlert` and sounds its local buzzer.
 */
export async function sendTrackingNudge(ref, booking, { actor = "system" } = {}) {
  if (!booking?.workerId) return false;
  const now = FieldValue.serverTimestamp();
  await ref.set(
    {
      trackingAlert: true,
      trackingAlertAt: now,
      trackingAlertSentAt: now,
      trackingNudgeCount: FieldValue.increment(1),
      updatedAt: now,
    },
    { merge: true },
  );

  await notify(booking.workerId, {
    title: "Action Required: update your job tracking",
    body: `Please update your status or location for ${booking.service || "your active job"} at ${
      booking.area || "the customer location"
    }.`,
    type: "tracking_alert",
    link: `/worker?job=${ref.id}&alert=1`,
  });

  if (actor !== "system") {
    await notifyAdmins({
      title: "Tracking nudge sent",
      body: `${actor === "admin" ? "An admin" : "EasyHome"} nudged ${
        booking.workerName || "a worker"
      } on ${booking.service || "an active job"}.`,
      type: "tracking_alert",
      link: "/admin/tracking",
    });
  }

  return true;
}

/**
 * Finds active jobs whose status and GPS heartbeat have not changed for ten
 * minutes and nudges the assigned worker. Called by the worker app watchdog
 * and by the lightweight server interval in index.js.
 */
export async function sweepInactiveJobs({ limit = 150 } = {}) {
  const snap = await collections.bookings
    .where("activeJob", "==", true)
    .limit(limit)
    .get();

  if (snap.empty) return { scanned: 0, nudged: 0 };

  let nudged = 0;
  let scanned = 0;

  for (const doc of snap.docs) {
    const booking = doc.data();
    scanned += 1;
    if (!["accepted", "ongoing"].includes(booking.status)) {
      await doc.ref
        .set({ activeJob: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        .catch(() => {});
      continue;
    }

    const last = lastActivityAt(booking);
    if (!last) continue;
    const idleMs = Date.now() - last.getTime();

    if (idleMs < INACTIVITY_MS) {
      if (booking.trackingAlert) {
        await doc.ref
          .set({ trackingAlert: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          .catch(() => {});
      }
      continue;
    }

    const lastNudge = toDate(booking.trackingAlertSentAt);
    if (lastNudge && Date.now() - lastNudge.getTime() < NUDGE_REPEAT_MS) continue;

    const sent = await sendTrackingNudge(doc.ref, booking).catch(() => false);
    if (sent) nudged += 1;
  }

  return { scanned, nudged };
}

let watchdogTimer = null;

export function startTrackingWatchdog({ intervalMs = 60_000 } = {}) {
  if (watchdogTimer) return watchdogTimer;
  const tick = () => {
    sweepInactiveJobs().catch((error) => {
      console.warn("Tracking watchdog failed:", error.message);
    });
  };
  const initial = setTimeout(tick, 20_000);
  initial.unref?.();
  watchdogTimer = setInterval(tick, intervalMs);
  watchdogTimer.unref?.();
  return watchdogTimer;
}
