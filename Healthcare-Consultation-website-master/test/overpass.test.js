const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createNearbyFinder, buildQuery } = require("../overpass");

const ELEMENT = { type: "node", id: 1, lat: 29.0, lon: 77.7, tags: { amenity: "pharmacy", name: "Test Chemist" } };
const servers = [];

async function mock(handler) {
  const hits = { count: 0 };
  const server = http.createServer((req, res) => {
    hits.count += 1;
    req.resume();
    req.on("end", () => handler(req, res));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}/api/interpreter`, hits };
}

const ok = (elements = [ELEMENT], extra = {}) => (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ elements, ...extra }));
};
const html = (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end("<html><body>Dispatcher_Client::request_read_and_idle: Server too busy</body></html>");
};
const status = code => (req, res) => { res.statusCode = code; res.end("nope"); };
const silent = () => {};
let clock = 1_000_000_000_000;
const finder = options => createNearbyFinder({ log: silent, now: () => clock, ...options });

test.after(async () => { for (const server of servers) await new Promise(resolve => server.close(resolve)); });

test("falls back to the next mirror when the first answers 200 with an HTML error page", async () => {
  const bad = await mock(html), good = await mock(ok());
  const result = await finder({ endpoints: [bad.url, good.url] }).find(29.0, 77.7, 25);
  assert.equal(result.source, "live");
  assert.equal(result.elements.length, 1);
  assert.equal(bad.hits.count, 1);
  assert.equal(good.hits.count, 1);
});

test("falls back on HTTP 429 and 504", async () => {
  const limited = await mock(status(429)), gateway = await mock(status(504)), good = await mock(ok());
  const result = await finder({ endpoints: [limited.url, gateway.url, good.url] }).find(29.0, 77.7, 25);
  assert.equal(result.elements.length, 1);
});

test("treats an empty result with a runtime-error remark as a failure, but accepts partial data", async () => {
  const timedOut = await mock(ok([], { remark: 'runtime error: Query timed out in "query" at line 3' }));
  const good = await mock(ok());
  assert.equal((await finder({ endpoints: [timedOut.url, good.url] }).find(1, 1, 10)).elements.length, 1);
  const partial = await mock(ok([ELEMENT], { remark: "runtime error: Query timed out" }));
  assert.equal((await finder({ endpoints: [partial.url] }).find(2, 2, 10)).elements.length, 1);
});

test("a hanging mirror is abandoned after the per-try timeout", async () => {
  const hanging = await mock(() => {}), good = await mock(ok());
  const started = Date.now();
  const result = await finder({ endpoints: [hanging.url, good.url], perTryTimeoutMs: 300 }).find(3, 3, 10);
  assert.equal(result.elements.length, 1);
  assert.ok(Date.now() - started < 3000);
});

test("remembers a failing mirror and tries it last next time", async () => {
  const bad = await mock(html), good = await mock(ok());
  const nearby = finder({ endpoints: [bad.url, good.url], cacheTtlMs: 0 });
  await nearby.find(4, 4, 10);
  await nearby.find(4, 4, 10);
  assert.equal(bad.hits.count, 1);
  assert.equal(good.hits.count, 2);
});

test("reports busy and connectivity failures clearly", async () => {
  const bad = await mock(html);
  await assert.rejects(finder({ endpoints: [bad.url] }).find(5, 5, 10), error => {
    assert.equal(error.status, 503);
    assert.equal(error.expose, true);
    assert.match(error.message, /busy/i);
    return true;
  });
  await assert.rejects(finder({ endpoints: ["http://127.0.0.1:9/api/interpreter"] }).find(6, 6, 10), error => {
    assert.match(error.message, /could not reach/i);
    return true;
  });
});

test("caches results, refetches after the TTL, and serves stale data if every mirror then fails", async () => {
  let healthy = true;
  let hits = 0;
  const flaky = await mock((req, res) => { hits += 1; (healthy ? ok() : status(503))(req, res); });
  const nearby = finder({ endpoints: [flaky.url], cacheTtlMs: 1000, staleTtlMs: 10_000 });
  assert.equal((await nearby.find(7, 7, 10)).source, "live");
  assert.equal((await nearby.find(7, 7, 10)).source, "cache");
  assert.equal(hits, 1);
  healthy = false;
  clock += 2000;
  const stale = await nearby.find(7, 7, 10);
  assert.equal(stale.source, "stale");
  assert.equal(stale.elements.length, 1);
  clock += 20_000;
  await assert.rejects(nearby.find(7, 7, 10), /busy/i);
});

test("identical concurrent searches share one upstream request", async () => {
  const slow = await mock((req, res) => setTimeout(() => ok()(req, res), 150));
  const nearby = finder({ endpoints: [slow.url] });
  const [first, second, third] = await Promise.all([
    nearby.find(8, 8, 10), nearby.find(8, 8, 10), nearby.find(8, 8, 10)
  ]);
  assert.equal(slow.hits.count, 1);
  assert.equal(first.elements.length + second.elements.length + third.elements.length, 3);
});

test("the Overpass query keeps healthcare and pharmacy coverage and rejects bad coordinates", () => {
  const query = buildQuery(28.98, 77.7, 25_000);
  assert.match(query, /around:25000,28.98,77.7/);
  assert.match(query, /"shop"="chemist"/);
  assert.match(query, /\.pharmacies out center tags 100;/);
  assert.throws(() => buildQuery(NaN, 1, 1000), TypeError);
});
