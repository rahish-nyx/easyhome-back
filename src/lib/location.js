import { distanceMeters } from "./geo.js";

function sameText(a, b) {
  return (
    String(a || "").trim().toLowerCase() ===
    String(b || "").trim().toLowerCase()
  );
}

function textIncludes(haystack, needle) {
  const text = String(haystack || "").toLowerCase();
  const term = String(needle || "").trim().toLowerCase();
  return Boolean(text && term && text.includes(term));
}

function workerCity(worker) {
  return String(worker?.city || worker?.cityName || "").trim();
}

function workerState(worker) {
  return String(worker?.state || worker?.stateName || "").trim();
}

function workerArea(worker) {
  return String(worker?.areaName || "").trim();
}

function bookingCity(booking) {
  return String(booking?.cityName || booking?.city || "").trim();
}

function bookingState(booking) {
  return String(booking?.stateName || booking?.state || "").trim();
}

function bookingArea(booking) {
  return String(booking?.areaName || "").trim();
}

/**
 * Strict service-area match for a worker and a booking.
 *
 * City and state are hard boundaries. When both sides name a local area, the
 * area must match as well. Coordinates are a secondary safety net for legacy
 * records that predate city/area keys.
 */
export function workerMatchesBooking(worker, booking) {
  if (!worker || !booking) return false;

  const city = bookingCity(booking);
  const state = bookingState(booking);
  const area = bookingArea(booking);

  if (city) {
    const ownCity = workerCity(worker);
    if (ownCity) {
      if (!sameText(ownCity, city)) return false;
    } else if (!textIncludes(worker?.area, city)) {
      return false;
    }
  }

  if (state) {
    const ownState = workerState(worker);
    if (ownState && !sameText(ownState, state)) return false;
  }

  if (area) {
    const ownArea = workerArea(worker);
    if (ownArea && !sameText(ownArea, area)) return false;
  }

  const workerPoint = {
    lat: worker?.lat,
    lng: worker?.lng,
  };
  const jobPoint = booking?.location || booking;
  const distance = distanceMeters(workerPoint, jobPoint);
  const exactArea = Boolean(area && workerArea(worker) && sameText(workerArea(worker), area));

  if (distance !== null && !exactArea) {
    const radiusKm = Math.max(1, Number(worker?.radiusKm) || 25);
    if (distance > radiusKm * 1000) return false;
  } else if (!city && !area) {
    // No city, area or coordinates means there is no safe way to prove this
    // job is local. Keep it out of the worker's feed.
    return false;
  }

  return true;
}

/** Checks whether a public/urgent booking belongs to a customer's location. */
export function bookingMatchesLocation(booking, location) {
  if (!booking) return false;
  if (!location) return true;

  const city = String(location.name || location.cityName || "").trim();
  const state = String(location.state || location.stateName || "").trim();
  const area = String(location.areaName || location.area || "").trim();

  if (city) {
    const ownCity = bookingCity(booking);
    if (ownCity) {
      if (!sameText(ownCity, city)) return false;
    } else if (!textIncludes(booking?.area, city)) {
      return false;
    }
  }

  if (state) {
    const ownState = bookingState(booking);
    if (ownState && !sameText(ownState, state)) return false;
  }

  if (area) {
    const ownArea = bookingArea(booking);
    if (ownArea && !sameText(ownArea, area)) return false;
  }

  // Legacy records may not have city/area keys. In that case fall back to a
  // radius check so cross-region jobs still never leak into a local feed.
  if (!bookingCity(booking) && !bookingArea(booking)) {
    const distance = distanceMeters(
      { lat: location.lat, lng: location.lng },
      booking?.location || booking,
    );
    const radiusKm = Number(location.radiusKm) || 0;
    if (distance === null || radiusKm <= 0) return false;
    return distance <= radiusKm * 1000;
  }

  return true;
}

export { sameText as sameLocationText };
