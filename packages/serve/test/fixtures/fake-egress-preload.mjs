// Loaded (`--import`) into the proxy container's process that the fake docker runs on this machine (fake-docker.mjs), as
// the tests' fake network: every name resolves as fake-egress.mjs says (a public address never dialled, or a VM's own
// host and gateway), and every connection to an address goes to that module's origin on loopback. A Unix socket and a
// loopback connection are left as they are. No lookup or connection leaves this machine. A proxy left behind by a test
// that did not end ends itself after three minutes.
import dns from "node:dns";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import fakeEgress from "./fake-egress.mjs";

const real = net.connect;
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the tests' fake origin on this machine's loopback
// The fake's origin first (its listen looks its address up), then the seams; its own connects to loopback pass through.
const seams = await fakeEgress();
net.connect = net.createConnection = (...args) => {
  const [first] = args;
  if (first && typeof first === "object" && typeof first.host === "string" && first.host !== LOOPBACK) return seams.dial(first.host, first.port);
  return real(...args);
};
dns.lookup = (host, options, callback) => seams.lookup(host, options, callback);
syncBuiltinESMExports();
setTimeout(() => process.exit(0), 180_000);
