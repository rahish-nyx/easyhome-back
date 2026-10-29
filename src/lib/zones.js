import { getDistance } from "geolib";
import { collections } from "../config/store.js";
import { docsToJson } from "./utils.js";

export const OUT_OF_ZONE_MESSAGE =
  "We are expanding soon. We will be in your area soon.";

function coord(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validPoint(lat, lng) {
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

export function zonePoint(zone) {
  const latitude = coord(zone?.latitude ?? zone?.lat);
  const longitude = coord(zone?.longitude ?? zone?.lng);
  return validPoint(latitude, longitude);
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

function candidateZones(
  zones,
  { cityName, state, areaName, allowAnyArea = false } = {},
) {
  if (!cityName) return zones;
  const city = String(cityName).trim().toLowerCase();
  const region = String(state || "").trim().toLowerCase();
  const area = String(areaName || "").trim().toLowerCase();
  const matchingCity = zones.filter((zone) => {
    if (String(zone.cityName || "").trim().toLowerCase() !== city) return false;
    return (
      !region ||
      !zone.state ||
      String(zone.state).trim().toLowerCase() === region
    );
  });
  if (!matchingCity.length) return [];

  const cityWide = matchingCity.filter((zone) => !zone.areaName);
  const local = matchingCity.filter((zone) => zone.areaName);
  if (!area) return cityWide.length ? cityWide : allowAnyArea ? local : [];
  const matchingArea = local.filter(
    (zone) => String(zone.areaName).trim().toLowerCase() === area,
  );
  if (matchingArea.length) return matchingArea;
  return cityWide.length ? cityWide : allowAnyArea ? local : [];
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
      allowed: !(zones || []).length,
      configured: Boolean((zones || []).length),
      zone: null,
      nearest: null,
      message: (zones || []).length ? OUT_OF_ZONE_MESSAGE : "",
    };
  }

  const latitude = coord(lat);
  const longitude = coord(lng);
  const hasPoint = latitude !== null && longitude !== null;

  if (hasPoint) {
    const point = { lat: latitude, lng: longitude };

    // Coordinates are authoritative. Matching another city label (for example
    // a reverse-geocoded district name) must never hide a live zone that
    // actually contains the customer.
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

    // Fallback: if no zone contains the point by distance, but the customer's
    // city/state matches an active zone (e.g. zone has missing/old coords),
    // allow the booking so a bad zone record never breaks live service.
    const cityMatch = candidateZones(active, { cityName, state, areaName })[0];
    if (cityMatch) {
      return {
        allowed: true,
        configured: true,
        zone: cityMatch,
        nearest,
        distanceMeters: nearest?.distanceMeters ?? null,
        message: `We serve ${cityMatch.cityName || "your area"}.`,
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

  const match = candidateZones(active, { cityName, state, areaName })[0];
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

const ZONES_CACHE_TTL_MS = 60 * 1000;
let zonesCache = null;
let zonesCachedAt = 0;
let zonesCachePromise = null;

export function invalidateZoneCache() {
  zonesCache = null;
  zonesCachedAt = 0;
  zonesCachePromise = null;
}

export async function activeServiceZones() {
  return (await allServiceZones()).filter((zone) => zone.isActive !== false);
}

export async function allServiceZones() {
  if (
    zonesCache !== null &&
    Date.now() - zonesCachedAt < ZONES_CACHE_TTL_MS
  ) {
    return zonesCache;
  }

  if (zonesCachePromise) return zonesCachePromise;

  zonesCachePromise = (async () => {
    try {
      const snap = await collections.serviceZones.get();
      const zones = docsToJson(snap)
        .map(normalizeZone)
        .filter(Boolean)
        .sort((a, b) => String(a.state || "").localeCompare(String(b.state || "")) ||
          String(a.cityName || "").localeCompare(String(b.cityName || "")));
      zonesCache = zones;
      zonesCachedAt = Date.now();
      return zones;
    } catch (error) {
      // Keep dispatch alive during a transient database outage.
      if (zonesCache !== null) return zonesCache;
      throw error;
    } finally {
      zonesCachePromise = null;
    }
  })();

  return zonesCachePromise;
}

export async function validateBookingZone(
  { lat, lng, cityName, state, areaName } = {},
) {
  const zones = await allServiceZones();
  return evaluateServiceZones(zones, { lat, lng, cityName, state, areaName });
}
