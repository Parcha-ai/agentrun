#!/usr/bin/env node
// The page's dev loop: agentrun-serve on the seeded data directory (seeded first when it is missing), behind a loopback
// proxy that answers the page's own files from the source folders on every request. Edit page.js, serve.js or their
// styles and reload the browser; the server keeps running. Everything else (/v2, /api/*, the token link) is the server's.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startServe } from "../dist/index.js";
import { DEFAULT_DATA, FAUX, seed } from "./seed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const storePage = join(here, "..", "..", "pi-durable-agent", "src", "serve");
const servePage = join(here, "..", "src", "page");
const CSS = "text/css; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
/** The page's files, read from the source on each request. */
const LIVE = {
  "/page.css": [join(storePage, "page.css"), CSS],
  "/page.js": [join(storePage, "page.js"), JS],
  "/graph.js": [join(storePage, "graph.js"), JS],
  "/serve.css": [join(servePage, "serve.css"), CSS],
  "/serve.js": [join(servePage, "serve.js"), JS],
  "/storyboard.html": [join(here, "storyboard.html"), "text/html; charset=utf-8"],
  "/storyboard.css": [join(here, "storyboard.css"), CSS],
  "/storyboard.js": [join(here, "storyboard.js"), JS],
};
const INDEX = join(servePage, "index.html");
// The headers the server sends with its page (src/page.ts), but the page may be framed by its own origin: the
// storyboard frames it.
const SECURITY = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const { values } = parseArgs({ options: { data: { type: "string" }, port: { type: "string", default: "7341" }, "api-port": { type: "string", default: "7342" } } });
const data = resolve(values.data ?? DEFAULT_DATA);
if (!existsSync(join(data, "store.sqlite"))) await seed({ data });
const server = await startServe({ data, port: Number(values["api-port"]), faux: FAUX, drainTimeout: "1s" });
const upstream = new URL(server.url);
let own = "";

const proxy = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const live = req.method === "GET" ? LIVE[path] : undefined;
  if (live) {
    const body = await readFile(live[0]);
    res.writeHead(200, { ...SECURITY, "content-type": live[1], "content-length": body.length });
    return void res.end(body);
  }
  const headers = { ...req.headers, host: upstream.host };
  // The server takes the page's cookie for a write only from its own origin: this proxy's origin stands for it.
  if (headers.origin === own) headers.origin = upstream.origin;
  const out = request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, async (answer) => {
    if (path === "/" && answer.statusCode === 200 && String(answer.headers["content-type"]).startsWith("text/html")) {
      answer.resume();
      const body = await readFile(INDEX);
      res.writeHead(200, { ...SECURITY, "content-type": "text/html; charset=utf-8", "content-length": body.length });
      return void res.end(body);
    }
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  out.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`the server did not answer: ${error.message}`);
  });
  req.pipe(out);
});
await new Promise((done, fail) => (proxy.once("error", fail), proxy.listen(Number(values.port), "127.0.0.1", done)));
own = `http://127.0.0.1:${proxy.address().port}`;

console.log(`agentrun-serve on ${server.baseUrl} over ${data} (sample model: dev/faux.mjs)`);
console.log(`The page, with its files read from src on every request: ${own}/ (the storyboard: ${own}/storyboard.html)`);
console.log(`Open ${own}/?token=${server.token}`);
const stop = () => {
  proxy.close();
  proxy.closeAllConnections();
  void server.close().then(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
