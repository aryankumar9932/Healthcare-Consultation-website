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

  // ---- OpenStreetMap lookups that also work from the visitor's browser (used when the server cannot reach OSM) ----
  const OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter"
  ];

  function buildOverpassQuery(latitude, longitude, radiusMeters) {
    if (![latitude, longitude, radiusMeters].every(Number.isFinite) || latitude < -90 || latitude > 90 ||
        longitude < -180 || longitude > 180 || radiusMeters <= 0) throw new TypeError("Invalid search area.");
    const around = `(around:${Math.round(radiusMeters)},${latitude},${longitude})`;
    return `[out:json][timeout:25];
(nwr["amenity"="pharmacy"]${around};nwr["healthcare"="pharmacy"]${around};nwr["shop"="chemist"]${around};)->.pharmacies;
(nwr["amenity"~"^(doctors|clinic|hospital|dentist)$"]${around};nwr["healthcare"~"^(doctor|clinic|hospital|dentist|medical_centre)$"]${around};)->.healthcare;
.pharmacies out center tags 100;
.healthcare out center tags 80;`;
  }

  // Runs the nearby search straight from the caller's network, trying each mirror in turn.
  async function searchOverpass(origin, { radiusKm = 50, mirrors = OVERPASS_MIRRORS, timeoutMs = 15000, fetchImpl = root.fetch.bind(root) } = {}) {
    const query = buildOverpassQuery(origin.latitude, origin.longitude, radiusKm * 1000);
    for (const url of mirrors) {
      try {
        // No custom headers: a plain form POST avoids a CORS preflight request.
        const response = await fetchImpl(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) continue;
        const data = JSON.parse(await response.text());
        const failed = data.elements && data.elements.length === 0 && /timed out|out of memory|rate_limited|too busy/i.test(String(data.remark || ""));
        if (!Array.isArray(data.elements) || failed) continue;
        return data.elements.map(normalizeOpenStreetMapElement).filter(Boolean);
      } catch { /* try the next mirror */ }
    }
    throw new Error("OpenStreetMap could not be reached from your browser either. Check your internet connection and try again.");
  }

  // Place-name search: Nominatim first, then Photon. Returns null when neither can answer.
  async function geocodePlace(query, { fetchImpl = root.fetch.bind(root), timeoutMs = 10000 } = {}) {
    const attempts = [
      async () => {
        const url = new URL("https://nominatim.openstreetmap.org/search");
        url.searchParams.set("q", query); url.searchParams.set("format", "jsonv2"); url.searchParams.set("limit", "1");
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const hit = (await response.json())[0];
        return hit && { latitude: Number(hit.lat), longitude: Number(hit.lon), label: String(hit.display_name || query).slice(0, 300) };
      },
      async () => {
        const url = new URL("https://photon.komoot.io/api/");
        url.searchParams.set("q", query); url.searchParams.set("limit", "1");
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const feature = ((await response.json()).features || [])[0];
        if (!feature) return null;
        const [longitude, latitude] = (feature.geometry?.coordinates || []).map(Number);
        const p = feature.properties || {};
        const label = [p.name, p.street, p.city || p.county, p.state, p.country].filter(Boolean).join(", ");
        return { latitude, longitude, label: (label || query).slice(0, 300) };
      }
    ];
    for (const attempt of attempts) {
      try {
        const result = await attempt();
        if (result && Number.isFinite(result.latitude) && Number.isFinite(result.longitude)) return result;
      } catch { /* try the next geocoder */ }
    }
    return null;
  }

  const tools = { distanceKm, findNearby, filterByCategory, isHospital, isDoctor, normalizeOpenStreetMapElement,
    buildOverpassQuery, searchOverpass, geocodePlace };
  if (typeof module !== "undefined" && module.exports) module.exports = tools;
  root.CareConnectGeo = tools;
})(globalThis);
