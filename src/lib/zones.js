import { getDistance } from "geolib";
import { collections } from "../config/firebase.js";
import { docsToJson } from "./utils.js";

export const OUT_OF_ZONE_MESSAGE =
  "We are not live in your location yet! Our services will get to your location soon.";

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
    latitude: coord(zone.latitude ?? zone.lat),
    longitude: coord(zone.longitude ?? zone.lng),
    radiusKm: zoneRadiusKm(zone),
    isActive: zone.isActive !== false,
  };
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
export function evaluateServiceZones(zones, { lat, lng, cityName, state } = {}) {
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

  const latitude = coord(lat);
  const longitude = coord(lng);
  const hasPoint = latitude !== null && longitude !== null;

  if (hasPoint) {
    const point = { lat: latitude, lng: longitude };
    const inside = active
      .filter((zone) => isInsideZone(zone, point))
      .sort(
        (a, b) =>
          (distanceToZoneMeters(a, point) || 0) - (distanceToZoneMeters(b, point) || 0),
      );
    const nearest = nearestZone(active, point);

    if (inside.length) {
      const zone = inside[0];
      return {
        allowed: true,
        configured: true,
        zone,
        nearest,
        distanceMeters: distanceToZoneMeters(zone, point),
        message: `We serve ${zone.cityName || "your area"}.`,
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

  const wantedCity = String(cityName || "").trim().toLowerCase();
  const wantedState = String(state || "").trim().toLowerCase();
  if (wantedCity) {
    const match = active.find((zone) => {
      const zoneCity = String(zone.cityName || "").trim().toLowerCase();
      const zoneState = String(zone.state || "").trim().toLowerCase();
      if (zoneCity !== wantedCity) return false;
      if (wantedState && zoneState && zoneState !== wantedState) return false;
      return true;
    });

    if (match) {
      return {
        allowed: true,
        configured: true,
        zone: match,
        nearest: null,
        distanceMeters: 0,
        message: `We serve ${match.cityName || "your area"}.`,
      };
    }
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

export async function validateBookingZone({ lat, lng, cityName, state } = {}) {
  const zones = await activeServiceZones();
  return evaluateServiceZones(zones, { lat, lng, cityName, state });
}
