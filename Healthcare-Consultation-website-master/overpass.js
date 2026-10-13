"use strict";

const DEFAULT_ENDPOINTS = Object.freeze([
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
]);

const { buildOverpassQuery: buildQuery } = require("./public/geo"); // one query definition shared with the browser

// Node wraps the real reason inside error.cause (and AggregateError for dual-stack connects).
function networkCode(error) {
  const inner = error?.cause;
  return inner?.code || inner?.errors?.find(item => item?.code)?.code || error?.code || inner?.name || error?.message || "UNKNOWN";
}
function explainNetworkCode(code) {
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) return "DNS lookup failed (blocked or broken DNS; try DNS_SERVERS=1.1.1.1,8.8.8.8)";
  if (code === "ECONNREFUSED") return "connection refused (firewall, or a proxy is required; try HTTPS_PROXY)";
  if (["ECONNRESET", "EPIPE"].includes(code)) return "connection reset (a network filter or ISP is dropping the connection; try a proxy/VPN or the browser fallback)";
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "no route to the server (offline, blocked, or an IPv6-only problem)";
  if (/CERT|SIGNATURE|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code)) return "TLS certificate not trusted (antivirus/proxy HTTPS scanning? start Node with NODE_OPTIONS=--use-system-ca)";
  return `network error ${code}`;
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
    if (timedOut) throw Object.assign(new Error("timed out"), { kind: "timeout" });
    const code = networkCode(cause);
    throw Object.assign(new Error(`unreachable (${code})`), { kind: "network", code, reason: explainNetworkCode(code) });
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
        failures.push({ host: hostOf(url), kind: error.kind || "network", message: error.message, reason: error.reason || error.message });
        if (error.kind === "http") break;
      }
    }
    const onlyNetworkFailures = failures.length && failures.every(failure => failure.kind === "network");
    const error = new Error(onlyNetworkFailures
      ? `Could not reach OpenStreetMap from the server (${failures[0].reason.split(/[;(:]/)[0].trim()}).` // short reason for visitors; full hints go to the log
      : "OpenStreetMap's servers are busy right now. Please try again in a minute.");
    error.publicCode = onlyNetworkFailures ? "OSM_UNREACHABLE" : "OSM_BUSY";
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
          `${failure.host}: ${failure.reason}`).join(" | "));
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

module.exports = { createNearbyFinder, buildQuery, DEFAULT_ENDPOINTS, networkCode, explainNetworkCode };
