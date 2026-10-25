import { getDistance } from "geolib";
import { collections } from "../config/firebase.js";
import { docsToJson } from "./utils.js";

export const OUT_OF_ZONE_MESSAGE =
  "We are expanding fast! We'll be in your area soon.";

function coord(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function zonePoint(zone) {
  const latitude = coord(zone?.latitude ?? zone?.lat);
  const longitude = coord(zone?.longitude ?? zone?.lng);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

export function zoneRadiusKm(zone) {
  return Math.max(0.5, Number(zone?.radiusKm) || 10);
}

export function normalizeZone(zone) {
  if (!zone) return null;
  return {
    ...zone,
    areaName: String(zone.areaName || zone.area || "").trim(),
    latitude: coord(zone.latitude ?? zone.lat),
    longitude: coord(zone.longitude ?? zone.lng),
    radiusKm: zoneRadiusKm(zone),
    isActive: zone.isActive !== false,
  };
}

function sameText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function cityMatches(zone, cityName, state = "") {
  if (!cityName) return true;
  if (!sameText(zone.cityName, cityName)) return false;
  if (state && zone.state && !sameText(zone.state, state)) return false;
  return true;
}

/**
 * When an admin creates local-area zones for a city, those area zones become
 * authoritative for that city. A disabled area must not silently fall back to
 * a broader city zone. Cities without area zones keep using city-level zones.
 */
export function candidateZones(zones, { cityName, state, areaName } = {}) {
  const active = (zones || []).map(normalizeZone).filter((zone) => zone && zone.isActive !== false);
  if (!cityName) return active;
  const cityZones = active.filter((zone) => cityMatches(zone, cityName, state));
  const areaZones = cityZones.filter((zone) => zone.areaName);
  if (areaName) {
    if (areaZones.length) {
      return areaZones.filter((zone) => sameText(zone.areaName, areaName));
    }
    return cityZones.filter((zone) => !zone.areaName);
  }
  return areaZones.length ? areaZones : cityZones;
}

export function zoneForArea(zones, cityName, state, areaName) {
  return (
    candidateZones(zones, { cityName, state, areaName }).find(
      (zone) => !areaName || sameText(zone.areaName, areaName),
    ) || null
  );
}

export function distanceToZoneMeters(zone, point) {
  const a = zonePoint(zone);
  const lat = coord(point?.lat ?? point?.latitude);
  const lng = coord(point?.lng ?? point?.longitude);
  if (!a || lat === null || lng === null) return null;
  return getDistance(a, { latitude: lat, longitude: lng });
}

export function isInsideZone(zone, point) {
  const meters = distanceToZoneMeters(zone, point);
  if (meters === null) return false;
  return meters <= zoneRadiusKm(zone) * 1000;
}

export function nearestZone(zones, point) {
  const ranked = (zones || [])
    .map((zone) => ({
      zone: normalizeZone(zone),
      distanceMeters: distanceToZoneMeters(zone, point),
    }))
    .filter((item) => item.zone && item.distanceMeters !== null)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  return ranked[0] || null;
}

/**
 * Checks a coordinate or city name against the admin-managed service zones.
 * Active zones are authoritative. If no zones exist yet, existing city-based
 * coverage remains available as a safe fallback.
 */
export function evaluateServiceZones(
  zones,
  { lat, lng, cityName, state, areaName } = {},
) {
  const active = (zones || [])
    .map(normalizeZone)
    .filter((zone) => zone && zone.isActive !== false);

  if (!active.length) {
    return {
      allowed: true,
      configured: false,
      zone: null,
      nearest: null,
      message: "",
    };
  }

  const candidates = candidateZones(active, { cityName, state, areaName });
  const latitude = coord(lat);
  const longitude = coord(lng);
  const hasPoint = latitude !== null && longitude !== null;

  if (hasPoint) {
    const point = { lat: latitude, lng: longitude };
    const inside = candidates
      .filter((zone) => isInsideZone(zone, point))
      .sort(
        (a, b) =>
          (distanceToZoneMeters(a, point) || 0) - (distanceToZoneMeters(b, point) || 0),
      );
    const nearest = nearestZone(candidates.length ? candidates : active, point);

    if (inside.length) {
      const zone = inside[0];
      return {
        allowed: true,
        configured: true,
        zone,
        nearest,
        distanceMeters: distanceToZoneMeters(zone, point),
        message: `We serve ${zone.areaName || zone.cityName || "your area"}.`,
      };
    }

    return {
      allowed: false,
      configured: true,
      reason: "coordinates_outside_zones",
      zone: null,
      nearest,
      distanceMeters: nearest?.distanceMeters ?? null,
      message: OUT_OF_ZONE_MESSAGE,
    };
  }

  const match = candidates.find((zone) => {
    if (!cityName) return false;
    if (!sameText(zone.cityName, cityName)) return false;
    if (state && zone.state && !sameText(zone.state, state)) return false;
    if (areaName && zone.areaName && !sameText(zone.areaName, areaName)) return false;
    return true;
  });

  if (match) {
    return {
      allowed: true,
      configured: true,
      zone: match,
      nearest: null,
      distanceMeters: 0,
      message: `We serve ${match.areaName || match.cityName || "your area"}.`,
    };
  }

  return {
    allowed: false,
    configured: true,
    reason: "location_missing",
    zone: null,
    nearest: null,
    distanceMeters: null,
    message: OUT_OF_ZONE_MESSAGE,
  };
}

export async function activeServiceZones() {
  const snap = await collections.serviceZones.where("isActive", "==", true).get();
  return docsToJson(snap).map(normalizeZone).filter(Boolean);
}

export async function allServiceZones() {
  const snap = await collections.serviceZones.get();
  return docsToJson(snap)
    .map(normalizeZone)
    .filter(Boolean)
    .sort((a, b) => String(a.state || "").localeCompare(String(b.state || "")) ||
      String(a.cityName || "").localeCompare(String(b.cityName || "")));
}

export async function validateBookingZone({ lat, lng, cityName, state, areaName } = {}) {
  const zones = await activeServiceZones();
  return evaluateServiceZones(zones, { lat, lng, cityName, state, areaName });
}
