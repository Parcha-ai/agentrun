// The runner's MCP claim step (runner/mcp-claim.ts, mcpClaim), once per claim before the loop starts, on the real store
// with a fake MCP server and a fake OAuth server: the run's pin written once, at its first claim, in its own fenced store
// transaction, and never rewritten; re-checked at every claim (a pinned meta tool refuses the claim in words, nothing
// sent); the pinned servers' credentials unsealed into the loop's memory only (never into a journal entry, a command
// row or a log line), feeding the redaction set, and dropped at release or when the claim's signal aborts; one fresh()
// hook that refreshes an expired OAuth token (bounded, its calls refused unsent in words when the sign-in server is
// silent or refuses), never holds the claim for a token still valid, and re-confirms the claim's epoch after it.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { startFakeOAuth } from "./fixtures/fake-oauth-server.mjs";
import { queued, storeOn, T0 } from "./store-helpers.mjs";

const { mcpClaim, McpClaimRefused } = await import("../dist/runner/mcp-claim.js");
const { sealMcpCredential } = await import("../dist/store/index.js");
const { Fenced } = await import("../dist/store/store.js");
const { mcpGateway, mcpPinOf } = await import("../dist/mcp-gateway.js");
const { META_REASON } = await import("../dist/mcp-meta.js");
const { UNUSABLE } = await import("../dist/mcp-servers.js");

const LEASE = 60_000;
const KEY = randomBytes(32);
const TOKEN = `not-a-secret-${"bearer-token-for-the-scan"}`;
const ADD = { name: "add", title: "Add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: true } };
const DELETE = { name: "delete_thing", description: "Delete a thing by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
const META = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "Run any tool by slug.", inputSchema: { type: "object", properties: {} } };
const quick = { requestMs: 200, tries: 2 };

/** The credential as the server's writer seals it (store/seal.ts): the whole JSON, its origin inside, under AAD
 *  mcp_servers|<name>|sealed. */
const sealed = (name, url, credential) => sealMcpCredential(KEY, name, credential, url);
const headersCredential = (url, name = "fake") => sealed(name, url, { type: "headers", headers: { authorization: `Bearer ${TOKEN}` } });

/** A store with run-1 queued and claimed, and the fake MCP server saved under "fake" (with `tools`, sealed as `seal`). */
async function setUp(t, { tools = [ADD], seal = headersCredential, mcp } = {}) {
  const opened = await storeOn(t);
  const fake = mcp ?? (await startFakeMcp({ token: TOKEN }));
  if (!mcp) t.after(() => fake.close());
  await opened.store.mcp.put({ name: "fake", url: fake.url, auth: "bearer", tools, sealed: seal(fake.url) });
  await queued(opened.store, "run-1");
  const claim = await opened.store.claim("run-1", "runner-a", { leaseMs: LEASE });
  return { ...opened, fake, claim };
}

const claimOf = (store, claim, grants, extra = {}) => mcpClaim({ store, claim, grants, sealKey: KEY, signal: new AbortController().signal, bounds: quick, ...extra });
const calls = (fake) => fake.log.filter((entry) => entry.method === "tools/call");

test("M1: the pin is written once, at the first claim, as mcpPinOf makes it, and a later claim reads it as written though the registry changed", async (t) => {
  const { store, clock, fake, claim } = await setUp(t);
  const first = await claimOf(store, claim, ["mcp:fake/add"]);
  const expected = mcpPinOf(["mcp:fake/add"], { server: () => ({ url: fake.url, tools: [ADD] }), headers: () => undefined });
  assert.deepEqual({ ...first.pin }, { ...expected }, "the pin of the granted tools");
  assert.deepEqual((await store.mcp.pin("run-1"))?.body, JSON.parse(JSON.stringify(expected)), "written to the run's pin row");
  first.release();
  // The registry changes (the tool is gone, another listed); the run's next claim reads its pin as written.
  await store.mcp.put({ name: "fake", url: fake.url, auth: "bearer", tools: [DELETE], sealed: headersCredential(fake.url) });
  clock.now = T0 + LEASE + 1;
  const next = await store.claim("run-1", "runner-b", { leaseMs: LEASE });
  const second = await claimOf(store, next, ["mcp:fake/add"]);
  assert.deepEqual({ ...second.pin }, { ...expected }, "never rewritten");
  assert.deepEqual((await store.mcp.pin("run-1"))?.body, JSON.parse(JSON.stringify(expected)));
});

test("M2: a run that grants no mcp: tool has no pin row", async (t) => {
  const { store, claim } = await setUp(t);
  const step = await claimOf(store, claim, ["read", "write"]);
  assert.equal(step.pin, undefined);
  assert.equal(await store.mcp.pin("run-1"), undefined);
});

test("M3: a pinned tool that is a meta tool now refuses the claim in words, and the MCP server receives nothing", async (t) => {
  const { store, fake, claim } = await setUp(t, { tools: [META] });
  // A pin made before the tool was known as a meta tool (the list grows after runs are pinned).
  await store.mcp.pinOnce(claim, { fake: { url: fake.url, tools: [META] } });
  await assert.rejects(claimOf(store, claim, ["mcp:fake/COMPOSIO_MULTI_EXECUTE_TOOL"]), (error) => error instanceof McpClaimRefused && error.message === `mcp:fake/COMPOSIO_MULTI_EXECUTE_TOOL can't be granted: ${META_REASON}`);
  assert.deepEqual(fake.log, [], "nothing was sent");
});

test("M4: a pin that cannot be made refuses the first claim in words, and no pin row is written", async (t) => {
  const { store, claim } = await setUp(t);
  await assert.rejects(claimOf(store, claim, ["mcp:gone/add"]), (error) => error instanceof McpClaimRefused && error.message === "The MCP tool mcp:gone/add cannot be pinned: the MCP server gone is no longer saved.");
  assert.equal(await store.mcp.pin("run-1"), undefined);
});

test("M5: a credential never appears in any journal entry, command row or log line: the store file and its WAL hold no byte of it after a run", async (t) => {
  const { store, file, fake, claim } = await setUp(t);
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  const log = console.log, error = console.error, warn = console.warn;
  process.stderr.write = (chunk, ...rest) => (lines.push(String(chunk)), write(chunk, ...rest));
  console.log = console.error = console.warn = (...args) => lines.push(args.join(" "));
  t.after(() => ((process.stderr.write = write), (console.log = log), (console.error = error), (console.warn = warn)));
  const step = await claimOf(store, claim, ["mcp:fake/add"]);
  assert.ok(step.pin?.fake && step.credentials.fake?.headers, "the claim pinned the server and opened its credential");
  const work = mkdtempSync(join(tmpdir(), "mcp-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const gateway = mcpGateway({ pin: step.pin, credentials: step.credentials, work: () => work });
  const answer = await gateway.call("fake", "add", { a: 2, b: 3 }, { signal: new AbortController().signal, callId: "call-1" });
  assert.equal(answer.isError, undefined, JSON.stringify(answer));
  assert.equal(calls(fake).at(-1)?.authorization, true, "the call went with its credential");
  // What a run keeps: its journal (the call and its answer), a command row, the run's end.
  const journal = store.journal(claim);
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }], BACKGROUND_CONTEXT);
  await commitWrites(journal, [{ type: "entry", value: { id: await journal.mintId(), conversationId: 1, kind: "agentrun.call.end", data: { callId: "call-1", status: "done", output: answer } } }], BACKGROUND_CONTEXT);
  await store.command("run-1", { kind: "steer", body: { text: "go on" } });
  step.release();
  await store.flush();
  for (const path of [file, `${file}-wal`]) {
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    assert.equal(bytes.includes(Buffer.from(TOKEN, "utf8")), false, `no byte of the credential in ${path.endsWith("-wal") ? "the WAL" : "the store file"}`);
  }
  assert.deepEqual(lines.filter((line) => line.includes(TOKEN)), [], "nor in any log line");
});

test("M6: the redaction set holds every credential value, and is emptied at release and when the claim's signal aborts", async (t) => {
  const { store, claim } = await setUp(t);
  const step = await claimOf(store, claim, ["mcp:fake/add"]);
  assert.ok([...step.secrets].some((value) => value.includes(TOKEN)), "the credential is in the redaction set");
  step.release();
  assert.equal(step.secrets.size, 0, "released: nothing held");
  assert.deepEqual({ ...step.credentials }, {}, "and no credential");
  const lost = new AbortController();
  const again = await mcpClaim({ store, claim, grants: ["mcp:fake/add"], sealKey: KEY, signal: lost.signal, bounds: quick });
  assert.ok(again.secrets.size > 0);
  lost.abort(new Error("the claim was lost"));
  assert.equal(again.secrets.size, 0, "the claim lost: nothing held");
});

/** A token set from the fake authorization server, by its own code flow (PKCE S256), as a sign-in keeps it. */
async function signedIn(oauth, resource) {
  const clientId = "runner-test";
  const redirect = "http://127.0.0.1:1/callback";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${oauth.issuer}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s" })) authorize.searchParams.set(k, v);
  const back = new URL((await fetch(authorize, { redirect: "manual" })).headers.get("location"));
  const tokens = await (await fetch(`${oauth.issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code"), redirect_uri: redirect, client_id: clientId, client_secret: "s3", code_verifier: verifier }) })).json();
  const metadata = await (await fetch(`${oauth.issuer}/.well-known/oauth-authorization-server`)).json();
  return { tokens, obtained_at: new Date(T0).toISOString(), client: { client_id: clientId, client_secret: "s3" }, kind: "pre-registered", discovery: { authorizationServerUrl: oauth.issuer, authorizationServerMetadata: metadata }, resource };
}

/** The fake MCP server behind the fake OAuth server, saved under "fake" with a sign-in whose token expires at `expiresAt`. */
async function oauthSetUp(t, { expiresAt, sealKey = KEY } = {}) {
  const oauth = await startFakeOAuth({ clients: { "runner-test": "s3" } });
  const fake = await startFakeMcp({ token: oauth.accepts, oauth: oauth.issuer });
  // after hooks run in order: the MCP server, then the authorization server (a hung /token closed with it).
  t.after(() => fake.close());
  t.after(() => oauth.close());
  const set = { ...(await signedIn(oauth, fake.url)), expires_at: new Date(expiresAt).toISOString() };
  const opened = await setUp(t, { mcp: fake, seal: (url) => sealed("fake", url, { type: "oauth", set }) });
  return { ...opened, oauth, set, sealKey };
}
const refreshes = (oauth) => oauth.log.filter((entry) => entry.path === "/token" && entry.form?.grant_type === "refresh_token").length;
const bearer = (step) => step.credentials.fake?.headers?.authorization;

test("M7: an expired token is refreshed once before the loop, its new token used and kept; a silent sign-in server is bounded and its calls refused unsent; a refused refresh says sign in again", async (t) => {
  const { store, oauth, fake, claim, set } = await oauthSetUp(t, { expiresAt: T0 - 1_000 });
  const kept = Buffer.from((await store.mcp.server("fake")).sealed);
  const step = await claimOf(store, claim, ["mcp:fake/add"], { now: () => T0 });
  assert.equal(refreshes(oauth), 1, "one refresh");
  assert.ok(bearer(step) && bearer(step) !== `Bearer ${set.tokens.access_token}`, "the new token is the one handed to the loop");
  assert.equal(Buffer.from((await store.mcp.server("fake")).sealed).equals(kept), false, "and the new token set kept, sealed, in the server's row");
  step.release();
  // Silent: no answer within the bound (2 tries of 200 ms): the loop starts, and that server's calls are refused unsent.
  await store.mcp.put({ name: "fake", url: fake.url, auth: "oauth", tools: [ADD], sealed: sealed("fake", fake.url, { type: "oauth", set: { ...set, expires_at: new Date(T0 - 1_000).toISOString() } }) });
  oauth.hang();
  const started = Date.now();
  const silent = await claimOf(store, claim, ["mcp:fake/add"], { now: () => T0 });
  assert.ok(Date.now() - started < 2_000, "bounded");
  assert.equal(silent.credentials.fake?.unopened, UNUSABLE.silent);
  const work = mkdtempSync(join(tmpdir(), "mcp-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const before = calls(fake).length;
  const refused = await mcpGateway({ pin: silent.pin, credentials: silent.credentials, work: () => work }).call("fake", "add", { a: 1, b: 1 }, { signal: new AbortController().signal });
  assert.equal(refused.content[0].text, `The MCP server fake's credential can't be used right now: ${UNUSABLE.silent}.`);
  assert.equal(calls(fake).length, before, "nothing was sent");
  silent.release();
  oauth.heal();
  oauth.revoke();
  const out = await claimOf(store, claim, ["mcp:fake/add"], { now: () => T0 });
  assert.equal(out.credentials.fake?.unopened, UNUSABLE.signedOut, "a refused refresh: sign in again");
});

test("M8: a claim lost while its refresh waited never starts its loop: fresh() re-confirms the claim's epoch and is Fenced", async (t) => {
  const { store, oauth, claim, clock } = await oauthSetUp(t, { expiresAt: T0 - 1_000 });
  oauth.hang();
  const pending = claimOf(store, claim, ["mcp:fake/add"], { now: () => T0, bounds: { requestMs: 400, tries: 1 } });
  // Meanwhile the claim lapses and another runner takes the run.
  clock.now = T0 + LEASE + 1;
  assert.ok(await store.claim("run-1", "runner-b", { leaseMs: LEASE }));
  await assert.rejects(pending, Fenced);
});

test("M9: fresh() run again on a resume refreshes a token that expired since the claim", async (t) => {
  let now = T0;
  const { store, oauth, claim } = await oauthSetUp(t, { expiresAt: T0 + 60 * 60_000 });
  const step = await claimOf(store, claim, ["mcp:fake/add"], { now: () => now });
  assert.equal(refreshes(oauth), 0, "valid at the claim: no refresh");
  const first = bearer(step);
  now = T0 + 2 * 60 * 60_000;
  await step.fresh();
  assert.equal(refreshes(oauth), 1, "expired by the resume: refreshed then");
  assert.notEqual(bearer(step), first);
});

test("M18: a token given with no expiry is taken to last an hour; a resume past that assumed hour refreshes it", async (t) => {
  // Mirrors the file registry's old headersForRun case (mcp-oauth.test.mjs, before the cut): the runner now owns a run's
  // token refresh, so the UNKNOWN_EXPIRY_MS rule is pinned here. A set with no expires_at is treated as obtained_at + an
  // hour: inside the hour it is used as is, past it the expired token is refreshed (awaited). Pins the hour from both sides.
  let now = T0;
  const oauth = await startFakeOAuth({ clients: { "runner-test": "s3" } });
  const fake = await startFakeMcp({ token: oauth.accepts, oauth: oauth.issuer });
  t.after(() => fake.close());
  t.after(() => oauth.close());
  const set = await signedIn(oauth, fake.url); // obtained_at T0, and no expires_at
  const { store, claim } = await setUp(t, { mcp: fake, seal: (url) => sealed("fake", url, { type: "oauth", set }) });
  const step = await claimOf(store, claim, ["mcp:fake/add"], { now: () => now });
  assert.equal(refreshes(oauth), 0, "inside the assumed hour: not refreshed");
  now = T0 + 61 * 60_000; // past obtained_at + the assumed hour, so the token reads as expired
  await step.fresh();
  assert.equal(refreshes(oauth), 1, "past the assumed hour: the expired token is refreshed");
});

test("M10: a token still valid but near its expiry never holds the claim: it is used at once", async (t) => {
  const { store, oauth, claim, set } = await oauthSetUp(t, { expiresAt: T0 + 60_000 });
  oauth.hang();
  const started = Date.now();
  const step = await claimOf(store, claim, ["mcp:fake/add"], { now: () => T0, bounds: { requestMs: 3_000, tries: 2 } });
  assert.ok(Date.now() - started < 1_000, "the claim did not wait on the refresh");
  assert.equal(bearer(step), `Bearer ${set.tokens.access_token}`, "the token still valid is used");
  step.release();
});

test("M13: two claims refreshing the same expired token at once make one network refresh, and both get the winner's token", async (t) => {
  const { store, oauth, claim } = await oauthSetUp(t, { expiresAt: T0 - 1_000 });
  // A second run of another agent's runner, granted the same server, claimed at the same time.
  await queued(store, "run-2");
  const other = await store.claim("run-2", "runner-b", { leaseMs: LEASE });
  const [a, b] = await Promise.all([claimOf(store, claim, ["mcp:fake/add"], { now: () => T0 }), claimOf(store, other, ["mcp:fake/add"], { now: () => T0 })]);
  assert.equal(refreshes(oauth), 1, "one refresh: a rotated refresh token is never spent twice");
  assert.ok(bearer(a), "the first has a token");
  assert.equal(bearer(b), bearer(a), "and the other the same, the winner's");
  a.release();
  b.release();
});

test("M11: with no seal key, a server's calls are refused in noSealKey's words, and no refresh is sent", async (t) => {
  const { store, oauth, claim } = await oauthSetUp(t, { expiresAt: T0 - 1_000 });
  const step = await claimOf(store, claim, ["mcp:fake/add"], { sealKey: undefined, now: () => T0 });
  assert.equal(step.credentials.fake?.unopened, UNUSABLE.noSealKey);
  assert.equal(refreshes(oauth), 0, "no refresh was sent");
});

test("M12: a server whose url origin no longer matches its sealed one is damaged: its calls are refused unsent in those words", async (t) => {
  const { store, fake, claim } = await setUp(t);
  const step = await claimOf(store, claim, ["mcp:fake/add"]);
  step.release();
  // The row's url moves to another origin; its sealed credential (and the origin inside it) stays as it was.
  const row = await store.mcp.server("fake");
  const moved = new URL(fake.url);
  moved.port = String(Number(moved.port) + 1);
  await store.mcp.put({ name: "fake", url: moved.href, auth: "bearer", tools: [ADD], sealed: row.sealed });
  const again = await claimOf(store, claim, ["mcp:fake/add"]);
  assert.equal(again.credentials.fake?.unopened, UNUSABLE.damaged);
  assert.equal(again.credentials.fake?.headers, undefined, "no header handed over");
  assert.deepEqual(calls(fake), [], "the MCP server received nothing");
});

test("M14: a token refreshed behind the claim reaches the gateway already built on the step's credentials: its next call carries the new token", async (t) => {
  const oauth = await startFakeOAuth({ clients: { "runner-test": "s3" } });
  // An access token the server no longer takes once it is replaced, as an expired one.
  const spent = new Set();
  const fake = await startFakeMcp({ token: (authorization) => oauth.accepts(authorization) && !spent.has(authorization), oauth: oauth.issuer });
  t.after(() => fake.close());
  t.after(() => oauth.close());
  // Near its expiry (inside REFRESH_MARGIN_MS): used at once, refreshed behind the claim.
  const set = { ...(await signedIn(oauth, fake.url)), expires_at: new Date(T0 + 60_000).toISOString() };
  const { store, claim } = await setUp(t, { mcp: fake, seal: (url) => sealed("fake", url, { type: "oauth", set }) });
  const step = await claimOf(store, claim, ["mcp:fake/add"], { now: () => T0 });
  const old = bearer(step);
  assert.equal(old, `Bearer ${set.tokens.access_token}`, "the token still valid is handed over at once");
  const work = mkdtempSync(join(tmpdir(), "mcp-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  // As the runner builds it from the claim step: reading the step's credentials live.
  const gateway = mcpGateway({ pin: step.pin, credentials: step.credentials, work: () => work, liveCredentials: true });
  const call = () => gateway.call("fake", "add", { a: 1, b: 1 }, { signal: new AbortController().signal });
  assert.deepEqual(await call(), { content: [{ type: "text", text: "2" }] }, "the first call goes, its client connected");
  for (let i = 0; bearer(step) === old; i++) {
    assert.ok(i < 200, "the refresh behind the claim lands");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  spent.add(old);
  assert.deepEqual(await call(), { content: [{ type: "text", text: "2" }] }, "the next call carries the refreshed token, not the one it connected with");
  step.release();
});

test("M15: a pinned server removed since an earlier open is dropped from the step's credentials at fresh(), and the gateway sends it nothing", async (t) => {
  const { store, fake, claim } = await setUp(t);
  const step = await claimOf(store, claim, ["mcp:fake/add"]);
  assert.equal(bearer(step), `Bearer ${TOKEN}`, "opened at the claim");
  await store.mcp.remove("fake");
  await step.fresh();
  assert.equal(step.credentials.fake, undefined, "its URL and headers are no longer held");
  const work = mkdtempSync(join(tmpdir(), "mcp-work-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const refused = await mcpGateway({ pin: step.pin, credentials: step.credentials, work: () => work, liveCredentials: true }).call("fake", "add", { a: 1, b: 1 }, { signal: new AbortController().signal });
  assert.equal(refused.content[0].text, "The MCP server fake is no longer saved on this server; nothing was sent.");
  assert.deepEqual(calls(fake), [], "the removed server received nothing");
  step.release();
});

/** A refresh the authorization server has granted (the refresh token rotated, the old one spent) whose answer is still on
 *  the wire when `stop` ends the claim's step; then the answer arrives, and the run's next claim opens the server. */
async function rotatedAcross(t, { expiresAt, stop }) {
  const { store, oauth, claim } = await oauthSetUp(t, { expiresAt });
  const hold = oauth.holdNext();
  const signal = new AbortController();
  // The fake answers when the test says so (hold.answer()), so this bound only catches a hang; a tight one fails under load.
  const bounds = { requestMs: 60_000, tries: 1 };
  const first = claimOf(store, claim, ["mcp:fake/add"], { now: () => T0, signal: signal.signal, bounds });
  // Behind a token still valid, the step returns before the refresh is answered; an expired one is awaited.
  const step = expiresAt > T0 ? await first : undefined;
  await hold.granted;
  stop({ step, signal });
  hold.answer();
  if (!step) await first.catch(() => undefined);
  // Later, past the old token's expiry: the next claim needs the rotated set, or a refresh with the spent token.
  const next = await claimOf(store, claim, ["mcp:fake/add"], { now: () => T0 + 120_000, bounds });
  t.after(() => next.release());
  return { oauth, next };
}

test("M16: a refresh granted while the step ends (shutdown, a lost claim, the run's end) is kept: the rotated token is used once and the server stays signed in", async (t) => {
  for (const [what, expiresAt, stop] of [
    ["the claim's signal aborts behind a token near its expiry (a shutdown or a lost claim)", T0 + 60_000, ({ signal }) => signal.abort()],
    ["release() at the run's end, behind a token near its expiry", T0 + 60_000, ({ step }) => step.release()],
    ["the claim's signal aborts while an expired token's refresh is awaited", T0 - 1_000, ({ signal }) => signal.abort()],
  ]) {
    const { oauth, next } = await rotatedAcross(t, { expiresAt, stop });
    assert.equal(next.credentials.fake?.unopened, undefined, `${what}: the next claim is not signed out`);
    assert.ok(oauth.accepts(bearer(next)), `${what}: the next claim holds a token the server takes (${bearer(next)})`);
    assert.equal(refreshes(oauth), 1, `${what}: the rotating refresh token was used once`);
  }
});

test("M17: claims waiting on another claim's refresh read the server's row O(1) times each, not every 25 ms", async (t) => {
  const { store, oauth, claim } = await oauthSetUp(t, { expiresAt: T0 - 1_000 });
  let reads = 0;
  const mcp = new Proxy(store.mcp, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "server") return (...args) => ((reads += 1), value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const counted = { where: store.where, mcp, runs: store.runs, settings: store.settings };
  const hold = oauth.holdNext();
  const CLAIMS = 300;
  const steps = Array.from({ length: CLAIMS }, () => claimOf(counted, claim, ["mcp:fake/add"], { now: () => T0, bounds: { requestMs: 5_000, tries: 1 } }));
  await hold.granted;
  // The holder's answer takes a while; every other claim waits on its lease meanwhile.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const answered = Date.now();
  hold.answer();
  const opened = await Promise.all(steps);
  const took = Date.now() - answered;
  t.after(() => opened.forEach((step) => step.release()));
  assert.equal(refreshes(oauth), 1, "one refresh");
  assert.equal(new Set(opened.map(bearer)).size, 1, "every claim holds the one refreshed token");
  assert.ok(oauth.accepts(bearer(opened[0])), "a token the server takes");
  assert.ok(reads <= 4 * CLAIMS, `the server's row read at most 4 times a claim: ${reads} reads for ${CLAIMS} claims`);
  assert.ok(took < 3_000, `every waiting claim woke when the holder let the lease go, not at the lease's end: ${took} ms`);
});
