// A preload (NODE_OPTIONS=--import=<this file's URL>, or imported) for a test that proves nothing leaves this machine:
// it refuses every connect, datagram, DNS lookup or query and fetch that is not this machine's loopback, and writes each
// attempt as one JSON line to $NET_GUARD_LOG. It also writes that it loaded (one line per process, so a run shows every
// process it covered) and every child process started (its file only), so a process it does not reach is named. Nothing
// refused is passed on: the original function is not called.
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const LOG = process.env.NET_GUARD_LOG;
const note = (kind, what) => {
  if (!LOG) return;
  const line = { at: new Date().toISOString(), pid: process.pid, kind, ...what };
  if (kind === "refused") line.stack = (new Error().stack ?? "").split("\n").slice(2, 9).map((s) => s.trim()).join(" | ");
  try { appendFileSync(LOG, `${JSON.stringify(line)}\n`); } catch {}
};

const bare = (host) => String(host).replace(/^\[|\]$/g, "").toLowerCase();
/** This machine's loopback: localhost by name, 127.0.0.0/8, ::1 (also v4-mapped). No host means localhost to net. */
const loopback = (host) => {
  if (host === undefined || host === null || host === "") return true;
  const h = bare(host);
  if (h === "localhost") return true;
  if (net.isIP(h) === 4) return h.startsWith("127.");
  if (net.isIP(h) === 6) return h === "::1" || h === "0:0:0:0:0:0:0:1" || /^::ffff:127\./.test(h);
  return false;
};
const refusal = (what) => Object.assign(new Error(`net guard: refused ${what}`), { code: "ECONNREFUSED" });

// TCP and TLS, and so http, https, http2, undici's fetch and WebSocket: every one goes through Socket#connect.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // net.connect's normalized [options, cb]
  let host, port, path;
  if (first !== null && typeof first === "object") ({ host, port, path } = first);
  else if (typeof first === "string" && Number.isNaN(Number(first))) path = first;
  else { port = first; host = typeof args[1] === "string" ? args[1] : undefined; }
  if (path !== undefined && path !== null) return connect.apply(this, args); // a unix socket or pipe: this machine
  if (loopback(host)) return connect.apply(this, args);
  note("refused", { call: "net.Socket.connect", host, port });
  process.nextTick(() => this.destroy(refusal(`a connect to ${host}:${port}`)));
  return this;
};

// UDP.
const udpSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function guardedSend(...args) {
  const long = typeof args[1] === "number" && typeof args[2] === "number" && typeof args[3] === "number";
  const [port, address] = long ? [args[3], args[4]] : [args[1], args[2]];
  if (typeof port !== "number" || typeof address !== "string" || loopback(address)) return udpSend.apply(this, args);
  note("refused", { call: "dgram.send", host: address, port });
  const cb = args.find((a) => typeof a === "function");
  if (cb) process.nextTick(cb, refusal(`a datagram to ${address}:${port}`));
};
const udpConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function guardedUdpConnect(port, address, cb) {
  if (typeof address !== "string" || loopback(address)) return udpConnect.call(this, port, address, cb);
  note("refused", { call: "dgram.connect", host: address, port });
  const done = typeof address === "function" ? address : cb;
  if (done) process.nextTick(done, refusal(`a datagram connect to ${address}:${port}`));
};

// DNS. A lookup of an IP literal sends no query (it answers at once), so it passes; any name but localhost is refused.
// Every resolve, reverse and lookupService query goes to the network's resolver: all refused.
const lookup = dns.lookup;
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (net.isIP(bare(hostname ?? "")) || loopback(hostname)) return lookup.call(this, hostname, ...rest);
  note("refused", { call: "dns.lookup", host: hostname });
  const cb = rest.find((a) => typeof a === "function");
  const err = Object.assign(refusal(`a lookup of ${hostname}`), { code: "ENOTFOUND", hostname });
  if (cb) process.nextTick(cb, err);
};
const pLookup = dns.promises.lookup;
dns.promises.lookup = function guardedPromisesLookup(hostname, ...rest) {
  if (net.isIP(bare(hostname ?? "")) || loopback(hostname)) return pLookup.call(this, hostname, ...rest);
  note("refused", { call: "dns.promises.lookup", host: hostname });
  return Promise.reject(Object.assign(refusal(`a lookup of ${hostname}`), { code: "ENOTFOUND", hostname }));
};
const QUERIES = Object.keys(dns).filter((name) => /^(resolve|reverse|lookupService)/.test(name) && typeof dns[name] === "function");
for (const name of QUERIES) {
  dns[name] = function guardedQuery(target, ...rest) {
    note("refused", { call: `dns.${name}`, host: target });
    const cb = rest.find((a) => typeof a === "function");
    if (cb) process.nextTick(cb, Object.assign(refusal(`dns.${name}(${target})`), { code: "ECONNREFUSED" }));
  };
}
for (const name of Object.keys(dns.promises).filter((n) => /^(resolve|reverse|lookupService)/.test(n) && typeof dns.promises[n] === "function")) {
  dns.promises[name] = function guardedPromisesQuery(target) {
    note("refused", { call: `dns.promises.${name}`, host: target });
    return Promise.reject(Object.assign(refusal(`dns.promises.${name}(${target})`), { code: "ECONNREFUSED" }));
  };
}
for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
  for (const name of Object.getOwnPropertyNames(Resolver.prototype).filter((n) => /^(resolve|reverse)/.test(n))) {
    Resolver.prototype[name] = function guardedResolver(target, ...rest) {
      note("refused", { call: `Resolver.${name}`, host: target });
      const err = Object.assign(refusal(`Resolver.${name}(${target})`), { code: "ECONNREFUSED" });
      const cb = rest.find((a) => typeof a === "function");
      if (cb) return void process.nextTick(cb, err);
      return Promise.reject(err);
    };
  }
}

// fetch: refused before undici is reached when its URL is not loopback (Socket#connect would refuse it again).
const realFetch = globalThis.fetch;
if (typeof realFetch === "function") {
  globalThis.fetch = function guardedFetch(input, init) {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); } catch { return realFetch.call(this, input, init); }
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || loopback(url.hostname)) return realFetch.call(this, input, init);
    note("refused", { call: "fetch", host: url.hostname, port: url.port || url.protocol });
    return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: refusal(`a fetch of ${url.origin}`) }));
  };
}

// Children: logged by file, so a process this preload does not reach (anything but node) is named in the log.
const spawnOf = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function loggedSpawn(options) {
  note("spawn", { file: options?.file, arg1: String(options?.args?.[1] ?? "").slice(0, 120), node_options: (options?.envPairs ?? []).some((p) => p.startsWith("NODE_OPTIONS=") && p.includes("net-guard")) });
  return spawnOf.call(this, options);
};
for (const name of ["spawnSync", "execFileSync", "execSync"]) {
  const real = childProcess[name];
  childProcess[name] = function loggedSync(file, ...rest) {
    note("spawn", { file: String(file).slice(0, 120), sync: name });
    return real.call(this, file, ...rest);
  };
}

// Named imports of the builtins (import { lookup } from "node:dns") see the guarded functions too.
syncBuiltinESMExports();
note("loaded", { argv: process.argv.slice(1, 4).map((a) => String(a).slice(-80)), node: process.version });
