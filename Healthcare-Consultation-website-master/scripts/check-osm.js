#!/usr/bin/env node
"use strict";
const dns = require("node:dns");
const { setupNetwork } = require("../net-setup");
const { DEFAULT_ENDPOINTS, networkCode, explainNetworkCode } = require("../overpass");

setupNetwork(process.env, () => {});
const hosts = [...new Set([...DEFAULT_ENDPOINTS.map(url => new URL(url).host), "nominatim.openstreetmap.org", "photon.komoot.io"] )];

(async () => {
  console.log(`Node ${process.version} | proxy: ${process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "none"} | DNS_SERVERS: ${process.env.DNS_SERVERS || "system"}\n`);
  let working = 0;
  for (const host of hosts) {
    const started = Date.now();
    let line = `${host.padEnd(32)}`;
    try {
      const { address } = await dns.promises.lookup(host, { family: 4 });
      line += `DNS ok (${address})  `;
    } catch (error) {
      console.log(`${line}DNS FAILED (${error.code}) -> ${explainNetworkCode(error.code)}`);
      continue;
    }
    try {
      const response = await fetch(`https://${host}/`, { method: "HEAD", signal: AbortSignal.timeout(10000) });
      console.log(`${line}HTTPS ok (HTTP ${response.status}, ${Date.now() - started} ms)`);
      working += 1;
    } catch (error) {
      const code = error.name === "TimeoutError" ? "TIMEOUT" : networkCode(error);
      console.log(`${line}HTTPS FAILED (${code}) -> ${code === "TIMEOUT" ? "connection hangs (blocked or very slow network)" : explainNetworkCode(code)}`);
    }
  }
  console.log(working ? `\n${working} of ${hosts.length} hosts reachable. The server can use OpenStreetMap.` :
    "\nNo host is reachable from this machine. Fix the cause shown above, or rely on the browser fallback (it uses your browser's own network).");
})();
