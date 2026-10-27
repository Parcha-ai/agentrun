import assert from "node:assert/strict";
import test from "node:test";
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";
import { LocalCustody } from "@parcha/pi-browser/coding-agent";
import { createRedactor } from "../dist/index.js";
import { createDrivingGates } from "../dist/core/driving.js";
import { vaultRuntime } from "../dist/vault-session.js";
import { connectCdp } from "../dist/providers/cdp-session.js";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { startSite } from "./fixtures/site.mjs";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { startAgent, turn } from "./coding-agent/rig.mjs";

// The pi extension's custody with a host's session vault: a kept sign-in is restored before the driver attaches, and captured when the session is released or a person hands it back
// (waiting out their last input, never while they are driving at a release).
const CTX = "ctx_55aa9c3e7b2d41f08e";
const START = "https://example.test/start";
const POLICY = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 180, batchTimeoutMs: 60_000 };
const TARGET = { sessionKey: "local-chrome", origins: ["https://app.example.com"] };
const KEPT = { kind: "provider-context", capturedAt: "2026-10-21T00:00:00.000Z", provider: "browserbase", contextId: CTX, origins: ["https://app.example.com"] };
const ASK = { requestId: "11111111-2222-4333-8444-555555555555", instruction: "Sign in.", completionCondition: "The account page shows." };

function setup({ kept = KEPT, gates, handoff, capture } = {}) {
  const backend = new FakeBackend({ start: START, pages: { [START]: { title: "Start", text: "start" } } });
  const events = []; const captured = []; const warnings = []; const tracked = new Set();
  const provider = {
    ...backend.provider,
    vault: { kind: "context", provider: "browserbase", contextIdsInClear: false, contextOf: () => CTX },
    create: async (spec, signal) => { events.push(["provider.create", spec.contextId, spec.profile?.name]); return backend.provider.create(spec, signal); },
    attach: async (ref, signal) => { events.push(["provider.attach"]); return backend.provider.attach(ref, signal); },
    release: async (ref, signal) => { events.push(["provider.release"]); return backend.provider.release(ref, signal); },
  };
  const port = {
    restore: async () => { events.push(["vault.restore"]); return kept; },
    capture: async (input) => { if (capture) return capture(input); events.push(["vault.capture", Date.now()]); captured.push(input); },
    forget: async () => {},
  };
  const vault = vaultRuntime({ sessionVault: port }, (secret) => tracked.add(secret), (message) => warnings.push(message));
  const custody = new LocalCustody({
    config: { label: "", run: "run-vault", policy: POLICY }, provider: async () => provider,
    driver: (target, signal, options) => { events.push(["driver.attach"]); return fakeDriver(backend)(target, signal, options); },
    keep: () => {}, redact: createRedactor(() => [...tracked]), signal: new AbortController().signal, gates, handoff, vault, vaultTarget: TARGET,
  });
  return { custody, events, captured, warnings, tracked, backend };
}
const names = (events) => events.map((e) => e[0]);

test("the pi extension restores a kept context before its driver attaches, and captures it before the release", async () => {
  const { custody, events, captured, tracked } = setup();
  await custody.session();
  assert.deepEqual(names(events).slice(0, 4), ["vault.restore", "provider.create", "provider.attach", "driver.attach"]);
  assert.deepEqual(events.find((e) => e[0] === "provider.create").slice(1), [CTX, undefined], "the provider runs on the kept context");
  assert.ok(tracked.has(CTX), "the id is a tracked secret");
  await custody.close("close");
  const order = names(events);
  assert.ok(order.indexOf("vault.capture") > order.indexOf("driver.attach") && order.indexOf("vault.capture") < order.indexOf("provider.release"), "captured while the browser exists");
  assert.deepEqual(captured.map((c) => [c.sessionKey, c.state.contextId]), [["local-chrome", CTX]]);
});

test("with nothing kept, a new persisted context is asked for, its id goes to the vault right after the create, and again at the release", async () => {
  const { custody, events, captured } = setup({ kept: null });
  await custody.session();
  const create = events.find((e) => e[0] === "provider.create");
  assert.equal(create[1], undefined);
  assert.match(create[2], /^vault-[0-9a-f]{18}$/);
  assert.equal(captured.length, 1, "the new context's id went to the vault right after the create");
  await custody.close("close");
  assert.equal(captured.length, 2, "and again at the release");
});

test("a handoff's end captures once the person has stopped driving: it waits out their last input, and a release while they drive captures nothing", async () => {
  const gates = createDrivingGates({ idleMs: 400 });
  const polled = [];
  const handoff = { request: async () => ({ interactionId: "i1" }), outcome: async () => { polled.push(Date.now()); gates(tag()).input(); return "done"; } };
  let tagName = "";
  const tag = () => tagName;
  const { custody, events, captured } = setup({ gates, handoff });
  const attached = await custody.session();
  tagName = attached.tag;
  const ended = await custody.handoff({ requestId: ASK.requestId, instruction: ASK.instruction, completionCondition: ASK.completionCondition });
  assert.equal(ended.outcome, "done");
  const at = captured.length ? events.find((e) => e[0] === "vault.capture")[1] : null;
  assert.equal(captured.length, 1, "the sign-in was captured at the handoff's end");
  assert.ok(at - polled[0] >= 350, `after the person's last input had aged out (${at - polled[0]} ms)`);
  // a person driving at a release: nothing is read, and the release goes on
  gates(attached.tag).input();
  await custody.close("close");
  assert.equal(captured.length, 1, "no second capture while a person drives");
  assert.ok(names(events).includes("provider.release"));
});

test("a vault that throws on capture does not stop the release: a warning says it failed, with the error's kind and not its message", async () => {
  const boom = Object.assign(new Error("no"), { name: `VaultError_${CTX}` });
  const { custody, events, warnings } = setup({ capture: async () => { throw boom; } });
  await custody.session();
  await custody.close("close");
  assert.ok(names(events).includes("provider.release"), "released");
  assert.ok(warnings.some((w) => /could not capture/.test(w)), "a warning said so");
  // the warning text goes through the extension's redactor (tracked ids) before it is printed: this runtime's own warn sink receives the raw message, which names the error's kind only
  assert.ok(warnings.every((w) => !/no\b/.test(w)), "the error's message is not in it");
});

test("in Chrome, through the pi extension: a sign-in is captured at the release, a fresh Chrome gets it back before any page opens, and the site is never asked for a restore page", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const site = await startSite();
  t.after(() => site.close(), { timeout: 30_000 });
  const store = { state: null };
  const events = [];
  const port = {
    restore: async () => { events.push("restore"); return store.state; },
    capture: async (input) => { events.push("capture"); store.state = input.state; },
    forget: async () => {},
  };
  const env = { PI_BROWSER_CHROME: CHROME, PATH: process.env.PATH ?? "", ...(process.env.CI ? { PI_BROWSER_NO_SANDBOX: "1" } : {}) };
  // What the browser's cookie jar holds at the moment each driver attaches: a restore that runs after the driver is too late for any page it opens.
  const atDriver = [];
  const driver = async (target, signal, options) => {
    const link = await connectCdp(target.sdkCdpUrl);
    try { atDriver.push((await link.send("Storage.getCookies", {})).cookies.some((c) => c.name === "kept")); } finally { link.close(); }
    return stagehandDriver()(target, signal, options);
  };
  const agent = await startAgent(t, { extension: { env, driver, sessionVault: port, vault: { sessionKey: "chrome-1", origins: [site.base] } } });
  let first;
  try {
    first = await agent.run(
      turn(["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); await page.evaluate(() => { localStorage.setItem("login", "sam"); document.cookie = "kept=1; max-age=3600; path=/"; }); return "signed in";` }]),
      turn(["browser_release"]),
    );
  } catch (error) { if (skipIncapable(t, error)) return; throw error; }
  if (first[0].isError && skipIncapable(t, { message: first[0].text })) return;
  assert.equal(first[0].isError, false, first[0].text);
  assert.deepEqual(events, ["restore", "capture"], "restored nothing at the start, captured at the release");
  assert.equal(store.state.kind, "cdp");
  assert.deepEqual(store.state.localStorage[site.base], { login: "sam" });
  assert.ok(store.state.cookies.some((c) => c.name === "kept" && c.expires > Date.now() / 1000), "the persistent cookie, with its expiry");
  const before = site.requests.length;
  const second = await agent.run(turn(["run", { code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.evaluate(() => localStorage.getItem("login") + "|" + document.cookie);` }]), turn(["browser_release"]));
  assert.equal(second[0].isError, false, second[0].text);
  assert.match(second[0].text, /sam\|kept=1/, "the new browser is signed in");
  assert.deepEqual(events.slice(0, 3), ["restore", "capture", "restore"]);
  assert.deepEqual(atDriver, [false, true], "the kept cookie was already in the new browser when its driver attached");
  assert.ok(!site.requests.slice(before).some((r) => r.path.includes("__pi-browser-vault__")), "the restore never reached the site");
  assert.equal(site.requests.slice(before).filter((r) => r.path === "/a").length, 1, "only the agent's own page load reached the site");
});
