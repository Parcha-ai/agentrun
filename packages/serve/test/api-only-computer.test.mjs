// An operator's own front end over an API-only server (AGENTRUN_API_ONLY=1): its backend reads a run's computer, takes it
// over and hands it back with the server's token, and mints a viewer credential (POST /v2/runs/{id}/computer/viewer,
// viewer-credential.ts) its user's browser opens the run's live page and socket with, on the public address alone. The
// credential opens that run's view, until it expires, and never once the run ended; a token that is not the server's
// opens none of it. Without the profile nothing changes: the mint is 404, the live page takes the owner's cookie alone.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fakeDesktopProvider } from "./computer-live-support.mjs";
import { connect } from "./fixtures/ws-client.mjs";
import { call, follow, serve, withEnv } from "./support.mjs";

const FAUX = new URL("./fixtures/faux-desktop-look.mjs", import.meta.url).pathname;
const PUBLIC = "https://agentrun.example.com";
const LINK = /^https:\/\/agentrun\.example\.com(\/v2\/runs\/[^/]+\/computer\/live\/v\/[A-Za-z0-9_-]{22})\?viewer=([0-9]+\.[A-Za-z0-9_-]{43})#t=([A-Za-z0-9_-]{43})$/;

async function until(check, what, ms = 30_000) {
  for (const deadline = Date.now() + ms; !(await check());) {
    assert.ok(Date.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const next = async (ws, type) => JSON.parse((await ws.until((m) => m.type === "text" && JSON.parse(m.data).type === type, 10_000)).item?.data ?? "null");
/** An inline run (the only way an API-only server's backend starts one), its agent's computer `computer`. */
const inline = (id, computer) => ({ external: { source: "grep", kind: "expert", id, version: 1 }, definition: { name: `Expert ${id}`, instructions: "Answer.", skills: [], tools: [], ...(computer ? { computer } : {}) }, input: { content: "Look at the desktop." } });
/** A request with `token` as its bearer (none when undefined). */
const asToken = (server, method, path, token, body) =>
  call(server.port, { method, path, headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body });
/** A request to the public address (its Host), with `headers`. */
const atPublic = (server, path, headers = {}) => call(server.port, { path, headers: { host: "agentrun.example.com", ...headers } });
/** The live socket at `path` on the public address, with `origin` and `headers`. */
const socketAt = (server, path, origin, headers = {}) => connect(`ws://127.0.0.1:${server.port}${path}/ws`, { origin, headers: { host: "agentrun.example.com", ...headers } });

test("API-only: the server's token reads a run's computer, takes it over and hands it back; its viewer credential opens that run's page and socket from the public address alone, until the run ends", { timeout: 120_000 }, async (t) => {
  const sealKey = randomBytes(32);
  withEnv(t, { E2B_API_KEY: "fake-test-key", AGENTRUN_SEAL_KEY: sealKey.toString("base64") }, ["E2B_API_KEY", "AGENTRUN_SEAL_KEY", "AGENTRUN_RUNNER_LIVE_HOST", "AGENTRUN_RUNNER_HOSTS"]);
  const desktop = fakeDesktopProvider({ holdShot: 2 });
  t.after(() => desktop.letGo());
  const server = await serve(t, { apiOnly: true, publicUrl: PUBLIC, faux: FAUX, computers: { load: desktop.load } });
  const started = await asToken(server, "POST", "/v2/runs", server.token, inline("9", { kind: "desktop", provider: "e2b" }));
  assert.equal(started.status, 202, started.text);
  const runId = started.json.run_id;
  const other = await asToken(server, "POST", "/v2/runs", server.token, inline("10"));
  assert.equal(other.status, 202, other.text);
  const otherRun = other.json.run_id;
  const path = `/v2/runs/${runId}/computer`;
  const notTheServers = `not-a-secret-${"x".repeat(32)}`;

  // (a) GET /computer: the server's token, and no other.
  await until(async () => (await asToken(server, "GET", path, server.token)).json?.state === "live", "the run's desktop went live");
  const read = await asToken(server, "GET", path, server.token);
  assert.equal(read.status, 200, read.text);
  assert.deepEqual({ ...read.json, viewer: "" }, { state: "live", kind: "desktop", viewer: "", hold: "agent" });
  assert.equal((await asToken(server, "GET", path, notTheServers)).status, 401, "a token that isn't the server's reads nothing");
  assert.equal((await asToken(server, "GET", path, undefined)).status, 401, "no token reads nothing");

  // (c) The mint: the server's token alone.
  for (const token of [notTheServers, undefined]) assert.equal((await asToken(server, "POST", `${path}/viewer`, token, {})).status, 401, `the mint with ${token ? "another" : "no"} token`);
  const before = Date.now();
  const minted = await asToken(server, "POST", `${path}/viewer`, server.token, {});
  assert.equal(minted.status, 201, minted.text);
  assert.equal(minted.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(minted.json).sort(), ["expires_at", "url"]);
  const [, pagePath, credential, viewerToken] = LINK.exec(minted.json.url) ?? [];
  assert.ok(pagePath?.startsWith(`${path}/live/v/`), minted.json.url);
  const expiresAt = Date.parse(minted.json.expires_at);
  assert.ok(expiresAt >= before + 5 * 60_000 && expiresAt <= Date.now() + 5 * 60_000, `five minutes: ${minted.json.expires_at}`);

  // The page: the credential for this run, the public address's Origin or none (a navigation sends none).
  assert.equal((await atPublic(server, pagePath)).status, 401, "no credential");
  assert.equal((await atPublic(server, `${pagePath}?viewer=${credential}`, { origin: "https://evil.example" })).status, 403, "a wrong Origin");
  const otherPage = pagePath.replace(runId, otherRun);
  assert.equal((await atPublic(server, `${otherPage}?viewer=${credential}`)).status, 403, "another run's");
  const { mintViewerCredential, viewerCredentialKey, VIEWER_CREDENTIAL_MS } = await import("../dist/viewer-credential.js");
  const key = viewerCredentialKey(sealKey);
  const expired = mintViewerCredential(key, runId, Date.now() - VIEWER_CREDENTIAL_MS - 1).credential;
  assert.equal((await atPublic(server, `${pagePath}?viewer=${expired}`)).status, 403, "an expired one");
  const forged = `${Date.now() + 60_000}.${credential.split(".")[1]}`;
  assert.equal((await atPublic(server, `${pagePath}?viewer=${forged}`)).status, 403, "one whose expiry was changed");
  const page = await atPublic(server, `${pagePath}?viewer=${credential}`, { origin: PUBLIC });
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /computer-viewer\.js/);
  const cookie = (page.headers["set-cookie"] ?? [])[0] ?? "";
  assert.match(cookie, new RegExp(`^agentrun-viewer=${credential.replace(".", "\\.")}; HttpOnly; SameSite=Strict; Path=/v2/runs/${runId}/computer/live; Max-Age=(\\d+)$`));
  assert.ok(Number(/Max-Age=(\d+)/.exec(cookie)[1]) <= 300);
  const jar = cookie.split(";")[0];
  const script = await atPublic(server, `${path}/live/computer-viewer.js`, { cookie: jar });
  assert.equal(script.status, 200, "the page's files take the cookie");
  // Nothing else opens to it: the run routes still take the server's token.
  assert.equal((await atPublic(server, `/v2/runs/${runId}`, { cookie: jar })).status, 401);
  assert.equal((await asToken(server, "POST", `${path}/take-over`, credential, {})).status, 401, "the credential is no bearer");

  // The socket: the public address's Origin and the credential's cookie.
  assert.equal((await socketAt(server, pagePath, "https://evil.example", { cookie: jar })).status, 403, "a wrong Origin");
  assert.equal((await socketAt(server, pagePath, `http://127.0.0.1:${server.port}`, { cookie: jar })).status, 403, "this server's own origin is not its public address");
  assert.equal((await socketAt(server, pagePath, PUBLIC)).status, 401, "no credential");
  assert.equal((await socketAt(server, pagePath, PUBLIC, { cookie: `agentrun-viewer=${expired}` })).status, 403, "an expired one");
  assert.equal((await socketAt(server, otherPage, PUBLIC, { cookie: jar })).status, 403, "another run's");
  const c = await socketAt(server, pagePath, PUBLIC, { cookie: jar });
  assert.equal(c.status, 101);
  const ws = c.ws;
  t.after(() => ws.destroy());
  ws.sendJson({ type: "hello", token: viewerToken });
  assert.deepEqual(await next(ws, "ready"), { type: "ready", drive: "agent", takeOver: true, held: false, kind: "desktop", input: "desktop" });
  await ws.until((m) => m.type === "binary", 10_000);
  ws.sendJson({ type: "ack" });

  // (b) Take over and hand back with the server's token, while the agent's second look is in flight; the open viewer hears
  // each. Another token takes nothing.
  await desktop.inShot;
  await until(async () => (await asToken(server, "GET", `/v2/runs/${runId}`, server.token)).json.computer?.state === "ready", "the run's journal says its desktop is up");
  assert.equal((await asToken(server, "POST", `${path}/take-over`, notTheServers, {})).status, 401, "another token's take-over");
  const taken = await asToken(server, "POST", `${path}/take-over`, server.token, {});
  assert.equal(taken.status, 200, taken.text);
  assert.deepEqual(await next(ws, "status"), { type: "status", drive: "pending" });
  desktop.letGo();
  assert.deepEqual(await next(ws, "hold"), { type: "hold", held: true });
  assert.equal((await asToken(server, "POST", `${path}/hand-back`, notTheServers, {})).status, 401, "another token's hand-back");
  const given = await asToken(server, "POST", `${path}/hand-back`, server.token, {});
  assert.equal(given.status, 200, given.text);
  const back = await next(ws, "hold");
  assert.deepEqual([back.held, back.reason], [false, "given"]);

  // The run ends: the socket open on the credential closes, and the same credential, unexpired, opens nothing more.
  await follow(server.api, runId, ["completed"]);
  await until(() => ws.closedWith() !== null, "the socket closed at the run's end", 10_000);
  assert.equal((await atPublic(server, `${pagePath}?viewer=${credential}`)).status, 403, "the page after the run's end");
  assert.equal((await atPublic(server, `${path}/live/computer-viewer.js`, { cookie: jar })).status, 403, "its files after the run's end");
  assert.equal((await socketAt(server, pagePath, PUBLIC, { cookie: jar })).status, 403, "the socket after the run's end");
  const late = await asToken(server, "POST", `${path}/viewer`, server.token, {});
  assert.deepEqual([late.status, late.json?.error?.code], [409, "computer_not_live"], "no mint after the run's end");

  // The credential is in the mint's answer alone: never in the run, its timeline or the runs list.
  for (const p of [`/v2/runs/${runId}`, `/v2/runs/${runId}/timeline`, "/v2/runs"]) assert.ok(!(await asToken(server, "GET", p, server.token)).text.includes(credential), p);
});

test("API-only: a run's computer routes and the mint reach the run with the server's token, and refuse another token", { timeout: 60_000 }, async (t) => {
  withEnv(t, { E2B_API_KEY: "fake-test-key" }, ["E2B_API_KEY"]);
  // No runner: the run stays queued, its desktop not made, so each route answers for a computer that is not up.
  const server = await serve(t, { apiOnly: true, runner: false, publicUrl: PUBLIC });
  const started = await asToken(server, "POST", "/v2/runs", server.token, inline("12", { kind: "desktop", provider: "e2b" }));
  assert.equal(started.status, 202, started.text);
  const path = `/v2/runs/${started.json.run_id}/computer`;
  const notTheServers = `not-a-secret-${"y".repeat(32)}`;
  const read = await asToken(server, "GET", path, server.token);
  assert.deepEqual([read.status, read.json], [200, { state: "none", kind: "desktop", hold: "agent", session: "opening" }], read.text);
  const taken = await asToken(server, "POST", `${path}/take-over`, server.token, {});
  assert.deepEqual([taken.status, taken.json?.error?.code], [409, "computer_not_live"], taken.text);
  const given = await asToken(server, "POST", `${path}/hand-back`, server.token, {});
  assert.equal(given.status, 404, given.text);
  assert.doesNotMatch(given.json.error.message, /AGENTRUN_API_ONLY/, "the route's own 404, not the profile's");
  const minted = await asToken(server, "POST", `${path}/viewer`, server.token, {});
  assert.deepEqual([minted.status, minted.json?.error?.code], [409, "computer_not_live"], minted.text);
  for (const [method, p] of [["GET", path], ["POST", `${path}/take-over`], ["POST", `${path}/hand-back`], ["POST", `${path}/viewer`]]) {
    assert.equal((await asToken(server, method, p, notTheServers, method === "POST" ? {} : undefined)).status, 401, `${method} ${p} with a token that isn't the server's`);
  }
});

test("API-only with no public address: the mint is refused in words, and the live socket opens for no Origin", { timeout: 60_000 }, async (t) => {
  const server = await serve(t, { apiOnly: true, runner: false });
  const started = await asToken(server, "POST", "/v2/runs", server.token, inline("11"));
  assert.equal(started.status, 202, started.text);
  const runId = started.json.run_id;
  const refused = await asToken(server, "POST", `/v2/runs/${runId}/computer/viewer`, server.token, {});
  assert.deepEqual([refused.status, refused.json?.error?.code], [501, "unsupported_here"], refused.text);
  assert.match(refused.json.error.message, /AGENTRUN_PUBLIC_URL is unset/);
  const socket = await connect(`ws://127.0.0.1:${server.port}/v2/runs/${runId}/computer/live/v/${"a".repeat(22)}/ws`, { origin: server.url, headers: { cookie: `agentrun-viewer=1.${"a".repeat(43)}` } });
  assert.equal(socket.status, 403);
});

test("without the profile nothing changes: the mint is 404, a run's computer refuses the token, and the live page takes the owner's cookie alone", { timeout: 60_000 }, async (t) => {
  const sealKey = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey.toString("base64") }, ["AGENTRUN_SEAL_KEY"]);
  const server = await serve(t, { runner: false, accounts: true, openSetup: true, publicUrl: PUBLIC });
  const made = await server.api("POST", "/agents", { definition: { id: "desk", version: 1, name: "desk", instructions: "Answer.", skills: [], tools: [] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const runId = (await server.api("POST", "/agents/desk/runs", { input: { content: "Hi" } })).body.run_id;
  const path = `/v2/runs/${runId}/computer`;
  const mint = await asToken(server, "POST", `${path}/viewer`, server.token, {});
  assert.deepEqual([mint.status, mint.json?.error?.code], [404, "not_found"], mint.text);
  assert.equal((await asToken(server, "GET", path, server.token)).status, 403, "GET /computer: the owner's session alone");
  assert.equal((await asToken(server, "POST", `${path}/take-over`, server.token, {})).status, 403, "take-over: the owner's session alone");
  assert.equal((await asToken(server, "POST", `${path}/hand-back`, server.token, {})).status, 403, "hand-back: the owner's session alone");
  // A credential this server's key would sign opens nothing: the page is the owner's cookie's.
  const { mintViewerCredential, viewerCredentialKey } = await import("../dist/viewer-credential.js");
  const { credential } = mintViewerCredential(viewerCredentialKey(sealKey), runId, Date.now());
  const page = await atPublic(server, `${path}/live/v/${"a".repeat(22)}?viewer=${credential}`);
  assert.equal(page.status, 401, page.text);
  assert.match(page.json.error.message, /owner's password sign-in/);
  const socket = await socketAt(server, `${path}/live/v/${"a".repeat(22)}`, PUBLIC, { cookie: `agentrun-viewer=${credential}` });
  assert.equal(socket.status, 401, "the socket takes the owner's session alone");
});

test("a viewer credential is its run's and its expiry's: another run, a later time or a changed byte refuses it", async () => {
  const { mintViewerCredential, viewerCredentialFor, viewerCredentialKey, VIEWER_CREDENTIAL_MS } = await import("../dist/viewer-credential.js");
  const key = viewerCredentialKey(randomBytes(32));
  const now = Date.now();
  const { credential, expiresAt } = mintViewerCredential(key, "run_a", now);
  assert.equal(VIEWER_CREDENTIAL_MS, 5 * 60_000);
  assert.equal(expiresAt, now + VIEWER_CREDENTIAL_MS);
  assert.equal(viewerCredentialFor(key, "run_a", credential, now), true);
  assert.equal(viewerCredentialFor(key, "run_b", credential, now), false, "another run");
  assert.equal(viewerCredentialFor(key, "run_a", credential, expiresAt), false, "at its expiry");
  assert.equal(viewerCredentialFor(viewerCredentialKey(randomBytes(32)), "run_a", credential, now), false, "another server's key");
  const [expiry, mac] = credential.split(".");
  const flipped = `${expiry}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
  assert.equal(viewerCredentialFor(key, "run_a", flipped, now), false, "a changed byte");
  // The MAC's last character carries two bits no byte uses: another spelling of the same bytes is refused all the same.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const respelled = `${credential.slice(0, -1)}${alphabet[alphabet.indexOf(credential.at(-1)) + 1]}`;
  assert.deepEqual(Buffer.from(respelled.split(".")[1], "base64url"), Buffer.from(mac, "base64url"), "the same bytes");
  assert.equal(viewerCredentialFor(key, "run_a", respelled, now), false, "another spelling");
  for (const bad of ["", "x", `${expiresAt}`, `${expiresAt}.`, `${expiresAt}.${"a".repeat(42)}`, `-1.${"a".repeat(43)}`]) assert.equal(viewerCredentialFor(key, "run_a", bad, now), false, JSON.stringify(bad));
});

test("an open viewer whose check reads the store closes once the check no longer holds, or fails", async () => {
  const { OpenViewers } = await import("../dist/browser-live.js");
  const { PassThrough } = await import("node:stream");
  const viewers = new OpenViewers();
  const ended = new PassThrough();
  const failing = new PassThrough();
  const open = new PassThrough();
  let over = false;
  viewers.watch(ended, async () => !over);
  viewers.watch(failing, async () => { throw new Error("the store is busy"); });
  viewers.watch(open, async () => true);
  // A slow store: its read is not asked again while one is in flight.
  const slow = new PassThrough();
  let reads = 0;
  let answer;
  viewers.watch(slow, () => (reads++, new Promise((resolve) => (answer = resolve))));
  over = true;
  viewers.recheck();
  viewers.recheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([ended.destroyed, failing.destroyed, open.destroyed, slow.destroyed, reads], [true, true, false, false, 1]);
  answer(true);
  await new Promise((resolve) => setImmediate(resolve));
  viewers.recheck();
  assert.equal(reads, 2, "asked again once its read answered");
  viewers.close();
});
