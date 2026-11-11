// The browser tool's sessions on the computer protocol (browser-computer.ts): pi-browser's BrowserProvider over a browser
// computer the claim or the tool plane opened (a ClaimBrowser). A session is a computer labelled with the run's labels and
// custody's tag; it opens with what the provider declares in capabilities().browser, asked in spec.browser (viewport,
// stealth for a Verified session, headless, the run's saved sign-in by its pointer), and never with an extension: the
// driver is raw CDP. A refusal carries status 403 so custody ends the create at once; one session at a time saves to a
// sign-in. Over a stand-in provider: no vendor, no network.
import assert from "node:assert/strict";
import { test } from "node:test";

const { claimBrowserProvider, planeBrowser, resetBrowserComputerHoldings } = await import("../dist/browser-computer.js");

/** The label a session's custody tag rides on (workspace/computer-for-claim.ts). */
const TAG_LABEL = "agentrun.session";
const RUN = { runId: "run-1", epoch: 3 };
const SPEC = { tag: "ar-run-1-1", maxLifetimeS: 1800, idleTimeoutS: 180, proxies: false, verified: false, captcha: false, viewport: { width: 1288, height: 711 }, metadata: { run: "run-1", label: "run" } };
const signal = () => new AbortController().signal;

/** A browser computer provider stand-in: `features` its declared browser features (capabilities().browser); each call
 *  kept in `calls`. */
function stand(features, { createFails, releaseRuns = false, downloads } = {}) {
  const calls = [];
  const browsers = new Map();
  return {
    calls,
    browsers,
    provider: {
      id: "stand",
      version: "0",
      capabilities: () => ({ kind: "browser", lifetime: "vendor", network: ["open"], isolation: "vm", os: "linux", daemon: "none", groups: ["cdp"], maxLifetimeMs: 6 * 3_600_000, release: ["delete"], ...(features ? { browser: features } : {}) }),
      check: () => [],
      async create(spec, context = {}) {
        calls.push({ op: "create", spec, context });
        if (createFails) return { ok: false, error: createFails };
        const id = `b${browsers.size + 1}`;
        browsers.set(id, { labels: spec.labels, running: true });
        return { ok: true, value: { id, name: id } };
      },
      async attach(ref) {
        const found = browsers.get(ref.id);
        if (!found) return { ok: false, error: { code: "not_found", message: "no such browser" } };
        return found.running ? { ok: true, value: { id: ref.id, name: ref.id, spec: {} } } : { ok: false, error: { code: "gone", message: "it ended" } };
      },
      async list(labels) {
        calls.push({ op: "list", labels });
        return { ok: true, value: [...browsers].filter(([, b]) => b.running && Object.entries(labels).every(([key, value]) => b.labels[key] === value)).map(([id, b]) => ({ ref: { id, name: id }, labels: b.labels, state: "running", network: "open" })) };
      },
      async network() { return { ok: true, value: "open" }; },
      async connect(ref) {
        if (!browsers.has(ref.id)) return { ok: false, error: { code: "not_found", message: "no such browser" } };
        if (!browsers.get(ref.id).running) return { ok: false, error: { code: "gone", message: "it ended" } };
        return { ok: true, value: { client: {}, hello: {}, cdp: { url: `ws://127.0.0.1:9/devtools/${ref.id}` }, close: async () => {} } };
      },
      async release(ref) {
        calls.push({ op: "release", id: ref.id });
        const found = browsers.get(ref.id);
        if (found && !releaseRuns) found.running = false;
        return { ok: true, value: undefined };
      },
      profiles: { create: async () => ({ ok: true, value: "made" }), remove: async () => ({ ok: true, value: undefined }) },
      ...(downloads ? { downloads } : {}),
    },
  };
}

const ALL = { timeout: "wall-clock", stealth: true, headless: true, profiles: { settleMs: 0 } };

test("a session is a computer labelled with the run's labels and custody's tag, its options in spec.browser as the provider declares them: viewport, stealth for a Verified session, headless, the sign-in by its pointer", async (t) => {
  t.after(resetBrowserComputerHoldings);
  const s = stand(ALL);
  const provider = claimBrowserProvider(planeBrowser(s.provider, RUN), { headless: true, signIn: { name: "default", pointer: "ctx-7" } });
  assert.equal(provider.name, "stand", "named for its provider, which prices its time");
  assert.equal(provider.caps.profiles, true);
  assert.equal(provider.caps.settings.verified, true, "a provider that declares stealth makes a Verified session");
  const ref = await provider.create({ ...SPEC, verified: true, profile: { name: "default", save: true } }, signal());
  const [made] = s.calls.filter((c) => c.op === "create");
  assert.equal(made.spec.image, "chromium");
  assert.equal(made.spec.network, "open");
  assert.equal(made.spec.lifetimeMs, 1_800_000, "a wall-clock vendor gets the session timeout");
  assert.deepEqual(made.spec.labels, { "agentrun.run": "run-1", "agentrun.epoch": "3", [TAG_LABEL]: SPEC.tag }, "the run's labels, so a sweep finds what a run left, and the tag");
  assert.deepEqual(made.spec.browser, { viewport: SPEC.viewport, stealth: true, headless: true, profile: { pointer: "ctx-7", save: true } }, "no extension: the driver is raw CDP");
  assert.deepEqual(Object.keys(made.context), ["signal"], "create's second argument is its signal alone: the options ride the spec");
  assert.deepEqual(ref, { id: "b1", tag: SPEC.tag });
  assert.deepEqual(await provider.findByTag(SPEC.tag), [ref], "found again by its tag");
  assert.equal(await provider.status(ref), "running");
  assert.deepEqual(await provider.attach(ref), { sdkCdpUrl: "ws://127.0.0.1:9/devtools/b1" }, "the driver dials the provider's CDP URL");
  await provider.release(ref);
  assert.equal(await provider.status(ref), "gone");
  assert.equal(await provider.status({ id: "nope", tag: "x" }), "gone");
  await provider.release(ref);
});

test("a session that is not Verified asks no stealth", async (t) => {
  t.after(resetBrowserComputerHoldings);
  const s = stand(ALL);
  await claimBrowserProvider(planeBrowser(s.provider, RUN)).create(SPEC, signal());
  const [made] = s.calls;
  assert.deepEqual(made.spec.browser, { viewport: SPEC.viewport });
});

test("an inactivity vendor gets custody's idle release as its lifetime; a feature it does not declare is never asked", async (t) => {
  t.after(resetBrowserComputerHoldings);
  const s = stand({ timeout: "inactivity" });
  const provider = claimBrowserProvider(planeBrowser(s.provider, RUN), { headless: true });
  await provider.create({ ...SPEC, verified: true }, signal());
  const [made] = s.calls;
  assert.equal(made.spec.lifetimeMs, 180_000);
  assert.deepEqual(made.spec.browser, { viewport: SPEC.viewport });
  assert.equal(provider.caps.settings.verified, false, "its record says the session is not Verified");
  assert.equal(provider.caps.profiles, false, "no sign-in handed, so no profile");
  assert.equal(provider.downloads, undefined, "a provider that keeps no downloads lists none");
});

test("a provider that keeps downloads lists and reads them through the protocol", async (t) => {
  t.after(resetBrowserComputerHoldings);
  const files = [{ name: "a.txt", sizeBytes: 2, modifiedAt: null }];
  const s = stand({ timeout: "wall-clock", downloads: { path: "downloads" } }, { downloads: { list: async () => ({ ok: true, value: files }), read: async () => ({ ok: true, value: (async function* () { yield Buffer.from("hi"); })() }) } });
  const provider = claimBrowserProvider(planeBrowser(s.provider, RUN));
  const ref = await provider.create(SPEC, signal());
  assert.deepEqual(await provider.downloads.list(ref), files);
  const chunks = [];
  for await (const chunk of await provider.downloads.read(ref, "a.txt", 10)) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "hi");
});

test("a profile the run was not handed is refused before anything is made", async (t) => {
  t.after(resetBrowserComputerHoldings);
  const s = stand(ALL);
  await assert.rejects(claimBrowserProvider(planeBrowser(s.provider, RUN)).create({ ...SPEC, profile: { name: "default", save: false } }, signal()), /no saved sign-in named "default"/);
  await assert.rejects(claimBrowserProvider(planeBrowser(s.provider, RUN), { signIn: { name: "default", pointer: "ctx-7" } }).create({ ...SPEC, profile: { name: "other", save: false } }, signal()), /no saved sign-in named "other"/);
  assert.equal(s.calls.length, 0);
});

test("a refusal carries status 403, so custody ends the create at once; the words are the provider's", async (t) => {
  t.after(resetBrowserComputerHoldings);
  const s = stand(ALL, { createFails: { code: "denied", message: "stand POST /v1/sessions answered 401" } });
  const error = await claimBrowserProvider(planeBrowser(s.provider, RUN)).create(SPEC, signal()).then(() => assert.fail("refused"), (e) => e);
  assert.equal(error.status, 403);
  assert.equal(error.message, "stand POST /v1/sessions answered 401");
});

test("one session at a time saves to a sign-in: a second saver is refused while the first runs, and opens once it has ended", async (t) => {
  t.after(resetBrowserComputerHoldings);
  const s = stand(ALL, { releaseRuns: false });
  const provider = claimBrowserProvider(planeBrowser(s.provider, RUN), { signIn: { name: "default", pointer: "ctx-7" }, sleep: async () => {} });
  const first = await provider.create({ ...SPEC, profile: { name: "default", save: true } }, signal());
  await assert.rejects(provider.create({ ...SPEC, tag: "ar-run-1-2", profile: { name: "default", save: true } }, signal()), /one session at a time may save/);
  // One that does not save opens beside it.
  await provider.create({ ...SPEC, tag: "ar-run-1-3", profile: { name: "default", save: false } }, signal());
  s.browsers.get(first.id).running = false;
  await provider.create({ ...SPEC, tag: "ar-run-1-2", profile: { name: "default", save: true } }, signal());
});

test("a provider that is no browser, or a browser that declares no features, is refused in browser_unavailable's words", () => {
  const capabilities = { lifetime: "vendor", network: ["open"], isolation: "vm", os: "linux", daemon: "none", groups: [], maxLifetimeMs: 1, release: ["delete"] };
  assert.throws(() => planeBrowser({ id: "docker", capabilities: () => ({ ...capabilities, kind: "linux" }) }, RUN), (error) => error.failure?.code === "browser_unavailable" && /gives no browser/.test(error.message));
  assert.throws(() => planeBrowser({ id: "bare", capabilities: () => ({ ...capabilities, kind: "browser" }) }, RUN), (error) => error.failure?.code === "browser_unavailable" && /gives no browser/.test(error.message));
});
