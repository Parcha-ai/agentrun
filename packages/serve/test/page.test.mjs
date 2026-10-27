// The page at "/" and how a browser holds the token: the link the server prints sets a cookie once, the cookie stands in
// for the Bearer header (a write only from the page's own origin, with a JSON body), and without it the page says to open
// the link. The page's data is pi-durable-agent's store page over the agent store in the data directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "@parcha/pi-durable-agent";
import { STORE_PAGE_FILES } from "@parcha/pi-durable-agent/serve";
import { agent, scratch, serve } from "./support.mjs";

/** One request with every header the caller names, Host and Origin included (fetch sets those itself). */
function call(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

/** A server whose data directory also holds an agent store with one agent, and the cookie its printed link sets. */
async function served(t) {
  const server = await serve(t);
  const store = openStore(server.data);
  try {
    store.createAgent({ id: "calc", name: "Calc" });
    await store.commitRevision("calc", { kind: "agentic", instructions: "Answer.", tools: [] }, { setCurrent: true });
  } finally {
    store.close();
  }
  const opened = await call(server.port, { path: `/?token=${server.token}` });
  const cookie = opened.headers["set-cookie"]?.[0]?.split(";")[0];
  return { ...server, opened, cookie, origin: `http://127.0.0.1:${server.port}` };
}

test("without the cookie the page is a plain page that says to open the printed link; a wrong token sets nothing; the page's files are public, its data is not", async (t) => {
  const { port, token } = await served(t);
  for (const path of ["/", "/?token=wrong", `/?token=${token}x`]) {
    const res = await call(port, { path });
    assert.equal(res.status, 401, path);
    assert.match(res.headers["content-type"], /^text\/html/);
    assert.match(res.text, /Open the link agentrun-serve printed/);
    assert.equal(res.headers["set-cookie"], undefined, path);
    assert.ok(!res.text.includes(token), "the page never holds the token");
  }
  const data = await call(port, { path: "/api/store" });
  assert.equal(data.status, 401);
  assert.equal(data.json.error.code, "unauthenticated");
  for (const path of ["/page.css", "/page.js", "/graph.js", "/serve.js", "/serve.css"]) assert.equal((await call(port, { path })).status, 200, path);
  assert.equal((await call(port, { path: "/v2/agents" })).status, 401);
  assert.equal((await call(port, { path: "/nothing" })).json.error.code, "not_found", "a path that is not the page's is the API's 404");
});

test("the printed link sets an HttpOnly, SameSite=Strict cookie that is not the token, once, and redirects to the same path without it", async (t) => {
  const { port, token, opened, cookie } = await served(t);
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.location, "/");
  const [set, ...more] = opened.headers["set-cookie"];
  assert.deepEqual(more, []);
  assert.deepEqual(set.split("; ").slice(1).sort(), ["HttpOnly", "Path=/", "SameSite=Strict"]);
  assert.match(cookie, /^agentrun-\d+=[A-Za-z0-9_-]{43}$/);
  assert.ok(!set.includes(token), "the cookie is not the API key");
  const kept = await call(port, { path: `/?theme=dark&token=${token}#ignored` });
  assert.equal(kept.headers.location, "/?theme=dark", "other parameters stay");
  const https = await call(port, { path: `/?token=${token}`, headers: { "x-forwarded-proto": "https" } });
  assert.ok(https.headers["set-cookie"][0].split("; ").includes("Secure"), "Secure when the request came over https");
  assert.equal(https.headers["set-cookie"][0].split(";")[0], cookie, "the same cookie for the same token");
});

test("with the cookie: the page is the store page with serve.js before page.js, under a CSP; its /api is the store's; a wrong cookie is no cookie", async (t) => {
  const { port, cookie } = await served(t);
  const page = await call(port, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers["content-security-policy"], /default-src 'self'; script-src 'self'; style-src 'self'/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.deepEqual([...page.text.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map((m) => m[1]), ["/page.css", "/serve.css", "/graph.js", "/serve.js", "/page.js", "/account.js"]);
  assert.match(page.text, /<html lang="en" data-serve="store">/);
  assert.doesNotMatch(page.text, /<style|\sstyle=|\son[a-z]+=|https?:|<script>/i);
  for (const route of ["/page.css", "/page.js", "/graph.js"]) assert.equal((await call(port, { path: route })).text, await readFile(STORE_PAGE_FILES[route].path, "utf8"), `${route} is pi-durable-agent's own`);
  const store = await call(port, { path: "/api/store", headers: { cookie } });
  assert.equal(store.status, 200);
  assert.deepEqual(store.json.agents.map((a) => [a.id, a.name, a.currentKind]), [["calc", "Calc", "agentic"]]);
  assert.equal((await call(port, { path: "/api/agents/calc", headers: { cookie } })).json.agent.id, "calc");
  assert.equal((await call(port, { path: "/api/runs", headers: { cookie } })).status, 200);
  const wrong = cookie.replace(/=./, (m) => (m === "=A" ? "=B" : "=A"));
  assert.equal((await call(port, { headers: { cookie: wrong } })).status, 401);
  assert.equal((await call(port, { path: "/api/store", headers: { cookie: wrong } })).status, 401);
  assert.equal((await call(port, { path: "/v2/agents", headers: { cookie: wrong } })).status, 401);
  assert.equal((await call(port, { method: "POST", headers: { cookie } })).status, 405, "the page takes GET and HEAD");
});

test("the cookie stands in for the Bearer header: every GET, and a write only from the page's own origin with a JSON body", async (t) => {
  const { port, cookie, origin, token } = await served(t);
  const json = { "content-type": "application/json" };
  assert.equal((await call(port, { path: "/v2/agents", headers: { cookie } })).status, 200);
  const write = (id, headers) => call(port, { method: "POST", path: "/v2/agents", headers: { cookie, ...headers }, body: agent(id) });
  const made = await write("same-origin", { ...json, origin });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  for (const [why, headers] of [
    ["another origin", { ...json, origin: "https://evil.example" }],
    ["no origin", json],
    ["the null origin", { ...json, origin: "null" }],
    ["the same host on another scheme", { ...json, origin: `https://127.0.0.1:${port}` }],
    ["a body that is not JSON", { "content-type": "text/plain", origin }],
    ["a form's body", { "content-type": "application/x-www-form-urlencoded", origin }],
  ]) {
    const refused = await write("refused", headers);
    assert.equal(refused.status, 401, why);
    assert.equal(refused.json.error.code, "unauthenticated", why);
  }
  const proxied = await write("over-https", { ...json, origin: `https://127.0.0.1:${port}`, "x-forwarded-proto": "https" });
  assert.equal(proxied.status, 201, "behind a proxy that says https, the page's origin is https");
  const bearer = await call(port, { method: "POST", path: "/v2/agents", headers: { ...json, authorization: `Bearer ${token}` }, body: agent("by-token") });
  assert.equal(bearer.status, 201, "the Bearer header works as before, with no Origin");
  const both = await call(port, { path: "/v2/agents", headers: { cookie, authorization: "Bearer wrong" } });
  assert.equal(both.status, 401, "a Bearer header that is sent is the one checked");
});

test("the bin prints the page's link once, with the token, beside the base URL and the key", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGTERM"));
  let out = "";
  for await (const chunk of child.stdout) {
    out += chunk;
    if (/\?token=.*\n/.test(out)) break;
  }
  const lines = out.trim().split("\n");
  const prefix = "AGENTRUN_API_KEY=";
  const key = lines.find((line) => line.startsWith(prefix)).slice(prefix.length);
  const links = lines.filter((line) => line.includes("?token="));
  assert.equal(links.length, 1);
  assert.match(links[0], new RegExp(`^Open http://127\\.0\\.0\\.1:\\d+/\\?token=${key}$`));
});

test("with AGENTRUN_PUBLIC_URL, the bin prints the link and base URL a person opens (a container's published port), not the one it listens on", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, AGENTRUN_PUBLIC_URL: "http://127.0.0.1:8123/" } });
  t.after(() => child.kill("SIGTERM"));
  let out = "";
  for await (const chunk of child.stdout) {
    out += chunk;
    if (/\?token=.*\n/.test(out)) break;
  }
  const key = /^AGENTRUN_API_KEY=(.+)$/m.exec(out)?.[1];
  assert.match(out, new RegExp(`^Open http://127\\.0\\.0\\.1:8123/\\?token=${key}$`, "m"), out);
  assert.match(out, /^AGENTRUN_BASE_URL=http:\/\/127\.0\.0\.1:8123\/v2$/m, out);
});

test("an AGENTRUN_PUBLIC_URL that is not an http(s) URL stops the bin before it serves", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0"], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, AGENTRUN_PUBLIC_URL: "javascript:alert(1)" } });
  const killer = setTimeout(() => child.kill("SIGTERM"), 10_000);
  t.after(() => (clearTimeout(killer), child.kill("SIGTERM")));
  let err = "";
  for await (const chunk of child.stderr) err += chunk;
  const code = await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve(child.exitCode)));
  assert.equal(code, 2, err);
  assert.match(err, /AGENTRUN_PUBLIC_URL/);
});

test("with AGENTRUN_TOKEN and --listen 0.0.0.0, the bin requires that token, prints a loopback link and never prints the token", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const token = `env_${"0123456789abcdef".repeat(3)}`;
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--listen", "0.0.0.0", "--port", "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, AGENTRUN_TOKEN: token } });
  t.after(() => child.kill("SIGTERM"));
  let out = "";
  for await (const chunk of child.stdout) {
    out += chunk;
    if (/\?token=.*\n/.test(out)) break;
  }
  assert.equal(out.includes(token), false, "the token from the environment is never printed");
  const [, port] = /^Open http:\/\/127\.0\.0\.1:(\d+)\/\?token=\$AGENTRUN_TOKEN$/m.exec(out) ?? [];
  assert.ok(port, out);
  assert.match(out, /listening on 0\.0\.0\.0/);
  assert.equal((await call(Number(port), { path: "/v2/agents", headers: { host: "agents.example.com", authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await call(Number(port), { path: "/v2/agents", headers: { host: "agents.example.com" } })).status, 401);
});
