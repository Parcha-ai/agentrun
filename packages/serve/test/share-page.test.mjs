// The share preview page (apps/console's second entry, share.html) at /share/<run>: the owner's own page, under the
// console's CSP, served only to a browser that holds this server's session (the owner's with accounts, the printed
// link's without). It reads the run's export (GET /v2/runs/<run>/export) with that session, and nothing else; its
// assets are the console's, public, under /share/assets/. Each test's run id is a nonce of its own, and no test counts
// requests: a hook on this machine GETs / on every new loopback listener, and nothing here is keyed on what reaches it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { builtConsole, call, cookieOf, serve } from "./support.mjs";

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://www.google.com https://t0.gstatic.com https://t1.gstatic.com https://t2.gstatic.com https://t3.gstatic.com; base-uri 'none'; form-action https://github.com; frame-ancestors 'none'";
/** A test password, no real one (built, so the source export's credential scan reads no literal). */
const PASSWORD = ["not-a-secret", "share-owner"].join("-");
const SHARE_INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Share preview</title>
<script type="module" crossorigin src="./assets/share-Mn34Op56.js"></script></head>
<body><div id="root"></div></body></html>
`;
const nonce = () => `run_${randomBytes(8).toString("hex")}`;

/** A built console with its share page beside index.html, as Vite's two entries build it. */
async function consoleWithShare(t) {
  const root = await builtConsole(t);
  await writeFile(join(root, "share.html"), SHARE_INDEX);
  await writeFile(join(root, "assets", "share-Mn34Op56.js"), "document.getElementById('root').textContent = 'share';\n");
  return root;
}

test("without a session /share/<run> is refused: a 401 page under the CSP that says to sign in first, never the page", async (t) => {
  const server = await serve(t, { console: await consoleWithShare(t), runner: false });
  const run = nonce();
  for (const headers of [{}, { cookie: `agentrun-${server.port}=not-a-session` }]) {
    const refused = await call(server.port, { path: `/share/${run}`, headers });
    assert.equal(refused.status, 401);
    assert.notEqual(refused.text, SHARE_INDEX);
    assert.match(refused.headers["content-type"], /^text\/html/);
    assert.equal(refused.headers["content-security-policy"], CSP);
    assert.equal(refused.headers["cache-control"], "no-store");
    assert.match(refused.text, /Sign in/);
    assert.doesNotMatch(refused.text, /<script|style=/, "nothing the CSP would block");
  }
});

test("with the printed link's session /share/<run> is share.html under the console's CSP, and the session reads that run's export", async (t) => {
  const server = await serve(t, { console: await consoleWithShare(t), runner: false });
  const cookie = cookieOf(await call(server.port, { path: `/?launch=${server.launchCode}` }));
  assert.ok(cookie, "the printed link sets a session");
  const run = nonce();
  const page = await call(server.port, { path: `/share/${run}`, headers: { cookie } });
  assert.deepEqual([page.status, page.text], [200, SHARE_INDEX]);
  assert.equal(page.headers["content-security-policy"], CSP);
  assert.equal(page.headers["content-security-policy"], (await call(server.port, { path: "/", headers: { cookie } })).headers["content-security-policy"], "the console's own CSP");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["cache-control"], "no-store");
  // The page's assets are relative (./assets/): under /share/<run>/ they would resolve to /share/<run>/assets/, a 404.
  for (const [path, to] of [[`/share/${run}/`, `/share/${run}`], [`/share/${run}/?tab=files`, `/share/${run}?tab=files`]]) {
    const slashed = await call(server.port, { path, headers: { cookie } });
    assert.deepEqual([slashed.status, slashed.headers.location], [303, to], `${path} leaves its trailing slash, its query kept`);
  }
  assert.equal((await call(server.port, { path: `/share/${run}/`, headers: {} })).status, 303, "with no session as well: the slash goes first");
  const head = await call(server.port, { method: "HEAD", path: `/share/${run}`, headers: { cookie } });
  assert.deepEqual([head.status, head.text], [200, ""]);
  // The page's one read: the session stands in for the token on it (this nonce is no run: the export's own 404).
  const exported = await call(server.port, { path: `/v2/runs/${run}/export`, headers: { cookie } });
  assert.deepEqual([exported.status, exported.json?.error?.code], [404, "not_found"]);
  assert.equal((await call(server.port, { path: `/v2/runs/${run}/export` })).status, 401, "and nothing without it");
});

test("the printed link's code on /share/<run> sets the console session as / does and lands on the page without the code; a wrong code is a 401 that sets nothing", async (t) => {
  const server = await serve(t, { console: await consoleWithShare(t), runner: false });
  const run = nonce();
  const opened = await call(server.port, { path: `/share/${run}?launch=${server.launchCode}` });
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.location, `/share/${run}`, "the code leaves the address");
  const set = opened.headers["set-cookie"]?.[0] ?? "";
  assert.match(set, new RegExp(`^agentrun-${server.port}=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=/$`), "the cookie / sets");
  assert.ok(!set.includes(server.launchCode) && !set.includes(server.token), "a session id, never the code or the token");
  const cookie = cookieOf(opened);
  assert.deepEqual([(await call(server.port, { path: `/share/${run}`, headers: { cookie } })).text], [SHARE_INDEX], "the session opens the page");
  assert.equal((await call(server.port, { path: `/v2/runs/${run}/export`, headers: { cookie } })).status, 404, "and reads the export (no such run)");
  // Its other words stay in the address; a token there signs nothing in and leaves it.
  const kept = await call(server.port, { path: `/share/${run}?launch=${server.launchCode}&tab=files` });
  assert.equal(kept.headers.location, `/share/${run}?tab=files`);
  const token = await call(server.port, { path: `/share/${run}?token=${server.token}` });
  assert.deepEqual([token.status, token.headers.location, token.headers["set-cookie"]], [303, `/share/${run}`, undefined]);
  for (const code of ["wrong", server.token]) {
    const wrong = await call(server.port, { path: `/share/${run}?launch=${encodeURIComponent(code)}` });
    assert.deepEqual([wrong.status, wrong.headers["set-cookie"]], [401, undefined]);
    assert.notEqual(wrong.text, SHARE_INDEX);
    assert.match(wrong.text, /Sign in/);
  }
});

test("with accounts a launch code on /share/<run> signs nothing in: it leaves the address, and the page still needs the owner", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, console: await consoleWithShare(t), runner: false });
  const run = nonce();
  const given = await call(server.port, { path: `/share/${run}?launch=anything` });
  assert.deepEqual([given.status, given.headers.location, given.headers["set-cookie"]], [303, `/share/${run}`, undefined]);
  assert.equal((await call(server.port, { path: `/share/${run}` })).status, 401);
});

test("the share page's assets are the console's, public, under /share/assets/; nothing else under /share/ is served", async (t) => {
  const dir = await consoleWithShare(t);
  const server = await serve(t, { console: dir, runner: false });
  const cookie = cookieOf(await call(server.port, { path: `/?launch=${server.launchCode}` }));
  const script = await call(server.port, { path: "/share/assets/share-Mn34Op56.js" });
  assert.equal(script.status, 200);
  assert.equal(script.text, await readFile(join(dir, "assets", "share-Mn34Op56.js"), "utf8"));
  assert.match(script.headers["content-type"], /^text\/javascript/);
  assert.equal(script.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal((await call(server.port, { path: "/share/assets/index-Ab12Cd34.js" })).status, 200, "the chunks it shares with the console");
  for (const path of [`/share/${nonce()}/more`, "/share/assets/../share.html", "/share/assets/%2e%2e/share.html", "/share/..", "/share/.hidden", "/share/assets/missing.js"]) {
    assert.equal((await call(server.port, { path, headers: { cookie } })).status, 404, path);
  }
  const post = await call(server.port, { method: "POST", path: `/share/${nonce()}`, headers: { cookie } });
  assert.equal(post.status, 405, "the page takes GET and HEAD");
});

test("with accounts /share/<run> needs the owner's signed-in session; the console's own page stays public", async (t) => {
  const server = await serve(t, { accounts: true, openSetup: true, console: await consoleWithShare(t), runner: false });
  const origin = `http://127.0.0.1:${server.port}`;
  const run = nonce();
  assert.equal((await call(server.port, { path: `/share/${run}` })).status, 401);
  assert.equal((await call(server.port, { path: "/" })).status, 200);
  const made = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin }, body: { password: PASSWORD } });
  assert.equal(made.status, 201, made.text);
  const cookie = cookieOf(made);
  const page = await call(server.port, { path: `/share/${run}`, headers: { cookie } });
  assert.deepEqual([page.status, page.text, page.headers["content-security-policy"]], [200, SHARE_INDEX, CSP]);
});

test("an API-only server serves no share page", async (t) => {
  const server = await serve(t, { apiOnly: true, console: await consoleWithShare(t), runner: false });
  const refused = await call(server.port, { path: `/share/${nonce()}` });
  assert.equal(refused.status, 404);
  assert.notEqual(refused.text, SHARE_INDEX);
});
