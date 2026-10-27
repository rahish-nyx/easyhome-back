import { getDistance } from "geolib";

function coordinate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function usablePoint(point) {
  const lat = coordinate(point?.lat ?? point?.latitude);
  const lng = coordinate(point?.lng ?? point?.longitude);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  // Null Island is the default value many devices and imports produce when
  // location is missing. Treating it as real coordinates displaces workers by
  // thousands of kilometres and hides them from local dispatch.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

export function distanceMeters(a, b) {
  const first = usablePoint(a);
  const second = usablePoint(b);
  if (!first || !second) return null;

  return Math.round(
    getDistance(
      { latitude: first.lat, longitude: first.lng },
      { latitude: second.lat, longitude: second.lng },
    ),
  );
}

export function hasCoords(value) {
  return usablePoint(value) !== null;
}

/**
 * Returns the nearest active service city for a coordinate.
 * `cities` are Firestore city documents: { name, lat, lng, radiusKm, active }.
 */
export function nearestServiceArea(cities, lat, lng) {
  if (!hasCoords({ lat, lng })) {
    return { allowed: false, error: "Valid location is required." };
  }

  const active = (cities || []).filter(
    (city) => city && city.active !== false && hasCoords(city),
  );

  if (active.length === 0) {
    return { allowed: true, city: null, radiusKm: null, distanceMeters: 0 };
  }

  const ranked = active
    .map((city) => ({
      city,
      distance: distanceMeters({ lat, lng }, city),
      radiusKm: Number(city.radiusKm) || 10,
    }))
    .sort((a, b) => a.distance - b.distance);

  const nearest = ranked[0];
  const allowed = nearest.distance <= nearest.radiusKm * 1000;

  return {
    allowed,
    city: nearest.city,
    radiusKm: nearest.radiusKm,
    distanceMeters: nearest.distance,
    nearest,
  };
}

export function mapsDirectionsUrl(lat, lng, label = "") {
  const destination = `${lat},${lng}`;
  const query = label ? encodeURIComponent(label) : "";
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}${
    query ? `&destination_place_id=&travelmode=driving` : ""
  }`;
}
