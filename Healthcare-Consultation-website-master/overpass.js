"use strict";

const DEFAULT_ENDPOINTS = Object.freeze([
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter"
]);

function buildQuery(latitude, longitude, radiusMeters) {
  if (![latitude, longitude, radiusMeters].every(Number.isFinite) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || radiusMeters <= 0) {
    throw new TypeError("Invalid search area.");
  }
  const around = `(around:${Math.round(radiusMeters)},${latitude},${longitude})`;
  return `[out:json][timeout:25];
(nwr["amenity"="pharmacy"]${around};nwr["healthcare"="pharmacy"]${around};nwr["shop"="chemist"]${around};)->.pharmacies;
(nwr["amenity"~"^(doctors|clinic|hospital|dentist)$"]${around};nwr["healthcare"~"^(doctor|clinic|hospital|dentist|medical_centre)$"]${around};)->.healthcare;
.pharmacies out center tags 100;
.healthcare out center tags 80;`;
}

const hostOf = value => {
  try { return new URL(value).host; } catch { return String(value); }
};

async function queryEndpoint(url, query, timeoutMs, userAgent) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json",
        "User-Agent": userAgent
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (cause) {
    const timedOut = cause.name === "TimeoutError" || cause.name === "AbortError";
    throw Object.assign(new Error(timedOut ? "timed out" : `unreachable (${cause.cause?.code || cause.message})`), {
      kind: timedOut ? "timeout" : "network"
    });
  }
  if (response.status === 429 || response.status === 406 || response.status >= 500) {
    throw Object.assign(new Error(`busy (HTTP ${response.status})`), { kind: "busy" });
  }
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { kind: "http" });

  let data;
  try { data = JSON.parse(await response.text()); }
  catch { throw Object.assign(new Error("returned a non-JSON reply (server may be overloaded)"), { kind: "busy" }); }
  if (!data || !Array.isArray(data.elements)) {
    throw Object.assign(new Error("returned an invalid reply"), { kind: "busy" });
  }
  if (data.remark && /timed out|out of memory|rate_limited|too busy/i.test(String(data.remark)) && !data.elements.length) {
    throw Object.assign(new Error(`query failed (${String(data.remark).slice(0, 80)})`), { kind: "busy" });
  }
  return data.elements;
}

function createNearbyFinder({
  endpoints = DEFAULT_ENDPOINTS,
  perTryTimeoutMs = 10000,
  totalBudgetMs = 28000,
  cooldownMs = 60000,
  cacheTtlMs = 10 * 60 * 1000,
  staleTtlMs = 24 * 60 * 60 * 1000,
  maxCacheEntries = 200,
  userAgent = "CareConnect/1.0 (nearby healthcare directory)",
  now = Date.now,
  log = console.warn
} = {}) {
  const mirrors = [...new Set(endpoints)];
  const cache = new Map();
  const inflight = new Map();
  const unhealthyUntil = new Map();
  const keyFor = (latitude, longitude, radiusKm) => `${latitude.toFixed(3)},${longitude.toFixed(3)},${radiusKm}`;

  function remember(key, elements) {
    cache.delete(key);
    cache.set(key, { at: now(), elements });
    while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
  }

  async function fetchLive(latitude, longitude, radiusKm) {
    const query = buildQuery(latitude, longitude, radiusKm * 1000);
    const healthy = mirrors.filter(url => (unhealthyUntil.get(url) || 0) <= now());
    const resting = mirrors.filter(url => (unhealthyUntil.get(url) || 0) > now());
    const deadline = now() + totalBudgetMs;
    const failures = [];
    for (const url of [...healthy, ...resting]) {
      const timeLeft = deadline - now();
      if (timeLeft < 100) break;
      try {
        const elements = await queryEndpoint(url, query, Math.max(1, Math.min(perTryTimeoutMs, timeLeft)), userAgent);
        unhealthyUntil.delete(url);
        return { elements, endpoint: hostOf(url) };
      } catch (error) {
        unhealthyUntil.set(url, now() + cooldownMs);
        failures.push({ host: hostOf(url), kind: error.kind || "network", message: error.message });
        if (error.kind === "http") break;
      }
    }
    const onlyNetworkFailures = failures.length && failures.every(failure => failure.kind === "network");
    const error = new Error(onlyNetworkFailures
      ? "Could not reach OpenStreetMap from the server. Check the server's internet connection or firewall."
      : "OpenStreetMap's servers are busy right now. Please try again in a minute.");
    error.status = 503;
    error.expose = true;
    error.failures = failures;
    throw error;
  }

  async function find(latitude, longitude, radiusKm = 50) {
    if (![latitude, longitude, radiusKm].every(Number.isFinite) || latitude < -90 || latitude > 90 ||
        longitude < -180 || longitude > 180 || radiusKm <= 0) throw new TypeError("Invalid search area.");
    const key = keyFor(latitude, longitude, radiusKm);
    const cached = cache.get(key);
    if (cached && now() - cached.at < cacheTtlMs) return { elements: cached.elements, source: "cache" };
    if (inflight.has(key)) return inflight.get(key);

    const job = (async () => {
      try {
        const { elements, endpoint } = await fetchLive(latitude, longitude, radiusKm);
        remember(key, elements);
        return { elements, source: "live", endpoint };
      } catch (error) {
        if (error.failures) log("[nearby] all Overpass mirrors failed:", error.failures.map(failure =>
          `${failure.host}: ${failure.message}`).join(" | "));
        if (cached && now() - cached.at < staleTtlMs) return { elements: cached.elements, source: "stale" };
        throw error;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  return { find, _cache: cache };
}

module.exports = { createNearbyFinder, buildQuery, DEFAULT_ENDPOINTS };
