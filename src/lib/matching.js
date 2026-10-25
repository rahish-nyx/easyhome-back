import { getDistance } from "geolib";
import { hasCoords } from "./geo.js";

function zonePoint(zone) {
  const rawLat = zone?.latitude ?? zone?.lat;
  const rawLng = zone?.longitude ?? zone?.lng;
  if (rawLat === null || rawLat === undefined || rawLat === "") return null;
  if (rawLng === null || rawLng === undefined || rawLng === "") return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function zoneRadiusKm(zone) {
  return Math.max(0.5, Number(zone?.radiusKm) || 10);
}

function isInsideZone(zone, point) {
  const center = zonePoint(zone);
  if (!center) return false;
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

export function workerDistanceKm(worker, location) {
  const point = workerPoint(worker);
  const target = {
    lat: Number(location?.lat),
    lng: Number(location?.lng),
  };
  if (!point || !hasCoords(target)) return null;
  return (
    getDistance(
      { latitude: point.lat, longitude: point.lng },
      { latitude: target.lat, longitude: target.lng },
    ) / 1000
  );
}

function bookingPoint(booking, zone) {
  if (hasCoords(booking?.location)) {
    return { lat: Number(booking.location.lat), lng: Number(booking.location.lng) };
  }
  return zonePoint(zone);
}

export function workerMatchesBooking(worker, booking, zone = null) {
  if (!worker || !booking || worker.status !== "approved" || worker.online !== true) {
    return false;
  }

  const workerId = worker.uid || worker.id;
  if (booking.preferredWorkerId && booking.preferredWorkerId !== workerId) {
    return false;
  }
  if (!booking.serviceKey || worker.serviceKey !== booking.serviceKey) return false;

  const city = String(booking.cityName || booking.city || "").trim();
  const state = String(booking.stateName || booking.state || "").trim();
  const area = String(booking.areaName || "").trim();
  const workerCity = String(worker.city || worker.cityName || "").trim();
  const workerState = String(worker.state || worker.stateName || "").trim();
  const workerArea = String(worker.areaName || "").trim();

  if (!city || !state || !workerCity || !workerState) return false;
  if (!sameText(workerCity, city) || !sameText(workerState, state)) return false;
  if (area && (!workerArea || !sameText(workerArea, area))) return false;

  if (zone) {
    if (zone.isActive !== true || !zonePoint(zone)) return false;
    if (!sameText(zone.cityName, city) || !sameText(zone.state, state)) return false;
    const zoneArea = String(zone.areaName || zone.area || "").trim();
    if (zoneArea && !sameText(zoneArea, area)) return false;
  }

  const point = workerPoint(worker);
  const target = bookingPoint(booking, zone);
  if (!point || !target) return false;

  const distanceMeters = getDistance(
    { latitude: point.lat, longitude: point.lng },
    { latitude: target.lat, longitude: target.lng },
  );
  const workerRadius = Number(worker.radiusKm);
  const radiusKm = zone
    ? Math.min(zoneRadiusKm(zone), workerRadius > 0 ? workerRadius : zoneRadiusKm(zone))
    : workerRadius;

  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || distanceMeters > radiusKm * 1000) {
    return false;
  }
  if (zone && !isInsideZone(zone, point)) return false;

  return true;
}

export function workerMatchesLocation(worker, location, zone = null) {
  if (!worker || worker.online !== true || !location) return false;

  const city = String(location.cityName || location.city || "").trim();
  const state = String(location.state || "").trim();
  const area = String(location.areaName || "").trim();
  const workerCity = String(worker.city || worker.cityName || "").trim();
  const workerState = String(worker.state || worker.stateName || "").trim();
  const workerArea = String(worker.areaName || "").trim();
  if (!city || !state || !workerCity || !workerState) return false;
  if (!sameText(workerCity, city) || !sameText(workerState, state)) return false;
  if (area && (!workerArea || !sameText(workerArea, area))) return false;

  if (zone) {
    if (
      zone.isActive !== true ||
      !zonePoint(zone) ||
      !sameText(zone.cityName, city) ||
      !sameText(zone.state, state) ||
      (zone.areaName && !sameText(zone.areaName, area)) ||
      !isInsideZone(zone, location)
    ) {
      return false;
    }
  }

  const point = workerPoint(worker);
  const target = { lat: Number(location.lat), lng: Number(location.lng) };
  if (!point || !hasCoords(target)) return false;

  const workerRadius = Number(worker.radiusKm);
  const radiusKm = zone
    ? Math.min(zoneRadiusKm(zone), workerRadius > 0 ? workerRadius : zoneRadiusKm(zone))
    : workerRadius;
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return false;

  const distanceMeters = getDistance(
    { latitude: point.lat, longitude: point.lng },
    { latitude: target.lat, longitude: target.lng },
  );
  return (
    distanceMeters <= radiusKm * 1000 &&
    (!zone || isInsideZone(zone, point))
  );
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
