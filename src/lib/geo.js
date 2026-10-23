const EARTH_RADIUS_M = 6371000;

export function distanceMeters(a, b) {
  if (
    !Number.isFinite(Number(a?.lat)) ||
    !Number.isFinite(Number(a?.lng)) ||
    !Number.isFinite(Number(b?.lat)) ||
    !Number.isFinite(Number(b?.lng))
  ) {
    return null;
  }

  const lat1 = (Number(a.lat) * Math.PI) / 180;
  const lat2 = (Number(b.lat) * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLng = ((Number(b.lng) - Number(a.lng)) * Math.PI) / 180;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)));
}

export function hasCoords(value) {
  return (
    Number.isFinite(Number(value?.lat)) && Number.isFinite(Number(value?.lng))
  );
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
