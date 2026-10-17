import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";
import { LocalCustody } from "@parcha/pi-browser/coding-agent";
import { BROWSER_TOOLS, WEB_TOOLS, browserSection } from "../dist/index.js";
import { done, startAgent, turn } from "./coding-agent/rig.mjs";

const START = "https://example.test/start";
const ARTICLE = { url: START, title: "Filing", text: "Menu Home Acme Corp file number 7741234 Footer", html: "<html><body><nav>Menu Home</nav><article><h1>Acme Corp</h1><p>File number 7741234</p></article><footer>Footer</footer></body></html>" };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fake = (options = {}) => new FakeBackend({ start: START, pages: { [START]: ARTICLE }, ...options });
const extensionOf = (backend, extra = {}) => ({ provider: () => backend.provider, driver: fakeDriver(backend), ...extra });
const failure = (text) => JSON.parse(text);
const until = async (check, ms = 4000) => { for (const end = Date.now() + ms; !check(); ) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };

test("the coding agent lists the browser and web tools with the package's contract unchanged", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  const listed = new Map(agent.session.getAllTools().map((tool) => [tool.name, tool]));
  const expected = [...BROWSER_TOOLS, ...WEB_TOOLS];
  for (const contract of expected) {
    const tool = listed.get(contract.name);
    assert.ok(tool, `${contract.name} is registered`);
    assert.equal(tool.description, contract.description, `${contract.name}: the description is the contract's`);
    assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), JSON.parse(JSON.stringify(contract.parameters)), `${contract.name}: the schema is the contract's`);
  }
});

test("the static browser section is in the system prompt of every request", async (t) => {
  const agent = await startAgent(t, { extension: extensionOf(fake()) });
  await agent.run(turn(["snapshot"]));
  assert.ok(agent.prompts.length >= 2);
  const section = browserSection({ idleReleaseS: 180 }, { downloads: true, upload: true });
  for (const context of agent.prompts) assert.ok(JSON.stringify(context.systemPrompt ?? context).includes(JSON.stringify(section).slice(1, -1)), "the section reaches the model unchanged");
});

test("snapshot and browser_read launch one session; the read is filed under the project with its provenance", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  const [snap, read] = await agent.run(turn(["snapshot"]), turn(["browser_read"]));
  assert.equal(backend.tally().creates, 1);
  assert.match(snap.text, /Acme Corp/);
  assert.match(read.text, /^url: https:\/\/example\.test\/start\ntitle: Filing\nevidence: \.pi\/browser\/evidence\/browser\/0001-browser_read\.md\n---\n# Acme Corp/);
  const receipt = fs.readFileSync(path.join(agent.work, ".pi/browser/evidence/browser/0001-browser_read.md"), "utf8");
  const [header, body] = [receipt.slice(0, receipt.indexOf("\n---\n")), receipt.slice(receipt.indexOf("\n---\n") + 5)];
  assert.match(header, /^tool: browser_read\nargs: \{"what":"markdown"\}\nstatus: ok\n/);
  assert.match(header, new RegExp(`\\nsha256: ${sha(body)}\\n`), "the hash is of the body filed");
  assert.match(header, /\nfinal_url: https:\/\/example\.test\/start\n/);
  assert.match(body, /# Acme Corp/);
  assert.doesNotMatch(body, /Menu Home|Footer/, "the article, not the page chrome");
});

test("a screenshot returns the image to the model and files a receipt with the capture beside it", async (t) => {
  const agent = await startAgent(t, { extension: extensionOf(fake()) });
  const [shot] = await agent.run(turn(["screenshot", { type: "jpeg", quality: 40 }]));
  const image = shot.result.content.find((part) => part.type === "image");
  assert.ok(image?.data && /^image\/(jpeg|png)$/.test(image.mimeType));
  const dir = path.join(agent.work, ".pi/browser/evidence/browser");
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files.map((f) => f.replace(/^\d+-/, "")), ["screenshot.jpg", "screenshot.md"]);
  assert.match(fs.readFileSync(path.join(dir, files.find((f) => f.endsWith(".md"))), "utf8"), new RegExp(`\\nsha256: ${sha(fs.readFileSync(path.join(dir, files.find((f) => f.endsWith(".jpg")))))}\\n`));
  const { media } = shot.result.details;
  assert.equal(media.path, `.pi/browser/evidence/browser/${files.find((f) => f.endsWith(".jpg"))}`, "the media path is the capture, relative to the project");
  assert.deepEqual([media.kind, media.mime, media.bytes], ["screenshot", image.mimeType, fs.statSync(path.join(agent.work, media.path)).size]);
});

test("a failed call is an error result with the typed envelope; an argument the schema refuses never reaches the tool", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  const [both, invalid] = await agent.run(turn(["run", { code: "return 1", actions: [{ op: "click", id: "1" }] }]), turn(["snapshot", { includeIframes: "yes" }]));
  assert.equal(both.isError, true);
  assert.equal(failure(both.text).code, "refused");
  assert.equal(invalid.isError, true, "the agent's own validation refuses the argument");
  assert.equal(backend.tally().creates, 0, "neither call launched a browser");
});

test("browser_release releases at the provider; the next call opens a fresh session", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  const [, released, again] = await agent.run(turn(["snapshot"]), turn(["browser_release"]), turn(["snapshot"]));
  const answer = failure(released.text);
  assert.equal(answer.ok, true);
  assert.equal(answer.released, true);
  assert.equal(backend.tally().releases, 1);
  assert.equal(backend.tally().creates, 2);
  assert.equal(again.isError, false);
  const changes = agent.custom("browser.session").map(({ state, reason }) => [state, reason]);
  assert.deepEqual(changes, [["creating", null], ["live", null], ["released", "tool"], ["creating", null], ["live", null]]);
});

test("browser_relaunch replaces the session and keeps the new one's settings", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend, { policy: { proxies: true } }) });
  const [, relaunched] = await agent.run(turn(["snapshot"]), turn(["browser_relaunch", { verified: true, geolocation: { country: "gb", city: "London" } }]));
  const answer = failure(relaunched.text);
  assert.deepEqual([answer.ok, answer.verified, answer.geolocation], [true, true, { country: "GB", city: "LONDON" }]);
  assert.deepEqual([backend.tally().creates, backend.tally().releases, backend.liveCount()], [2, 1, 1]);
  assert.ok(agent.custom("browser.session").some(({ reason }) => reason === "relaunch"));
});

test("browser_relaunch on a session the host assigned is refused, nothing is released, and the session goes on serving", async (t) => {
  const backend = fake();
  const made = await backend.provider.create({ tag: "host-made", maxLifetimeS: 600, idleTimeoutS: 0, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal);
  const { assignedSessionProvider } = await import("../dist/providers/assigned.js");
  let handedBack = 0;
  const provider = assignedSessionProvider({ name: "host-site", session: { id: made.id, attach: () => backend.provider.attach(made), status: async () => "running", release: async () => { handedBack += 1; }, failure: () => null } });
  const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
  const [, relaunched, after] = await agent.run(turn(["snapshot"]), turn(["browser_relaunch", {}]), turn(["snapshot"]));
  const answer = failure(relaunched.text);
  assert.deepEqual([answer.ok, answer.code], [false, "refused"]);
  assert.match(answer.message, /unchanged/);
  assert.match(after.text, /Acme Corp/);
  assert.equal(handedBack, 0, "the task's only browser was not handed back");
});

/** A session the host assigned over the fake backend's own session; `attach` may fail, and every call is counted. */
async function hostAssigned(backend, { failAttaches = 0 } = {}) {
  const made = await backend.provider.create({ tag: "host-made", maxLifetimeS: 600, idleTimeoutS: 0, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal);
  const { assignedSessionProvider } = await import("../dist/providers/assigned.js");
  const counts = { creates: 0, attaches: 0, handedBack: 0 };
  const outage = { ok: false, code: "browser_unavailable", retryable: true, effect: "none", message: "The host's broker did not answer; try again." };
  const session = {
    id: made.id,
    attach: async () => { counts.attaches += 1; if (counts.attaches <= failAttaches) throw Object.assign(new Error("broker outage"), { failure: outage }); return backend.provider.attach(made); },
    status: async () => "running",
    release: async () => { counts.handedBack += 1; },
    failure: () => null,
  };
  const provider = () => {
    const assigned = assignedSessionProvider({ name: "host-site", session });
    return { ...assigned, create: (spec, signal) => { counts.creates += 1; return assigned.create(spec, signal); } };
  };
  return { counts, provider };
}

test("a session the host assigned survives a failed first attach: the next call attaches it again with no second create, and the host is never asked to take it back", async (t) => {
  const backend = fake();
  const { counts, provider } = await hostAssigned(backend, { failAttaches: 1 });
  const held = provider();
  const agent = await startAgent(t, { extension: { provider: () => held, driver: fakeDriver(backend) } });
  const [failed, after] = await agent.run(turn(["snapshot"]), turn(["snapshot"]));
  assert.equal(failed.isError, true, "the first attach failed");
  assert.equal(failure(failed.text).code, "browser_unavailable");
  assert.equal(after.isError, false, `the next call browses the assigned session: ${after.text}`);
  assert.match(after.text, /Acme Corp/);
  assert.deepEqual([counts.creates, counts.attaches, counts.handedBack], [1, 2, 0]);
  assert.deepEqual(agent.custom("browser.session").map((e) => e.state), ["creating", "live"], "one session record, still live");
});

test("a resumed session never hands back a session the host assigned: the orphan pass lets go of the old hold, and the next call is served the same session", async (t) => {
  const backend = fake();
  const { counts, provider } = await hostAssigned(backend);
  const first = await startAgent(t, { extension: { provider: (() => { const p = provider(); return () => p; })(), driver: fakeDriver(backend) } });
  await first.run(turn(["snapshot"]));
  // The first process dies without a shutdown; a new one opens the same session file over the same host session.
  const second = await startAgent(t, { extension: { provider: (() => { const p = provider(); return () => p; })(), driver: fakeDriver(backend) }, sessionFile: first.sessionFile(), dir: first.root, cwd: first.work });
  const [resumed] = await second.run(turn(["snapshot"]));
  assert.equal(resumed.isError, false, `the resumed task browses its assigned session: ${resumed.text}`);
  assert.match(resumed.text, /Acme Corp/);
  assert.equal(counts.handedBack, 0, "the task's only browser was never handed back");
});

test("a browser_relaunch keeps a Verified run Verified: no verified and verified: false both keep it, and the false one is told so", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend, { policy: { proxies: true, verified: true } }) });
  const [, bare, off] = await agent.run(turn(["snapshot"]), turn(["browser_relaunch", {}]), turn(["browser_relaunch", { verified: false }]));
  assert.deepEqual([failure(bare.text).ok, failure(bare.text).verified, failure(bare.text).note], [true, true, undefined], "a bare relaunch stays Verified");
  assert.deepEqual([failure(off.text).ok, failure(off.text).verified], [true, true], "verified: false cannot lower the run's Verified policy");
  assert.match(failure(off.text).note, /Verified/, "and the answer says the false was not followed");
  // The schema the agent reads says the same.
  const relaunch = BROWSER_TOOLS.find((tool) => tool.name === "browser_relaunch");
  assert.match(relaunch.parameters.properties.verified.description, /false, or leaving it out, keeps the run's setting/);
  assert.match(relaunch.description, /a relaunch never lowers that/);
});

test("session_shutdown releases the browser for every way a session ends, and a second shutdown does nothing", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  await agent.run(turn(["snapshot"]));
  assert.equal(backend.liveCount(), 1);
  await agent.runtime.newSession();
  assert.equal(backend.liveCount(), 0, "a new session releases the old one's browser");
  assert.equal(backend.tally().releases, 1);
  await agent.bind();
  const [after] = await agent.run(turn(["snapshot"]));
  assert.equal(after.isError, false, "the new session opens its own browser");
  assert.equal(backend.tally().creates, 2);
  await agent.dispose();
  assert.deepEqual([backend.liveCount(), backend.tally().releases], [0, 2]);
  await agent.runtime.dispose().catch(() => undefined);
  assert.equal(backend.tally().releases, 2, "nothing is released twice");
});

test("each session is appended to the session file and never sent to the model", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  await agent.run(turn(["snapshot"]), turn(["browser_release"]));
  assert.deepEqual([...new Set(agent.entries().filter((e) => e.type === "custom").map((e) => e.customType))], ["browser.session"]);
  const states = agent.custom("browser.session");
  assert.deepEqual(states.map((e) => [e.state, e.reason]), [["creating", null], ["live", null], ["released", "tool"]]);
  assert.equal(states[1].resourceId, states[2].resourceId, "the entry names the provider's session, so an orphan can be found");
  assert.doesNotMatch(JSON.stringify(agent.prompts), /browser\.session|resourceId/, "custom entries are not model context");
});

test("the provider ending a session is told to the model on the next call, which opens a fresh one", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  await agent.run(turn(["snapshot"]), () => { backend.goto("https://example.test/page?sid=SECRETVALUE1&q=2"); return turn(["run", { code: "return 1" }]); });
  backend.endAll();
  const [after] = await agent.run(turn(["snapshot"]));
  assert.match(after.text, /^Your previous browser session had ended \(the provider closed it\), so this call runs in a fresh session with no cookies or page state; the last page was https:\/\/example\.test\/page\?sid=\[redacted\]&q=\[redacted\]\./);
  assert.doesNotMatch(after.text, /SECRETVALUE1/, "every query value of a page URL is scrubbed, whatever its name");
  assert.equal(backend.tally().creates, 2);
  assert.equal(backend.liveCount(), 1);
});

test("a resumed session releases the browser a crashed process left running and opens a fresh one, never adopting it", async (t) => {
  const backend = fake();
  const first = await startAgent(t, { extension: extensionOf(backend) });
  await first.run(turn(["snapshot"]));
  const orphan = first.custom("browser.session").find((e) => e.state === "live").resourceId;
  assert.equal(backend.liveCount(), 1);
  // The first process dies without a shutdown: its browser is still running when the same session file is opened again.
  const second = await startAgent(t, { extension: extensionOf(backend), sessionFile: first.sessionFile(), dir: first.root, cwd: first.work });
  assert.equal(backend.liveCount(), 0, "the orphan is released as the session starts");
  assert.ok(backend.ledger.some((row) => row.op === "release" && row.id === orphan));
  const [fresh] = await second.run(turn(["snapshot"]));
  assert.equal(fresh.isError, false);
  assert.doesNotMatch(fresh.text, /interruption|ended/, "the model is told nothing: a resumed session simply has a fresh browser");
  assert.equal(backend.tally().creates, 2);
  assert.equal(backend.liveCount(), 1);
  assert.deepEqual(second.custom("browser.session").filter((e) => e.resourceId === orphan).map((e) => e.state), ["live", "released"], "the sweep leaves the orphan recorded as released");
});

test("a release the provider fails leaves the browser held, unrecorded as released, and the next release retries it", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  await agent.run(turn(["snapshot"]));
  backend.fail("release", 1);
  const [failed] = await agent.run(turn(["browser_release"]));
  assert.equal(failed.isError, true);
  assert.equal(backend.liveCount(), 1, "the failed release did not end the session");
  const [retried] = await agent.run(turn(["browser_release"]));
  assert.equal(JSON.parse(retried.text).released, true, "the browser was still held, so the next release found it");
  assert.equal(backend.liveCount(), 0);
  assert.deepEqual(agent.custom("browser.session").map((e) => e.state), ["creating", "live", "released"], "released is recorded once, after the provider confirmed it");
});

test("an orphan whose release fails stays open in the session file until a later start releases it", async (t) => {
  const backend = fake();
  const first = await startAgent(t, { extension: extensionOf(backend) });
  await first.run(turn(["snapshot"]));
  const orphan = first.custom("browser.session").find((e) => e.state === "live").resourceId;
  backend.fail("release", 1);
  const second = await startAgent(t, { extension: extensionOf(backend), sessionFile: first.sessionFile(), dir: first.root, cwd: first.work });
  assert.equal(backend.liveCount(), 1, "the provider failed the release: the orphan still runs");
  assert.ok(!second.custom("browser.session").some((e) => e.resourceId === orphan && e.state === "released"), "and is not recorded as released");
  const third = await startAgent(t, { extension: extensionOf(backend), sessionFile: second.sessionFile(), dir: first.root, cwd: first.work });
  assert.equal(backend.liveCount(), 0, "the next start releases it");
  assert.ok(third.custom("browser.session").some((e) => e.resourceId === orphan && e.state === "released"));
});

test("a fork never shares a live browser", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  await agent.run(turn(["snapshot"]));
  const root = agent.entries().find((e) => e.type === "message" && e.message?.role === "user");
  await agent.runtime.fork(root.id);
  await agent.bind();
  const [first] = await agent.run(turn(["snapshot"]));
  assert.doesNotMatch(first.text, /survived an interruption/);
  assert.equal(backend.tally().creates, 2, "the fork opened its own browser");
});

const pollSpy = () => {
  const made = new Map(), realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms, ...rest) => { const handle = realSet(fn, ms, ...rest); made.set(handle, ms); return handle; };
  globalThis.clearInterval = (handle) => { made.delete(handle); return realClear(handle); };
  return { pending: () => made.size, restore: () => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; } };
};

test("#1098, the coding agent: the idle check leaves no gate behind: after an idle release with nobody on the session, the registry no longer holds the gate the check looked up", async () => {
  const { createDrivingGates } = await import("@parcha/pi-browser/live-view");
  const registry = createDrivingGates();
  const looked = [];
  const backend = fake();
  const custody = new LocalCustody({
    config: { label: "", run: "run-no-gate-left", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0.05, batchTimeoutMs: 60_000 } },
    gates: (tag) => { const gate = registry(tag); looked.push([tag, gate]); return gate; },
    provider: async () => backend.provider, driver: fakeDriver(backend), keep: () => {}, redact: (text) => text, signal: new AbortController().signal,
  });
  await custody.session();
  custody.activity(1);
  custody.activity(-1);
  await until(() => backend.tally().releases === 1);
  const [tag, gate] = looked[0] ?? [];
  assert.ok(tag, "the idle check looked the gate up");
  const again = registry(tag);
  assert.notEqual(again, gate, "a lookup now makes a new gate: the one the check made was let go");
  again.onChange(() => {})();
  await custody.close("close");
});

test("#1098, the coding agent: no poll survives the session's release: a release or the close stops it at once", async () => {
  for (const how of ["release", "close"]) {
    const spy = pollSpy();
    try {
      const backend = fake();
      const gates = () => ({ state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => true, setViewing() {}, end() {} });
      const custody = new LocalCustody({
        config: { label: "", run: `run-poll-${how}`, policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0.1, batchTimeoutMs: 60_000 } },
        gates, provider: async () => backend.provider, driver: fakeDriver(backend), keep: () => {}, redact: (text) => text, signal: new AbortController().signal,
      });
      await custody.session();
      custody.activity(1);
      custody.activity(-1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(spy.pending() >= 1, `${how}: the kept session was being watched`);
      if (how === "release") await custody.release(); else await custody.close("close");
      assert.equal(spy.pending(), 0, `${how}: no poll left after it`);
      await custody.close("close");
    } finally { spy.restore(); }
  }
});

test("#1098, the coding agent: a process restart while a person watches the live view: the new process releases the old browser as it starts (it never adopts a crashed process's browser, person or not)", async (t) => {
  const backend = fake();
  const watching = () => ({ state: () => "idle", input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => true, setViewing() {}, end() {} });
  const first = await startAgent(t, { extension: extensionOf(backend, { gates: watching }) });
  await first.run(turn(["snapshot"]));
  const orphan = first.custom("browser.session").find((e) => e.state === "live").resourceId;
  // The first process dies with the person watching; its viewer and gates go with it.
  const second = await startAgent(t, { extension: extensionOf(backend), sessionFile: first.sessionFile(), dir: first.root, cwd: first.work });
  assert.equal(backend.liveCount(), 0, "the old browser is released as the new session starts");
  assert.ok(backend.ledger.some((row) => row.op === "release" && row.id === orphan));
  const [fresh] = await second.run(turn(["snapshot"]));
  assert.equal(fresh.isError, false);
  assert.equal(backend.tally().creates, 2, "the next call opens a fresh browser");
});

test("#1098, the coding agent: a person who leaves mid-window: the session is released one idle window after they leave, not at once and not never", async () => {
  for (const mode of ["driving", "watching"]) {
    const backend = fake();
    const on = { state: mode === "driving" ? "person" : "idle", viewing: mode === "watching" };
    const gates = () => ({ state: () => on.state, input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => on.viewing, setViewing() {}, end() {} });
    const custody = new LocalCustody({
      config: { label: "", run: `run-leave-${mode}`, policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0.3, batchTimeoutMs: 60_000 } },
      gates, provider: async () => backend.provider, driver: fakeDriver(backend), keep: () => {}, redact: (text) => text, signal: new AbortController().signal,
    });
    await custody.session();
    custody.activity(1);
    custody.activity(-1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(backend.tally().releases, 0, `${mode}: kept while the person is on it`);
    on.state = "idle";
    on.viewing = false;
    const left = Date.now();
    await until(() => backend.tally().releases === 1);
    const after = Date.now() - left;
    assert.ok(after >= 250 && after <= 300 + 400, `${mode}: released one idle window (300 ms) after the person left, not at once: ${after} ms`);
    await custody.close("close");
  }
});

test("#1098, the coding agent: an idle window releases nothing while a person drives or watches the live view; the next window after they leave releases it; with nobody on the session, idle releases as before", async () => {
  for (const mode of ["driving", "watching", "nobody"]) {
    const backend = fake();
    const on = { state: mode === "driving" ? "person" : "idle", viewing: mode === "watching" };
    const gates = () => ({ state: () => on.state, input: () => "driving", model: () => ({ release() {} }), onChange: () => () => {}, viewing: () => on.viewing, setViewing() {}, end() {} });
    const custody = new LocalCustody({
      config: { label: "", run: `run-idle-${mode}`, policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0.05, batchTimeoutMs: 60_000 } },
      gates, provider: async () => backend.provider, driver: fakeDriver(backend), keep: () => {}, redact: (text) => text, signal: new AbortController().signal,
    });
    await custody.session();
    custody.activity(1);
    custody.activity(-1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(backend.tally().releases, mode === "nobody" ? 1 : 0, `${mode}: past the idle window`);
    if (mode !== "nobody") {
      on.state = "idle";
      on.viewing = false;
      await until(() => backend.tally().releases === 1);
    }
    await custody.close("close");
  }
});

test("an idle session is released after the policy's idle spell, and the record says why", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend, { policy: { idleReleaseS: 0.05 } }) });
  await agent.run(turn(["snapshot"]));
  await until(() => backend.liveCount() === 0);
  assert.equal(agent.custom("browser.session").at(-1).reason, "idle");
  const [next] = await agent.run(turn(["snapshot"]));
  assert.equal(next.isError, false);
  assert.equal(backend.tally().creates, 2);
});

test("the coding agent's first call after an idle release says so first, with previous_session: an idle release is never silent", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend, { policy: { idleReleaseS: 0.05 } }) });
  await agent.run(turn(["snapshot"]));
  await until(() => backend.liveCount() === 0);
  const ended = agent.custom("browser.session").at(-1);
  const [next, after] = await agent.run(turn(["snapshot"]), turn(["snapshot"]));
  assert.equal(next.isError, false, next.text);
  assert.match(next.text, /^Your previous browser session was released/, "the release is the first thing the call says");
  assert.deepEqual(next.result.details?.previous_session, { released: true, reason: "idle", at: ended.endedAt });
  assert.equal(after.result.details?.previous_session, undefined, "only the first call after the release says it");
  // A replacement launch that fails in between does not take the release's place.
  const flaky = fake();
  const other = await startAgent(t, { extension: extensionOf(flaky, { policy: { idleReleaseS: 0.05 } }) });
  await other.run(turn(["snapshot"]));
  await until(() => flaky.liveCount() === 0);
  const idle = other.custom("browser.session").at(-1);
  flaky.fail("attach", 1);
  const [failed, told] = await other.run(turn(["snapshot"]), turn(["snapshot"]));
  assert.equal(failed.isError, true, "the replacement launch failed");
  assert.match(told.text, /^Your previous browser session was released/);
  assert.deepEqual(told.result.details?.previous_session, { released: true, reason: "idle", at: idle.endedAt });
});

test("the coding agent's browser_release after an idle release says the session was already released, as data", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend, { policy: { idleReleaseS: 0.05 } }) });
  await agent.run(turn(["snapshot"]));
  await until(() => backend.liveCount() === 0);
  const ended = agent.custom("browser.session").at(-1);
  const [released] = await agent.run(turn(["browser_release"]));
  const answer = failure(released.text);
  assert.equal(typeof ended.endedAt, "string", "the idle release records when it ended");
  assert.deepEqual([answer.ok, answer.released, answer.already_released], [true, false, { reason: "idle", at: ended.endedAt }]);
});

test("browser_release after a launch that failed and was cleaned up names that launch's release, not an earlier session's", async (t) => {
  const backend = fake();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  await agent.run(turn(["snapshot"]), turn(["browser_release"]));
  backend.fail("attach", 1);
  const [refused, again] = await agent.run(turn(["snapshot"]), turn(["browser_release"]));
  assert.equal(refused.isError, true, "the second launch's attach failed");
  const ended = agent.custom("browser.session").at(-1);
  assert.deepEqual([ended.state, ended.reason, typeof ended.endedAt], ["released", "create_failed", "string"], "the cleaned-up launch records when it ended");
  const answer = failure(again.text);
  assert.deepEqual([answer.released, answer.session_id, answer.already_released], [false, ended.resourceId, { reason: "create_failed", at: ended.endedAt }]);
});

test("a launch the provider refuses is a typed failure, leaves no session behind, and the next call can launch", async (t) => {
  const backend = fake();
  backend.fail("create", 1);
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  const [refused, ok] = await agent.run(turn(["snapshot"]), turn(["snapshot"]));
  assert.equal(refused.isError, true);
  assert.ok(["browser_unavailable", "command_failed", "rate_limited", "auth", "timeout"].includes(failure(refused.text).code));
  assert.equal(ok.isError, false);
  assert.equal(backend.liveCount(), 1);
  assert.ok(agent.custom("browser.session").some(({ reason }) => reason === "create_failed"));
});

test("a launch whose answer was lost is looked up by its tag and released, never recorded released with the browser still running", async (t) => {
  const backend = fake();
  backend.lose("create");
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  const [lost, ok] = await agent.run(turn(["snapshot"]), turn(["snapshot"]));
  assert.equal(lost.isError, true);
  assert.equal(ok.isError, false);
  assert.equal(backend.tally().creates, 2);
  assert.equal(backend.liveCount(), 1, "the first launch's browser was found by its tag and released; only the second lives");
  const entries = agent.custom("browser.session");
  const first = entries[0].tag;
  assert.ok(entries.some((entry) => entry.tag === first && entry.state === "released" && entry.reason === "create_failed"));
});

test("a launch whose answer was lost stays open in the session file when the lookup fails, for the next start to retry", async (t) => {
  const backend = fake();
  backend.lose("create");
  backend.fail("findByTag", 1);
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  const [lost] = await agent.run(turn(["snapshot"]));
  assert.equal(lost.isError, true);
  const entries = agent.custom("browser.session");
  const tag = entries[0].tag;
  assert.ok(!entries.some((entry) => entry.tag === tag && entry.state === "released"), "not recorded released: the browser may still be running");
  assert.equal(backend.liveCount(), 1, "the browser the lost answer made is still there for the next start to find");
});

test("resetting the fake backend disarms a lost answer, so a reused backend carries no failure into the next test", async (t) => {
  const backend = fake();
  backend.lose("create");
  backend.reset();
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  const [ok] = await agent.run(turn(["snapshot"]));
  assert.equal(ok.isError, false);
  assert.equal(backend.tally().creates, 1);
});

test("a test's agent root is removed when its last agent's test ends, not before", async (t) => {
  let root = null;
  await t.test("parent", async (parent) => {
    const first = await startAgent(parent, { extension: extensionOf(fake()) });
    root = first.root;
    await parent.test("child on the parent's root", async (child) => {
      await startAgent(child, { extension: extensionOf(fake()), dir: first.root, sessionFile: first.sessionFile(), cwd: first.work });
    });
    assert.equal(fs.existsSync(root), true, "the child's end leaves the root the parent's agent still uses");
  });
  assert.equal(fs.existsSync(root), false, "the parent's end removes it");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rig-failed-start-"));
  const outer = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  try {
    await assert.rejects(startAgent(t, { extension: extensionOf(fake()), cwd: "/dev/null/x/work" }));
    assert.deepEqual(fs.readdirSync(scratch), [], "a start that fails after its root exists leaves it behind no longer");
  } finally {
    if (outer === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = outer;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("web_fetch is filed as evidence through the provider; web_search is listed only when the provider can search", async (t) => {
  const backend = fake({ fetches: { "https://example.test/doc": "# Doc\n\nthe answer is 42" }, search: [{ url: "https://example.test/doc", title: "Doc" }] });
  const agent = await startAgent(t, { extension: extensionOf(backend) });
  const [fetched, searched, refused] = await agent.run(turn(["web_fetch", { url: "https://example.test/doc" }]), turn(["web_search", { query: "doc" }]), turn(["web_fetch", { url: "file:///etc/passwd" }]));
  assert.match(fetched.text, /^url: https:\/\/example\.test\/doc\nvia: .*fetch\nevidence: \.pi\/browser\/evidence\/web\/0001-web_fetch\.md\n---\n# Doc/);
  assert.equal(failure(searched.text).ok, true);
  assert.equal(failure(refused.text).code, "refused");
  const quiet = await startAgent(t, { extension: extensionOf({ ...backend, provider: { ...backend.provider, search: undefined } }) });
  assert.ok(!quiet.session.getAllTools().some((tool) => tool.name === "web_search"), "no search provider, no web_search");
});

test("web_fetch falls back to the host's fetchers when the provider cannot fetch", async (t) => {
  const backend = fake();
  const noFetch = { ...backend.provider, fetch: undefined, search: undefined };
  const agent = await startAgent(t, { extension: { provider: () => noFetch, driver: fakeDriver(backend), backups: [{ name: "plain", fetch: async (url) => `# From ${url}` }] } });
  const [fetched] = await agent.run(turn(["web_fetch", { url: "https://example.test/x" }]));
  assert.match(fetched.text, /^url: https:\/\/example\.test\/x\nvia: backup:plain\n/);
  assert.match(fetched.text, /# From https:\/\/example\.test\/x/);
});

test("a driver whose close never comes back does not hold the release: the provider still releases", { timeout: 30_000 }, async (t) => {
  // A Stagehand close after its connection dropped and was reconnected can wait forever.
  const backend = fake();
  const hanging = async (target, signal, options) => ({ ...(await fakeDriver(backend)(target, signal, options)), close: () => new Promise(() => {}) });
  const agent = await startAgent(t, { extension: extensionOf(backend, { driver: hanging }) });
  const [, released] = await agent.run(turn(["snapshot"]), turn(["browser_release"]));
  assert.equal(failure(released.text).released, true);
  assert.equal(backend.tally().releases, 1, "the provider released the session");
});

test("the coding agent's custody: a hold refuses every call until the session is handed back, and a driver from before it cannot act", async () => {
  const backend = fake();
  const kept = [];
  const custody = new LocalCustody({
    config: { label: "", run: "run-held", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0.05, batchTimeoutMs: 60_000 } },
    provider: async () => backend.provider, driver: fakeDriver(backend), keep: (_type, data) => kept.push(data.state), redact: (text) => text, signal: new AbortController().signal,
  });
  const codeOf = (promise) => promise.then(() => "acted", (error) => error.failure?.code ?? String(error));
  assert.equal(await codeOf(custody.hold("handoff-1")), "refused", "no session to hand over");
  const before = await custody.session();
  custody.activity(1);
  custody.activity(-1);
  const held = await custody.hold("handoff-1");
  assert.deepEqual(held, { tag: before.tag, sessionId: before.sessionId });
  assert.deepEqual(await Promise.all([codeOf(before.driver.page()), codeOf(custody.session()), codeOf(custody.relaunch({})), codeOf(custody.hold("handoff-2"))]), ["waiting_for_human", "waiting_for_human", "waiting_for_human", "waiting_for_human"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual([await codeOf(custody.session()), backend.tally().releases], ["waiting_for_human", 0], "an idle spell never releases a held session, even one armed before the hold");
  await custody.resume("A person finished your handoff (done).");
  const after = await custody.session();
  assert.deepEqual([after.fence, after.notice, await codeOf(before.driver.page())], [2, "A person finished your handoff (done).", "stale_snapshot"]);
  assert.equal(backend.dispatched.filter((row) => row.op === "read").length, 0);
  assert.deepEqual([backend.tally().creates, backend.tally().attaches], [1, 2]);
  await custody.hold("handoff-3");
  assert.deepEqual(await custody.release(), { released: true, sessionId: before.sessionId });
  assert.deepEqual(kept, ["creating", "live", "held", "live", "held", "released"]);
  assert.equal(backend.liveCount(), 0);
});

test("the coding agent's custody: a held session the host assigned answers a relaunch with the hold, not the fixed-session refusal", async () => {
  const backend = fake();
  const made = await backend.provider.create({ tag: "host-made", maxLifetimeS: 600, idleTimeoutS: 0, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal);
  const { assignedSessionProvider } = await import("../dist/providers/assigned.js");
  const provider = assignedSessionProvider({ name: "host-site", session: { id: made.id, attach: () => backend.provider.attach(made), status: async () => "running", release: async () => {}, failure: () => null } });
  const custody = new LocalCustody({
    config: { label: "", run: "run-held-fixed", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 180, batchTimeoutMs: 60_000 } },
    provider: async () => provider, driver: fakeDriver(backend), keep: () => {}, redact: (text) => text, signal: new AbortController().signal,
  });
  await custody.session();
  await custody.hold("handoff-1");
  const code = await custody.relaunch({}).then(() => "acted", (error) => error.failure?.code ?? String(error));
  assert.equal(code, "waiting_for_human");
  assert.deepEqual([backend.tally().creates, backend.tally().releases], [1, 0], "nothing launched or released");
  await custody.close("close");
});

test("the coding agent's custody: a held session the provider ended stops the wait, and the next call opens a fresh one", async () => {
  const backend = fake();
  const custody = new LocalCustody({
    config: { label: "", run: "run-held-ended", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 180, batchTimeoutMs: 60_000 } },
    provider: async () => backend.provider, driver: fakeDriver(backend), keep: () => {}, redact: (text) => text, signal: new AbortController().signal,
  });
  await custody.session();
  await custody.hold("handoff-1");
  backend.endAll();
  const next = await custody.session();
  assert.match(next.notice ?? "", /had ended \(the provider closed it\)/);
  assert.equal(backend.tally().creates, 2);
  await custody.close("close");
});

test("the coding agent's idle release after #1001 and #1068 compose: a held session past the idle window stays and is told nothing; an unheld one is released, and the next session says so", async () => {
  const policy = { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0.05, batchTimeoutMs: 60_000 };
  const custodyOf = (backend, run) => new LocalCustody({
    config: { label: "", run, policy },
    provider: async () => backend.provider, driver: fakeDriver(backend), keep: () => {}, redact: (text) => text, signal: new AbortController().signal,
  });
  // Held (#1001's guard): the idle window passes and nothing is released, so nothing is told; handed back, it is the same session.
  const heldBackend = fake();
  const held = custodyOf(heldBackend, "run-idle-held");
  const first = await held.session();
  held.activity(1);
  held.activity(-1);
  await held.hold("handoff-1");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(heldBackend.tally().releases, 0, "a held session is never idle-released");
  await held.resume("A person finished your handoff (done).");
  const back = await held.session();
  assert.equal(back.tag, first.tag, "the same session after the hand-back");
  assert.doesNotMatch(back.notice ?? "", /released/, "nothing was released, so there is no release notice");
  assert.equal(back.replaced ?? null, null, "and no replaced session");
  await held.close("close");
  // Unheld (#1068's notice): the same window releases it, and the next session leads with the release and names what it replaced.
  const openBackend = fake();
  const open = custodyOf(openBackend, "run-idle-open");
  const before = await open.session();
  open.activity(1);
  open.activity(-1);
  await until(() => openBackend.tally().releases === 1);
  const next = await open.session();
  assert.notEqual(next.tag, before.tag, "a fresh session");
  assert.match(next.notice ?? "", /^Your previous browser session was released/, "the release is told to the next session");
  assert.equal(next.replaced?.reason, "idle");
  await open.close("close");
});

/** A provider whose release really releases and then, `times` times, says a directory is left behind: what the cdp provider does when a profile cannot be removed (EACCES, EBUSY). */
function leftoverProvider(backend, times) {
  let left = times;
  const releases = [];
  const provider = Object.create(backend.provider);
  provider.release = async (ref, signal) => {
    releases.push(ref.id);
    await backend.provider.release(ref, signal);
    if (left > 0) { left -= 1; throw Object.assign(new Error(`the browser is gone but its directory /tmp/pib-x/${ref.tag} could not be removed (EACCES: permission denied); it may hold the session's cookies`), { name: "ProfileNotRemovedError", code: "profile_not_removed", dirs: [`/tmp/pib-x/${ref.tag}`] }); }
  };
  return { provider, releases };
}
const lastStates = (agent) => { const last = new Map(); for (const e of agent.custom("browser.session")) last.set(e.tag, e.state); return last; };

test("a browser that ended, whose directory cannot be removed, is not reused: the next call opens a fresh browser, and the leftover is released again at the next release", async (t) => {
  const backend = fake();
  const { provider, releases } = leftoverProvider(backend, 1);
  const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
  const [first] = await agent.run(turn(["snapshot"]));
  assert.equal(first.isError, false);
  const [oldId] = backend.live().map((s) => s.id);
  backend.endAll(); // the browser dies on its own
  const [second] = await agent.run(turn(["snapshot"]));
  assert.equal(second.isError, false, second.text);
  assert.equal(backend.tally().creates, 2, "the dead browser was not reused: a fresh one was opened");
  assert.notEqual(backend.live()[0]?.id, oldId);
  const [oldTag] = [...lastStates(agent).keys()];
  assert.equal(lastStates(agent).get(oldTag), "releasing", "the dead browser's record stays open: its directory is still to be removed");
  await agent.run(turn(["browser_release"]));
  assert.equal(releases.filter((id) => id === oldId).length, 2, "the leftover was released again, as cleanup, by the next release");
  assert.equal(lastStates(agent).get(oldTag), "released", "and the record ends once it worked");
});

test("browser_relaunch goes on when the browser it replaces is released but its directory is left: the new browser opens", async (t) => {
  const backend = fake();
  const { provider } = leftoverProvider(backend, 1);
  const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
  const [, relaunched] = await agent.run(turn(["snapshot"]), turn(["browser_relaunch", { verified: false }]));
  assert.equal(relaunched.isError, false, relaunched.text);
  assert.equal(backend.tally().creates, 2);
  assert.equal(backend.liveCount(), 1, "one browser is running: the new one");
});

test("an explicit browser_release of a browser whose directory is left says so, and the session is over", async (t) => {
  const backend = fake();
  const { provider } = leftoverProvider(backend, 1);
  const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
  const [, released] = await agent.run(turn(["snapshot"]), turn(["browser_release"]));
  assert.match(released.text, /could not be removed/, "the caller is told what is left");
  const [again] = await agent.run(turn(["snapshot"]));
  assert.equal(again.isError, false, again.text);
  assert.equal(backend.tally().creates, 2, "the next call opens a fresh browser, not the released one");
});

test("a browser_release after one whose directory was left removes it and says the session was already released, by the tool", async (t) => {
  const backend = fake();
  const { provider, releases } = leftoverProvider(backend, 1);
  const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
  const [, first, again] = await agent.run(turn(["snapshot"]), turn(["browser_release"]), turn(["browser_release"]));
  assert.match(first.text, /could not be removed/, "the first release says what is left");
  assert.equal(releases.length, 2, "the second release removed the leftover directory");
  const ended = agent.custom("browser.session").at(-1);
  assert.equal(ended.state, "released");
  assert.equal(typeof ended.endedAt, "string", "the record ends, with its time, once the directory is gone");
  const answer = failure(again.text);
  assert.deepEqual([answer.ok, answer.released, answer.already_released], [true, false, { reason: "tool", at: ended.endedAt }]);
});

test("shutdown releases a leftover directory once more, and a release that fails for another reason still holds the session", async (t) => {
  const backend = fake();
  const { provider, releases } = leftoverProvider(backend, 1);
  const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
  await agent.run(turn(["snapshot"]));
  const [oldId] = backend.live().map((s) => s.id);
  backend.endAll();
  await agent.run(turn(["snapshot"]));
  await agent.dispose();
  assert.equal(releases.filter((id) => id === oldId).length, 2, "the shutdown released the leftover again");
  // A release that fails with anything else may have left the browser running: the session stays held for the retry.
  const failing = fake();
  failing.fail("release", 1);
  const held = await startAgent(t, { extension: extensionOf(failing) });
  await held.run(turn(["snapshot"]));
  const [refused] = await held.run(turn(["browser_release"]));
  assert.equal(refused.isError, true);
  assert.equal(failing.liveCount(), 1);
  const [still] = await held.run(turn(["snapshot"]));
  assert.equal(still.isError, false, "the held session is the one the next call uses");
  assert.equal(failing.tally().creates, 1);
});

test("a leftover directory that still cannot be removed stays for the next release; the record ends released only when one works", async (t) => {
  const backend = fake();
  const { provider, releases } = leftoverProvider(backend, 2);
  const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
  await agent.run(turn(["snapshot"]));
  const [oldId] = backend.live().map((s) => s.id);
  backend.endAll();
  await agent.run(turn(["snapshot"])); // the first leftover
  const [oldTag] = [...lastStates(agent).keys()];
  await agent.run(turn(["browser_release"])); // the sweep fails once more (the second failure), then this release works
  assert.equal(releases.filter((id) => id === oldId).length, 2);
  assert.equal(lastStates(agent).get(oldTag), "releasing", "still left: the record stays open");
  await agent.dispose();
  assert.equal(releases.filter((id) => id === oldId).length, 3, "the shutdown tried it once more");
  assert.equal(lastStates(agent).get(oldTag), "released");
});

test("with no browser open, the shutdown still releases the directory an earlier release left", async (t) => {
  const backend = fake();
  const { provider, releases } = leftoverProvider(backend, 1);
  const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
  const [, released] = await agent.run(turn(["snapshot"]), turn(["browser_release"]));
  assert.match(released.text, /could not be removed/);
  assert.equal(releases.length, 1);
  await agent.dispose();
  assert.equal(releases.length, 2, "the shutdown released the leftover again with no live browser");
});

test("browser_release with no browser open retries the directory an earlier release left: two releases in a row, no browser opened between", async (t) => {
  const backend = fake();
  const { provider, releases } = leftoverProvider(backend, 1);
  const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
  const [, first, second] = await agent.run(turn(["snapshot"]), turn(["browser_release"]), turn(["browser_release"]));
  assert.match(first.text, /could not be removed/, "the first release says what is left");
  assert.equal(second.isError, false, second.text);
  assert.equal(releases.length, 2, "the second release tried the directory again, with no browser live");
  assert.equal(backend.tally().creates, 1, "no browser was opened for it");
  const [tag] = [...lastStates(agent).keys()];
  assert.equal(lastStates(agent).get(tag), "released", "and the record ends once it worked");
});

test("browser_release with no browser open says so again while the directory still cannot be removed, and succeeds once it can", async (t) => {
  const backend = fake();
  const { provider, releases } = leftoverProvider(backend, 2);
  const agent = await startAgent(t, { extension: { provider: () => provider, driver: fakeDriver(backend) } });
  const [, first, second, third] = await agent.run(turn(["snapshot"]), turn(["browser_release"]), turn(["browser_release"]), turn(["browser_release"]));
  assert.match(first.text, /could not be removed/);
  assert.equal(second.isError, true, "still left: the caller is told again");
  assert.match(second.text, /could not be removed/);
  assert.equal(third.isError, false, third.text);
  assert.equal(releases.length, 3);
});

test("a profile the provider cannot keep, or beside a context id, is refused with the typed envelope before a browser is started", async (t) => {
  for (const policy of [{ profile: { name: "work", save: true } }, { profile: { name: "work", save: true }, contextId: "ctx_1" }]) {
    const backend = fake({ caps: { profiles: Boolean(policy.contextId) } });
    const agent = await startAgent(t, { extension: extensionOf(backend, { policy }) });
    const [refused] = await agent.run(turn(["snapshot"]));
    assert.equal(refused.isError, true);
    assert.deepEqual([failure(refused.text).code, failure(refused.text).effect], ["refused", "none"]);
    assert.equal(backend.tally().creates, 0);
  }
});
