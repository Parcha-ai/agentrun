// An agent whose computer is a browser, run on the runner end to end: the claim gives the run's browser tool (tools.ts,
// pi-browser's durable extension on pi's native route) the computer's provider (computer-for-claim.ts, no launch of the
// server's own), the tool opens its session through it at its first call and releases it when it lets go, and drives it
// with the raw-CDP driver over the CDP URL the provider's connect hands over. Browserbase, Kernel and the local Chrome
// take this one path. The provider here is a stand-in in the computer module's shape whose connect hands over a
// signed-looking URL of pi-browser's fake page (fixtures/fake-ax-page); the model is a scripted origin. Each CLI harness
// (claude-agent, codex, opencode, goose and cursor, on run-adapters' faux harness) is handed the same browser's tools as
// host tools, on the same claim: a run's snapshot and click, its resume with a browser call in flight, the agent's
// hand-over to the person and the person's own take-over in the live view, each on every one of them. Goose and Cursor
// also run the snapshot and click on their own ACP adapter, with the ACP package's fake agent as their binary.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, connect } from "node:net";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { fakeAxPage } from "../../pi-browser/test/fixtures/fake-ax-page.mjs";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { acpFakeTable, fauxTable } from "./fixtures/faux-table.mjs";
import { connect as wsConnect } from "./fixtures/ws-client.mjs";
import { KINDS } from "./workspace-kinds-fixture.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { secretRedactor } = await import("../dist/runner/redact.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { runEntries, runTimeline } = await import("../dist/store-reads/journal.js");
const { browserHandBack, handBackTarget } = await import("../dist/browser-commands.js");
const { readLiveViewers } = await import("../dist/browser-live.js");
const { KINDS: JOURNAL, HANDOVER_WAITING } = await import("../dist/runner/journal-kinds.js");
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

/** Each adapter harness (a CLI harness: every harness the table has facts for, the test below holds the list to it): its
 *  launch's model and its gateway environment (the faux harness's session proxy), as runner-ask-person-harnesses.test.mjs
 *  runs them. Goose and Cursor are the owner's to install, so they are in the table only where the ACP harnesses' package
 *  is beside serve, as it is here. Cursor's model is its owner's plan: its session has no proxy of ours, and the faux
 *  harness runs it on none. */
const fake = (name) => `not-a-secret-${name}`;
const ANTHROPIC = { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, env: (url) => ({ ANTHROPIC_API_KEY: fake("anthropic"), ANTHROPIC_BASE_URL: url }) };
const GATEWAY = { model: { provider: "openai", modelId: "gpt-6.1-sol" }, env: (url) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL: "gpt-6.1-sol", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "1,2,0.5" }) };
const CLI_HARNESSES = {
  "claude-agent": ANTHROPIC,
  codex: GATEWAY,
  opencode: GATEWAY,
  goose: ANTHROPIC,
  cursor: { model: { provider: "cursor", modelId: "default" }, env: () => ({ CURSOR_API_KEY: fake("cursor") }) },
};
const CLI = Object.keys(CLI_HARNESSES);

/** A claim on CLI harness `harness` of an agent whose computer is the browser `computerDepsOver` gives over `cdpUrl`, its
 *  tools `tools`, on run-adapters' faux harness (fauxTable) whose model is a faux gateway: `start(name, timing)` starts a runner on
 *  it through the runner's dispatch, `rested()` waits for the run's row to rest and reads its timeline and the tool lists
 *  its harness was handed. */
async function cliClaim(t, harness, cdpUrl, record, tools, instructions = "Snapshot the browser and click its Add button.", table = fauxTable(FAUX_HARNESS), runnerOptions = {}) {
  const gw = await startFauxGateway();
  t.after(() => gw.close());
  const { model, env: gatewayEnv } = CLI_HARNESSES[harness];
  const opened = await storeWith(t, { harness, instructions, tools, computer: BROWSER_COMPUTER }, { ...PI_LAUNCH, harness, model });
  const handed = join(opened.dir, "handed.jsonl");
  const env = { ...gatewayEnv(gw.url), AGENTRUN_HARNESS_TABLE: table, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1", AGENTRUN_TEST_FAUX_HARNESS_OPENED: handed };
  const prior = process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED;
  process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED = handed;
  t.after(() => (prior === undefined ? delete process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED : (process.env.AGENTRUN_TEST_FAUX_HARNESS_OPENED = prior)));
  const deps = { env, data: opened.dir, journal: (claim) => opened.store.journal(claim), store: opened.store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim, computerDeps: computerDepsOver(cdpUrl, record) };
  const start = (name, timing = {}) => {
    const runner = startRunner({
      store: opened.store, name, ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000, ...runnerOptions, ...timing,
      createLoop: createDispatchLoop({ launchOf: (runId) => opened.store.runs.launch(runId), resolve: (id, given) => (id === harness ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
    });
    t.after(() => runner.close().catch(() => {}));
    return runner;
  };
  const rested = async (page, ms) => {
    let last;
    const row = await until(async () => {
      const now = (last = await opened.server.runs.get(RUN));
      return ["ended", "failed", "stopped", "parked"].includes(now.state) && now.runner === null && now;
    }, "the run is released", ms).catch((error) => {
      throw new Error(`${error.message}: ${JSON.stringify({ row: last, created: record.created, released: record.released, cdp: page.calls.map((call) => call.method) })}`);
    });
    const timeline = await runTimeline(opened.server, RUN, ctx);
    const lines = existsSync(handed) ? readFileSync(handed, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const lists = lines.filter((line) => line.tools).map((line) => line.tools);
    // Each tool answer as the harness was handed it (faux-table.mjs answersKept).
    const answers = lines.filter((line) => line.answer).map((line) => line.answer);
    return { row, timeline, lists, answers };
  };
  return { opened, start, rested };
}

/** A run of `cliClaim` on one runner, to its rest. */
async function cliRun(t, harness, page, record, tools, table) {
  const claim = await cliClaim(t, harness, `${page.url}?${SIGNED}`, record, tools, undefined, table);
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

/** The answer of the `nth` call (from 0) the run's timeline names `name`, and that call's row. */
const answerOf = (timeline, name, nth = 0) => {
  const use = timeline.filter((one) => one.kind === "tool_use" && one.tool_name === name)[nth];
  return { use, result: use && timeline.find((one) => one.kind === "tool_result" && one.tool_use_id === use.tool_use_id) };
};
/** `check`, ended at once when the run rests before it holds (a refused claim never makes it hold): no wait outlives the run. */
const whileRunning = (server, check) => async () => {
  const value = await check();
  if (value) return value;
  const row = await server.runs.get(RUN);
  if (["ended", "failed", "stopped"].includes(row.state) && row.runner === null) throw new Error(`the run rested ${row.state}: ${row.summary}`);
  return undefined;
};
/** The mouse events the fake page was sent, by type. */
const mouseOf = (page) => page.calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type);
const CLICK = ["mouseMoved", "mousePressed", "mouseReleased"];

test("the adapter harnesses driven here are every one the table has: the browser is bound on each, and a save of an agent granted it, or whose computer is a browser, is refused on none; subagent, pdf_pages and llm are still pi's, refused in words on each", { timeout: 30_000 }, async () => {
  const { harnessTable } = await import("../dist/harness-table.js");
  const { adapterBinds } = await import("../dist/tool-list.js");
  const adapters = Object.entries(harnessTable({})).filter(([, entry]) => entry.facts).map(([id]) => id);
  assert.deepEqual([...adapters].sort(), [...CLI].sort(), "a harness the table has facts for is driven by the tests below");
  assert.equal(adapterBinds("browser"), true);
  const table = { AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  for (const harness of CLI) {
    const { model, env: gatewayEnv } = CLI_HARNESSES[harness];
    const env = { ...gatewayEnv("http://127.0.0.1:9"), ...table };
    const named = `${model.provider}/${model.modelId}`;
    const blockers = await blockersOf(env, { kind: "agentic", instructions: "Browse.", harness, tools: ["read", "browser"], computer: BROWSER_COMPUTER, model: named }, {}, { computerReady: async () => ({ ok: true }) });
    assert.deepEqual(blockers.filter((one) => one.tool === "browser" || one.field === "definition.computer"), [], `${harness}: ${JSON.stringify(blockers)}`);
    for (const tool of ["subagent", "pdf_pages", "llm"]) {
      assert.equal(adapterBinds(tool), false, `${tool} is no tool a CLI harness binds`);
      const refused = await blockersOf(env, { kind: "agentic", instructions: "Work.", harness, tools: [tool], model: named }, {}, {});
      // subagent is an agent's to name, refused as pi's; pdf_pages and llm run only in a workflow's nodes, no agent's tool.
      const words = tool === "subagent" ? `${tool} runs on pi here; on ${harness} it is not bound yet.` : `${tool} is not a tool here: grant one of`;
      assert.ok(refused.some((one) => one.field === "definition.tools[0]" && one.message.startsWith(words)), `${tool} is refused on ${harness} in words: ${JSON.stringify(refused)}`);
    }
  }
});

// Goose and Cursor on their own ACP adapter (acpFakeTable): the harness's recipe, with the ACP package's fake agent as its
// binary, so the browser's tools reach the agent as the real one gets them (the adapter's loopback MCP server, named in
// session/new) and its calls of them pass the harness's own permission path (Cursor's title tie, Goose's permission file).
const RUNS_ON = [...CLI.map((harness) => [harness, "", undefined]), ...["goose", "cursor"].map((harness) => [harness, " on its own ACP adapter (the fake ACP agent as its binary)", acpFakeTable(FAUX_HARNESS)])];
for (const [harness, on, table] of RUNS_ON) for (const [how, tools] of [["granted the browser", ["read", "browser"]], ["with no grant of the browser", ["read"]]]) {
  test(`${harness}${on}: an agent whose computer is a Browserbase browser, ${how}, runs: the harness is handed the browser's tools, and its snapshot and click reach the browser the claim started`, { timeout: 120_000 }, async (t) => {
    const page = await fakeAxPage();
    t.after(() => page.close());
    const record = { created: [], released: [], connects: 0 };
    const { row, timeline, lists } = await cliRun(t, harness, page, record, tools, table);

    assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
    for (const name of ["snapshot", "run"]) assert.ok(lists.length > 0 && lists.every((list) => list.filter((one) => one === name).length === 1), `the harness is handed ${name} once: ${JSON.stringify(lists)}`);
    assert.equal(record.created.length, 1, "the browser tool opened one session through the claim's provider");
    assert.equal(record.created[0]["agentrun.run"], RUN, "under the run's labels");
    const methods = page.calls.map((call) => call.method);
    assert.ok(methods.includes("Accessibility.getFullAXTree"), `the snapshot read the page's tree: ${JSON.stringify(methods)}`);
    assert.deepEqual(mouseOf(page), CLICK, "the click reached the page");
    const results = timeline.filter((one) => one.kind === "tool_result");
    assert.match(String(answerOf(timeline, "snapshot").result?.tool_result_preview ?? ""), /\[0-11\] button "Add"/, `the snapshot's answer names the page's ids: ${JSON.stringify(results)}`);
    assert.notEqual(answerOf(timeline, "snapshot").result?.tool_status, "failed");
    assert.match(String(answerOf(timeline, "run").result?.tool_result_preview ?? ""), /\[ok\] click \[0-11\] button "Add"/, `the click's answer: ${JSON.stringify(results)}`);
    assert.ok(!JSON.stringify(timeline).includes("SECRET-signed-url-token"), "the signed URL reaches no row of the run's");
    await until(() => record.released.length > 0, "the session is released");
    assert.deepEqual(record.released, [["bb-1", "delete"]], "the session was released once, when the tool let it go at the run's end");
  });
}

// A browser call's answer on a CLI harness is the page's own text, and a page can show a value the run must not leak (a key
// the runner holds, shown back in a form field or a title): the answer the harness is handed passes through the run's
// redactor (LoopDeps.redact, the runner's one), as every other host tool answer does, so the value reaches the CLI only as
// "[redacted]", on the faux harness and on goose and cursor's own ACP adapter.
const PAGE_VALUE = "page-value-7f3a9c2e5b1d4a6f0c8e";
for (const [harness, on, table] of RUNS_ON) {
  test(`${harness}${on}: a value the run's redactor holds, shown on the page, reaches the harness only as [redacted] in the browser's answers`, { timeout: 120_000 }, async (t) => {
    const page = await fakeAxPage({ title: `Account ${PAGE_VALUE}` });
    t.after(() => page.close());
    const record = { created: [], released: [], connects: 0 };
    const claim = await cliClaim(t, harness, `${page.url}?${SIGNED}`, record, ["read", "browser"], undefined, table, { redact: secretRedactor([PAGE_VALUE]) });
    claim.start("runner-a");
    const { row, timeline, answers } = await claim.rested(page);

    assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
    assert.ok(page.calls.some((call) => call.method === "Accessibility.getFullAXTree"), "the snapshot read the page, whose title holds the value");
    const browser = answers.filter((one) => ["snapshot", "run"].includes(one.tool));
    assert.ok(browser.some((one) => one.tool === "snapshot"), `the harness was handed the snapshot's answer: ${JSON.stringify(answers)}`);
    for (const one of browser) assert.ok(!JSON.stringify(one).includes(PAGE_VALUE), `the harness is never handed the value raw, in its text or its value: ${JSON.stringify(one)}`);
    assert.match(browser.find((one) => one.tool === "snapshot").text, /Account \[redacted\]/, "the snapshot's answer shows the page with the value cut");
    assert.ok(!JSON.stringify(timeline).includes(PAGE_VALUE), "nor does any row of the run's");
  });
}

/** A lease short enough that a crashed runner's claim lapses within the test (runner.kill(): nothing stopped, flushed or
 *  released, as a process that died). */
const CRASH_LEASE = { leaseMs: 2_000, renewEveryMs: 400, stopMarginMs: 500 };

// A browser call is a host tool its binding runs once (host-tools.ts RUNS_ONCE): pi's tool task would keep a durable memo
// and could run the call again on resume, but a CLI harness's call runs in no task, and its memo is the call's own. So a
// run on a CLI harness whose runner dies with a browser call in flight, resumed on another runner, has that call ended
// interrupted ("may or may not have taken effect") when the record opens again, never sends it to the browser again, and
// the model goes on from that answer. The session the cut call drove is not lost: the next claim's reconcile takes it back (connected
// again, never created again), and it is released once, when the run ends.
for (const harness of CLI) {
  test(`${harness}: a run whose runner dies while a browser call is in flight resumes on the next runner: the cut call is answered interrupted and never sent to the browser again, the session is taken back, not made again, and released once at the run's end`, { timeout: 120_000 }, async (t) => {
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
    const claim = await cliClaim(t, harness, `${relay.url}?${SIGNED}`, record, ["read", "browser"]);
    const first = claim.start("runner-a", CRASH_LEASE);
    await until(whileRunning(claim.opened.server, () => cut), "the click is in flight on the first runner");
    first.kill();
    const connected = record.connects;
    assert.deepEqual(record.released, [], "the first runner's crash releases no session: the run resumes on it");
    claim.start("runner-b", CRASH_LEASE);
    const { row, timeline, lists } = await claim.rested(page);

    assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
    assert.equal(lists.length, 2, `each claim's harness is handed the browser's tools: ${JSON.stringify(lists)}`);
    for (const list of lists) assert.ok(list.includes("snapshot") && list.includes("run"), JSON.stringify(list));
    const uses = timeline.filter((one) => one.kind === "tool_use").map((one) => one.tool_name);
    assert.deepEqual(uses, ["snapshot", "run"], "the cut call is issued once, never again on the next claim");
    const results = timeline.filter((one) => one.kind === "tool_result");
    assert.equal(answerOf(timeline, "snapshot").result?.tool_status, "success");
    assert.equal(answerOf(timeline, "run").result?.tool_status, "failed");
    assert.match(String(answerOf(timeline, "run").result?.tool_result_preview ?? ""), /^interrupted: .*may or may not have taken effect/, `the cut call's answer: ${JSON.stringify(results)}`);
    assert.deepEqual(mouseOf(page), ["mouseMoved", "mousePressed"], "the cut click is never sent to the browser again");
    const starts = (await runEntries(claim.opened.server, RUN, ctx)).filter((entry) => entry.kind === JOURNAL.callStart).map((entry) => [entry.data.tool, entry.data.replaySafe]);
    assert.deepEqual(starts, [["snapshot", false], ["run", false]], "each browser call starts on the record as never replay-safe: its intent is written before it acts, and a resume never runs it again");
    assert.equal(record.created.length, 1, "the next claim takes the session back: none is made again");
    assert.ok(record.connects > connected, `the next claim connects to it again: ${record.connects}`);
    await until(() => record.released.length > 0, "the session is released");
    assert.deepEqual(record.released, [["bb-1", "delete"]], "released once, at the run's end");
  });
}

// The agent's hand-over (browser_request_handoff): the person is asked, the call waits on them with the run working and
// its session held, and their hand-back answers it. The agent's next browser calls (a snapshot, since the person may have
// changed the page, then a click) drive the same session: none is made again, and it is released once, at the run's end.
for (const harness of CLI) {
  test(`${harness}: browser_request_handoff asks the person and the call waits on the hand-over; the person's hand-back answers it, and the agent's next browser call runs on the same session, none made again`, { timeout: 120_000 }, async (t) => {
    const page = await fakeAxPage();
    t.after(() => page.close());
    const record = { created: [], released: [], connects: 0 };
    const claim = await cliClaim(t, harness, `${page.url}?${SIGNED}`, record, ["read", "browser"], "Hand the browser to the person to sign in, then click its Add button.");
    claim.start("runner-a");
    const { server } = claim.opened;
    const target = await until(whileRunning(server, async () => handBackTarget(await runEntries(server, RUN, ctx), await server.commands(RUN, 0))), "the person is asked", 30_000).catch(async (error) => {
      const row = await server.runs.get(RUN);
      throw new Error(`${error.message}: ${JSON.stringify({ state: row.state, summary: row.summary, timeline: (await runTimeline(server, RUN, ctx)).map((one) => [one.kind, one.tool_name, one.tool_status, String(one.tool_result_preview ?? one.text ?? "").slice(0, 300)]) })}`);
    });
    assert.equal(target.answer, undefined, "the ask is open");
    const waiting = await runTimeline(server, RUN, ctx);
    const { use, result } = answerOf(waiting, "browser_request_handoff");
    assert.ok(use, `the hand-over call is on the record: ${JSON.stringify(waiting.map((one) => one.kind))}`);
    assert.equal(result, undefined, "and it waits, unanswered");
    const held = await server.runs.get(RUN);
    assert.equal(held.state, "running");
    assert.equal(held.summary, HANDOVER_WAITING, "the run's row says it waits for the person in the browser (run.needs_input)");
    assert.deepEqual(mouseOf(page), [], "nothing is clicked while the person has the browser");
    assert.deepEqual(record.released, [], "the session is held while the call waits");
    await browserHandBack(server, RUN, "done", target);
    const { row, timeline } = await claim.rested(page);

    assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
    assert.notEqual(row.summary, HANDOVER_WAITING, "the hand-back clears the row's waiting summary");
    const answered = answerOf(timeline, "browser_request_handoff").result;
    assert.notEqual(answered?.tool_status, "failed", JSON.stringify(answered));
    assert.match(String(answered?.tool_result_preview ?? ""), /done/, `the call is answered with the person's hand-back: ${JSON.stringify(answered)}`);
    const after = answerOf(timeline, "snapshot", 1).result;
    assert.equal(after?.tool_status, "success", JSON.stringify(after));
    assert.match(String(after?.tool_result_preview ?? ""), /\[0-11\] button "Add"/, "the agent's next browser call reads the page it handed over");
    const click = answerOf(timeline, "run").result;
    assert.equal(click?.tool_status, "success", JSON.stringify(click));
    assert.match(String(click?.tool_result_preview ?? ""), /\[ok\] click \[0-11\] button "Add"/, "and the one after it drives it");
    assert.deepEqual(mouseOf(page), CLICK, "its click reached the browser");
    assert.equal(record.created.length, 1, "on the session the run had: none is made again");
    await until(() => record.released.length > 0, "the session is released");
    assert.deepEqual(record.released, [["bb-1", "delete"]], "released once, at the run's end");
  });
}

/** Session `tag`'s viewer as the run's process handed it over (through the store, its token sealed), signed in past its
 *  hello, as serve's proxy reaches it: its socket on the viewer's own origin. */
async function viewerOf(server) {
  const handed = await until(async () => (await readLiveViewers(server, SEAL_KEY, RUN))[0], "the run's viewer is handed over", 30_000);
  const origin = `http://127.0.0.1:${handed.port}`;
  const opened = await wsConnect(`ws://127.0.0.1:${handed.port}/v/${handed.id}/ws`, { origin });
  assert.equal(opened.status, 101, "the viewer's socket opens");
  opened.ws.sendJson({ type: "hello", token: handed.token });
  const ready = JSON.parse((await opened.ws.next(5_000)).data);
  const next = async (type, ms = 10_000) => JSON.parse((await opened.ws.until((m) => m.type === "text" && JSON.parse(m.data).type === type, ms)).item?.data ?? "null");
  return { ws: opened.ws, ready, next };
}

// The person's take-over (the live view's Take over, unasked): while they hold the browser the agent's next browser call
// waits for them and the run stays working; once they hand it back the call goes on, told plainly the person had it, on
// the same session, and the agent's call after it too. None is made again, and it is released once, at the run's end.
for (const harness of CLI) {
  test(`${harness}: the person takes the browser over in its live view mid-run and hands it back: the agent's browser call waits while they hold it, then runs on the same session, told the person had it, as does its next call; none made again`, { timeout: 120_000 }, async (t) => {
    const page = await fakeAxPage();
    t.after(() => page.close());
    const record = { created: [], released: [], connects: 0 };
    const go = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-browser-take-")), "go");
    t.after(() => rmSync(dirname(go), { recursive: true, force: true }));
    const claim = await cliClaim(t, harness, `${page.url}?${SIGNED}`, record, ["read", "browser"], `Snapshot the browser, again once ${go} exists, then click its Add button.`);
    claim.start("runner-a");
    const { server } = claim.opened;
    const timeline = () => runTimeline(server, RUN, ctx);
    await until(whileRunning(server, async () => answerOf(await timeline(), "snapshot").result), "the first snapshot is answered", 30_000);
    const viewer = await viewerOf(server);
    t.after(() => viewer.ws.destroy());
    assert.equal(viewer.ready.type, "ready", JSON.stringify(viewer.ready));
    assert.equal(viewer.ready.takeOver, true, "the viewer offers Take over");
    viewer.ws.sendJson({ type: "take" });
    assert.deepEqual(await viewer.next("hold"), { type: "hold", held: true }, "the person holds the browser");

    writeFileSync(go, "");
    await until(whileRunning(server, async () => answerOf(await timeline(), "snapshot", 1).use), "the agent asks for its next snapshot", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const during = await timeline();
    assert.equal(answerOf(during, "snapshot", 1).result, undefined, "the call waits while the person holds the browser");
    assert.equal((await server.runs.get(RUN)).state, "running", "a take-over leaves the run working");
    assert.deepEqual(record.released, [], "and its session held");

    viewer.ws.sendJson({ type: "give" });
    assert.deepEqual(await viewer.next("hold"), { type: "hold", held: false, reason: "given" }, "the person hands it back");
    const { row, timeline: rows } = await claim.rested(page);

    assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
    const waited = answerOf(rows, "snapshot", 1).result;
    assert.equal(waited?.tool_status, "success", JSON.stringify(waited));
    assert.match(String(waited?.tool_result_preview ?? ""), /This call waited while the person had the browser/, `the call that waited is told the person had it: ${JSON.stringify(waited)}`);
    assert.match(String(waited?.tool_result_preview ?? ""), /\[0-11\] button "Add"/, "and reads the same page");
    const click = answerOf(rows, "run").result;
    assert.equal(click?.tool_status, "success", JSON.stringify(click));
    assert.match(String(click?.tool_result_preview ?? ""), /\[ok\] click \[0-11\] button "Add"/, "the agent's next call drove the page");
    assert.deepEqual(mouseOf(page), CLICK, "and its click reached the browser");
    assert.equal(record.created.length, 1, "on the session the run had: none is made again");
    await until(() => record.released.length > 0, "the session is released");
    assert.deepEqual(record.released, [["bb-1", "delete"]], "released once, at the run's end");
  });
}
