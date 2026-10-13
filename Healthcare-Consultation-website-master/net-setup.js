"use strict";

const dns = require("node:dns");

function setupNetwork(env = process.env, log = console.log) {
  dns.setDefaultResultOrder("ipv4first"); // broken IPv6 routes otherwise cause hangs or "fetch failed"

  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "";
  const dnsServers = (env.DNS_SERVERS || "").split(",").map(item => item.trim()).filter(Boolean);
  if (!proxy && !dnsServers.length) return { proxy: false, dnsServers: [] };

  let undici;
  try {
    undici = require("undici");
  } catch {
    log("[net] HTTPS_PROXY / DNS_SERVERS are set but the 'undici' package is not installed. Run: npm install undici");
    return { proxy: false, dnsServers: [] };
  }

  const connect = {};
  if (dnsServers.length) {
    const resolver = new dns.promises.Resolver();
    resolver.setServers(dnsServers);
    connect.lookup = (hostname, options, callback) => {
      // Local names are supplied by the OS hosts file, not public DNS. Preserve that behavior
      // even when a custom DNS server is configured for outbound hostnames.
      if (hostname === "localhost" || hostname.endsWith(".localhost")) return dns.lookup(hostname, options, callback);
      resolver.resolve4(hostname).then(
        addresses => (options && options.all
          ? callback(null, addresses.map(address => ({ address, family: 4 })))
          : callback(null, addresses[0], 4)),
        () => dns.lookup(hostname, options, callback) // not found by the custom servers: use the system resolver
      );
    };
  }

  if (proxy) {
    const noProxy = [env.NO_PROXY || env.no_proxy || "", "localhost", "127.0.0.1", "::1"].filter(Boolean).join(",");
    undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ httpProxy: proxy, httpsProxy: proxy, noProxy, connect }));
  } else {
    undici.setGlobalDispatcher(new undici.Agent({ connect }));
  }
  log(`[net] outbound requests: ${proxy ? "via proxy" : "direct"}${dnsServers.length ? `, DNS servers ${dnsServers.join(", ")}` : ""}`);
  return { proxy: Boolean(proxy), dnsServers };
}

module.exports = { setupNetwork };
