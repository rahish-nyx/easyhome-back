import assert from "node:assert/strict";
import test from "node:test";
import {
  prioritizeWorkers,
  workerMatchesBooking,
  workerMatchesLocation,
} from "../src/lib/matching.js";
import { hasCoords } from "../src/lib/geo.js";
import { serviceZoneSchema } from "../src/lib/validate.js";
import { evaluateServiceZones } from "../src/lib/zones.js";

const zone = {
  id: "giridih-zone",
  cityName: "Giridih",
  state: "Jharkhand",
  latitude: 24.18,
  longitude: 86.3,
  radiusKm: 10,
  isActive: true,
};

const booking = {
  serviceKey: "plumbing",
  cityName: "Giridih",
  stateName: "Jharkhand",
  areaName: "Makatpur",
  location: { lat: 24.18, lng: 86.3 },
};

function worker(overrides = {}) {
  return {
    id: "worker-1",
    status: "approved",
    online: true,
    serviceKey: "plumbing",
    city: "Giridih",
    state: "Jharkhand",
    areaName: "Makatpur",
    lat: 24.19,
    lng: 86.31,
    radiusKm: 25,
    ...overrides,
  };
}

test("matches an online worker in the same service area and radius", () => {
  assert.equal(workerMatchesBooking(worker(), booking, zone), true);
});

test("matches nearby workers even when city, state, or locality labels differ", () => {
  // Radius is the source of truth. Reverse-geocoded labels can disagree for the
  // same physical neighbourhood, so they must not block a nearby match.
  assert.equal(workerMatchesBooking(worker({ city: "Ranchi" }), booking, zone), true);
  assert.equal(workerMatchesBooking(worker({ state: "Bihar" }), booking, zone), true);
  assert.equal(workerMatchesBooking(worker({ areaName: "Dumri" }), booking, zone), true);
});

test("rejects inactive zones and workers outside the configured radius", () => {
  assert.equal(
    workerMatchesBooking(worker(), booking, { ...zone, isActive: false }),
    false,
  );
  assert.equal(
    workerMatchesBooking(worker({ lat: 24.4, lng: 86.3 }), booking, zone),
    false,
  );
});

test("falls back to text matching for legacy records without coordinates", () => {
  assert.equal(workerMatchesBooking(worker({ lat: null, lng: null }), booking, zone), true);
  assert.equal(
    workerMatchesBooking(
      worker({ lat: null, lng: null, city: "Ranchi" }),
      booking,
      zone,
    ),
    false,
  );
});

test("prefers Pro workers among eligible candidates", () => {
  const standard = worker({ id: "standard", premium: false });
  const lowerRatedPro = worker({ id: "pro", premium: true, rating: 3.5 });
  const topRatedStandard = worker({
    id: "top-rated",
    premium: false,
    rating: 5,
    reviewCount: 20,
  });
  assert.deepEqual(
    prioritizeWorkers(
      [standard, lowerRatedPro, topRatedStandard],
      (candidate) => candidate.premium,
    ).map(
      (candidate) => candidate.id,
    ),
    ["pro", "top-rated", "standard"],
  );
});

test("nearby professionals must be online in the selected zone and radius", () => {
  const location = {
    cityName: "Giridih",
    state: "Jharkhand",
    areaName: "Makatpur",
    lat: 24.18,
    lng: 86.3,
  };
  assert.equal(workerMatchesLocation(worker(), location, zone), true);
  assert.equal(
    workerMatchesLocation(worker({ online: false }), location, zone),
    false,
  );
  assert.equal(
    workerMatchesLocation(worker({ lat: 24.4, lng: 86.3 }), location, zone),
    false,
  );
  assert.equal(
    workerMatchesLocation(
      worker({
        currentLat: 24.4,
        currentLng: 86.3,
        lastLocationAt: new Date().toISOString(),
      }),
      location,
      zone,
    ),
    false,
  );
});

test("admin service zones retain optional local-area boundaries", () => {
  const parsed = serviceZoneSchema.parse({
    state: "Jharkhand",
    cityName: "Giridih",
    areaName: "Makatpur",
    latitude: 24.18,
    longitude: 86.3,
    radiusKm: 10,
    isActive: true,
  });
  assert.equal(parsed.areaName, "Makatpur");
});

test("coordinates select the containing area zone even if reverse-geocoded area differs", () => {
  const result = evaluateServiceZones(
    [{ ...zone, areaName: "Makatpur" }],
    {
      cityName: "Giridih",
      state: "Jharkhand",
      areaName: "Old market",
      lat: 24.18,
      lng: 86.3,
    },
  );
  assert.equal(result.allowed, true);
  assert.equal(result.zone.areaName, "Makatpur");
});

test("null-island and out-of-range coordinates are treated as missing", () => {
  assert.equal(hasCoords({ lat: 0, lng: 0 }), false);
  assert.equal(hasCoords({ lat: 24.18, lng: 86.3 }), true);
  assert.equal(hasCoords({ lat: 124.18, lng: 86.3 }), false);
  assert.equal(hasCoords({ lat: 24.18, lng: 186.3 }), false);
});

test("a worker with 0,0 coordinates falls back to matching text labels", () => {
  assert.equal(workerMatchesBooking(worker({ lat: 0, lng: 0 }), booking, zone), true);
  assert.equal(
    workerMatchesBooking(worker({ lat: 0, lng: 0, city: "Ranchi" }), booking, zone),
    false,
  );
});

test("a null-island zone is never considered live", () => {
  const result = evaluateServiceZones(
    [{ ...zone, latitude: 0, longitude: 0 }],
    { cityName: "Giridih", state: "Jharkhand", lat: 24.18, lng: 86.3 },
  );
  assert.equal(result.allowed, false);
  assert.equal(Boolean(result.zone), false);
});
