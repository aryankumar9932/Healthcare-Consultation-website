const test = require("node:test");
const assert = require("node:assert/strict");
const { distanceKm, findNearby, filterByCategory, isDoctor, isHospital, normalizeOpenStreetMapElement } = require("../public/geo");

test("calculates a zero distance for the same coordinates", () => {
  assert.equal(distanceKm({ latitude: 10, longitude: 20 }, { latitude: 10, longitude: 20 }), 0);
});

test("sorts nearby clinics and filters by radius and specialty", () => {
  const origin = { latitude: 0, longitude: 0 };
  const clinics = [
    { id: 3, latitude: 0, longitude: 1, doctor: { specialty: "Dentist" } },
    { id: 2, latitude: 0, longitude: 0.05, doctor: { specialty: "Dentist" } },
    { id: 1, latitude: 0, longitude: 0.08, doctor: { specialty: "Cardiologist" } }
  ];
  const nearby = findNearby(clinics, origin, 10);
  assert.deepEqual(nearby.map(clinic => clinic.id), [2, 1]);
  assert.deepEqual(findNearby(clinics, origin, 10, "Dentist").map(clinic => clinic.id), [2]);
});

test("filters map providers to medical stores independently of healthcare", () => {
  const providers = [
    { id: "doctor", category: "healthcare" },
    { id: "clinic" },
    { id: "pharmacy", category: "pharmacy" }
  ];
  assert.deepEqual(filterByCategory(providers, "pharmacy").map(provider => provider.id), ["pharmacy"]);
  assert.deepEqual(filterByCategory(providers, "healthcare").map(provider => provider.id), ["doctor", "clinic"]);
  assert.deepEqual(filterByCategory(providers).map(provider => provider.id), ["doctor", "clinic", "pharmacy"]);
});

test("normalizes OpenStreetMap pharmacy and healthcare listings", () => {
  const pharmacy = normalizeOpenStreetMapElement({
    type: "node",
    id: 123,
    lat: 40.72,
    lon: -74,
    tags: {
      amenity: "pharmacy",
      name: "Community Pharmacy",
      "addr:housenumber": "12",
      "addr:street": "Main St",
      "addr:city": "Test City",
      phone: "+1 555 0100",
      opening_hours: "Mo-Fr 09:00-18:00"
    }
  });
  assert.equal(pharmacy.id, "osm-node-123");
  assert.equal(pharmacy.doctor.specialty, "Pharmacy · Medical store");
  assert.equal(pharmacy.address, "12 Main St, Test City");
  assert.equal(pharmacy.mapURI, "https://www.openstreetmap.org/node/123");
  assert.equal(pharmacy.phone, "+1 555 0100");
  assert.equal(pharmacy.openingHours, "Mo-Fr 09:00-18:00");

  const chemistShop = normalizeOpenStreetMapElement({
    type: "node",
    id: 124,
    lat: 40.721,
    lon: -74.001,
    tags: { shop: "chemist", name: "Corner Chemist" }
  });
  assert.equal(chemistShop.category, "pharmacy");
  assert.equal(chemistShop.doctor.specialty, "Pharmacy · Medical store");

  const healthcare = normalizeOpenStreetMapElement({
    type: "way",
    id: 456,
    center: { lat: 40.73, lon: -74.01 },
    tags: { healthcare: "dentist", name: "City Dental" }
  });
  assert.equal(healthcare.doctor.specialty, "Dentist");
  assert.equal(healthcare.category, "healthcare");
  assert.equal(normalizeOpenStreetMapElement({ type: "node", id: 1, tags: {} }), null);
});

test("separates named doctor and hospital listings for their directory pages", () => {
  const doctor = normalizeOpenStreetMapElement({
    type: "node",
    id: 201,
    lat: 28.84,
    lon: 78.77,
    tags: { healthcare: "doctor", name: "Dr Example Clinic" }
  });
  const hospital = normalizeOpenStreetMapElement({
    type: "way",
    id: 202,
    center: { lat: 28.85, lon: 78.78 },
    tags: { amenity: "hospital", name: "Moradabad General Hospital" }
  });
  assert.equal(doctor.name, "Dr Example Clinic");
  assert.equal(doctor.facilityType, "doctor");
  assert.equal(isDoctor(doctor), true);
  assert.equal(isHospital(doctor), false);
  assert.equal(hospital.name, "Moradabad General Hospital");
  assert.equal(hospital.facilityType, "hospital");
  assert.equal(isHospital(hospital), true);
  assert.equal(isDoctor(hospital), false);
});
