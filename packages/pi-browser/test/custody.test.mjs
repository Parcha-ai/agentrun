// The custody crash matrix: each row is a real process on a real SQLite run file, SIGKILLed at the named cut,
// then a second process that reconciles, resumes and ends the conversation. The fake provider lives in this process,
// so its ledger (creates, releases, dispatches, the most sessions live at once) is the truth the rows assert, and
// every scenario must end with no session live at the provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeBackend, fixturePage } from "@parcha/pi-browser/testing";
import { fakeKernel } from "./fixtures/fake-kernel.mjs";

const CHILD = fileURLToPath(new URL("./custody/child.mjs", import.meta.url));
const START = "https://example.test/start";

function child(env) {
  const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  proc.stdout.on("data", (chunk) => { out += chunk; proc.emit("line", out); });
  proc.stderr.on("data", (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal, out, err })));
  return { proc, exited, output: () => out + err };
}

/** Run the first process to its cut (or to its end), then the second; return the ledger and what the model saw. */
async function scenario(t, { script, script2 = script, cutAt, hold, between, inactive, env = {}, env2 = {}, zombie = false, kernel = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custody-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const server = await backend.serve();
  t.after(() => server.close());
  const base = { DB: path.join(dir, "run.sqlite"), FAKE: server.url };
  // The real kernel provider in both processes, against a fake Kernel API in this one whose browsers are the backend's sessions.
  let api = null;
  if (kernel) {
    const key = `kernel-crash-key-${process.pid}-${Math.random().toString(36).slice(2)}`;
    api = await fakeKernel({ key, backend });
    t.after(() => api.close());
    Object.assign(base, { KERNEL_URL: api.url, KERNEL_KEY: key });
  }

  if (hold) backend.hold(hold);
  const first = child({ ...base, ...env, MODE: "first", SCRIPT: JSON.stringify(script), KILL_AT: cutAt ?? "", OUT: path.join(dir, "first.json") });
  const reached = new Promise((resolve) => {
    if (hold) backend.events.once("held", () => resolve("held"));
    if (cutAt) first.proc.on("line", (out) => { if (out.includes(`AT ${cutAt}`)) resolve("cut"); });
    first.exited.then(() => resolve("exit"));
  });
  const how = await reached;
  if (how !== "exit") first.proc.kill("SIGKILL");
  const firstEnd = await first.exited;
  assert.ok(how !== "exit" || firstEnd.code === 0, `first process: ${firstEnd.out}${firstEnd.err}`);
  if (cutAt || hold) assert.equal(how === "exit" ? null : firstEnd.signal, "SIGKILL", `the first process reached its cut (${how}): ${firstEnd.out}${firstEnd.err}`);
  between?.(backend);

  const second = child({ ...base, ...env2, MODE: "second", SCRIPT: JSON.stringify(script2), OUT: path.join(dir, "second.json"), RELEASE_AT_END: "1", ...(inactive ? { INACTIVE: "1" } : {}) });
  // A zombie holder: its create, sent before the takeover, lands at the provider after the new holder reconciled.
  let landed = null;
  if (zombie) {
    const tag = /TAG (\S+)/.exec(firstEnd.out)?.[1];
    landed = new Promise((resolve) => second.proc.on("line", (out) => {
      if (out.includes("RECONCILED") && !landed.started) { landed.started = true; resolve(backend.provider.create({ tag, metadata: {}, viewport: { width: 1, height: 1 } }, new AbortController().signal)); }
    }));
  }
  const end = await second.exited;
  if (landed) await landed;
  assert.equal(end.code, 0, `second process: ${end.out}${end.err}`);
  const result = JSON.parse(fs.readFileSync(path.join(dir, "second.json"), "utf8"));
  const firstOut = path.join(dir, "first.json");
  return { tally: backend.tally(), ledger: backend.ledger, result, seen: result.results, api, first: fs.existsSync(firstOut) ? JSON.parse(fs.readFileSync(firstOut, "utf8")) : null };
}

const failure = (row) => { try { return JSON.parse(row.text); } catch { return null; } };

test("cut before the creating commit: the read reruns and creates once; a run is interrupted and creates nothing", async (t) => {
  const read = await scenario(t, { script: ["browser_read", "browser_release"], cutAt: "provider" });
  assert.equal(read.tally.creates, 1);
  assert.equal(read.seen[0].isError, false);
  assert.deepEqual([read.tally.peakLive, read.tally.liveAtEnd], [1, 0]);

  const run = await scenario(t, { script: ["run", "browser_release"], cutAt: "provider" });
  assert.equal(run.seen[0].isError, true, "an unsafe run is never rerun");
  assert.deepEqual([run.tally.creates, run.tally.dispatches, run.tally.liveAtEnd], [0, 0, 0]);
});

test("cut after the creating commit with the create never sent: the record ends create_failed, the rerun creates one session", async (t) => {
  const { tally, result, seen } = await scenario(t, { script: ["browser_read", "browser_release"], cutAt: "create-sent" });
  assert.equal(result.reconcile.lost.length, 1, "the unanswered create had no session by its tag");
  assert.equal(result.sessions.sessions[0].releaseReason, "create_failed");
  assert.deepEqual([tally.creates, tally.peakLive, tally.liveAtEnd], [1, 1, 0]);
  assert.equal(seen[0].isError, false);
});

test("a create that lands after reconcile looked (a fenced holder's call in flight) is found by its tag and released", async (t) => {
  const { tally, ledger, result } = await scenario(t, { script: ["browser_read", "browser_release"], cutAt: "create-sent", zombie: true, env2: { CREATE_DEADLINE_MS: "1500" } });
  const late = ledger.find((row) => row.op === "create" && row.metadata && Object.keys(row.metadata).length === 0);
  assert.ok(late, "the zombie's create landed");
  assert.equal(result.reconcile.lost.length, 1, "reconcile found nothing by the tag when it looked");
  assert.ok(ledger.some((row) => row.op === "release" && row.id === late.id), "the release task found the late session by its tag");
  assert.deepEqual([tally.creates, tally.liveAtEnd], [2, 0]);
  assert.equal(result.sessions.sessions[0].releaseReason, "create_failed");
});

test("the provider created the session but the answer was lost: reconcile binds it by its tag, no second create", async (t) => {
  for (const cut of [{ hold: "create" }, { cutAt: "after-create" }]) {
    const { tally, result, seen } = await scenario(t, { script: ["browser_read", "browser_release"], ...cut });
    assert.equal(result.reconcile.kept.length, 1, JSON.stringify(cut));
    assert.deepEqual([tally.creates, tally.peakLive, tally.liveAtEnd], [1, 1, 0], JSON.stringify(cut));
    assert.equal(seen[0].isError, false);
    assert.equal(failure(seen[0]).session, result.sessions.sessions[0].resourceId, "the rerun read on the bound session");
  }
});

test("a read cut while live, the provider ended the session on disconnect: the rerun says session_replaced and opens nothing", async (t) => {
  const { tally, result, seen } = await scenario(t, { script: ["browser_read", "browser_read", "browser_release"], hold: "driver.page", between: (b) => b.endAll() });
  assert.equal(result.reconcile.lost.length, 1);
  assert.equal(failure(seen[0]).code, "session_replaced");
  assert.equal(seen[1].isError, false, "the next call opens a fresh session");
  assert.match(failure(seen[1]).notice, /ended during an interruption/);
  assert.deepEqual([tally.creates, tally.liveAtEnd], [2, 0]);
  assert.equal(tally.peakLive, 1);
});

test("a relaunch cut after its create reruns on the session it launched: one create in all", async (t) => {
  const { tally, seen, result } = await scenario(t, { script: ["browser_relaunch", "browser_release"], hold: "create" });
  assert.equal(result.reconcile.kept.length, 1, "reconcile bound the relaunched session by its tag");
  assert.equal(seen[0].isError, false, "the rerun answered on it");
  assert.deepEqual([tally.creates, tally.liveAtEnd], [1, 0]);
});

test("a relaunch cut after its create whose session then ended: the rerun says session_replaced and launches nothing", async (t) => {
  const { tally, seen } = await scenario(t, { script: ["browser_relaunch", "browser_release"], hold: "create", between: (b) => b.endAll() });
  assert.equal(failure(seen[0]).code, "session_replaced");
  assert.deepEqual([tally.creates, tally.liveAtEnd], [1, 0]);
});

test("a read cut while live, the provider kept the session: the read reruns on the same page and is told it was kept", async (t) => {
  const { tally, result, seen } = await scenario(t, { script: ["browser_read", "browser_release"], hold: "driver.page" });
  assert.equal(result.reconcile.kept.length, 1);
  assert.equal(seen[0].isError, false);
  assert.match(failure(seen[0]).notice, /survived an interruption/);
  assert.deepEqual([tally.creates, tally.reads, tally.liveAtEnd], [1, 2, 0]);
});

test("a run cut while live: interrupted, dispatched at most once, and the next call learns which run it was", async (t) => {
  const { tally, seen, result } = await scenario(t, { script: ["run", "browser_read", "browser_release"], hold: "driver.run" });
  assert.equal(seen[0].isError, true, "pi never reruns an unsafe run");
  assert.equal(tally.dispatches, 1);
  assert.equal(failure(seen[1]).interrupted, "call-0", "the pending effect survived the crash");
  assert.equal(result.sessions.sessions.length, 1, "no second session");
  assert.deepEqual([tally.creates, tally.liveAtEnd], [1, 0]);
});

test("a release task cut before or after the provider released: it resumes and releases exactly once", async (t) => {
  for (const cut of [{ cutAt: "release-sent" }, { hold: "release" }]) {
    const { tally, result } = await scenario(t, { script: ["browser_read", "browser_release"], ...cut });
    assert.deepEqual([tally.creates, tally.releases, tally.liveAtEnd], [1, 1, 0], JSON.stringify(cut));
    assert.equal(result.sessions.sessions[0].state, "released", JSON.stringify(cut));
    assert.equal(result.sessions.sessions[0].releaseReason, "tool");
    assert.deepEqual(result.inventory.rows, {}, "no open lease is left in the inventory");
  }
});

test("a host pause: a conversation that continues keeps its session; one that is done has it released", async (t) => {
  const kept = await scenario(t, { script: ["browser_read"], script2: ["browser_read", "browser_read", "browser_release"] });
  assert.equal(kept.result.reconcile.kept.length, 1);
  assert.match(failure(kept.seen[1]).notice, /survived an interruption/);
  assert.deepEqual([kept.tally.creates, kept.tally.liveAtEnd], [1, 0]);

  const done = await scenario(t, { script: ["browser_read"], inactive: true });
  assert.equal(done.result.reconcile.released.length, 1);
  assert.equal(done.result.sessions.sessions[0].releaseReason, "lost");
  assert.deepEqual([done.tally.creates, done.tally.releases, done.tally.liveAtEnd], [1, 1, 0]);

  const ended = await scenario(t, { script: ["browser_read"], script2: ["browser_read", "browser_read"], between: (b) => b.endAll() });
  assert.equal(ended.result.reconcile.lost.length, 1);
  assert.match(failure(ended.seen[1]).notice, /ended during an interruption/);
  assert.deepEqual([ended.tally.creates, ended.tally.liveAtEnd], [2, 0]);
});

test("the host ends a conversation: its session is released by the task, and the host channel hears it with the conversation's label", async (t) => {
  const { tally, result } = await scenario(t, { script: ["browser_read"], script2: ["browser_read", "browser_read"] });
  assert.deepEqual([tally.creates, tally.releases, tally.liveAtEnd], [1, 1, 0]);
  assert.deepEqual(result.rows.map((r) => [r.change, r.label]), [["released", "node-a"]], "the second process released what the first launched");
  assert.equal(result.sessions.sessions[0].releaseReason, "close");
});

test("a session nobody calls for its idle window is released by the task", async (t) => {
  const { tally, result } = await scenario(t, { script: ["browser_read"], script2: [], env: { IDLE_S: "1", WAIT_MS: "2500" } });
  assert.deepEqual([tally.creates, tally.releases, tally.liveAtEnd], [1, 1, 0]);
  assert.equal(result.sessions.sessions[0].releaseReason, "idle");
});

/** One process, in memory: the extension on the fake's in-process face, a conversation that reads and releases.
 *  `extra` (or a function of the fake backend returning it) overrides the extension's options, `policy` the config's. */
async function inProcess(t, extra = {}, policy = {}) {
  const [{ BACKGROUND_CONTEXT: ctx }, { createModels }, faux, durable, { createBrowserExtension }, { fakeDriver }] = await Promise.all([
    import("@earendil-works/chord/context"), import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/providers/faux"),
    import("@earendil-works/pi-durable"), import("@parcha/pi-browser/durable"), import("@parcha/pi-browser/testing"),
  ]);
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const browser = createBrowserExtension({
    provider: () => backend.provider, driver: fakeDriver(backend), evidence: { file: async () => null }, ...(typeof extra === "function" ? extra(backend, fakeDriver) : extra),
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); return { content: [{ type: "text", text: "read" }] }; } },
  });
  const script = ["browser_read", "browser_release"];
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 10 }, () => (context) => {
    const done = context.messages.filter((m) => m.role === "toolResult").length;
    return script[done] ? faux.fauxAssistantMessage([faux.fauxToolCall(script[done], {})], { stopReason: "toolUse" }) : faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(model.provider);
  const registry = durable.createRegistry();
  registry.install(browser.extension);
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  const config = { label: "node-a", run: "run-abort", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000, ...policy } };
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
  await browser.reconcile(harness, () => true, ctx);
  const settled = async () => { for (let i = 0; i < 200 && (await harness.inspect(ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 25)); };
  const releaseTasks = async () => (await harness.commit((tx) => tx.scanTasks({}, 50), ctx)).items.filter((task) => task.kind === "browser.release");
  return { backend, browser, harness, root, ctx, settled, releaseTasks };
}

test("the driver factory gets the run batch's limit from the conversation's policy", async (t) => {
  const seen = [];
  const extra = (backend, fakeDriver) => ({ driver: (target, signal, options) => { seen.push(options); return fakeDriver(backend)(target); } });
  const { root, ctx, settled } = await inProcess(t, extra, { batchTimeoutMs: 42_000 });
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  await settled();
  assert.deepEqual(seen, [{ batchTimeoutMs: 42_000 }]);
});

test("an aborted release task releases once in its abort handler", async (t) => {
  const { backend, browser, harness, root, ctx, settled, releaseTasks } = await inProcess(t);
  backend.delay("release", 60_000);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  backend.delay("release", 0);
  await root.abort(ctx, { background: true });
  await settled();
  assert.deepEqual([backend.tally().creates, backend.tally().releases, backend.liveCount()], [1, 1, 0]);
  assert.deepEqual((await releaseTasks()).map((task) => task.state.outcome?.status), ["aborted"]);
  assert.equal((await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions[0].state, "released");
});

test("an abort handler whose release fails hands it to a successor task, which releases", async (t) => {
  const { backend, browser, harness, root, ctx, settled, releaseTasks } = await inProcess(t);
  backend.delay("release", 60_000);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  backend.delay("release", 0);
  backend.fail("release", 1);
  await root.abort(ctx, { background: true });
  await settled();
  assert.deepEqual([backend.tally().releases, backend.liveCount()], [1, 0]);
  assert.deepEqual((await releaseTasks()).map((task) => task.state.outcome?.status).sort(), ["aborted", "completed"]);
  assert.equal((await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions[0].state, "released");
});

test("a page URL is scrubbed before custody commits it: a credential in its query never reaches the run file", async (t) => {
  const { result } = await scenario(t, { script: ["run", "browser_release"] });
  const [record] = result.sessions.sessions;
  const stored = JSON.stringify(record);
  assert.ok(!stored.includes("planted-"), "no credential in the committed session record, whatever its query name");
  assert.equal(record.lastUrl, "https://example.test/article?api_key=[redacted]&code=[redacted]&session=[redacted]");
  assert.equal(record.navigation.at(-1).url, record.lastUrl);
});

test("custody that gave up releasing a session keeps it tracked: the next run open releases it", { timeout: 90_000 }, async (t) => {
  const { RELEASE_ATTEMPTS } = await import("@parcha/pi-browser/durable");
  const { backend, browser, harness, root, ctx } = await inProcess(t);
  backend.fail("release", RELEASE_ATTEMPTS);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  for (let i = 0; i < 600 && (await harness.inspect(ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 100));
  const [record] = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  assert.equal(record.state, "lost");
  assert.equal(backend.liveCount(), 1, "the provider still runs it");
  assert.deepEqual(Object.values((await harness.snapshot(browser.docs.Inventory, ctx)).rows).map((row) => row.state), ["lost"], "custody still tracks it");
  const report = await browser.reconcile(harness, () => true, ctx);
  assert.deepEqual(report.released, [record.tag]);
  assert.equal(backend.liveCount(), 0);
  assert.deepEqual((await harness.snapshot(browser.docs.Inventory, ctx)).rows, {}, "dropped once nothing under its tag runs");
  const [billed] = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  assert.ok(billed.spent.final === true && billed.spent.seconds >= 60, `its bill is closed when the release is confirmed: ${JSON.stringify(billed.spent)}`);
});

test("an abort while a failed create's delayed lookup waits keeps the lookup: a session landing late is still released", async (t) => {
  const { backend, browser, harness, root, ctx, settled, releaseTasks } = await inProcess(t, { createDeadlineMs: 800 });
  backend.fail("create", 1);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  const [record] = (await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions;
  assert.deepEqual([record.state, record.releaseReason], ["releasing", "create_failed"]);
  await root.abort(ctx, { background: true });
  await backend.provider.create({ tag: record.tag, metadata: {}, viewport: { width: 1, height: 1 } }, new AbortController().signal);
  assert.equal(backend.liveCount(), 1, "the late session is live");
  await settled();
  assert.equal(backend.liveCount(), 0, "the successor's delayed lookup released it");
  assert.deepEqual((await releaseTasks()).map((task) => task.state.outcome?.status).sort(), ["aborted", "completed"]);
});

test("the real run tool cut mid-dispatch: interrupted, the identical code refused once with effect_unknown, then let through", async (t) => {
  const submit = ["run", { code: "await page.click('#submit')" }];
  const { tally, seen } = await scenario(t, { script: [submit, submit, submit, "browser_release"], hold: "driver.run", env: { REAL_TOOLS: "1" }, env2: { REAL_TOOLS: "1" } });
  assert.equal(seen[0].isError, true, "pi reports the cut run interrupted and never reruns it");
  const refused = failure(seen[1]);
  assert.equal(refused.code, "effect_unknown");
  assert.match(refused.message, /Your run call call-0 .*was interrupted and may have taken effect/);
  assert.equal(seen[2].isError, false, "the identical code runs when asked again");
  assert.deepEqual([tally.dispatches, tally.creates, tally.liveAtEnd], [2, 1, 0]);
});

test("a call after a cut run tells the interruption even when it fails: a walled read carries the notice", async (t) => {
  const submit = ["run", { code: "await page.click('#submit')" }];
  const { seen } = await scenario(t, { script: [submit, "browser_read", "browser_release"], hold: "driver.run", env: { REAL_TOOLS: "1" }, env2: { REAL_TOOLS: "1", WALL: "1" } });
  const walled = failure(seen[1]);
  assert.equal(walled.code, "not_content");
  assert.match(walled.notice, /Your run call call-0 .*was interrupted and may have taken effect/);
});

test("a policy that asks for the effect observer and cannot attach says so once per attach; the second process reattaches the same session", async (t) => {
  const asked = { OBSERVE: "allow" };
  // The second process continues the first's conversation, so its script is the whole list: two reads done, then two more.
  const { tally, first, result, seen } = await scenario(t, { script: ["browser_read", "browser_read"], script2: ["browser_read", "browser_read", "browser_read", "browser_release"], env: asked, env2: asked });
  for (const [who, rows] of [["first", first.observer], ["second", result.observer]]) {
    assert.equal(rows.length, 1, `${who} process: one row for its one attach, not one per call: ${JSON.stringify(rows)}`);
    assert.deepEqual([rows[0].label, rows[0].policy], ["node-a", "allow"]);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["code", "conversationId", "label", "policy", "session_id", "tag"], "a code says why; there is no free text");
    assert.equal(rows[0].code, "attach_refused", "the fake's CDP port is closed: the socket never opened");
    assert.ok(!/(?:https?|wss?):\/\//.test(JSON.stringify(rows[0])), "no URL in the row");
  }
  const reads = seen.filter((r) => r.tool === "browser_read").map((r) => JSON.parse(r.text).session);
  assert.equal(reads.length, 3, "two reads before the cut of the process, one after");
  assert.deepEqual([...new Set(reads)], [first.observer[0].session_id], "one session throughout");
  assert.equal(result.observer[0].session_id, first.observer[0].session_id, "the second process reattached the first's session");
  assert.deepEqual([tally.creates, tally.attaches], [1, 2], "reattached, not replaced: one create, one attach per process");

  // A conversation with no action policy asked for no observer, so nothing is missing and nothing is said.
  const none = await scenario(t, { script: ["browser_read"], script2: ["browser_read", "browser_read", "browser_release"] });
  assert.deepEqual([none.first.observer.length, none.result.observer.length], [0, 0]);
});

test("an attach error whose message holds a connect URL with its token yields a row with neither: a code, no text", async (t) => {
  const asked = { OBSERVE: "allow", THROWING_DIAL: "1" };
  const { first, result } = await scenario(t, { script: ["browser_read"], script2: ["browser_read", "browser_read"], env: asked, env2: asked });
  for (const rows of [first.observer, result.observer]) {
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, "attach_failed", "an error the observer did not tag is attach_failed");
    assert.deepEqual(Object.keys(rows[0]).sort(), ["code", "conversationId", "label", "policy", "session_id", "tag"]);
    const said = JSON.stringify(rows[0]);
    for (const leak of ["wss://", "connect.example.test", "signingKey", "SECRETTOKEN", "connect failed"]) assert.ok(!said.includes(leak), `${leak} is not in the row`);
  }
  // Nor anywhere the model or the host reads: the call itself was served.
  assert.ok(!JSON.stringify(result.results).includes("SECRETTOKEN") && !JSON.stringify(result.rows).includes("SECRETTOKEN"));
});

// Kernel rows: the real kernel provider in both processes, against a fake Kernel API whose browsers are the backend's
// sessions. The API's own record says what reached Kernel; the ledger says what ran.
test("kernel: SIGKILL after launch, reconcile finds the session by its tag, and the release deletes it", async (t) => {
  for (const cut of [{ cutAt: "after-create" }, { hold: "create" }]) {
    const label = JSON.stringify(cut);
    const { tally, result, seen, api } = await scenario(t, { kernel: true, script: ["browser_read", "browser_release"], ...cut });
    const [session] = result.sessions.sessions;
    assert.equal(result.reconcile.kept.length, 1, `reconcile bound the launched session ${label}`);
    assert.deepEqual([tally.creates, tally.peakLive, tally.liveAtEnd], [1, 1, 0], label);
    assert.equal(seen[0].isError, false, label);
    assert.equal(failure(seen[0]).session, session.resourceId, "the rerun read on the session found by its tag");
    assert.equal(api.only("POST /browsers").length, 1, `one create reached Kernel ${label}`);
    assert.ok(api.only("GET /browsers").some((c) => c.query.status === "active" && c.query["tags[agentrun_tag]"] === session.tag), "reconcile asked Kernel by the tag");
    assert.deepEqual(api.only("DELETE /browsers/{id}").map((c) => c.path), [`/browsers/${session.resourceId}`], "the release deleted exactly that session");
    assert.deepEqual([session.state, api.alive().length], ["released", 0], label);
  }
});

test("kernel: a release cut before or after Kernel deleted resumes and deletes exactly once", async (t) => {
  for (const cut of [{ cutAt: "release-sent" }, { hold: "release" }]) {
    const label = JSON.stringify(cut);
    const { tally, result, api } = await scenario(t, { kernel: true, script: ["browser_read", "browser_release"], ...cut });
    assert.deepEqual([tally.creates, tally.releases, tally.liveAtEnd], [1, 1, 0], label);
    assert.equal(result.sessions.sessions[0].state, "released", label);
    assert.ok(api.only("DELETE /browsers/{id}").length >= 1, label);
    assert.equal(api.alive().length, 0, label);
  }
});

test("kernel: a session Kernel ended while the host was down (its idle timeout) is lost, and the rerun opens a fresh one", async (t) => {
  const { tally, result, seen, api } = await scenario(t, { kernel: true, script: ["browser_read", "browser_read", "browser_release"], hold: "driver.page", between: (b) => b.endAll() });
  assert.equal(result.reconcile.lost.length, 1);
  assert.equal(failure(seen[0]).code, "session_replaced");
  assert.equal(seen[1].isError, false, "the next call opens a fresh session");
  assert.deepEqual([tally.creates, tally.liveAtEnd], [2, 0]);
  assert.equal(api.only("POST /browsers").length, 2);
  assert.equal(api.alive().length, 0);
});
