// The pi coding-agent adapter as the coding agent meets it: the package's extension loaded by a real
// AgentSessionRuntime, driven by a scripted faux model, over the shared fake provider and driver. Each test asserts what
// the model was told, what the session file recorded, what was filed as evidence and what the provider saw.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FakeBackend, fakeDriver } from "@agentrun/pi-browser/testing";
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
  const expected = [...BROWSER_TOOLS.filter((tool) => tool.listedWhen === "always"), ...WEB_TOOLS];
  for (const contract of expected) {
    const tool = listed.get(contract.name);
    assert.ok(tool, `${contract.name} is registered`);
    assert.equal(tool.description, contract.description, `${contract.name}: the description is the contract's`);
    assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), JSON.parse(JSON.stringify(contract.parameters)), `${contract.name}: the schema is the contract's`);
  }
  assert.ok(!listed.has("browser_downloads"), "downloads need a provider that serves them, and this adapter has no such tool yet");
});

test("the static browser section is in the system prompt of every request", async (t) => {
  const agent = await startAgent(t, { extension: extensionOf(fake()) });
  await agent.run(turn(["snapshot"]));
  assert.ok(agent.prompts.length >= 2);
  const section = browserSection({ idleReleaseS: 180 });
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
