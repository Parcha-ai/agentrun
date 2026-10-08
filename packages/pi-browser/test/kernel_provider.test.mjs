// The kernel provider against a fake Kernel REST API on loopback: the create body, at-most-once create, tag recovery across
// pages, release with confirmation, status facts, the Stagehand extension upload, the shared undici Agent, and no key, token
// or Kernel text in any error.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import test from "node:test";
import * as undici from "undici";
import { classifyBrowserError } from "../dist/index.js";
import { closeDirectFetch } from "../dist/providers/http.js";
import { KERNEL_IDLE_MAX_S, KERNEL_IDLE_MIN_S, KernelError, kernelCreateBody, kernelProvider } from "../dist/providers/kernel.js";
import { makeSentinels } from "../dist/testing/index.js";
import { fakeKernel } from "./fixtures/fake-kernel.mjs";

let keySeq = 0;
// Each test names its own account (the extension upload is remembered per process and account) and its own key, so the
// fake counts only this test's requests.
const newKey = () => `kernel-test-key-${process.pid}-${(keySeq += 1)}-${Math.random().toString(36).slice(2)}`;
const spec = (over = {}) => ({ tag: "ar-run1-1-1", maxLifetimeS: 1800, idleTimeoutS: 180, proxies: false, verified: false, captcha: false, viewport: { width: 1288, height: 711 }, metadata: { run: "run 1", label: "browser" }, ...over });
const signal = () => new AbortController().signal;
/** The SHA-256 of the Stagehand extension archive the provider sends: Kernel's checksum of it as stored. */
const ARCHIVE_SHA = createHash("sha256").update(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve("@browserbasehq/stagehand"))), "assets", "stagehand-extension.zip"))).digest("hex");

async function rig(t, { knobs = {}, sentinels = {}, extra = {}, key = newKey() } = {}) {
  const fake = await fakeKernel({ key, sentinels, knobs });
  t.after(() => fake.close());
  const env = { KERNEL_API_KEY: key, KERNEL_BASE_URL: fake.url };
  const provider = kernelProvider({ env, sleep: async () => {}, confirm: { polls: 3, intervalMs: 0 }, ...extra });
  return { fake, provider, env, key };
}

test("create sends one explicit body with the tag stamped, and the ref carries no token", async (t) => {
  const { fake, provider } = await rig(t);
  const ref = await provider.create(spec(), signal());
  assert.deepEqual(ref, { id: "kb_1", tag: "ar-run1-1-1" });
  const creates = fake.only("POST /browsers");
  assert.equal(creates.length, 1, "at most once");
  const { body } = creates[0];
  assert.deepEqual(body.tags, { run: "run_1", label: "browser", agentrun_tag: "ar-run1-1-1" });
  assert.equal(body.timeout_seconds, 180, "the idle timeout is sent, never Kernel's 60 s default");
  assert.deepEqual([body.headless, body.stealth], [false, false]);
  assert.deepEqual(body.viewport, { width: 1288, height: 711 });
  assert.match(body.extensions?.[0]?.name ?? "", /^agentrun-stagehand-[0-9a-f]{16}$/, "the Stagehand extension rides the create");
  assert.equal(JSON.stringify(ref).includes("jwt"), false, "the CDP URL stays in provider memory");
  assert.equal(provider.caps.timeoutModel, "inactivity");
});

test("the idle timeout is clamped to Kernel's bounds, and stealth and headless are the host's options", () => {
  assert.equal(kernelCreateBody(spec({ idleTimeoutS: 0 })).timeout_seconds, KERNEL_IDLE_MIN_S);
  assert.equal(kernelCreateBody(spec({ idleTimeoutS: 10 ** 9 })).timeout_seconds, KERNEL_IDLE_MAX_S);
  const body = kernelCreateBody(spec(), { stealth: true, headless: true, extension: { name: "ext-name" } });
  assert.deepEqual([body.stealth, body.headless, body.extensions], [true, true, [{ name: "ext-name" }]]);
  assert.equal(kernelCreateBody(spec({ metadata: { note: "x".repeat(90) } })).tags.note.length, 60);
});

test("a failed create is one call, names the call, status and code only, and leaves nothing for findByTag", async (t) => {
  const sentinels = makeSentinels();
  const { fake, provider } = await rig(t, { knobs: { createStatus: 502, echo: true }, sentinels, key: sentinels.kernelApiKey });
  const error = await provider.create(spec(), signal()).then(() => null, (e) => e);
  assert.ok(error instanceof KernelError);
  assert.equal(error.message, "Kernel POST /browsers answered 502 (internal_error)");
  assert.equal(error.status, 502);
  assert.equal(fake.only("POST /browsers").length, 1, "no retry");
  fake.knobs.createStatus = 0;
  assert.deepEqual(await provider.findByTag("ar-run1-1-1"), []);
});

test("a Kernel that cannot be reached fails as browser_unavailable; an aborted call stays an abort", async (t) => {
  const { fake, provider } = await rig(t, { extra: { extension: async () => ({ name: "ext" }) } });
  await fake.close();
  const error = await provider.create(spec(), signal()).then(() => null, (e) => e);
  assert.equal(error.message, "Kernel POST /browsers could not be reached");
  assert.equal(classifyBrowserError(error, false).code, "browser_unavailable", "the cause chain keeps the system code");
  const live = await rig(t, { extra: { extension: async () => ({ name: "ext" }) } });
  const aborted = new AbortController();
  aborted.abort();
  const abort = await live.provider.create(spec(), aborted.signal).then(() => null, (e) => e);
  assert.equal(abort?.name, "AbortError");
});

test("findByTag returns every live session with the tag across pages, and never another's when the filter is ignored", async (t) => {
  const { fake, provider, key } = await rig(t, { knobs: { pageSize: 1, ignoreFilter: true } });
  for (const tag of ["ar-a", "ar-b", "ar-a", "ar-a"]) await provider.create(spec({ tag }), signal());
  const found = await provider.findByTag("ar-a");
  assert.deepEqual(found.map((r) => r.id).sort(), ["kb_1", "kb_3", "kb_4"]);
  assert.ok(found.every((r) => r.tag === "ar-a"));
  const asked = fake.only("GET /browsers");
  assert.ok(asked.length >= 4, "every page was read");
  assert.deepEqual([asked[0].query.status, asked[0].query["tags[agentrun_tag]"]], ["active", "ar-a"]);
  await provider.release({ id: "kb_3", tag: "ar-a" });
  assert.deepEqual((await provider.findByTag("ar-a")).map((r) => r.id).sort(), ["kb_1", "kb_4"], "a deleted session is not live");
  await assert.rejects(provider.findByTag("ar a/../x"), /tag/);
  // A base URL that answers 404 to the list is a misconfiguration, never "no sessions".
  const wrong = kernelProvider({ env: { KERNEL_API_KEY: key, KERNEL_BASE_URL: `${fake.url}/nowhere` } });
  await assert.rejects(wrong.findByTag("ar-a"), /GET \/browsers answered 404/);
});

test("findByTag fails on a list it cannot read, never answering an empty set a release would trust", async (t) => {
  for (const listBody of ["object", "cut"]) {
    const { provider } = await rig(t, { knobs: { listBody } });
    await assert.rejects(provider.findByTag("ar-run1-1-1"), /Kernel GET \/browsers/, listBody);
  }
});

test("a cancelled create stops waiting for the shared extension upload, which still serves the next create", async (t) => {
  const { fake, provider } = await rig(t, { knobs: { uploadDelayMs: 400 } });
  const cancelled = new AbortController();
  const started = Date.now();
  const first = provider.create(spec(), cancelled.signal);
  setTimeout(() => cancelled.abort(), 50);
  const error = await first.then(() => null, (e) => e);
  assert.equal(error?.name, "AbortError");
  assert.ok(Date.now() - started < 300, "the cancelled caller did not wait for the upload to finish");
  await provider.create(spec(), signal());
  assert.deepEqual([fake.only("POST /extensions").length, fake.only("POST /browsers").length], [1, 1], "one upload, one browser");
});

test("a create whose signal is already aborted starts no extension work and leaves no rejection unhandled", async (t) => {
  const unhandled = [];
  const note = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", note);
  t.after(() => process.off("unhandledRejection", note));
  let asked = 0;
  const { fake, env } = await rig(t);
  const provider = kernelProvider({ env, extension: () => { asked += 1; return new Promise((_, reject) => setTimeout(() => reject(new Error("the host's extension failed")), 20)); } });
  const aborted = new AbortController();
  aborted.abort();
  const error = await provider.create(spec(), aborted.signal).then(() => null, (e) => e);
  assert.equal(error?.name, "AbortError");
  // A live caller cancelled while the host's extension promise is still pending: that promise's later failure is handled too.
  const late = new AbortController();
  const pending = provider.create(spec(), late.signal);
  late.abort();
  assert.equal((await pending.then(() => null, (e) => e))?.name, "AbortError");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(unhandled, [], "no rejection escaped");
  assert.equal(asked, 1, "an already-aborted create asks for nothing");
  assert.equal(fake.only("POST /browsers").length, 0);
});

test("findByTag fails instead of answering part of the set when Kernel says there is more without an offset", async (t) => {
  const { provider } = await rig(t, { knobs: { pageSize: 1, hasMoreWithoutOffset: true } });
  await provider.create(spec(), signal());
  await provider.create(spec(), signal());
  await assert.rejects(provider.findByTag("ar-run1-1-1"), /next page/);
});

test("status reads Kernel's facts: running, stopped once deleted, gone when Kernel no longer knows it", async (t) => {
  const { fake, provider } = await rig(t);
  const ref = await provider.create(spec(), signal());
  assert.equal(await provider.status(ref), "running");
  fake.browsers.get(ref.id).deletedAt = "2026-10-08T00:01:00Z";
  assert.equal(await provider.status(ref), "stopped");
  fake.knobs.deletedIs404 = true;
  assert.equal(await provider.status(ref), "gone");
  assert.equal(await provider.status({ id: "kb_404", tag: "x" }), "gone");
});

test("attach hands the driver the CDP URL from memory, or Kernel's after a restart; a deleted session is refused", async (t) => {
  const { fake, provider, env } = await rig(t);
  const ref = await provider.create(spec(), signal());
  const target = await provider.attach(ref);
  assert.equal(target.sdkCdpUrl, fake.browsers.get(ref.id).url);
  assert.equal(fake.only("GET /browsers/{id}").length, 0, "held in memory: no lookup");
  // A session this process never created (another process made it, then died): found by a lookup.
  fake.browsers.set("kb_other", { id: "kb_other", tags: { agentrun_tag: "ar-x" }, deletedAt: null, url: "wss://kernel.fake.test/browser/cdp?jwt=other&sessionId=kb_other", lookupsSinceDelete: null });
  const fresh = kernelProvider({ env });
  assert.equal((await fresh.attach({ id: "kb_other", tag: "ar-x" })).sdkCdpUrl, "wss://kernel.fake.test/browser/cdp?jwt=other&sessionId=kb_other");
  fake.browsers.set("kb_dead", { id: "kb_dead", tags: {}, deletedAt: "2026-10-08T00:00:00Z", url: "wss://x/?jwt=dead", lookupsSinceDelete: null });
  await assert.rejects(fresh.attach({ id: "kb_dead", tag: "ar-x" }), /not available/);
});

test("release deletes and waits until Kernel shows the session gone; a second release is a no-op", async (t) => {
  const { fake, provider } = await rig(t, { knobs: { deleteLag: 2 } });
  const ref = await provider.create(spec(), signal());
  await provider.release(ref, signal());
  assert.equal(fake.only("DELETE /browsers/{id}").length, 1);
  assert.ok(fake.only("GET /browsers/{id}").length >= 3, "it polled until the delete showed");
  assert.equal(fake.alive().length, 0);
  await provider.release(ref, signal());
  assert.equal(fake.only("DELETE /browsers/{id}").length, 2, "the second delete answers 404, which counts as released");
});

test("a delete that fails once is sent again; one that keeps failing while the session runs throws its failure", async (t) => {
  const once = await rig(t, { knobs: { deleteStatuses: [503] } });
  const ref = await once.provider.create(spec(), signal());
  await once.provider.release(ref, signal());
  assert.equal(once.fake.alive().length, 0);
  const stuck = await rig(t, { knobs: { deleteStatuses: [500, 500] } });
  const held = await stuck.provider.create(spec(), signal());
  const error = await stuck.provider.release(held, signal()).then(() => null, (e) => e);
  assert.equal(error?.message, "Kernel DELETE /browsers/{id} answered 500 (internal_error)");
  assert.equal(stuck.fake.alive().length, 1, "never reported released while it runs");
});

test("with no stored copy of the archive, the extension is uploaded once per process and account, and retried after a failure", async (t) => {
  const { fake, provider, env } = await rig(t);
  await provider.create(spec(), signal());
  await kernelProvider({ env }).create(spec({ tag: "ar-run1-2-1" }), signal());
  const uploads = fake.only("POST /extensions");
  assert.equal(uploads.length, 1, "one upload for two providers on one account");
  assert.deepEqual({ ...uploads[0].upload, bytes: undefined }, { name: `agentrun-stagehand-${ARCHIVE_SHA.slice(0, 16)}`, hasFile: true, closed: true, bytes: undefined });
  assert.equal(fake.extensions.get(uploads[0].upload.name).checksum, ARCHIVE_SHA, "the archive itself was sent, byte for byte");
  assert.deepEqual(fake.only("POST /browsers")[0].body.extensions, [{ name: uploads[0].upload.name }]);

  const failing = await rig(t, { knobs: { uploadStatus: 502 } });
  await assert.rejects(failing.provider.create(spec(), signal()), /POST \/extensions answered 502/);
  assert.equal(failing.fake.only("POST /browsers").length, 0, "no browser without the extension");
  failing.fake.knobs.uploadStatus = 0;
  await failing.provider.create(spec(), signal());
  assert.equal(failing.fake.only("POST /extensions").length, 2, "the failed upload was forgotten");

  const racing = await rig(t, { knobs: { uploadConflict: true } });
  await racing.provider.create(spec(), signal());
  assert.equal(racing.fake.only("POST /browsers").length, 1, "a copy another process stored meanwhile serves");
});

test("a stored extension with the archive's exact bytes is reused under its own name, read-only, and nothing is uploaded", async (t) => {
  // The account's one stored extension is another tool's copy of this Stagehand (Kernel's checksum is the archive's SHA-256).
  const { fake, provider } = await rig(t, { knobs: { storedLimit: 1, pageSize: 1 } });
  fake.extensions.set("someone-else", { id: "ext_other", size: 9, checksum: "0".repeat(64) });
  fake.extensions.set("grep-stagehand-4.1.0", { id: "ext_grep", size: 440798, checksum: ARCHIVE_SHA });
  await provider.create(spec(), signal());
  assert.deepEqual(fake.only("POST /browsers")[0].body.extensions, [{ name: "grep-stagehand-4.1.0" }]);
  assert.equal(fake.only("POST /extensions").length, 0, "nothing uploaded");
  assert.ok(fake.only("GET /extensions").length >= 2, "the match was found on a later page");
  assert.deepEqual(fake.calls.filter((c) => c.authorized && /^(DELETE|PATCH|PUT) \/extensions/.test(c.op)), [], "the stored copy is never changed");
});

test("an extension list Kernel cuts short (more pages, no next offset) fails the create instead of uploading a copy", async (t) => {
  const { fake, provider } = await rig(t, { knobs: { pageSize: 1, hasMoreWithoutOffset: true } });
  fake.extensions.set("someone-else", { id: "ext_other", size: 9, checksum: "0".repeat(64) });
  fake.extensions.set("grep-stagehand-4.1.0", { id: "ext_grep", size: 440798, checksum: ARCHIVE_SHA });
  await assert.rejects(provider.create(spec(), signal()), /Kernel GET \/extensions answered 200 \(no_next_offset\)/);
  assert.deepEqual([fake.only("POST /extensions").length, fake.only("POST /browsers").length], [0, 0], "no upload, no browser");
});

test("a plan with no room for the upload fails the create naming insufficient_plan, and opens no browser", async (t) => {
  const { fake, provider } = await rig(t, { knobs: { storedLimit: 1 } });
  fake.extensions.set("another-extension", { id: "ext_other", size: 9, checksum: "0".repeat(64) });
  await assert.rejects(provider.create(spec(), signal()), /Kernel POST \/extensions answered 403 \(insufficient_plan\)/);
  assert.equal(fake.only("POST /browsers").length, 0);
  assert.equal(fake.extensions.size, 1, "the stored extension is untouched");
});

test("every request carries the key as a Bearer value; a missing key sends nothing and names the variable", async (t) => {
  const { fake, provider } = await rig(t);
  const ref = await provider.create(spec(), signal());
  await provider.findByTag(ref.tag);
  await provider.release(ref);
  assert.ok(fake.calls.length >= 5 && fake.calls.every((c) => c.authorized));
  const none = kernelProvider({ env: { KERNEL_BASE_URL: fake.url }, extension: async () => ({ name: "ext" }) });
  const before = fake.calls.length;
  await assert.rejects(none.create(spec(), signal()), /KERNEL_API_KEY/);
  assert.equal(fake.calls.length, before);
});

test("no error carries the key, the CDP token or Kernel's echoed text, on any call", async (t) => {
  const sentinels = makeSentinels();
  const { fake, provider } = await rig(t, { sentinels, key: sentinels.kernelApiKey, knobs: { echo: true } });
  const ref = await provider.create(spec(), signal());
  const errors = [];
  const attempt = async (run) => { try { await run(); } catch (error) { errors.push(error); } };
  fake.knobs.createStatus = 500;
  await attempt(() => provider.create(spec(), signal()));
  fake.knobs.deleteStatuses = [500, 500];
  fake.knobs.deleteLag = 99;
  await attempt(() => provider.release(ref, signal()));
  const wrong = kernelProvider({ env: { KERNEL_API_KEY: `${sentinels.kernelApiKey}-wrong`, KERNEL_BASE_URL: fake.url }, extension: async () => ({ name: "ext" }) });
  await attempt(() => wrong.findByTag("ar-run1-1-1"));
  await attempt(() => wrong.status(ref));
  await attempt(() => wrong.attach({ id: "kb_unknown", tag: "x" }));
  assert.equal(errors.length, 5);
  const secrets = [sentinels.kernelApiKey, sentinels.kernelJwt, sentinels.kernelLiveViewUrl];
  for (const error of errors) {
    const seen = JSON.stringify({ message: error.message, cause: String(error.cause ?? ""), stack: error.stack, classified: classifyBrowserError(error, true) });
    for (const secret of secrets) assert.equal(seen.includes(secret), false, `${error.message} carried a secret`);
  }
  assert.equal(errors[2].status, 401);
});

test("Kernel calls ride the package's own undici Agent, never the process-global dispatcher", async (t) => {
  const { fake, provider } = await rig(t);
  const before = undici.getGlobalDispatcher();
  const foreign = { dispatch() { throw new Error("the global dispatcher must not serve Kernel calls"); }, close: async () => {}, destroy: async () => {} };
  undici.setGlobalDispatcher(foreign);
  try {
    const ref = await provider.create(spec(), signal());
    assert.equal(await provider.status(ref), "running");
    await provider.release(ref);
    assert.equal(fake.alive().length, 0);
  } finally { undici.setGlobalDispatcher(before); await closeDirectFetch(); }
});

test("a host's own fetch replaces the Agent (a pi user behind an HTTP proxy hands one in)", async (t) => {
  const { fake, env } = await rig(t);
  const used = [];
  const provider = kernelProvider({ env, fetch: async (url, init) => { used.push(`${init.method} ${new URL(url).pathname}`); return fetch(url, init); }, extension: async () => ({ name: "ext" }) });
  const ref = await provider.create(spec(), signal());
  await provider.release(ref);
  assert.deepEqual(used.slice(0, 2), ["POST /browsers", `DELETE /browsers/${ref.id}`]);
  assert.equal(fake.alive().length, 0);
});

// Keep the loopback server honest: a stray request without the key is answered 401 and never counted.
test("the fake counts only requests that carry the test's key", async (t) => {
  const { fake } = await rig(t);
  await new Promise((resolve) => http.get(`${fake.url}/browsers`, (res) => { res.resume(); res.on("end", resolve); }));
  assert.equal(fake.only("GET /browsers").length, 0);
  assert.equal(fake.calls.at(-1).authorized, false);
});
