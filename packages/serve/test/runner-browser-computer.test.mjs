// An agent whose computer is a browser, run on the runner end to end: the claim gives the run's browser tool (tools.ts,
// pi-browser's durable extension on pi's native route) the computer's provider (computer-for-claim.ts, no launch of the
// server's own), the tool opens its session through it at its first call and releases it when it lets go, and drives it
// with the raw-CDP driver over the CDP URL the provider's connect hands over. Browserbase, Kernel and the local Chrome
// take this one path. The provider here is a stand-in in the computer module's shape whose connect hands over a
// signed-looking URL of pi-browser's fake page (fixtures/fake-ax-page); the model is a scripted origin. A CLI harness
// (claude-agent here, on run-adapters' faux harness) is handed the same browser's tools as host tools, on the same claim.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, connect } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { fakeAxPage } from "../../pi-browser/test/fixtures/fake-ax-page.mjs";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { blockersOf } = await import("../dist/runnable.js");

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
/** Test keys, no real ones, saved sealed as Settings → Computers saves them. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const BROWSER_COMPUTER = { kind: "browser", provider: "browserbase" };
const PI_LAUNCH = { input: { content: "Browse." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
/** The query a vendor signs its CDP URL with: a secret that must reach no request to the model. */
const SIGNED = "signingKey=SECRET-signed-url-token";
after(closeOpenSessions);

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A browser provider in the computer module's shape: each connect hands over `url` as its CDP target (as Browserbase's,
 *  Kernel's and the local Chrome's do) and dials nothing itself. */
function browserProvider(url, record) {
  return {
    id: "browserbase",
    version: "0",
    capabilities: () => ({ lifetime: "vendor", maxLifetimeMs: 3_600_000, network: ["open"], groups: ["cdp"] }),
    check: () => [],
    list: async () => ({ ok: true, value: [] }),
    async create(spec) {
      record.created.push(spec.labels);
      return { ok: true, value: { id: "bb-1", name: "bb-1" } };
    },
    async connect(ref) {
      record.connects += 1;
      // A session it released reads as gone, as a vendor's does.
      if (record.released.some(([id]) => id === ref.id)) return { ok: false, error: { code: "gone", message: `the session ${ref.id} has ended` } };
      return { ok: true, value: { client: { close() {} }, hello: { version: "0", kind: "browser", groups: ["cdp"] }, cdp: { url }, close: async () => {} } };
    },
    // A session it made runs until it is released, as a vendor's reads.
    async attach(ref) {
      if (record.released.some(([id]) => id === ref.id)) return { ok: false, error: { code: "gone", message: `the session ${ref.id} has ended` } };
      return { ok: true, value: { id: ref.id, name: ref.id, spec: { image: "chromium", user: "unknown", network: "open", kind: "browser" } } };
    },
    async release(ref, how) {
      record.released.push([ref.id, how]);
      return { ok: true, value: undefined };
    },
  };
}

/** The claim's computer as the runner composes it, on the stand-in provider: the module's registry, no deps.launch. */
const computerDepsOver = (url, record) => ({
  kinds: KINDS,
  providers: { browserbase: () => browserProvider(url, record) },
  spec: () => ({ image: "browser", lifetimeMs: 600_000, network: "open" }),
  check: { readBackOf },
});

/** A store on a new data directory with Browserbase's keys saved, an agent of `body`, and run-1 launched with `launch`. */
async function storeWith(t, body, launch) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-browser-computer-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries(BROWSERBASE)) await putSealedKey(server, SEAL_KEY, name, value);
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Browse.", ...body } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  return { dir, server, store };
}

test("pi: an agent whose computer is a Browserbase browser runs: its snapshot and its click reach the browser the claim started, over the URL the provider's connect handed over", { timeout: 120_000 }, async (t) => {
  const page = await fakeAxPage();
  t.after(() => page.close());
  const record = { created: [], released: [], connects: 0 };
  const opened = await storeWith(t, { tools: ["read"], computer: BROWSER_COMPUTER }, PI_LAUNCH);
  const requests = [];
  const script = [{ call: "snapshot" }, { call: "run", args: { actions: [{ op: "click", id: "0-11" }] } }, { call: "run", args: { actions: [{ op: "fill", id: "0-10", value: "Bern" }, { op: "click", id: "0-11" }] } }, { say: "done" }];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests) };
  const deps = { env: {}, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps: computerDepsOver(`${page.url}?${SIGNED}`, record) };
  const runner = startRunner({
    store: opened.store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  let last;
  const row = await until(async () => {
    const now = (last = await opened.server.runs.get(RUN));
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run is released").catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify({ row: last, requests: requests.length, created: record.created, released: record.released, cdp: page.calls.map((call) => call.method) })}`);
  });

  assert.equal(row.state, "ended", JSON.stringify(row));
  assert.equal(record.created.length, 1, "the browser tool opened one session through the claim's provider");
  assert.equal(record.created[0]["agentrun.run"], RUN, "under the run's labels");
  assert.match(record.created[0]["agentrun.session"] ?? "", /\S/, "and the tool's tag");
  const offered = (requests[0]?.tools ?? []).map((tool) => tool.name);
  for (const name of ["snapshot", "run"]) assert.equal(offered.filter((one) => one === name).length, 1, `${name} is offered once, with no grant of the browser: ${JSON.stringify(offered)}`);
  const methods = page.calls.map((call) => call.method);
  assert.ok(methods.includes("Accessibility.getFullAXTree"), `the snapshot read the page's tree: ${JSON.stringify(methods)}`);
  const mouse = page.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type);
  assert.deepEqual(mouse, Array(3).fill(["mouseMoved", "mousePressed", "mouseReleased"]).flat(), "the click, the fill's click into its field and the batch's click reached the page");
  const told = JSON.stringify(requests.at(-1)?.messages ?? []);
  assert.match(told, /\[0-11\] button \\"Add\\"/, "the model read the snapshot's ids");
  assert.match(told, /\[ok\] click \[0-11\] button \\"Add\\"/, "and the click's line");
  assert.match(told, /\[ok\] fill \[0-10\] textbox \\"City\\" = \\"Bern\\" -> page changed\\n\[ok\] click \[0-11\] button \\"Add\\"/, "and a batch's every line, through the driving guard");
  assert.ok(!JSON.stringify(requests).includes("SECRET-signed-url-token"), "the signed URL reaches no request to the model");
  await until(() => record.released.length > 0, "the session is released");
  assert.deepEqual(record.released, [["bb-1", "delete"]], "the session was released once, when the tool let it go at the run's end");
});

/** A claude-agent claim of an agent whose computer is the browser `computerDepsOver` gives over `cdpUrl`, its tools `tools`,
 *  on run-adapters' faux harness (fauxTable) whose model is a faux gateway: `start(name)` starts a runner on it through the
 *  runner's dispatch, `rested()` waits for the run's row to rest and reads its timeline and the tool lists its harness was
 *  handed. */
async function claudeAgentClaim(t, cdpUrl, record, tools) {
  const gw = await startFauxGateway();
  t.after(() => gw.close());
  const opened = await storeWith(t, { harness: "claude-agent", instructions: "Snapshot the browser and click its Add button.", tools, computer: BROWSER_COMPUTER }, { ...PI_LAUNCH, harness: "claude-agent", model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } });
  const handed = join(opened.dir, "handed.jsonl");
  const env = { ANTHROPIC_API_KEY: "not-a-secret", ANTHROPIC_BASE_URL: gw.url, AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1", AGENTRUN_TEST_FAUX_HARNESS_OPENED: handed };
  const prior = process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED;
  process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED = handed;
  t.after(() => (prior === undefined ? delete process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED : (process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED = prior)));
  const deps = { env, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim, computerDeps: computerDepsOver(cdpUrl, record) };
  const start = (name) => {
    const runner = startRunner({
      store: opened.store, name, ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
      createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (harness, given) => (harness === "claude-agent" ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
    });
    t.after(() => runner.close().catch(() => {}));
    return runner;
  };
  const rested = async (page) => {
    let last;
    const row = await until(async () => {
      const now = (last = await opened.server.runs.get(RUN));
      return ["ended", "failed", "stopped", "parked"].includes(now.state) && now.runner === null && now;
    }, "the run is released").catch((error) => {
      throw new Error(`${error.message}: ${JSON.stringify({ row: last, created: record.created, released: record.released, cdp: page.calls.map((call) => call.method) })}`);
    });
    const timeline = await runTimeline(opened.server, RUN, ctx);
    const lists = existsSync(handed) ? readFileSync(handed, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.tools).map((line) => line.tools) : [];
    return { row, timeline, lists };
  };
  return { opened, start, rested };
}

/** A claude-agent run of `claudeAgentClaim` on one runner, to its rest. */
async function claudeAgentRun(t, page, record, tools) {
  const claim = await claudeAgentClaim(t, `${page.url}?${SIGNED}`, record, tools);
  claim.start("runner-a");
  return claim.rested(page);
}

/** A TCP relay in front of the fake page: `hold()` stops every connection open now from hearing the page again (its
 *  replies kept, never sent), as a runner's process that died mid-call hears nothing more; a connection opened after
 *  is relayed as usual. */
async function holdingRelay(target) {
  const port = Number(new URL(target).port);
  const open = new Set();
  const server = createServer((client) => {
    const up = connect(port, "127.0.0.1");
    const pair = { held: false, client, up };
    open.add(pair);
    client.on("data", (bytes) => up.write(bytes));
    up.on("data", (bytes) => { if (!pair.held) client.write(bytes); });
    const end = () => { open.delete(pair); client.destroy(); up.destroy(); };
    for (const socket of [client, up]) { socket.on("close", end); socket.on("error", () => {}); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: target.replace(`:${port}/`, `:${server.address().port}/`),
    hold() { for (const pair of open) pair.held = true; },
    async close() { for (const pair of open) { pair.client.destroy(); pair.up.destroy(); } await new Promise((resolve) => server.close(resolve)); },
  };
}

for (const [how, tools] of [["granted the browser", ["read", "browser"]], ["with no grant of the browser", ["read"]]]) {
  test(`claude-agent: an agent whose computer is a Browserbase browser, ${how}, runs: the harness is handed the browser's tools, and its snapshot and click reach the browser the claim started`, { timeout: 120_000 }, async (t) => {
    const page = await fakeAxPage();
    t.after(() => page.close());
    const record = { created: [], released: [], connects: 0 };
    const { row, timeline, lists } = await claudeAgentRun(t, page, record, tools);

    assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
    for (const name of ["snapshot", "run"]) assert.ok(lists.length > 0 && lists.every((list) => list.filter((one) => one === name).length === 1), `the harness is handed ${name} once: ${JSON.stringify(lists)}`);
    assert.equal(record.created.length, 1, "the browser tool opened one session through the claim's provider");
    assert.equal(record.created[0]["agentrun.run"], RUN, "under the run's labels");
    const methods = page.calls.map((call) => call.method);
    assert.ok(methods.includes("Accessibility.getFullAXTree"), `the snapshot read the page's tree: ${JSON.stringify(methods)}`);
    const mouse = page.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type);
    assert.deepEqual(mouse, ["mouseMoved", "mousePressed", "mouseReleased"], "the click reached the page");
    const results = timeline.filter((one) => one.kind === "tool_result");
    const answered = (name) => results.find((one) => one.tool_use_id === timeline.find((use) => use.kind === "tool_use" && use.tool_name === name)?.tool_use_id);
    assert.match(String(answered("snapshot")?.tool_result_preview ?? ""), /\[0-11\] button "Add"/, `the snapshot's answer names the page's ids: ${JSON.stringify(results)}`);
    assert.notEqual(answered("snapshot")?.tool_status, "failed");
    assert.match(String(answered("run")?.tool_result_preview ?? ""), /\[ok\] click \[0-11\] button "Add"/, `the click's answer: ${JSON.stringify(results)}`);
    assert.ok(!JSON.stringify(timeline).includes("SECRET-signed-url-token"), "the signed URL reaches no row of the run's");
    await until(() => record.released.length > 0, "the session is released");
    assert.deepEqual(record.released, [["bb-1", "delete"]], "the session was released once, when the tool let it go at the run's end");
  });
}

test("claude-agent: an agent granted the browser, whose computer is a browser, is runnable: nothing refuses the grant as pi's only", async () => {
  const blockers = await blockersOf({ ANTHROPIC_API_KEY: "not-a-secret" }, { kind: "agentic", instructions: "Browse.", harness: "claude-agent", tools: ["browser"], computer: BROWSER_COMPUTER, model: "anthropic/claude-sonnet-5-5" }, {}, { computerReady: async () => ({ ok: true }) });
  assert.deepEqual(blockers.filter((one) => one.tool === "browser"), [], JSON.stringify(blockers));
});

// A browser call is a host tool its binding runs once (host-tools.ts RUNS_ONCE): pi's tool task would keep a durable memo
// and could run the call again on resume, but a CLI harness's call runs in no task, and its memo is the call's own. So a
// claude-agent run that resumes on another runner with a browser call in flight has that call ended interrupted ("may or
// may not have taken effect") when the record opens again, never sends it to the browser again, and the model goes on
// from that answer. The session the cut call drove is
// not lost: the next claim's reconcile takes it back (connected again, never created again), and it is released once,
// when the run ends.
test("claude-agent: a run whose runner stops while a browser call is in flight resumes on the next runner: the cut call is answered interrupted and never sent to the browser again, the session is taken back, not made again, and released once at the run's end", { timeout: 120_000 }, async (t) => {
  const page = await fakeAxPage();
  t.after(() => page.close());
  const relay = await holdingRelay(page.url);
  t.after(() => relay.close());
  const record = { created: [], released: [], connects: 0 };
  // The click's press reaches the page, and from then on the first runner hears nothing from it: its call is in flight.
  let cut = false;
  const push = page.calls.push.bind(page.calls);
  page.calls.push = (call) => {
    if (!cut && call.method === "Input.dispatchMouseEvent" && call.params.type === "mousePressed") {
      cut = true;
      relay.hold();
    }
    return push(call);
  };
  const claim = await claudeAgentClaim(t, `${relay.url}?${SIGNED}`, record, ["read", "browser"]);
  const first = claim.start("runner-a");
  await until(() => cut, "the click is in flight on the first runner");
  await first.close();
  assert.deepEqual(record.released, [], "the first runner's stop releases no session: the run resumes on it");
  claim.start("runner-b");
  const { row, timeline, lists } = await claim.rested(page);

  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.equal(lists.length, 2, `each claim's harness is handed the browser's tools: ${JSON.stringify(lists)}`);
  for (const list of lists) assert.ok(list.includes("snapshot") && list.includes("run"), JSON.stringify(list));
  const uses = timeline.filter((one) => one.kind === "tool_use").map((one) => one.tool_name);
  assert.deepEqual(uses, ["snapshot", "run"], "the cut call is issued once, never again on the next claim");
  const results = timeline.filter((one) => one.kind === "tool_result");
  const answered = (name) => results.find((one) => one.tool_use_id === timeline.find((use) => use.kind === "tool_use" && use.tool_name === name)?.tool_use_id);
  assert.equal(answered("snapshot")?.tool_status, "success");
  assert.equal(answered("run")?.tool_status, "failed");
  assert.match(String(answered("run")?.tool_result_preview ?? ""), /^interrupted: .*may or may not have taken effect/, `the cut call's answer: ${JSON.stringify(results)}`);
  const mouse = page.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type);
  assert.deepEqual(mouse, ["mouseMoved", "mousePressed"], "the cut click is never sent to the browser again");
  assert.equal(record.created.length, 1, "the next claim takes the session back: none is made again");
  assert.ok(record.connects >= 2, `the next claim connects to it again: ${record.connects}`);
  await until(() => record.released.length > 0, "the session is released");
  assert.deepEqual(record.released, [["bb-1", "delete"]], "released once, at the run's end");
});

test("claude-agent: the browser is the one table tool past the host tools a CLI harness binds: subagent, pdf_pages and llm are still refused on it", async () => {
  const { adapterBinds } = await import("../dist/tool-list.js");
  assert.equal(adapterBinds("browser"), true);
  for (const tool of ["subagent", "pdf_pages", "llm"]) {
    assert.equal(adapterBinds(tool), false, `${tool} is no tool a CLI harness binds`);
    const blockers = await blockersOf({ ANTHROPIC_API_KEY: "not-a-secret" }, { kind: "agentic", instructions: "Work.", harness: "claude-agent", tools: [tool], model: "anthropic/claude-sonnet-5-5" }, {}, {});
    assert.ok(blockers.some((one) => one.field === "definition.tools[0]"), `${tool} is refused on claude-agent: ${JSON.stringify(blockers)}`);
  }
  // subagent is an agent's to name: on claude-agent it is refused as pi's. pdf_pages and llm run in a workflow's nodes,
  // which on claude-agent are refused whole.
  const subagent = await blockersOf({ ANTHROPIC_API_KEY: "not-a-secret" }, { kind: "agentic", instructions: "Work.", harness: "claude-agent", tools: ["subagent"], model: "anthropic/claude-sonnet-5-5" }, {}, {});
  assert.ok(subagent.some((one) => one.tool === "subagent" && one.message === "subagent runs on pi here; on claude-agent it is not bound yet."), JSON.stringify(subagent));
});
