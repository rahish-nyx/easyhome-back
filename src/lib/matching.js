import { getDistance } from "geolib";
import { hasCoords } from "./geo.js";

const DEFAULT_RADIUS_KM = 10;

function zonePoint(zone) {
  const rawLat = zone?.latitude ?? zone?.lat;
  const rawLng = zone?.longitude ?? zone?.lng;
  if (rawLat === null || rawLat === undefined || rawLat === "") return null;
  if (rawLng === null || rawLng === undefined || rawLng === "") return null;
  const point = { lat: Number(rawLat), lng: Number(rawLng) };
  if (!hasCoords(point)) return null;
  return point;
}

function zoneRadiusKm(zone) {
  return Math.max(0.5, Number(zone?.radiusKm) || DEFAULT_RADIUS_KM);
}

function isInsideZone(zone, point) {
  const center = zonePoint(zone);
  if (!center || !hasCoords(point)) return false;
  const distance = getDistance(
    { latitude: center.lat, longitude: center.lng },
    { latitude: point.lat, longitude: point.lng },
  );
  return distance <= zoneRadiusKm(zone) * 1000;
}

function sameText(a, b) {
  return String(a || "").trim().toLocaleLowerCase() ===
    String(b || "").trim().toLocaleLowerCase();
}

function workerPoint(worker) {
  const current = { lat: worker?.currentLat, lng: worker?.currentLng };
  const lastLocation = worker?.lastLocationAt;
  const updatedAt =
    typeof lastLocation?.toMillis === "function"
      ? lastLocation.toMillis()
      : lastLocation instanceof Date
        ? lastLocation.getTime()
        : typeof lastLocation === "string"
          ? new Date(lastLocation).getTime()
          : null;
  if (
    hasCoords(current) &&
    Number.isFinite(updatedAt) &&
    Date.now() - updatedAt <= 10 * 60 * 1000
  ) {
    return { lat: Number(current.lat), lng: Number(current.lng) };
  }
  if (!hasCoords(worker)) return null;
  return { lat: Number(worker.lat), lng: Number(worker.lng) };
}

/**
 * Effective match radius. A service zone defines the outer limit; a worker
 * can opt into a smaller personal radius. Without a zone we still use 10 km so
 * nearby workers in the same area are matched even when their city/area labels
 * differ (for example a customer in Giridih and a worker in the adjacent ward).
 */
function matchRadiusKm(worker, zone) {
  const outer = zone ? zoneRadiusKm(zone) : DEFAULT_RADIUS_KM;
  const personal = Number(worker?.radiusKm);
  if (Number.isFinite(personal) && personal > 0) {
    return Math.min(outer, personal);
  }
  return outer;
}

function distanceMetersBetween(point, target) {
  return getDistance(
    { latitude: point.lat, longitude: point.lng },
    { latitude: target.lat, longitude: target.lng },
  );
}

function textMatches(worker, location) {
  const city = String(location?.cityName || location?.city || "").trim();
  const state = String(location?.stateName || location?.state || "").trim();
  const area = String(location?.areaName || "").trim();
  const workerCity = String(worker?.city || worker?.cityName || "").trim();
  const workerState = String(worker?.state || worker?.stateName || "").trim();
  const workerArea = String(worker?.areaName || "").trim();
  if (!city || !state || !workerCity || !workerState) return false;
  if (!sameText(workerCity, city) || !sameText(workerState, state)) {
    return false;
  }
  if (area && (!workerArea || !sameText(workerArea, area))) return false;
  return true;
}

export function workerDistanceKm(worker, location) {
  const point = workerPoint(worker);
  const target = {
    lat: Number(location?.lat),
    lng: Number(location?.lng),
  };
  if (!point || !hasCoords(target)) return null;
  return distanceMetersBetween(point, target) / 1000;
}

function bookingPoint(booking, zone) {
  if (hasCoords(booking?.location)) {
    return {
      lat: Number(booking.location.lat),
      lng: Number(booking.location.lng),
    };
  }
  return zonePoint(zone);
}

export function workerMatchesBooking(worker, booking, zone = null) {
  if (
    !worker ||
    !booking ||
    worker.status !== "approved" ||
    worker.online !== true
  ) {
    return false;
  }

  const workerId = worker.uid || worker.id;
  if (booking.preferredWorkerId && booking.preferredWorkerId !== workerId) {
    return false;
  }
  if (!booking.serviceKey) return false;

  const workerTrades = Array.isArray(worker.trades) ? worker.trades : [];
  const hasTrade = worker.serviceKey === booking.serviceKey || workerTrades.includes(booking.serviceKey);
  if (!hasTrade) {
    return false;
  }

  const target = bookingPoint(booking, zone);
  const point = workerPoint(worker);

  // Text matching is only a fallback for legacy records without coordinates.
  if (!target || !point) {
    return textMatches(worker, booking);
  }

  if (zone) {
    if (zone.isActive !== true || !zonePoint(zone)) return false;
    if (!isInsideZone(zone, target)) return false;
  }

  const radiusKm = matchRadiusKm(worker, zone);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return false;
  return distanceMetersBetween(point, target) <= radiusKm * 1000;
}

export function workerMatchesLocation(worker, location, zone = null) {
  if (!worker || worker.online !== true || !location) return false;

  const target = { lat: Number(location.lat), lng: Number(location.lng) };
  const point = workerPoint(worker);

  if (zone) {
    if (zone.isActive === false || !zonePoint(zone)) return false;
    if (hasCoords(target) && !isInsideZone(zone, target)) return false;
  }

  if (!hasCoords(target) || !point) {
    return textMatches(worker, location);
  }

  const radiusKm = matchRadiusKm(worker, zone);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return false;
  return distanceMetersBetween(point, target) <= radiusKm * 1000;
}

export function prioritizeWorkers(workers, isPremium) {
  return [...workers].sort((a, b) => {
    const aPremium = isPremium(a);
    const bPremium = isPremium(b);
    if (aPremium !== bPremium) return aPremium ? -1 : 1;
    const ratingDifference = (Number(b.rating) || 0) - (Number(a.rating) || 0);
    if (ratingDifference) return ratingDifference;
    const reviewDifference =
      (Number(b.reviewCount) || 0) - (Number(a.reviewCount) || 0);
    if (reviewDifference) return reviewDifference;
    return (Number(b.jobsCompleted) || 0) - (Number(a.jobsCompleted) || 0);
  });
}
