// The Host check of a server on loopback: the guard against DNS rebinding, where a page on a name of its own (rebound to
// 127.0.0.1) calls this server. It refuses every name but this machine's, and the port is not part of the check: through
// a tunnel (`ssh -L 8080:localhost:7340`) or a proxy, the Host's port is the one the person opened, not the server's.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { hostName } from "../dist/host-check.js";
import { call, serve } from "./support.mjs";

/** A GET to the server at `port` with the Host header `host`, as a browser (`accept: text/html`) or a script sends it. */
const get = (port, host, { path = "/v2/capabilities", accept = "application/json" } = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host, accept } }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], csp: res.headers["content-security-policy"], body }));
    });
    req.once("error", reject).end();
  });

test("a Host header's name is its name without the port, lowercased; anything that is not name[:port] has none", () => {
  assert.equal(hostName("localhost:7340"), "localhost");
  assert.equal(hostName("LocalHost:8080"), "localhost");
  assert.equal(hostName("127.0.0.1"), "127.0.0.1");
  assert.equal(hostName("[::1]:9"), "[::1]");
  assert.equal(hostName("agentrun.example.com"), "agentrun.example.com");
  for (const bad of ["", "evil@localhost:7340", "localhost:7340@evil.example", "localhost:", "localhost:http", "localhost:123456", "local host", "localhost/x", "[::1", undefined]) {
    assert.equal(hostName(bad), undefined, String(bad));
  }
});

test("on loopback, this machine's names are served on any port, and a name rebound to this address still is not", async (t) => {
  const { port } = await serve(t);
  for (const host of [`localhost:${port}`, "localhost:8080", "127.0.0.1:8080", "[::1]:7341", "localhost", "127.0.0.1", "LOCALHOST:1"]) {
    assert.equal((await get(port, host)).status, 200, host);
  }
  for (const host of [`evil.example:${port}`, "evil.example", `localhost.evil.example:${port}`, `127.0.0.1.nip.io:${port}`, `evil@localhost:${port}`, `localhost:${port}@evil.example`, "localhost:http", "127.0.0.2:8080"]) {
    const refused = await get(port, host);
    assert.equal(refused.status, 403, host);
    assert.equal(JSON.parse(refused.body).error.code, "forbidden", host);
  }
});

test("a refused Host gets a page that names the fix in a browser, and the same fix in the JSON a script reads; neither repeats the Host", async (t) => {
  const { port } = await serve(t);
  const page = await get(port, "evil.example:8080", { path: "/", accept: "text/html,application/xhtml+xml" });
  assert.equal(page.status, 403);
  assert.match(page.type, /^text\/html/);
  assert.match(page.csp, /default-src 'self'/, "the page is under the console's CSP");
  assert.match(page.body, /localhost/);
  assert.match(page.body, /AGENTRUN_PUBLIC_URL/);
  assert.match(page.body, /--allow-host/);
  assert.doesNotMatch(page.body, /evil\.example/, "what the page shows is fixed text, never the name that was sent");
  const api = await get(port, "evil.example:8080");
  assert.match(api.type, /^application\/json/);
  const { message } = JSON.parse(api.body).error;
  assert.match(message, /^unexpected Host header/);
  assert.match(message, new RegExp(`ssh -L ${port}:localhost:${port}`), "the tunnel example names this server's own port");
  assert.match(page.body, new RegExp(`ssh -L ${port}:localhost:${port}`), "and so does the page");
  assert.match(message, /localhost or 127\.0\.0\.1/);
  assert.match(message, /AGENTRUN_PUBLIC_URL/);
  assert.doesNotMatch(message, /evil\.example/);
});

test("on loopback, the public address's name and an --allow-host name are served, on any port and with none (a proxy in front sends its own)", async (t) => {
  const { port } = await serve(t, { publicUrl: "https://agentrun.example.com", allowHosts: ["agents.internal", "Box.Internal:9000"] });
  for (const host of ["agentrun.example.com", "agentrun.example.com:443", "agents.internal", `agents.internal:${port}`, "box.internal:1"]) {
    assert.equal((await get(port, host)).status, 200, host);
  }
  for (const host of ["other.example.com", "example.com", "agentrun.example.com.evil.example", "internal"]) {
    assert.equal((await get(port, host)).status, 403, host);
  }
});

test("behind an HTTPS proxy on the same machine that keeps the browser's Host (Caddy's default), the owner sets up and signs in at the public address, and another origin is still refused", async (t) => {
  const server = await serve(t, { accounts: true, publicUrl: "https://agentrun.example.com" });
  const code = new URL(server.setupUrl).hash.slice("#code=".length);
  const proxied = { host: "agentrun.example.com", "x-forwarded-proto": "https", origin: "https://agentrun.example.com", "content-type": "application/json" };
  const post = (path, body, headers = proxied) => call(server.port, { method: "POST", path, headers, body });
  const password = `not-a-secret-${"owner"}`; // made, not a literal, as owner-auth.test.mjs makes its own (export-source.mjs)
  assert.equal((await post("/v2/setup", { password, code })).status, 201, "setup at the public address");
  const signedIn = await post("/v2/auth/sign-in", { password });
  assert.equal(signedIn.status, 200, signedIn.text);
  const [cookie] = signedIn.headers["set-cookie"];
  assert.match(cookie, /^__Host-agentrun-session=.*; Secure$/, "over https, the __Host- cookie");
  const agents = await call(server.port, { path: "/v2/agents", headers: { host: "agentrun.example.com", "x-forwarded-proto": "https", cookie: cookie.split(";")[0] } });
  assert.equal(agents.status, 200, agents.text);
  const elsewhere = await post("/v2/auth/sign-in", { password }, { ...proxied, origin: "https://evil.example" });
  assert.equal(elsewhere.status, 403, "a page on another origin, through the same proxy");
});
