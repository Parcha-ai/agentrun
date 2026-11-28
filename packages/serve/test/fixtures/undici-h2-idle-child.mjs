// One HTTP/2 session through an undici Agent with allowH2 and a short keepAliveTimeout, the pool the E2B and Archil
// SDKs build: a first request read to the end, then a second one aborted before it is dispatched, then a wait past the
// session's idle timeout. Prints "survived" and ends 0 when the idle close reaches no stream without an error listener.
// argv: the undici entry file to load, the request shape ("fetch" or "request"), the key and the certificate.
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import { createRequire } from "node:module";

const [undiciPath, shape, keyPath, certPath] = process.argv.slice(2);
const { Agent, fetch, request } = createRequire(import.meta.url)(undiciPath);
const IDLE_MS = 100;

const server = http2.createSecureServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) });
server.on("session", (session) => session.on("error", () => {}));
server.on("stream", (stream) => {
	stream.on("error", () => {});
	stream.respond({ ":status": 200 });
	stream.end("ok");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `https://127.0.0.1:${server.address().port}/`;
const agent = new Agent({ allowH2: true, keepAliveTimeout: IDLE_MS, connect: { rejectUnauthorized: false } });

const first = await fetch(url, { dispatcher: agent });
await first.text();

const abort = new AbortController();
const second = shape === "request" ? request(url, { dispatcher: agent, signal: abort.signal }) : fetch(url, { dispatcher: agent, signal: abort.signal });
abort.abort();
await second.then(
	() => console.log("not aborted"),
	(error) => console.log(`aborted ${error.name}`),
);

await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 4));
console.log("survived");
await agent.close();
server.close();
