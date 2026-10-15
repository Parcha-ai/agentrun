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

async function scenario(t, { script, script2 = script, cutAt, hold, between, inactive, env = {}, env2 = {}, zombie = false, kernel = false, start = START }) {

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "custody-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const backend = new FakeBackend({ start, pages: { [start]: fixturePage(start, "The start page.") } });
  const server = await backend.serve();
  t.after(() => server.close());
  const base = { DB: path.join(dir, "run.sqlite"), FAKE: server.url };
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

async function inProcess(t, extra = {}, policy = {}, script = ["browser_read", "browser_release"]) {
  const [{ BACKGROUND_CONTEXT: ctx }, { createModels }, faux, durable, { createBrowserExtension }, { fakeDriver }] = await Promise.all([
    import("@earendil-works/chord/context"), import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/providers/faux"),
    import("@earendil-works/pi-durable"), import("@parcha/pi-browser/durable"), import("@parcha/pi-browser/testing"),
  ]);
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const browser = createBrowserExtension({
    provider: () => backend.provider, driver: fakeDriver(backend), evidence: { file: async () => null }, ...(typeof extra === "function" ? extra(backend, fakeDriver) : extra),
    tools: { browser_read: async (_args, port) => { const s = await port.session(); await s.driver.page(); return { content: [{ type: "text", text: "read" }] }; } },
  });
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 10 }, () => (context) => {
    const done = context.messages.filter((m) => m.role === "toolResult").length;
    const [tool, args = {}] = [script[done]].flat();
    return tool ? faux.fauxAssistantMessage([faux.fauxToolCall(tool, args)], { stopReason: "toolUse" }) : faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
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

test("a host that releases, waits for idle, drains and closes: the provider sees the release and no lease is left open", async (t) => {
  const { backend, browser, harness, root, ctx } = await inProcess(t, {}, {}, ["browser_read"]);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  backend.delay("release", 1_000);
  await browser.release(root, "close", ctx);
  await harness.waitForIdle(ctx);
  assert.equal(backend.tally().releases, 0, "waitForIdle returns before the release reaches the provider");
  await browser.drain(harness, ctx);
  assert.deepEqual([backend.tally().releases, backend.liveCount()], [1, 0]);
  assert.deepEqual((await harness.snapshot(browser.docs.Inventory, ctx)).rows, {});
  await harness.close(ctx);
});

test("an idle release in flight at shutdown: the drain waits for it before the host closes", async (t) => {
  const { backend, browser, harness, root, ctx, releaseTasks } = await inProcess(t, {}, { idleReleaseS: 0.05 }, ["browser_read"]);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  backend.delay("release", 1_000);
  for (let i = 0; i < 200 && (await releaseTasks()).length === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
  await harness.waitForIdle(ctx);
  assert.equal(backend.tally().releases, 0, "waitForIdle returns before the release reaches the provider");
  await browser.drain(harness, ctx);
  assert.deepEqual([backend.tally().releases, backend.liveCount()], [1, 0]);
  assert.equal((await harness.snapshot(browser.docs.Sessions, root.id, ctx)).sessions[0].releaseReason, "idle");
  await harness.close(ctx);
});

test("a drain bounded by the host's signal gives up when it aborts, and leaves the release to the next run", async (t) => {
  const { backend, browser, harness, root, ctx } = await inProcess(t, {}, {}, ["browser_read"]);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  backend.delay("release", 10_000);
  await browser.release(root, "close", ctx);
  const started = Date.now();
  const outcome = await browser.drain(harness, ctx, AbortSignal.timeout(100)).then(() => "drained", (error) => error.name);
  assert.equal(outcome, "TimeoutError");
  assert.ok(Date.now() - started < 5_000, "it stopped at the host's bound, not the release's");
  assert.equal(Object.values((await harness.snapshot(browser.docs.Inventory, ctx)).rows)[0]?.state, "releasing");
});

test("a host signal that fires while the drain is still inspecting rejects at once and leaves no rejection unhandled", async (t) => {
  const { browser, harness, ctx } = await inProcess(t, {}, {}, ["browser_read"]);
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  t.after(() => process.off("unhandledRejection", record));
  let inspected;
  const gate = new Promise((resolve) => { inspected = resolve; });
  const slow = { inspect: async (context) => { await gate; return harness.inspect(context); }, waitForTask: (id, context) => harness.waitForTask(id, context) };
  const controller = new AbortController();
  const outcome = browser.drain(slow, ctx, controller.signal).then(() => "drained", (error) => error.name);
  controller.abort(new DOMException("the host's shutdown bound", "TimeoutError"));
  const early = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still inspecting"), 1_000))]);
  inspected();
  await outcome;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(early, "TimeoutError", "the drain answers the host's signal while the harness is still being inspected");
  assert.deepEqual(unhandled.map(String), [], "no rejection went unhandled");
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

test("the real run tool cut mid-dispatch: interrupted, the identical code refused with effect_unknown until the model looks at the page", async (t) => {
  const submit = ["run", { code: "await page.click('#submit')" }];
  const { tally, seen } = await scenario(t, { script: [submit, submit, submit, "screenshot", submit, "snapshot", submit, "browser_release"], hold: "driver.run", env: { REAL_TOOLS: "1" }, env2: { REAL_TOOLS: "1" } });
  assert.equal(seen[0].isError, true, "pi reports the cut run interrupted and never reruns it");
  const refused = failure(seen[1]);
  assert.equal(refused.code, "effect_unknown");
  assert.match(refused.message, /Your run call call-0 .*was interrupted and may have taken effect/);
  assert.equal(failure(seen[2])?.code, "effect_unknown", "asked again without looking, it is refused again");
  assert.equal(seen[3].isError, false, "the screenshot runs");
  assert.equal(failure(seen[4])?.code, "effect_unknown", "a screenshot is not the look that clears a refusal: snapshot or browser_read is");
  assert.equal(seen[6].isError, false, "after a snapshot, the identical code runs");
  assert.deepEqual([tally.dispatches, tally.creates, tally.liveAtEnd], [2, 1, 0]);
});

test("a run applied and answered, killed before pi committed its answer: the identical run is refused until the model looks after the refusal", async (t) => {
  const submit = ["run", { code: "await page.click('#submit')" }];
  for (const cutAt of ["session-updated", "run-answered"]) {
    const { tally, seen } = await scenario(t, { script: [submit, "snapshot", submit, "browser_read", submit, "browser_release"], cutAt, env: { REAL_TOOLS: "1" }, env2: { REAL_TOOLS: "1" } });
    assert.equal(seen[0].isError, true, `${cutAt}: pi answers the cut run interrupted`);
    assert.equal(seen[1].isError, false, `${cutAt}: the snapshot runs`);
    assert.match(seen[1].text, /Your run call call-0/, `${cutAt}: the snapshot tells the cut`);
    const facts = { callId: "call-0", urlAtDispatch: null, urlNow: START, observed: false, sent: null };
    assert.deepEqual(seen[1].details?.pendingEffect, facts, `${cutAt}: the notice's facts are data, and sent is null with no observer`);
    const refused = failure(seen[2]);
    assert.equal(refused?.code, "effect_unknown", `${cutAt}: a look before the refusal does not clear it`);
    assert.deepEqual(seen[2].details?.pendingEffect, facts, `${cutAt}: the refusal carries the same facts`);
    assert.equal(seen[3].details?.pendingEffect, undefined, `${cutAt}: a told cut is not told again`);
    assert.equal(seen[3].isError, false, `${cutAt}: the read runs`);
    assert.equal(seen[4].isError, false, `${cutAt}: after a read, the identical run runs`);
    assert.equal(tally.dispatches, 2, `${cutAt}: the run reached the page once before the cut and once after the look`);
  }
});

test("a cut run's facts list, as data, the requests its observer saw leave the browser", async (t) => {
  const submit = ["run", { code: "await page.click('#submit')" }];
  const env = { REAL_TOOLS: "1", STUB_OBSERVER: "1", ACTIONS: "allow" };
  const { seen } = await scenario(t, { script: [submit, submit, "browser_release"], hold: "driver.run", env, env2: env });
  assert.equal(failure(seen[1])?.code, "effect_unknown");
  const facts = seen[1].details?.pendingEffect;
  assert.equal(facts?.observed, true);
  assert.deepEqual(facts?.sent, [{ method: "POST", url: "https://example.test/submit", held: null }], "sent is an array when an observer ran");
});

test("a run whose answer pi committed before the process died is no cut: the identical run runs after the restart", async (t) => {
  const submit = ["run", { code: "await page.click('#submit')" }];
  const { tally, seen } = await scenario(t, { script: [submit, "browser_read", submit, "browser_release"], hold: "driver.page", env: { REAL_TOOLS: "1" }, env2: { REAL_TOOLS: "1" } });
  assert.equal(seen[0].isError, false, "the first run's answer was committed");
  assert.ok(!/was interrupted/.test(seen[1].text), "the read after the restart tells no cut");
  assert.equal(seen[2].isError, false, "the identical run runs");
  assert.equal(tally.dispatches, 2);
});

test("a run in flight is no cut: a snapshot beside it in a parallel round tells nothing, and the same run asked after its answer runs", async (t) => {
  const [{ BACKGROUND_CONTEXT: ctx }, { createModels }, faux, durable, { createBrowserExtension }, { fakeDriver }] = await Promise.all([
    import("@earendil-works/chord/context"), import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/providers/faux"),
    import("@earendil-works/pi-durable"), import("@parcha/pi-browser/durable"), import("@parcha/pi-browser/testing"),
  ]);
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  // The run reaches the page only once the snapshot beside it has run, so the snapshot sees the run's journal entry.
  let looked;
  const snapshotted = new Promise((resolve) => { looked = resolve; });
  const driver = async (target, signal, options) => {
    const real = await fakeDriver(backend)(target, signal, options);
    return { ...real, snapshot: async (input) => { const out = await real.snapshot(input); looked(); return out; }, run: async (input) => { await Promise.race([snapshotted, new Promise((resolve) => setTimeout(resolve, 5_000))]); return real.run(input); } };
  };
  const browser = createBrowserExtension({ provider: () => backend.provider, driver, evidence: { file: async () => null } });
  const submit = { code: "await page.click('#submit')" };
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses([
    faux.fauxAssistantMessage([faux.fauxToolCall("run", submit, { id: "call-a" }), faux.fauxToolCall("snapshot", {}, { id: "call-b" })], { stopReason: "toolUse" }),
    faux.fauxAssistantMessage([faux.fauxToolCall("run", submit, { id: "call-c" })], { stopReason: "toolUse" }),
    faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" }),
  ]);
  const models = createModels();
  models.setProvider(model.provider);
  const registry = durable.createRegistry();
  // A host that wraps the tools may run them in parallel; then run shares its round with the snapshot.
  registry.install({ ...browser.extension, tools: browser.extension.tools.map((tool) => (tool.name === "run" || tool.name === "snapshot" ? { ...tool, executionMode: "parallel" } : tool)) });
  const harness = await durable.Harness.open(new durable.MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  const config = { label: "node-a", run: "run-parallel", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
  await browser.reconcile(harness, () => true, ctx);
  await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  const results = Object.fromEntries([...(await root.entries({}, 50, undefined, ctx)).items].filter((entry) => durable.ToolResultEntry.is(entry)).map((entry) => [entry.model[0].toolCallId, entry.model[0]]));
  const said = (id) => results[id].content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
  assert.ok(!/was interrupted/.test(said("call-b")), `the snapshot told a cut that is only in flight: ${said("call-b")}`);
  assert.equal(results["call-a"].isError, false);
  assert.equal(results["call-c"].isError, false, `the same run asked again after its answer was refused: ${said("call-c")}`);
  assert.equal(backend.tally().dispatches, 2);
  await browser.release(root, "close", ctx);
});

test("a resumed run looks for a journaled action's answer only in its conversation, from where it was journaled on", async (t) => {
  const [{ BACKGROUND_CONTEXT: ctx }, { createModels }, faux, durable, { createBrowserExtension }, { fakeDriver }] = await Promise.all([
    import("@earendil-works/chord/context"), import("@earendil-works/pi-ai/models"), import("@earendil-works/pi-ai/providers/faux"),
    import("@earendil-works/pi-durable"), import("@parcha/pi-browser/durable"), import("@parcha/pi-browser/testing"),
  ]);
  const backend = new FakeBackend({ start: START, pages: { [START]: fixturePage(START, "The start page.") } });
  const storage = new durable.MemoryStorage();
  const scans = [];
  // Each process sees the storage through its own view; a process that ends leaves the storage open, as a file would be.
  const view = (lasts) => new Proxy(storage, { get: (target, prop) => (prop === "scanEntries" ? (query, ...rest) => { scans.push(query); return target.scanEntries(query, ...rest); } : prop === "close" && !lasts ? async () => {} : typeof target[prop] === "function" ? target[prop].bind(target) : target[prop]) });
  const config = { label: "node-a", run: "run-bounded", policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };
  const submit = { code: "await page.click('#submit')" };
  const call = (name, args, id) => faux.fauxAssistantMessage([faux.fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
  const stop = faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" });
  // One process's custody: a new extension, so a new incarnation, over the same storage.
  const open = async (responses, lasts) => {
    const browser = createBrowserExtension({ provider: () => backend.provider, driver: fakeDriver(backend), evidence: { file: async () => null } });
    const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
    model.setResponses(responses);
    const models = createModels();
    models.setProvider(model.provider);
    const registry = durable.createRegistry();
    registry.install(browser.extension);
    const harness = await durable.Harness.open(view(lasts), { models, registry, onReport: () => {} }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), config); } });
    await browser.reconcile(harness, () => true, ctx);
    return { browser, harness, root };
  };
  const first = await open([call("snapshot", {}, "s1"), call("snapshot", {}, "s2"), call("snapshot", {}, "s3"), call("run", submit, "r1"), stop], false);
  await (await first.root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  const journaled = (await first.harness.snapshot(first.browser.docs.Sessions, first.root.id, ctx)).sessions[0].pendingEffect;
  await first.browser.close();
  await first.harness.close(ctx);
  scans.length = 0;
  const second = await open([call("run", submit, "r2"), stop], true);
  t.after(async () => { await second.browser.release(second.root, "close", ctx); await second.browser.close(); await second.harness.close(ctx); });
  await (await second.root.submit({ type: "input", content: "again" }, ctx)).wait(ctx);
  assert.ok(journaled.after > 1, `the journal entry records where the conversation stood: ${journaled.after}`);
  const lookups = scans.filter((query) => query.minEntryId !== undefined && query.maxEntryId === undefined);
  assert.deepEqual(lookups.map((query) => [query.conversationId, query.minEntryId, query.order]), [[first.root.id, journaled.after, "ascending"]], "one bounded scan, from the journal entry on");
  assert.equal(backend.tally().dispatches, 2, "the answered run is no cut: the same run runs again");
});

test("a look that settles a refused cut leaves alone a run journaled beside it in a parallel round", async (t) => {
  const submit = ["run", { code: "await page.click('#submit')" }];
  const other = ["run", { code: "await page.click('#other')" }];
  const env2 = { REAL_TOOLS: "1", PARALLEL: "1", GATE_CODE: other[1].code };
  const { result, seen } = await scenario(t, { script: [submit], script2: [submit, submit, { round: ["snapshot", other] }], hold: "driver.run", env: { REAL_TOOLS: "1" }, env2 });
  assert.equal(failure(seen[1])?.code, "effect_unknown", "the identical run is refused");
  const round = Object.fromEntries(seen.filter((row) => row.callId.startsWith("call-2-")).map((row) => [row.callId, row]));
  assert.deepEqual([round["call-2-0"]?.isError, round["call-2-1"]?.isError], [false, false], "the snapshot and the other run both answer");
  const journal = result.sessions.sessions.map((record) => record.pendingEffect).filter(Boolean).map((entry) => [entry.callId, entry.finished === true]);
  assert.deepEqual(journal, [["call-2-1", true]], "the look settled only the refused cut; the run beside it keeps its finished entry");
});

test("a different run after a cut runs and replaces it", async (t) => {
  const submit = ["run", { code: "await page.click('#submit')" }];
  const other = ["run", { code: "await page.click('#other')" }];
  const { tally, seen } = await scenario(t, { script: [submit, other, submit, "browser_release"], hold: "driver.run", env: { REAL_TOOLS: "1" }, env2: { REAL_TOOLS: "1" } });
  assert.equal(seen[1].isError, false, "a different run is not refused");
  assert.match(seen[1].text, /Your run call call-0 .*was interrupted/, "and it tells the cut");
  assert.equal(seen[2].isError, false, "the cut run's code runs once another run replaced it");
  assert.equal(tally.dispatches, 3);
});

test("the interruption notice names the page the browser is on now without a credential in its fragment, userinfo or query", async (t) => {
  for (const [start, scrubbed] of [["https://example.test/cb#access_token=SEKRET123456", "https://example.test/cb"], ["https://example.test/p?sid=SEKRET123456", "https://example.test/p?sid=[redacted]"]]) {
    const submit = ["run", { code: "await page.click('#submit')" }];
    const { seen } = await scenario(t, { script: [submit, submit, "browser_release"], hold: "driver.run", env: { REAL_TOOLS: "1" }, env2: { REAL_TOOLS: "1" }, start });
    const refused = failure(seen[1]);
    assert.equal(refused.code, "effect_unknown");
    assert.ok(!JSON.stringify(seen).includes("SEKRET123456"), `${start}: a credential reached the model`);
    assert.match(refused.message, new RegExp(`the page is now ${scrubbed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`), "the notice says where the page is, scrubbed");
  }
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
  // The second process continues the first's conversation, so its script is the whole list: two reads done, then two
  // more.
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
  assert.ok(!JSON.stringify(result.results).includes("SECRETTOKEN") && !JSON.stringify(result.rows).includes("SECRETTOKEN"));
});

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
