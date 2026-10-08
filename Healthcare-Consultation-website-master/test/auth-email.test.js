const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { SMTPServer } = require("smtp-server");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "careconnect-authmail-"));
process.env.DB_FILE = path.join(dir, "db.json");
process.env.SESSION_SECRET = "test-only-session-secret-that-is-long-enough";
process.env.MAIL_TRANSPORT = "memory";
process.env.APP_URL = "https://care.example.test";
process.env.ADMIN_EMAIL = "boss@example.com";
process.env.ADMIN_SETUP_TOKEN = "test-only-admin-setup-token-long-enough";
delete process.env.REQUIRE_VERIFIED_EMAIL; // default policy: enforced because email can be delivered
delete process.env.GEMINI_API_KEY;
delete process.env.ML_SERVICE_URL;
const { createApp, store, ready, mailer } = require("../server");
const { createMailer, templates } = require("../mailer");
const { PURPOSES, generateToken } = require("../authtokens");

const servers = [];
async function start(options = {}) {
  await ready;
  const server = createApp({ limits: { auth: { windowMs: 60_000, limit: 1000 }, api: { windowMs: 60_000, limit: 100000 },
    reset: { windowMs: 60_000, limit: 1000 }, email: { windowMs: 60_000, limit: 1000 }, ...(options.limits || {}) } }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function client(base) {
  let cookie = "";
  const jar = response => {
    const set = response.headers.getSetCookie().map(v => v.split(";")[0]);
    if (set.length) cookie = set.join("; ");
  };
  const c = {
    async csrf() {
      const r = await fetch(`${base}/api/csrf`, { headers: { Cookie: cookie } });
      jar(r);
      return (await r.json()).csrfToken;
    },
    async call(method, url, body) {
      const headers = {};
      if (method !== "GET") { headers["Content-Type"] = "application/json"; headers["X-CSRF-Token"] = await c.csrf(); }
      headers.Cookie = cookie;
      const r = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      jar(r);
      const text = await r.text();
      return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
    },
    get: url => c.call("GET", url),
    post: (url, body) => c.call("POST", url, body)
  };
  return c;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mailsTo = email => mailer.outbox.filter(m => m.to === email);
const tokenIn = message => /token=([A-Za-z0-9_-]{43})/.exec(message.text)[1];
// Emails are sent after the response, so wait for them to appear.
async function waitForMail(email, count, subjectPart) {
  for (let i = 0; i < 100; i += 1) {
    const found = mailsTo(email).filter(m => !subjectPart || m.subject.includes(subjectPart));
    if (found.length >= count) return found;
    await sleep(20);
  }
  throw new Error(`no mail #${count} for ${email}`);
}
async function signUp(base, name, email, password = "a-long-test-password") {
  const c = client(base);
  const r = await c.post("/api/register", { name, email, password });
  assert.equal(r.status, 201);
  await waitForMail(email, 1, "Confirm");
  return c;
}
const futureDate = () => new Date(Date.now() + 3 * 864e5).toISOString();
const order = { items: [{ productId: 2, quantity: 1 }] };

let base;
test.before(async () => {
  await ready;
  if (store.driver === "postgres") await store.reset();
  base = await start();
});
test.after(async () => {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registration emails a confirmation link built from APP_URL", async () => {
  const c = await signUp(base, "Asha <script>", "asha@example.com");
  const [mail] = mailsTo("asha@example.com");
  assert.match(mail.subject, /Confirm your CareConnect email/);
  assert.match(mail.text, /^Hi Asha <script>,/);
  assert.ok(mail.text.includes("https://care.example.test/verify-email?token="));
  assert.ok(mail.html.includes("Asha &lt;script&gt;"), "names are HTML-escaped in the HTML part");
  assert.ok(!mail.html.includes("<script>"));
  const me = await c.get("/api/me");
  assert.equal(me.body.user.emailVerified, false);
});

test("unverified accounts cannot book, order or upload until they confirm their email", async () => {
  const c = await signUp(base, "Ravi", "ravi@example.com");
  for (const [url, body] of [["/api/appointments", { doctorId: 1, date: futureDate() }], ["/api/orders", order], ["/api/patient/reports", {}]]) {
    const r = await c.post(url, body);
    assert.equal(r.status, 403, url);
    assert.equal(r.body.code, "EMAIL_NOT_VERIFIED", url);
  }
  assert.equal((await c.get("/api/appointments")).status, 200); // browsing their own data is fine

  const token = tokenIn(mailsTo("ravi@example.com")[0]);
  const verify = await client(base).post("/api/email/verify", { token }); // possibly a different browser
  assert.equal(verify.status, 200);
  assert.equal((await c.get("/api/me")).body.user.emailVerified, true);
  assert.equal((await c.post("/api/orders", order)).status, 201);
  assert.equal((await c.post("/api/appointments", { doctorId: 1, date: futureDate() })).status, 201);
  assert.equal((await c.post("/api/patient/reports", {})).status, 400); // passes the gate, then fails for the missing file
});

test("confirmation tokens are single-use, expire, and reject junk", async () => {
  await signUp(base, "Meera", "meera@example.com");
  const token = tokenIn(mailsTo("meera@example.com")[0]);
  const anon = client(base);
  assert.equal((await anon.post("/api/email/verify", { token: "short" })).status, 400);
  assert.equal((await anon.post("/api/email/verify", { token: "A".repeat(43) })).status, 400);
  assert.equal((await anon.post("/api/email/verify", {})).status, 400);
  assert.equal((await anon.post("/api/email/verify", { token })).status, 200);
  assert.equal((await anon.post("/api/email/verify", { token })).status, 400, "second use");

  const user = await store.getUserByEmail("meera@example.com");
  const expired = generateToken();
  await store.createAuthToken({ userId: user.id, purpose: PURPOSES.verifyEmail, hash: expired.hash, expiresAt: Date.now() - 1000 });
  assert.equal((await anon.post("/api/email/verify", { token: expired.token })).status, 400, "expired");
  const wrongPurpose = generateToken();
  await store.createAuthToken({ userId: user.id, purpose: PURPOSES.resetPassword, hash: wrongPurpose.hash, expiresAt: Date.now() + 60000 });
  assert.equal((await anon.post("/api/email/verify", { token: wrongPurpose.token })).status, 400, "a reset token cannot confirm an email");
});

test("resending is rate-limited per user and revokes the previous link", async () => {
  const c = await signUp(base, "Dev", "dev@example.com");
  const tooSoon = await c.post("/api/email/verify/resend", {});
  assert.equal(tooSoon.status, 429);
  assert.ok(Number(tooSoon.headers.get("retry-after")) > 0);

  const fast = await start({ limits: { resendCooldownMs: 0 } });
  const c2 = client(fast);
  assert.equal((await c2.post("/api/login", { email: "dev@example.com", password: "a-long-test-password" })).status, 200);
  assert.equal((await c2.post("/api/email/verify/resend", {})).status, 202);
  const [first, second] = await waitForMail("dev@example.com", 2, "Confirm");
  assert.notEqual(tokenIn(first), tokenIn(second));
  assert.equal((await client(base).post("/api/email/verify", { token: tokenIn(first) })).status, 400, "old link revoked");
  assert.equal((await client(base).post("/api/email/verify", { token: tokenIn(second) })).status, 200);
  assert.deepEqual((await c2.post("/api/email/verify/resend", {})).body, { alreadyVerified: true });
});

test("forgot-password answers identically for known and unknown accounts", async () => {
  await signUp(base, "Known", "known@example.com");
  const before = mailer.outbox.length;
  const a = await client(base).post("/api/password/forgot", { email: "known@example.com" });
  const b = await client(base).post("/api/password/forgot", { email: "nobody@example.com" });
  const c = await client(base).post("/api/password/forgot", { email: "not-an-email" });
  assert.deepEqual([a.status, b.status, c.status], [202, 202, 202]);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(b.body, c.body);
  await waitForMail("known@example.com", 1, "Reset");
  assert.equal(mailer.outbox.length, before + 1, "only the real account got an email");
  assert.equal(mailsTo("nobody@example.com").length, 0);
  // inside the cooldown a repeat request sends nothing more
  await client(base).post("/api/password/forgot", { email: "known@example.com" });
  await sleep(80);
  assert.equal(mailsTo("known@example.com").filter(m => /Reset/.test(m.subject)).length, 1);
});

test("password reset: one-time link, weak passwords do not burn it, signs out everywhere, clears lockout", async () => {
  const fast = await start({ limits: { resendCooldownMs: 0, lockout: { maxFailures: 3, lockMs: 60_000 } } });
  const phone = await signUp(fast, "Nina", "nina@example.com", "original-password-1");
  const laptop = client(fast);
  assert.equal((await laptop.post("/api/login", { email: "nina@example.com", password: "original-password-1" })).status, 200);
  assert.equal((await phone.get("/api/me")).body.user.email, "nina@example.com");

  for (let i = 0; i < 3; i += 1) await client(fast).post("/api/login", { email: "nina@example.com", password: "wrong-password" });
  assert.equal((await client(fast).post("/api/login", { email: "nina@example.com", password: "original-password-1" })).status, 429, "locked out");

  await client(fast).post("/api/password/forgot", { email: "nina@example.com" });
  const [mail] = await waitForMail("nina@example.com", 1, "Reset");
  const token = tokenIn(mail);
  assert.ok(mail.text.includes("https://care.example.test/reset-password?token="));

  const anon = client(fast);
  assert.equal((await anon.post("/api/password/reset", { token, password: "short" })).status, 400);
  assert.equal((await anon.post("/api/password/reset", { token: "A".repeat(43), password: "brand-new-password-2" })).status, 400);
  assert.equal((await anon.post("/api/password/reset", { token, password: "brand-new-password-2" })).status, 200, "link still works after the weak-password attempt");
  assert.equal((await anon.post("/api/password/reset", { token, password: "another-password-3" })).status, 400, "single use");

  assert.equal((await phone.get("/api/me")).body.user, null, "existing sessions are revoked");
  assert.equal((await laptop.get("/api/me")).body.user, null);
  assert.equal((await client(fast).post("/api/login", { email: "nina@example.com", password: "original-password-1" })).status, 401);
  const login = await client(fast).post("/api/login", { email: "nina@example.com", password: "brand-new-password-2" });
  assert.equal(login.status, 200, "lockout was cleared");
  assert.equal(login.body.user.emailVerified, true, "following the emailed link proves the address");
  await waitForMail("nina@example.com", 1, "password was changed");
});

test("a newer reset link revokes the older one and expired links fail", async () => {
  const fast = await start({ limits: { resendCooldownMs: 0 } });
  await signUp(fast, "Omar", "omar@example.com");
  await client(fast).post("/api/password/forgot", { email: "omar@example.com" });
  await waitForMail("omar@example.com", 1, "Reset");
  await client(fast).post("/api/password/forgot", { email: "omar@example.com" });
  const [older, newer] = await waitForMail("omar@example.com", 2, "Reset");
  assert.equal((await client(fast).post("/api/password/reset", { token: tokenIn(older), password: "brand-new-password-2" })).status, 400);
  const user = await store.getUserByEmail("omar@example.com");
  const expired = generateToken();
  await store.createAuthToken({ userId: user.id, purpose: PURPOSES.resetPassword, hash: expired.hash, expiresAt: Date.now() - 1000 });
  assert.equal((await client(fast).post("/api/password/reset", { token: expired.token, password: "brand-new-password-2" })).status, 400);
  // creating the expired token revoked the newer one as well (one live token per purpose): request again
  await client(fast).post("/api/password/forgot", { email: "omar@example.com" });
  const latest = (await waitForMail("omar@example.com", 3, "Reset")).pop();
  assert.equal((await client(fast).post("/api/password/reset", { token: tokenIn(latest), password: "brand-new-password-2" })).status, 200);
  void newer;
});

test("changing the password needs the current one, keeps this session, signs out the others", async () => {
  const fast = await start({ limits: { lockout: { maxFailures: 3, lockMs: 60_000 } } });
  const here = await signUp(fast, "Priya", "priya@example.com", "original-password-1");
  const there = client(fast);
  await there.post("/api/login", { email: "priya@example.com", password: "original-password-1" });

  assert.equal((await client(fast).post("/api/password/change", { currentPassword: "x", newPassword: "whatever-long-1" })).status, 401);
  assert.equal((await here.post("/api/password/change", { currentPassword: "wrong-password", newPassword: "new-password-long-2" })).status, 401);
  assert.equal((await here.post("/api/password/change", { currentPassword: "original-password-1", newPassword: "short" })).status, 400);
  assert.equal((await here.post("/api/password/change", { currentPassword: "original-password-1", newPassword: "original-password-1" })).status, 400);
  assert.equal((await here.post("/api/password/change", { currentPassword: "original-password-1", newPassword: "new-password-long-2" })).status, 200);

  assert.equal((await here.get("/api/me")).body.user.email, "priya@example.com", "this session survives");
  assert.equal((await there.get("/api/me")).body.user, null, "other sessions are signed out");
  assert.equal((await client(fast).post("/api/login", { email: "priya@example.com", password: "original-password-1" })).status, 401);
  assert.equal((await client(fast).post("/api/login", { email: "priya@example.com", password: "new-password-long-2" })).status, 200);
  await waitForMail("priya@example.com", 1, "password was changed");

  // a hijacked session cannot brute-force the current password
  for (let i = 0; i < 3; i += 1) await here.post("/api/password/change", { currentPassword: `guess-${i}-password`, newPassword: "yet-another-pass-3" });
  assert.equal((await here.post("/api/password/change", { currentPassword: "new-password-long-2", newPassword: "yet-another-pass-3" })).status, 429);
});

test("email links ignore a spoofed Host header", async () => {
  await signUp(base, "Host Test", "host@example.com");
  const port = new URL(base).port;
  const raw = (method, url, headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { Host: "evil.example", ...headers } }, res => {
      let data = ""; res.on("data", chunk => { data += chunk; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data }));
    });
    req.on("error", reject); if (body) req.write(body); req.end();
  });
  const t = await raw("GET", "/api/csrf", {});
  const cookie = t.headers["set-cookie"].map(v => v.split(";")[0]).join("; ");
  const body = JSON.stringify({ email: "host@example.com" });
  const r = await raw("POST", "/api/password/forgot", { Cookie: cookie, "X-CSRF-Token": JSON.parse(t.data).csrfToken, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, body);
  assert.equal(r.status, 202);
  const [mail] = await waitForMail("host@example.com", 1, "Reset");
  assert.ok(mail.text.includes("https://care.example.test/reset-password?token="));
  assert.ok(!mail.text.includes("evil.example") && !mail.html.includes("evil.example"));
});

test("the password endpoints are rate-limited per client", async () => {
  const tight = await start({ limits: { reset: { windowMs: 60_000, limit: 3 } } });
  const c = client(tight);
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await c.post("/api/password/forgot", { email: "nobody@example.com" })).status);
  assert.deepEqual(statuses, [202, 202, 202, 429, 429]);
});

test("admin-created doctor accounts receive an address confirmation email", async () => {
  const boss = await signUp(base, "Boss", "boss@example.com");
  assert.equal((await boss.post("/api/admin/bootstrap", { setupToken: process.env.ADMIN_SETUP_TOKEN })).status, 200);
  const unassigned = await boss.get("/api/admin/doctors/unassigned");
  const created = await boss.post("/api/admin/doctor-accounts", { doctorId: unassigned.body[0].id, name: "Dr Test", email: "drtest@example.com", password: "temporary-password-12" });
  assert.equal(created.status, 201);
  const [mail] = await waitForMail("drtest@example.com", 1, "Confirm");
  assert.ok(mail.text.includes("/verify-email?token="));
});

test("confirmation is only enforced when email can be delivered, unless overridden", async () => {
  const c = await signUp(base, "Policy", "policy@example.com");
  process.env.REQUIRE_VERIFIED_EMAIL = "false";
  try {
    assert.equal((await c.post("/api/orders", order)).status, 201, "override off");
  } finally { delete process.env.REQUIRE_VERIFIED_EMAIL; }
  assert.equal((await c.post("/api/orders", order)).status, 403, "default: enforced because the memory transport can deliver");
  assert.equal(createMailer({ NODE_ENV: "production" }).canDeliver, false);
  assert.equal(createMailer({ NODE_ENV: "production", SMTP_HOST: "smtp.example.test" }).mode, "smtp");
  assert.equal(createMailer({ NODE_ENV: "production", SMTP_HOST: "smtp.example.test" }).canDeliver, true);
  assert.equal(createMailer({ NODE_ENV: "development" }).mode, "console");
  assert.deepEqual(await createMailer({ NODE_ENV: "production" }).send({ to: "a@b.c", subject: "s", text: "t" }), { sent: false });
});

test("the SMTP transport delivers real messages", async () => {
  const received = [];
  const smtp = new SMTPServer({
    authOptional: true, disabledCommands: ["STARTTLS", "AUTH"],
    onData(stream, session, done) {
      let raw = ""; stream.on("data", chunk => { raw += chunk; });
      stream.on("end", () => { received.push({ raw, to: session.envelope.rcptTo.map(r => r.address), from: session.envelope.mailFrom.address }); done(); });
    }
  });
  await new Promise(resolve => smtp.listen(0, "127.0.0.1", resolve));
  try {
    const mail = createMailer({ SMTP_URL: `smtp://127.0.0.1:${smtp.server.address().port}/?ignoreTLS=true`, MAIL_FROM: "CareConnect <care@example.test>" });
    assert.equal(mail.mode, "smtp");
    await mail.verify();
    const content = templates.resetPassword({ name: "Zed", url: "https://care.example.test/reset-password?token=abc", minutes: 60 });
    assert.deepEqual(await mail.send({ to: "zed@example.com", ...content }), { sent: true });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].to, ["zed@example.com"]);
    assert.equal(received[0].from, "care@example.test");
    assert.match(received[0].raw, /Subject: Reset your CareConnect password/);
    assert.ok(received[0].raw.includes("reset-password?token=3Dabc") || received[0].raw.includes("reset-password?token=abc"));
    assert.match(received[0].raw, /text\/html/);
  } finally {
    await new Promise(resolve => smtp.close(resolve));
  }
});
