// The Composio source against the protocol's adapter half (tools-protocol §2.5), on the fake Composio (fake.ts): what it
// lists and how each action is pinned and priced; each declared capability has a passing case and each unsupported one
// says why; the check touches only a free listing; the key goes to Composio's origin alone, through no redirect, and is
// never in any text; every fault maps to its refusal; a call never throws, names its version, and never claims it cost
// nothing; and a connection is made, read and removed on Composio's managed OAuth app.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPOSIO_ORIGIN, composioCall } from "./client.ts";
import { FAKE_KEY, fakeComposio, PINNED } from "./fake.ts";
import { composio, specOf } from "./index.ts";
import type { ActionSpec, CallCtx, Ctx } from "./protocol-draft.ts";

const ctxOf = (fake: ReturnType<typeof fakeComposio>, { connection = "ca_active", signal = new AbortController().signal, key = FAKE_KEY, settings = {} }: { connection?: string; signal?: AbortSignal; key?: string | null; settings?: Record<string, string> } = {}): CallCtx => ({
  signal,
  fetch: fake.fetch,
  ...(key === null ? {} : { credential: { header: (name: string) => [name, key] as [string, string], connection: () => connection } }),
  settings,
  callId: "call-1",
  attempt: 1,
  file: async (name) => `evidence/composio/${name}`,
});

async function gmail(fake: ReturnType<typeof fakeComposio>): Promise<Record<string, ActionSpec>> {
  const specs = await composio.actions("composio:gmail", ctxOf(fake));
  return Object.fromEntries(specs.map((spec) => [spec.id, spec]));
}

test("toolkits and actions: each toolkit by its id, and each action pinned to Composio's dated version, asked, not metered, never resent, its key bound to Composio's origin; meta tools and an unpinnable version are never grantable", async () => {
  const fake = fakeComposio();
  const kits = await composio.toolkits(ctxOf(fake));
  assert.deepEqual(kits.map((k) => [k.id, k.needsConnection, k.actions]), [["composio:gmail", true, 4], ["composio:hackernews", false, 1], ["composio:composio", false, 1]]);
  const specs = await gmail(fake);
  assert.deepEqual(Object.keys(specs), ["composio:gmail/GMAIL_SEND_EMAIL", "composio:gmail/GMAIL_FETCH_EMAILS", "composio:gmail/GMAIL_DELETE_MESSAGE", "composio:gmail/GMAIL_BETA_THING"], "every page read (the cursor followed)");
  const send = specs["composio:gmail/GMAIL_SEND_EMAIL"]!;
  assert.equal(send.version, PINNED);
  assert.deepEqual([send.price, send.replay, send.grantable, send.resultMaxChars], [{ kind: "not_metered" }, "never", true, 60_000]);
  assert.deepEqual(send.custody, { kind: "oauth", holder: "provider", connectionRef: "", boundTo: COMPOSIO_ORIGIN });
  assert.equal((send.inputSchema as { type?: string }).type, "object", "a JSON schema object");
  assert.deepEqual([send.risk, specs["composio:gmail/GMAIL_FETCH_EMAILS"]!.risk, specs["composio:gmail/GMAIL_DELETE_MESSAGE"]!.risk], [{ level: "write", from: "unknown" }, { level: "read", from: "source_hint" }, { level: "destructive", from: "source_hint" }]);
  const beta = specs["composio:gmail/GMAIL_BETA_THING"]!;
  assert.ok(beta.grantable !== true && /no fixed version \(latest\)/.test(beta.grantable.reason), "latest is never pinned");
  const meta = await composio.actions("composio:composio", ctxOf(fake));
  assert.ok(meta.every((spec) => spec.grantable !== true && /meta tools/.test(spec.grantable.reason)), "Composio's meta tools are never granted (ruling A)");
  const free = (await composio.actions("composio:hackernews", ctxOf(fake)))[0]!;
  assert.deepEqual(free.custody, { kind: "sealed_key", keyRef: "COMPOSIO_API_KEY", boundTo: COMPOSIO_ORIGIN }, "a toolkit with no account needs only the key");
  const only = await composio.actions("composio:gmail", ctxOf(fake), ["GMAIL_FETCH_EMAILS"]);
  assert.deepEqual(only.map((spec) => spec.id), ["composio:gmail/GMAIL_FETCH_EMAILS"]);
  await assert.rejects(composio.actions("gmail" as `${string}:${string}`, ctxOf(fake)), /not a Composio toolkit id/);
});

test("capabilities: connect and search each pass; quote, recover and triggers are unsupported in words and have no method", async () => {
  const fake = fakeComposio();
  for (const cap of ["quote", "recover", "triggers"] as const) {
    const said = composio.caps[cap];
    assert.ok(said !== true && said.unsupported.length > 20, `${cap} says why`);
  }
  assert.deepEqual([composio.quote, composio.recover, composio.triggers], [undefined, undefined, undefined]);
  assert.deepEqual([composio.caps.connect, composio.caps.search], [true, true]);
  const found = await composio.search!("fetch", ctxOf(fake));
  assert.ok(found.some((spec) => spec.id === "composio:gmail/GMAIL_FETCH_EMAILS"), JSON.stringify(found.map((s) => s.id)));
  const started = await composio.connect!.start("composio:gmail", ctxOf(fake));
  assert.equal(await composio.connect!.status(started.connectionRef, ctxOf(fake)), "pending");
});

test("check touches one free listing alone: the key works, is refused, or can't be told now", async () => {
  const fake = fakeComposio();
  assert.equal((await composio.check(ctxOf(fake))).state, "ok");
  assert.deepEqual(fake.seen.map((s) => [s.method, s.path, s.query.limit]), [["GET", "/toolkits", "1"]]);
  assert.equal((await composio.check(ctxOf(fake, { key: "not-a-secret-wrong-key" }))).state, "refused");
  fake.faults.set("/toolkits", { status: 503 });
  assert.equal((await composio.check(ctxOf(fake))).state, "unknown");
  assert.ok(fake.seen.every((s) => s.method === "GET" && s.path === "/toolkits"), "nothing but the free listing");
});

test("a call runs its one action by direct execute on the grant's connection, naming the pinned version, and never claims it cost nothing", async () => {
  const fake = fakeComposio();
  const send = (await gmail(fake))["composio:gmail/GMAIL_SEND_EMAIL"]!;
  const before = fake.seen.length;
  const out = await composio.call(send, { to: "a@example.com" }, ctxOf(fake, { settings: { COMPOSIO_USER_ID: "owner-7" } }));
  assert.equal(out.isError, false, out.text);
  assert.deepEqual(JSON.parse(out.text), { slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@example.com" } });
  assert.equal(out.chargedUsd, null, "not metered: unknown, never 0");
  assert.match(out.upstreamRef ?? "", /^log_/);
  const [sent] = fake.seen.slice(before);
  assert.deepEqual([sent!.method, sent!.path], ["POST", "/tools/execute/GMAIL_SEND_EMAIL"]);
  assert.deepEqual(sent!.body, { connected_account_id: "ca_active", user_id: "owner-7", version: PINNED, arguments: { to: "a@example.com" } }, "its version, never latest; the connection; the server's one user");
  assert.equal(fake.seen.length, before + 1, "one request: never a session or a meta tool");
  const failed = await composio.call(send, {}, ctxOf(fake, { connection: "ca_missing" }));
  assert.deepEqual([failed.isError, failed.refusal, failed.chargedUsd], [true, "needs_connection", null]);
});

test("a call is refused unsent, never thrown: no connection for an account's action, no pinned version, an action that is not grantable, no key", async () => {
  const fake = fakeComposio();
  const specs = await gmail(fake);
  const send = specs["composio:gmail/GMAIL_SEND_EMAIL"]!;
  const before = fake.seen.length;
  const cases: [ActionSpec, CallCtx, string, RegExp][] = [
    [send, ctxOf(fake, { connection: "" }), "needs_connection", /needs a connected gmail account/],
    [{ ...send, version: "latest" }, ctxOf(fake), "unsupported", /no pinned version \(latest\)/],
    [specs["composio:gmail/GMAIL_BETA_THING"]!, ctxOf(fake), "unsupported", /can't be run/],
    [specOf({ slug: "COMPOSIO_MULTI_EXECUTE_TOOL", toolkit: { slug: "composio" }, version: PINNED })!, ctxOf(fake), "unsupported", /meta tools/],
  ];
  for (const [spec, ctx, refusal, words] of cases) {
    const out = await composio.call(spec, {}, ctx);
    assert.deepEqual([out.isError, out.refusal, "chargedUsd" in out], [true, refusal, false], out.text);
    assert.match(out.text, words);
  }
  assert.equal(fake.seen.length, before, "nothing sent");
  const keyless = await composio.call(send, {}, ctxOf(fake, { key: null }));
  assert.deepEqual([keyless.isError, keyless.refusal, "chargedUsd" in keyless], [true, "key_refused", false]);
  assert.equal(fake.seen.length, before, "nothing sent without a key either");
});

test("the key goes to Composio's origin alone, as x-api-key; a redirect is never followed; an answer echoing the key never shows it", async () => {
  const fake = fakeComposio();
  const send = (await gmail(fake))["composio:gmail/GMAIL_SEND_EMAIL"]!;
  await composio.call(send, {}, ctxOf(fake));
  fake.faults.set("POST /tools/execute/GMAIL_SEND_EMAIL", "redirect");
  const redirected = await composio.call(send, {}, ctxOf(fake));
  assert.deepEqual([redirected.isError, redirected.refusal], [true, "blocked_address"]);
  fake.faults.set("POST /tools/execute/GMAIL_SEND_EMAIL", "echo");
  const echoed = await composio.call(send, {}, ctxOf(fake));
  fake.faults.set("/toolkits", "echo");
  const checked = await composio.check(ctxOf(fake));
  await assert.rejects(composio.toolkits(ctxOf(fake)), (error: Error) => !error.message.includes(FAKE_KEY));
  assert.ok(fake.seen.every((s) => s.origin === COMPOSIO_ORIGIN), `only Composio's origin: ${[...new Set(fake.seen.map((s) => s.origin))]}`);
  assert.ok(fake.seen.every((s) => s.key === FAKE_KEY), "every request carried the key as x-api-key");
  for (const text of [redirected.text, echoed.text, checked.words]) assert.ok(!text.includes(FAKE_KEY), text);
  assert.match(echoed.text, /\[redacted\]/);
});

test("faults map to refusals: 401 and 403 key_refused, 402 quota_exhausted, 404 and 422 on an account needs_connection and connection_expired, 408 timeout, 429 rate_limited, 5xx upstream_error, unreachable upstream_error; each may have run, so its charge is unknown", async () => {
  const fake = fakeComposio();
  const send = (await gmail(fake))["composio:gmail/GMAIL_SEND_EMAIL"]!;
  const expected: [number, string][] = [[401, "key_refused"], [403, "key_refused"], [402, "quota_exhausted"], [404, "needs_connection"], [422, "connection_expired"], [408, "timeout"], [429, "rate_limited"], [500, "upstream_error"], [502, "upstream_error"], [503, "upstream_error"]];
  for (const [status, refusal] of expected) {
    fake.faults.set("POST /tools/execute/GMAIL_SEND_EMAIL", { status });
    const out = await composio.call(send, {}, ctxOf(fake));
    assert.deepEqual([out.isError, out.refusal, out.chargedUsd], [true, refusal, null], `${status}: ${out.text}`);
    assert.match(out.text, new RegExp(`HTTP ${status}`));
  }
  fake.faults.set("POST /tools/execute/GMAIL_SEND_EMAIL", "unreachable");
  const unreachable = await composio.call(send, {}, ctxOf(fake));
  assert.deepEqual([unreachable.refusal, unreachable.chargedUsd], ["upstream_error", null]);
  fake.faults.set("POST /tools/execute/GMAIL_SEND_EMAIL", { status: 200, body: { data: {}, error: "Gmail said no", successful: false, log_id: "log_x" } });
  const unsuccessful = await composio.call(send, {}, ctxOf(fake));
  assert.deepEqual([unsuccessful.isError, unsuccessful.refusal, unsuccessful.chargedUsd, unsuccessful.upstreamRef], [true, "upstream_error", null, "log_x"]);
  assert.match(unsuccessful.text, /Gmail said no/);
});

test("a hang ends: stopped within 250 ms of the call's abort, and a request past its bound is a timeout", async () => {
  const fake = fakeComposio();
  const send = (await gmail(fake))["composio:gmail/GMAIL_SEND_EMAIL"]!;
  fake.faults.set("POST /tools/execute/GMAIL_SEND_EMAIL", "hang");
  const stop = new AbortController();
  const from = Date.now();
  const running = composio.call(send, {}, ctxOf(fake, { signal: stop.signal }));
  setTimeout(() => stop.abort(), 20);
  const out = await running;
  assert.deepEqual([out.isError, out.refusal, out.chargedUsd], [true, "stopped", null]);
  assert.ok(Date.now() - from < 270, `answered in ${Date.now() - from} ms`);
  fake.faults.set("/toolkits", "hang");
  const timedOut = await composioCall(ctxOf(fake), "GET", "/toolkits", { ms: 50 });
  assert.deepEqual([timedOut.ok, !timedOut.ok && timedOut.refusal], [false, "timeout"]);
});

test("connect: a toolkit's account is connected on Composio's managed OAuth app, its auth config made once and reused; its status read in the protocol's words; revoked, and revoked again harmlessly", async () => {
  const fake = fakeComposio();
  const first = await composio.connect!.start("composio:gmail", ctxOf(fake));
  assert.match(first.url, /^https:\/\/connect\.composio\.dev\/link\//);
  assert.deepEqual([typeof first.connectionRef, first.expiresAt], ["string", "2026-11-10T12:10:00.000Z"]);
  const second = await composio.connect!.start("gmail", ctxOf(fake));
  assert.notEqual(second.connectionRef, first.connectionRef);
  assert.equal(fake.authConfigs.length, 1, "the managed auth config made once, then reused");
  assert.deepEqual(fake.seen.filter((s) => s.path === "/auth_configs" && s.method === "POST").map((s) => s.body), [{ toolkit: { slug: "gmail" }, auth_config: { type: "use_composio_managed_auth" } }]);
  assert.deepEqual(fake.seen.find((s) => s.path === "/connected_accounts/link")!.body, { auth_config_id: fake.authConfigs[0]!.id, user_id: "agentrun" });
  for (const [state, words] of [["ACTIVE", "active"], ["INITIALIZING", "pending"], ["INITIATED", "pending"], ["EXPIRED", "expired"], ["INACTIVE", "revoked"], ["FAILED", "failed"], ["SOMETHING_NEW", "pending"]] as const) {
    fake.accounts.get(first.connectionRef)!.status = state;
    assert.equal(await composio.connect!.status(first.connectionRef, ctxOf(fake)), words, state);
  }
  await composio.connect!.revoke!(first.connectionRef, ctxOf(fake));
  assert.equal(await composio.connect!.status(first.connectionRef, ctxOf(fake)), "revoked", "gone is revoked");
  await composio.connect!.revoke!(first.connectionRef, ctxOf(fake));
  await assert.rejects(composio.connect!.start("Not A Toolkit", ctxOf(fake)), /not a Composio toolkit/);
});
