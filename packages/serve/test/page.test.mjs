// The page at "/" is the console (apps/console's build in dist/console), and how a browser holds the token: the link the
// server prints sets a cookie once, the cookie stands in for the Bearer header (a write only from the page's own origin,
// with a JSON body). The console's files are public and hold no data; every path that is the API's (an unknown /v2 path,
// /api/*, a file the console does not have) answers as the API does, never with the console's page.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "@parcha/pi-durable-agent";
import { agent, scratch, serve } from "./support.mjs";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** A console build as Vite makes one: index.html with one module script and one stylesheet, both external, and assets/. */
const INDEX = `<!doctype html>\n<html lang="en" class="dark"><head><meta charset="utf-8"><title>AgentRun</title><script type="module" crossorigin src="./assets/index-a1b2.js"></script><link rel="stylesheet" crossorigin href="./assets/index-c3d4.css"></head><body><div id="root"></div></body></html>\n`;
async function consoleBuild(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-console-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), INDEX);
  await writeFile(join(dir, "assets", "index-a1b2.js"), "export const console = 1;\n");
  await writeFile(join(dir, "assets", "index-c3d4.css"), "body{margin:0}\n");
  await writeFile(join(dir, "assets", "font-e5f6.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  await writeFile(join(dir, "secret.txt"), "outside assets\n");
  return dir;
}

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
async function served(t, options = {}) {
  const server = await serve(t, { consoleDir: await consoleBuild(t), ...options });
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

test("the console is public: index.html at / and at any path with no extension, under the CSP; a wrong token sets nothing and no file holds the token; its data is not public", async (t) => {
  const { port, token } = await served(t);
  for (const path of ["/", "/agents/x", "/runs/r1", "/setup", "/sign-in", "/?token=wrong", `/?token=${token}x`]) {
    const res = await call(port, { path });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8", path);
    assert.equal(res.text, INDEX, `${path} is the console's index.html`);
    assert.equal(res.headers["content-security-policy"], CSP, path);
    assert.equal(res.headers["x-content-type-options"], "nosniff", path);
    assert.equal(res.headers["referrer-policy"], "no-referrer", path);
    assert.equal(res.headers["cache-control"], "no-store", path);
    assert.equal(res.headers["set-cookie"], undefined, path);
    assert.ok(!res.text.includes(token), `${path}: the page never holds the token`);
  }
  assert.equal((await call(port, { path: "/v2/agents" })).status, 401, "the page's data needs a credential");
});

test("the console's files: from its assets only, with their type and a long cache; anything else is the API's 404, never the page", async (t) => {
  const { port, token } = await served(t);
  for (const [path, type] of [["/assets/index-a1b2.js", "text/javascript; charset=utf-8"], ["/assets/index-c3d4.css", "text/css; charset=utf-8"], ["/assets/font-e5f6.woff2", "font/woff2"]]) {
    const res = await call(port, { path });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers["content-type"], type, path);
    assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable", path);
    assert.equal(res.headers["content-security-policy"], CSP, path);
    assert.equal(res.headers["x-content-type-options"], "nosniff", path);
    assert.ok(!res.text.includes(token), path);
  }
  for (const path of ["/v2/nope", "/v2/agents/x/nope", "/api/store", "/api/runs", "/nope.js", "/assets/missing.js", "/assets/../secret.txt", "/assets/%2e%2e/secret.txt", "/assets/%2E%2E%2Fsecret.txt", "/assets/..%5csecret.txt", "/assets/index-a1b2.exe", "/secret.txt", "/assets/"]) {
    const res = await call(port, { path });
    assert.equal(res.status, path.startsWith("/v2/agents/x") ? 404 : 404, path);
    assert.match(res.headers["content-type"], /^application\/json/, `${path} answers JSON, never the page`);
    assert.equal(res.json.error.code, "not_found", path);
    assert.ok(!res.text.includes("<html"), path);
  }
});

test("the page takes GET and HEAD only: a HEAD has the GET's headers and no body, a POST is 405", async (t) => {
  const { port } = await served(t);
  const head = await call(port, { method: "HEAD", path: "/agents/x" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(head.headers["content-security-policy"], CSP);
  assert.equal(head.text, "");
  assert.equal((await call(port, { method: "HEAD", path: "/assets/index-a1b2.js" })).status, 200);
  const post = await call(port, { method: "POST", path: "/" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
});

test("a server built without its console says so at its pages, plainly, and the API is unchanged", async (t) => {
  const empty = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-no-console-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const { port } = await served(t, { consoleDir: empty });
  const page = await call(port, { path: "/" });
  assert.equal(page.status, 200);
  assert.match(page.text, /built without its console/);
  assert.doesNotMatch(page.text, /<script|<style|\sstyle=|\son[a-z]+=/i);
  assert.equal((await call(port, { path: "/assets/index-a1b2.js" })).status, 404);
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

test("with the cookie the page is the same public console, and a wrong cookie is no credential", async (t) => {
  const { port, cookie } = await served(t);
  const page = await call(port, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.equal(page.text, INDEX);
  assert.equal((await call(port, { path: "/v2/agents", headers: { cookie } })).status, 200);
  const wrong = cookie.replace(/=./, (m) => (m === "=A" ? "=B" : "=A"));
  assert.equal((await call(port, { path: "/v2/agents", headers: { cookie: wrong } })).status, 401);
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

test("a write to /v2 from another origin gets no Bearer from the cookie", async (t) => {
  const { port, cookie } = await served(t);
  const res = await call(port, { method: "POST", path: "/v2/agents", headers: { cookie, "content-type": "application/json", origin: "https://evil.example" }, body: agent("from-elsewhere") });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, "unauthenticated");
});

test("the bin prints the page's link once, with the token, beside the base URL and the key", { timeout: 20_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, AGENTRUN_ACCOUNTS: "0" } });
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
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--port", "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, AGENTRUN_ACCOUNTS: "0", AGENTRUN_PUBLIC_URL: "http://127.0.0.1:8123/" } });
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
  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "--data", data, "--listen", "0.0.0.0", "--port", "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, AGENTRUN_ACCOUNTS: "0", AGENTRUN_TOKEN: token } });
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
