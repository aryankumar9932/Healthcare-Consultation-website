const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "careconnect-sec-"));
process.env.DB_FILE = path.join(dir, "db.json");
process.env.SESSION_SECRET = "test-only-session-secret-that-is-long-enough";
delete process.env.GEMINI_API_KEY;
delete process.env.ML_SERVICE_URL;
const { createApp, store, ready } = require("../server");

const servers = [];
test.before(async () => {
  await ready;
  if (store.driver === "postgres") await store.reset();
});
async function start(options) {
  await ready;
  const server = createApp(options).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

// Tiny browser-like client: cookie jar + CSRF token handling.
function client(base) {
  let cookie = "";
  const jar = response => {
    const set = response.headers.getSetCookie().map(v => v.split(";")[0]);
    if (set.length) cookie = set.join("; ");
  };
  const c = {
    get cookie() { return cookie; },
    async csrf() {
      const r = await fetch(`${base}/api/csrf`, { headers: { Cookie: cookie } });
      jar(r);
      return (await r.json()).csrfToken;
    },
    async post(url, body, { token } = {}) {
      const t = token === undefined ? await c.csrf() : token;
      const headers = { "Content-Type": "application/json", Cookie: cookie, ...(t ? { "X-CSRF-Token": t } : {}) };
      const r = await fetch(`${base}${url}`, { method: "POST", headers, body: JSON.stringify(body) });
      jar(r);
      return r;
    }
  };
  return c;
}

const user = { name: "Sec Test", email: "sec@example.com", password: "correct-horse-battery" };

test.after(async () => {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sets hardened security headers and a strict content-security policy", async () => {
  const base = await start();
  const response = await fetch(`${base}/`);
  const csp = response.headers.get("content-security-policy");
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("object-src 'none'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(!csp.includes("unsafe-inline"));
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.ok(response.headers.get("permissions-policy").includes("camera=()"));
});

test("rejects state-changing requests without a valid CSRF token", async () => {
  const base = await start();
  const a = client(base);
  const missing = await a.post("/api/register", user, { token: "" });
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).code, "CSRF");

  await a.csrf(); // creates a session + token
  const wrong = await a.post("/api/register", user, { token: "0".repeat(64) });
  assert.equal(wrong.status, 403);

  const b = client(base); // a token from another session must not work
  const otherToken = await b.csrf();
  const crossSession = await a.post("/api/register", user, { token: otherToken });
  assert.equal(crossSession.status, 403);

  const ok = await a.post("/api/register", user);
  assert.equal(ok.status, 201);
});

test("issues a new session id on login (session fixation protection)", async () => {
  const base = await start();
  const c = client(base);
  await c.csrf();
  const before = c.cookie;
  const login = await c.post("/api/login", { email: user.email, password: user.password });
  assert.equal(login.status, 200);
  assert.notEqual(c.cookie, before);
});

test("locks an account after repeated failed sign-ins, even with the right password", async () => {
  const base = await start({ limits: { lockout: { maxFailures: 3, lockMs: 60_000 } } });
  const c = client(base);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await c.post("/api/login", { email: user.email, password: "wrong-password" })).status, 401);
  }
  const locked = await c.post("/api/login", { email: user.email, password: user.password });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  assert.match((await locked.json()).error, /Too many failed sign-in attempts/);
  // Unknown emails are tracked the same way, so lock state does not reveal whether an account exists.
  for (let i = 0; i < 3; i += 1) await c.post("/api/login", { email: "ghost@example.com", password: "whatever-123" });
  assert.equal((await c.post("/api/login", { email: "ghost@example.com", password: "whatever-123" })).status, 429);
});

test("rate-limits authentication endpoints per client", async () => {
  const base = await start({ limits: { auth: { windowMs: 60_000, limit: 2 } } });
  const c = client(base);
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    statuses.push((await c.post("/api/login", { email: "nobody@example.com", password: "irrelevant-123" })).status);
  }
  assert.deepEqual(statuses.slice(0, 2), [401, 401]);
  assert.equal(statuses[2], 429);
  assert.equal(statuses[3], 429);
});

test("health endpoint reports the active database driver", async () => {
  const base = await start();
  const body = await (await fetch(`${base}/api/health`)).json();
  assert.equal(body.ok, true);
  assert.ok(["json", "postgres"].includes(body.database));
});
