// The live tests' fake network, loaded (NODE_OPTIONS=--import) into the egress proxy container of the image
// egress.docker.test.mjs builds: every name resolves as NAMES says (a public address that is never dialled, or a private,
// loopback or link-local one the proxy must refuse), each lookup is logged, and every connection to an address goes to
// this module's origin on the container's own loopback, which answers each request with what it was asked. A Unix
// socket and a loopback connection are left as they are. No lookup or connection leaves the container.
import dns from "node:dns";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const LOOPBACK = "127.0.0.1";
const PRIVATE = "10.0.0.1"; // key-gate: denylist where a listed name resolves for the proxy to refuse
const METADATA = "169.254.169.254"; // key-gate: denylist where a listed name resolves for the proxy to refuse
/** The names the tests list, and what each resolves to here. */
const NAMES = { "origin.example": "93.184.215.14", "inner.example": PRIVATE, "loop.example": LOOPBACK, "meta.example": METADATA };

const port = await new Promise((resolve) => {
	const origin = createServer((req, res) => {
		res.setHeader("content-type", "text/plain");
		res.end(`fake origin: ${req.method} ${req.headers.host}${req.url}\n`);
	});
	origin.listen(0, LOOPBACK, () => {
		origin.unref();
		resolve(origin.address().port);
	});
});

const real = net.connect;
net.connect = net.createConnection = (...args) => {
	const [first] = args;
	if (first && typeof first === "object" && typeof first.host === "string" && first.host !== LOOPBACK) return real({ host: LOOPBACK, port });
	return real(...args);
};
dns.lookup = (host, options, callback) => {
	process.stdout.write(`fake lookup ${host}\n`);
	const address = NAMES[host.toLowerCase()];
	if (address === undefined) return process.nextTick(callback, Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" }), []);
	process.nextTick(callback, null, [{ address, family: 4 }]);
};
syncBuiltinESMExports();
