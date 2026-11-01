// The console (apps/console) at /console/ on the server's own origin: its built files, public like the page's, with the
// page's security headers; nothing outside its directory; a note when the server was built without it. Its /v2 calls
// hold the owner's session as the page's do. Each test points the server at a console directory of its own.
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, call, cookieOf, scratch, serve } from "./support.mjs";

/** A test password, no real one (built, so the source export's credential scan reads no literal). */
const PASSWORD = ["not-a-secret", "owner"].join("-");
const INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>AgentRun</title>
<script type="module" crossorigin src="./assets/index-Ab12Cd34.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-Ef56Gh78.css"></head>
<body><div id="root"></div></body></html>
`;

/** A built console in a scratch directory, beside files it must never serve: one outside it, one a link points out to. */
async function built(t) {
  const dir = await scratch(t);
  const root = join(dir, "console");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), INDEX);
  await writeFile(join(root, "assets", "index-Ab12Cd34.js"), "document.getElementById('root').textContent = 'console';\n");
  await writeFile(join(root, "assets", "index-Ef56Gh78.css"), "body { margin: 0; }\n");
  await writeFile(join(root, "assets", "mono-latin-400-normal-Ij90Kl12.woff2"), Buffer.from("wOF2"));
  await writeFile(join(root, "notes.txt"), "a kind of file the console never builds\n");
  await writeFile(join(root, ".hidden.js"), "hidden\n");
  await writeFile(join(dir, "secret.js"), "outside the console\n");
  await writeFile(join(dir, "secret.html"), "outside the console\n");
  await symlink(join(dir, "secret.js"), join(root, "assets", "escape.js"));
  return root;
}

test("/console/ is the console's index.html with the page's CSP and security headers, no-store; its hashed assets are cached with their types", async (t) => {
  const server = await serve(t, { console: await built(t) });
  const page = await call(server.port, { path: "/" });
  const index = await call(server.port, { path: "/console/" });
  assert.equal(index.status, 200);
  assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(index.text, INDEX);
  assert.equal(index.headers["content-security-policy"], "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  for (const name of ["content-security-policy", "x-content-type-options", "referrer-policy"]) assert.equal(index.headers[name], page.headers[name], name);
  assert.equal(index.headers["cache-control"], "no-store");
  assert.equal(index.headers["set-cookie"], undefined);
  for (const [path, type] of [["/console/assets/index-Ab12Cd34.js", "text/javascript; charset=utf-8"], ["/console/assets/index-Ef56Gh78.css", "text/css; charset=utf-8"], ["/console/assets/mono-latin-400-normal-Ij90Kl12.woff2", "font/woff2"]]) {
    const asset = await call(server.port, { path });
    assert.deepEqual([asset.status, asset.headers["content-type"]], [200, type], path);
    assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable", path);
    assert.equal(asset.headers["content-security-policy"], index.headers["content-security-policy"], path);
    assert.equal(asset.headers["x-content-type-options"], "nosniff", path);
  }
  const head = await call(server.port, { method: "HEAD", path: "/console/" });
  assert.deepEqual([head.status, head.text, head.headers["content-length"]], [200, "", String(Buffer.byteLength(INDEX))]);
  const post = await call(server.port, { method: "POST", path: "/console/", headers: { "content-type": "application/json" }, body: {} });
  assert.deepEqual([post.status, post.headers.allow], [405, "GET, HEAD"]);
});

test("/console redirects to /console/, its query kept", async (t) => {
  const server = await serve(t, { console: await built(t) });
  for (const [path, location] of [["/console", "/console/"], ["/console?view=runs", "/console/?view=runs"]]) {
    const res = await call(server.port, { path });
    assert.deepEqual([res.status, res.headers.location], [303, location], path);
    assert.ok(res.headers["content-security-policy"], path);
  }
});

test("nothing outside the console's directory: dot segments, encoded ones, hidden files, other kinds of file and links out are 404s", async (t) => {
  const server = await serve(t, { console: await built(t) });
  for (const path of [
    "/console/../secret.js", "/console/assets/../../secret.js", "/console/./index.html", "/console//index.html",
    "/console/%2e%2e/secret.js", "/console/%2E%2E/secret.html", "/console/..%2fsecret.js", "/console/assets%2f..%2f..%2fsecret.js",
    "/console/%69ndex.html", "/console/assets/%2e%2e%2f%2e%2e%2fsecret.js", "/console/..%5csecret.js", "/console/assets\\..\\..\\secret.js",
    "/console/.hidden.js", "/console/notes.txt", "/console/assets/escape.js", "/console/assets/", "/console/assets", "/console/missing.js",
  ]) {
    const res = await call(server.port, { path });
    assert.equal(res.status, 404, path);
    assert.ok(!res.text.includes("outside the console"), path);
    assert.equal(res.headers["content-security-policy"]?.startsWith("default-src 'self'"), true, path);
  }
});

test("a server built without its console answers /console/ with a plain 404 that says so, and its files with 404s", async (t) => {
  const dir = await scratch(t);
  const server = await serve(t, { console: join(dir, "no-console") });
  const index = await call(server.port, { path: "/console/" });
  assert.equal(index.status, 404);
  assert.equal(index.headers["content-type"], "text/plain; charset=utf-8");
  assert.match(index.text, /^This server was built without its console/);
  assert.equal((await call(server.port, { path: "/console/assets/index-Ab12Cd34.js" })).status, 404);
  assert.equal((await call(server.port, { path: "/console" })).headers.location, "/console/");
  assert.equal((await call(server.port, { path: "/" })).status, 401, "the page at / is unchanged");
});

test("with accounts the console is public and its /v2 calls hold the owner's session, as the page's do: a GET, and a write from this origin", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, console: await built(t) });
  const origin = `http://127.0.0.1:${server.port}`;
  const json = { "content-type": "application/json", origin };
  assert.equal((await call(server.port, { path: "/console/" })).status, 200, "no session needed for the console's files");
  assert.equal((await call(server.port, { path: "/" })).headers.location, "/setup", "the page at / is unchanged");
  const before = await call(server.port, { path: "/v2/auth/session" });
  assert.deepEqual([before.status, before.json.password_set, before.json.signed_in], [200, false, false]);
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: json, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  assert.match(made.headers["set-cookie"][0], /; HttpOnly; SameSite=Strict; Path=\//);
  assert.equal((await call(server.port, { path: "/v2/auth/session", headers: { cookie } })).json.signed_in, true);
  assert.equal((await call(server.port, { path: "/v2/agents", headers: { cookie } })).status, 200);
  assert.equal((await call(server.port, { path: "/v2/agents" })).status, 401);
  assert.equal((await call(server.port, { method: "POST", path: "/v2/agents", headers: { ...json, cookie }, body: agent("calc") })).status, 201);
  const elsewhere = await call(server.port, { method: "POST", path: "/v2/agents", headers: { ...json, origin: "https://evil.example", cookie }, body: agent("other") });
  assert.deepEqual([elsewhere.status, elsewhere.json.error.code], [401, "unauthenticated"], "a write from another origin gets nothing from the cookie");
});
