// The tests' network for a box's egress proxy (startServe's `fauxEgress`, under `--faux`; box-egress.ts): every name
// answers with a public address that is never dialled (but INNER's, which the proxy must refuse), and every dial reaches
// this module's own origin, on loopback in the run's process, which answers each request with what it was asked: its
// method, host and path, and the names of the headers it got. No lookup or connection leaves this machine.
import { createServer } from "node:http";
import { connect } from "node:net";

let listening;
const origin = () =>
  (listening ??= new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end(`fake origin: ${req.method} ${req.headers.host}${req.url}\nheaders: ${Object.keys(req.headers).sort().join(",")}\n`);
    });
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve(server.address().port);
    });
  }));

/** Names that resolve where a box must not go: OrbStack's VM host and gateway (0.0.0.0/8), as a Mac measured them. */
export const INNER = { "vm-host.example.org": "0.250.250.254", "vm-gateway.example.org": "0.250.250.1" };

export default async function fakeEgress() {
  const port = await origin();
  return {
    lookup: (host, _options, callback) => process.nextTick(callback, null, [{ address: INNER[host] ?? "1.1.1.1", family: 4 }]),
    dial: () => connect({ host: "127.0.0.1", port }),
  };
}
