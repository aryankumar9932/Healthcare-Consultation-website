const URL_BASE = process.env.ML_SERVICE_URL;
const KEY = process.env.ML_SERVICE_KEY || "";

function warnUnavailable(path, reason) {
  console.warn(`CareConnect ML service ${path} ${reason}; using the configured fallback.`);
}

async function post(path, body) {
  if (!URL_BASE) return null;
  if (!KEY) {
    warnUnavailable(path, "is configured without an ML_SERVICE_KEY");
    return null;
  }

  let response;
  try {
    response = await fetch(`${URL_BASE.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Key": KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000)
    });
  } catch {
    warnUnavailable(path, "could not be reached");
    return null;
  }

  if (!response.ok) {
    warnUnavailable(path, `returned HTTP ${response.status}`);
    return null;
  }

  try {
    return await response.json();
  } catch {
    warnUnavailable(path, "returned invalid JSON");
    return null;
  }
}

const specialty = (symptoms, available) =>
  post("/v1/specialty", { symptoms, available_specialties: available });
const noShow = features => post("/v1/no-show", features);
const demand = payload => post("/v1/demand", payload);

module.exports = { specialty, noShow, demand };
