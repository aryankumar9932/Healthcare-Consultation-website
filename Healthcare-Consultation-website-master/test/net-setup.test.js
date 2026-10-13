const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { execFile } = require("node:child_process");
const { setupNetwork } = require("../net-setup");

const run = (script, env) => new Promise((resolve, reject) => {
  execFile(process.execPath, ["-e", script], { env: { ...process.env, ...env }, cwd: __dirname + "/.." }, (error, stdout, stderr) =>
    error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout.trim()));
});
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

test("does nothing (and needs no extra package) when no proxy or DNS settings are given", () => {
  const messages = [];
  assert.deepEqual(setupNetwork({}, message => messages.push(message)), { proxy: false, dnsServers: [] });
  assert.deepEqual(messages, []);
});

test("custom DNS servers fall back to the system resolver when they cannot answer", async () => {
  const target = http.createServer((req, res) => res.end("direct-ok"));
  const port = await listen(target);
  try {
    const output = await run(
      `const { setupNetwork } = require("./net-setup"); setupNetwork(process.env, () => {});
       fetch("http://localhost:${port}/").then(r => r.text()).then(t => console.log(t));`,
      { DNS_SERVERS: "127.0.0.1" } // nothing answers DNS here, so the fallback must kick in
    );
    assert.equal(output, "direct-ok");
  } finally { target.close(); }
});

test("HTTPS_PROXY routes outbound requests through the proxy, while localhost stays direct", async () => {
  const seen = { connect: [], requests: [] };
  const target = http.createServer((req, res) => res.end("via-proxy-ok"));
  const targetPort = await listen(target);
  const proxy = http.createServer((req, res) => {
    seen.requests.push(req.url);
    const upstream = http.request({ host: "127.0.0.1", port: targetPort, path: "/", method: req.method }, up => { res.writeHead(up.statusCode); up.pipe(res); });
    upstream.end();
  });
  proxy.on("connect", (req, socket, head) => {
    seen.connect.push(req.url);
    const upstream = net.connect(targetPort, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
    upstream.on("error", () => socket.destroy());
  });
  const proxyPort = await listen(proxy);
  try {
    const output = await run(
      `const { setupNetwork } = require("./net-setup"); setupNetwork(process.env, () => {});
       const local = require("node:http").createServer((q, s) => s.end("local-direct")).listen(0, "127.0.0.1", async () => {
         const viaProxy = await fetch("http://overpass.test/api").then(r => r.text());
         const direct = await fetch("http://127.0.0.1:" + local.address().port + "/").then(r => r.text());
         console.log(viaProxy + "|" + direct); local.close();
       });`,
      { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "" }
    );
    assert.equal(output, "via-proxy-ok|local-direct");
    assert.ok(seen.connect.length + seen.requests.length >= 1, "the proxy should have been used for overpass.test");
    assert.ok([...seen.connect, ...seen.requests].every(entry => /overpass\.test/.test(entry)), "localhost must not go through the proxy");
  } finally { target.close(); proxy.close(); }
});
