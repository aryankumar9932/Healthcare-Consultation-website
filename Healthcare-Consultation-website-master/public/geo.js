(function attachGeoTools(root) {
  function distanceKm(origin, destination) {
    const radians = degrees => degrees * Math.PI / 180;
    const latitudeDelta = radians(destination.latitude - origin.latitude);
    const longitudeDelta = radians(destination.longitude - origin.longitude);
    const a = Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(radians(origin.latitude)) *
      Math.cos(radians(destination.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function findNearby(clinics, origin, radiusKm, specialty = "") {
    return clinics
      .map(clinic => ({ ...clinic, distanceKm: distanceKm(origin, clinic) }))
      .filter(clinic => clinic.distanceKm <= radiusKm &&
        (!specialty || clinic.doctor.specialty.toLowerCase() === specialty.toLowerCase()))
      .sort((left, right) => left.distanceKm - right.distanceKm);
  }

  function filterByCategory(providers, category = "all") {
    if (category === "pharmacy") return providers.filter(provider => provider.category === "pharmacy");
    if (category === "healthcare") return providers.filter(provider => provider.category !== "pharmacy");
    return providers;
  }

  function isHospital(provider) {
    return provider.facilityType === "hospital" || provider.doctor?.specialty === "Hospital";
  }

  function isDoctor(provider) {
    return provider.category === "healthcare" &&
      (["doctor", "doctors", "dentist"].includes(provider.facilityType) ||
        ["Doctor", "Dentist"].includes(provider.doctor?.specialty));
  }

  function normalizeOpenStreetMapElement(element) {
    if (!element || !["node", "way", "relation"].includes(element.type) ||
        !Number.isSafeInteger(Number(element.id)) || !element.tags || typeof element.tags !== "object") return null;
    const latitude = Number(element.lat ?? element.center?.lat);
    const longitude = Number(element.lon ?? element.center?.lon);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
    const tags = element.tags;
    const type = String(tags.amenity || tags.healthcare || tags.shop || "").toLowerCase();
    const pharmacy = tags.amenity === "pharmacy" ||
      tags.healthcare === "pharmacy" ||
      tags.shop === "chemist";
    const hospital = type === "hospital";
    const name = String(tags.name || tags["name:en"] || tags.operator ||
      (pharmacy ? "Unnamed medical store" : hospital ? "Unnamed hospital" : "Unnamed healthcare provider")).slice(0, 160);
    const address = tags["addr:full"] || [
      [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
      tags["addr:suburb"] || tags["addr:neighbourhood"],
      tags["addr:city"] || tags["addr:town"] || tags["addr:village"],
      tags["addr:postcode"]
    ].filter(Boolean).join(", ");
    const specialty = pharmacy ? "Pharmacy · Medical store" : ({
      doctor: "Doctor",
      doctors: "Doctor",
      dentist: "Dentist",
      hospital: "Hospital",
      clinic: "Clinic",
      medical_centre: "Medical centre"
    }[type] || "Healthcare");
    return {
      id: `osm-${element.type}-${element.id}`,
      name,
      address: String(address || "Address not listed on OpenStreetMap"),
      latitude,
      longitude,
      doctor: { id: null, name, specialty },
      category: pharmacy ? "pharmacy" : "healthcare",
      facilityType: pharmacy ? "pharmacy" : type,
      source: "openstreetmap",
      mapURI: `https://www.openstreetmap.org/${element.type}/${Number(element.id)}`,
      phone: String(tags.phone || tags["contact:phone"] || ""),
      openingHours: String(tags.opening_hours || "")
    };
  }

  const tools = { distanceKm, findNearby, filterByCategory, isHospital, isDoctor, normalizeOpenStreetMapElement };
  if (typeof module !== "undefined" && module.exports) module.exports = tools;
  root.CareConnectGeo = tools;
})(globalThis);
