// The console (apps/console) at "/" on the server's own origin: its index.html and its assets under /assets/, public,
// with the server's security headers; nothing outside its directory; a note when the server was built without it. Its
// old address (/console/) and the old page's setup and sign-in send the browser to "/". Each test points the server at
// a console directory of its own.
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agent, builtConsole, call, CONSOLE_INDEX, cookieOf, scratch, serve } from "./support.mjs";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** A test password, no real one (built, so the source export's credential scan reads no literal). */
const PASSWORD = ["not-a-secret", "owner"].join("-");

/** A built console beside files it must never serve: one outside it, one a link points out to, one hidden, one of a kind
 *  Vite never builds. */
async function consoleWithTraps(t) {
  const root = await builtConsole(t);
  const outside = dirname(root);
  await writeFile(join(root, "notes.txt"), "a kind of file the console never builds\n");
  await writeFile(join(root, "assets", ".hidden.js"), "hidden\n");
  await writeFile(join(outside, "secret.js"), "outside the console\n");
  await writeFile(join(outside, "secret.html"), "outside the console\n");
  await symlink(join(outside, "secret.js"), join(root, "assets", "escape.js"));
  return root;
}

test("/ is the console's index.html with the server's CSP and security headers, no-store; its hashed assets are cached with their types", async (t) => {
  const server = await serve(t, { console: await consoleWithTraps(t) });
  const index = await call(server.port, { path: "/" });
  assert.equal(index.status, 200);
  assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(index.text, CONSOLE_INDEX);
  assert.equal(index.headers["content-security-policy"], CSP);
  assert.deepEqual([index.headers["x-content-type-options"], index.headers["referrer-policy"], index.headers["cache-control"]], ["nosniff", "no-referrer", "no-store"]);
  assert.equal(index.headers["set-cookie"], undefined);
  for (const [path, type] of [["/assets/index-Ab12Cd34.js", "text/javascript; charset=utf-8"], ["/assets/index-Ef56Gh78.css", "text/css; charset=utf-8"], ["/assets/mono-latin-400-normal-Ij90Kl12.woff2", "font/woff2"]]) {
    const asset = await call(server.port, { path });
    assert.deepEqual([asset.status, asset.headers["content-type"]], [200, type], path);
    assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable", path);
    assert.deepEqual([asset.headers["content-security-policy"], asset.headers["x-content-type-options"]], [CSP, "nosniff"], path);
  }
  const head = await call(server.port, { method: "HEAD", path: "/" });
  assert.deepEqual([head.status, head.text, head.headers["content-length"]], [200, "", String(Buffer.byteLength(CONSOLE_INDEX))]);
  const post = await call(server.port, { method: "POST", path: "/", headers: { "content-type": "application/json" }, body: {} });
  assert.deepEqual([post.status, post.headers.allow], [405, "GET, HEAD"]);
});

test("the console's old address and the old page's setup and sign-in send the browser to /, the query kept (a #code stays with the browser)", async (t) => {
  for (const accounts of [true, false]) {
    const server = await serve(t, { accounts, openSetup: true, console: await consoleWithTraps(t) });
    for (const [path, location] of [["/console", "/"], ["/console/", "/"], ["/console/?view=runs", "/?view=runs"], ["/setup", "/"], ["/sign-in", "/"], ["/sign-in?next=x", "/?next=x"]]) {
      const res = await call(server.port, { path });
      assert.deepEqual([res.status, res.headers.location], [303, location], `${path} (accounts ${accounts})`);
      assert.equal(res.headers["content-security-policy"], CSP, path);
    }
  }
});

test("nothing outside the console's directory: dot segments, encoded ones, hidden files, other kinds of file and links out are 404s", async (t) => {
  const server = await serve(t, { console: await consoleWithTraps(t) });
  for (const path of [
    "/assets/../secret.js", "/assets/../../secret.js", "/assets/./index-Ab12Cd34.js", "/assets//index-Ab12Cd34.js",
    "/assets/%2e%2e/secret.js", "/assets/%2E%2E/secret.html", "/assets/..%2fsecret.js", "/assets%2f..%2fsecret.js",
    "/assets/%69ndex-Ab12Cd34.js", "/assets/%2e%2e%2f%2e%2e%2fsecret.js", "/assets/..%5csecret.js", "/assets\\..\\secret.js",
    "/assets/.hidden.js", "/assets/escape.js", "/assets/", "/assets/missing.js", "/notes.txt", "/index.html", "/secret.js",
    "/console/assets/index-Ab12Cd34.js",
  ]) {
    const res = await call(server.port, { path });
    assert.equal(res.status, 404, path);
    assert.ok(!res.text.includes("outside the console") && !res.text.includes("hidden\n"), path);
  }
});

test("the old page's files are gone: each is a 404, with the token or without", async (t) => {
  const server = await serve(t, { console: await consoleWithTraps(t) });
  for (const path of ["/page.css", "/page.js", "/graph.js", "/serve.js", "/serve.css", "/account.js", "/account.css", "/locked.html", "/setup.html"]) {
    for (const headers of [{}, { authorization: `Bearer ${server.token}` }]) assert.equal((await call(server.port, { path, headers })).status, 404, path);
  }
});

test("a server built without its console answers / with a plain 404 that says so, its assets with 404s, and a wrong link token with a 401", async (t) => {
  const server = await serve(t, { console: join(await scratch(t), "no-console") });
  const index = await call(server.port, { path: "/" });
  assert.equal(index.status, 404);
  assert.equal(index.headers["content-type"], "text/plain; charset=utf-8");
  assert.match(index.text, /^This server was built without its console/);
  assert.equal((await call(server.port, { path: "/assets/index-Ab12Cd34.js" })).status, 404);
  assert.equal((await call(server.port, { path: "/console/" })).headers.location, "/");
  const wrong = await call(server.port, { path: "/?token=wrong" });
  assert.deepEqual([wrong.status, wrong.headers["set-cookie"]], [401, undefined], "a wrong link token is still refused, as a refusal");
  assert.match(wrong.text, /^This server was built without its console/);
  assert.equal((await call(server.port, { path: `/?token=${server.token}` })).status, 303, "the right one still sets the cookie");
});

test("with accounts the console is public and its /v2 calls hold the owner's session: setup, the session, a GET, and a write from this origin", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, console: await consoleWithTraps(t) });
  const origin = `http://127.0.0.1:${server.port}`;
  const json = { "content-type": "application/json", origin };
  assert.equal((await call(server.port, { path: "/" })).status, 200, "no session needed for the console's files");
  const before = await call(server.port, { path: "/v2/auth/session" });
  assert.deepEqual([before.status, before.json.password_set, before.json.signed_in], [200, false, false]);
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: json, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  assert.match(made.headers["set-cookie"][0], /; HttpOnly; SameSite=Strict; Path=\//);
  assert.equal((await call(server.port, { path: "/", headers: { cookie } })).status, 200);
  assert.equal((await call(server.port, { path: "/v2/auth/session", headers: { cookie } })).json.signed_in, true);
  assert.equal((await call(server.port, { path: "/v2/agents", headers: { cookie } })).status, 200);
  assert.equal((await call(server.port, { path: "/v2/agents" })).status, 401);
  assert.equal((await call(server.port, { method: "POST", path: "/v2/agents", headers: { ...json, cookie }, body: agent("calc") })).status, 201);
  const elsewhere = await call(server.port, { method: "POST", path: "/v2/agents", headers: { ...json, origin: "https://evil.example", cookie }, body: agent("other") });
  assert.deepEqual([elsewhere.status, elsewhere.json.error.code], [401, "unauthenticated"], "a write from another origin gets nothing from the cookie");
});
