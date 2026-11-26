// A runner's graceful close lets go of what a run holds, and books it, before close() resolves: the run's tool hosts'
// beforeRelease runs while the run's journal still takes their writes, so a browser session's release is charged on the
// run's ledger (its final charge on the root) and a priced computer's last stretch is booked, each once. Nothing is let
// go after close() has resolved, and no tool host's beforeRelease fails for a loop already stopped. On pi (the browser
// tool, on the faux browser) and on a CLI harness (claude-agent's faux harness, on a priced faux desktop), each through
// the real loop: startRunner over createDispatchLoop and the adapter or CLI spec, on a real store.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf } from "@parcha/agentrun-computer";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
after(closeOpenSessions);

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 5);
const RUN = "run-1";
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
/** Test keys, no real ones. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const TIMING = { leaseMs: 30_000, renewEveryMs: 5_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
/** How long after close() a late release would still land: longer than any the loop's teardown takes. */
const AFTER_CLOSE_MS = 3_500;
/** $0.01 a vCPU-second and $0.001 a GiB-second on faux-desktop. */
const PRICES = { AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_FAUX_DESKTOP: "0.01", AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_FAUX_DESKTOP: "0.001" };

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Every console.warn from here on, kept for the test, and still said. */
function warnings(t) {
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => {
    said.push(args.map(String).join(" "));
    warn(...args);
  };
  t.after(() => (console.warn = warn));
  return said;
}

/** A new data directory with a server and a runner store on it, closed and removed after the test. */
async function stores(t, prefix) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), prefix));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(async () => {
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, server, store };
}

/** The run's journal records as they stand, read as the server reads them. */
async function recordsOf(server) {
  const row = await server.runs.get(RUN);
  return journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
}

/** A model origin that answers `script` in turn, and holds every request after it until the request is aborted: the
 *  run's turn is in flight when the test closes its runner. */
function holdingOrigin(script, requests) {
  const scripted = scriptedOrigin(script, requests);
  return async (url, init = {}) => {
    const step = (JSON.parse(String(init.body ?? "{}")).messages ?? []).filter((message) => message.role === "assistant").length;
    if (step < script.length) return scripted(url, init);
    requests.push(JSON.parse(String(init.body ?? "{}")));
    return new Promise((_resolve, reject) => {
      const stop = () => reject(init.signal?.reason ?? new Error("aborted"));
      if (init.signal?.aborted) stop();
      init.signal?.addEventListener("abort", stop, { once: true });
    });
  };
}

test("pi: a runner's graceful close releases the run's browser session once and books its release before close() resolves, with no beforeRelease refused", { timeout: 120_000 }, async (t) => {
  const said = warnings(t);
  const { dir, server, store } = await stores(t, "runner-close-browser-");
  for (const [name, value] of Object.entries(BROWSERBASE)) await putSealedKey(server, SEAL_KEY, name, value);
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Browse.", tools: ["browser"] } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Browse." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, plane: { browser: "browserbase" } } });
  await server.flush?.();
  // The vendor's sessions (FAUX_BROWSER_STATE: each live one) and its every call (FAUX_BROWSER_LOG: its releases).
  const state = join(dir, "faux-browser-state.json");
  const log = join(dir, "faux-browser.log");
  const before = { state: process.env.FAUX_BROWSER_STATE, log: process.env.FAUX_BROWSER_LOG };
  process.env.FAUX_BROWSER_STATE = state;
  process.env.FAUX_BROWSER_LOG = log;
  t.after(() => {
    for (const [name, value] of [["FAUX_BROWSER_STATE", before.state], ["FAUX_BROWSER_LOG", before.log]]) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  const requests = [];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: holdingOrigin([{ call: "snapshot" }], requests), price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 100 };
  const deps = { env: { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  const runner = startRunner({
    store, name: "runner-a", ...TIMING,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  // The snapshot opened a session, and the turn's next request is in flight.
  await until(() => requests.length >= 2, "the request after the snapshot is in flight");
  const live = () => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : []);
  assert.equal(live().length, 1, "the snapshot opened one session");
  const releases = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.op === "release") : []);

  await runner.close();

  const closedAt = { live: live(), releases: releases().length, records: await recordsOf(server) };
  const charged = (records) => records.entries.filter((entry) => entry.kind === "agentrun.browser_charged" && entry.data?.final === true);
  assert.deepEqual(closedAt.live, [], "the session was let go by the time close() resolved");
  assert.equal(closedAt.releases, 1, "released once, before close() resolved");
  assert.equal(charged(closedAt.records).length, 1, `its release was charged on the run's ledger before close() resolved: ${JSON.stringify(closedAt.records.entries.filter((entry) => entry.kind === "agentrun.browser_charged").map((entry) => entry.data))}`);
  assert.deepEqual(said.filter((line) => /beforeRelease failed/.test(line)), [], "no tool host's beforeRelease was refused");

  // Nothing more is let go or written after close() resolved.
  await new Promise((resolve) => setTimeout(resolve, AFTER_CLOSE_MS));
  assert.equal(releases().length, 1, "still released once");
  assert.equal(charged(await recordsOf(server)).length, 1, "still charged once");
  assert.deepEqual(said.filter((line) => /beforeRelease failed/.test(line)), [], "and no beforeRelease failed after close() either");
});

/** A vendor of --faux's desktops: create starts one, connect finds it, delete ends it. */
function fauxDesktops(faux) {
  const entry = faux.kinds.PROVIDERS.find((one) => one.id === "faux-desktop");
  const computers = new Map();
  let made = 0;
  return {
    id: "faux-desktop",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    async list(labels) {
      const held = [...computers.values()].filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: held.map((one) => ({ ref: { id: one.id, name: one.id }, labels: { ...one.labels }, deadline: new Date(Date.now() + 3_600_000), state: "running", network: "open" })) };
    },
    async create(spec) {
      const id = `d${++made}`;
      computers.set(id, { id, labels: { ...spec.labels }, desk: await faux.launch(entry, { kind: "desktop", keys: {} }) });
      return { ok: true, value: { id, name: id } };
    },
    async attach({ id }) {
      if (!computers.has(id)) return { ok: false, error: { code: "not_found", message: `no computer ${id}` } };
      return { ok: true, value: { id, name: id, spec: { image: "faux", user: "1000:1000", network: "open" } } };
    },
    async connect({ id }) {
      const one = computers.get(id);
      if (!one) return { ok: false, error: { code: "gone", message: `no computer ${id}` } };
      return { ok: true, value: { client: one.desk.client, hello: one.desk.hello, close: async () => {} } };
    },
    async watch() {
      return { ok: true, value: { input: async () => ({ ok: true, value: { done: 0 } }), close: async () => {} } };
    },
    async release(ref, how) {
      if (how === "delete") {
        await computers.get(ref.id)?.desk.release().catch(() => {});
        computers.delete(ref.id);
      }
      return { ok: true, value: undefined };
    },
  };
}

test("claude-agent (faux harness): a runner's graceful close books the run's priced computer's last stretch before close() resolves, every hold settled, with no beforeRelease refused", { timeout: 120_000 }, async (t) => {
  const said = warnings(t);
  const { dir, server, store } = await stores(t, "runner-close-computer-");
  const gw = await startFauxGateway();
  t.after(() => gw.close());
  // The turn's first request, then a hold with no request open (writing `<at>.held`) until `<at>` exists: never, here.
  const at = join(dir, "restart");
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: `Claude Code restarts before the note at ${at}.`, harness: "claude-agent", computer: { kind: "desktop", provider: "faux-desktop" }, tools: ["read"] } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "claude-agent", model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } } });
  await server.flush?.();
  const faux = fauxComputers();
  const vendor = fauxDesktops(faux);
  const computerDeps = { kinds: faux.kinds, keyTable: faux.keyTable, providers: { "faux-desktop": () => vendor }, spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open", cpus: 2, memoryMb: 4096 }), check: { readBackOf } };
  // The harness table loads a test's module only under a test runner (harness-table.ts): the flag is handed the runner.
  const env = { ...PRICES, ANTHROPIC_API_KEY: "not-a-secret-anthropic", ANTHROPIC_BASE_URL: gw.url, AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim, computerDeps };
  const runner = startRunner({
    store, name: "runner-a", ...TIMING,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "claude-agent" ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  t.after(() => runner.close().catch(() => {}));
  await until(() => existsSync(`${at}.held`), "the turn holds after its first request");

  await runner.close();

  /** The computer's time on the run's ledger: each hold and each booking (a runner.request of tool compute), and each
   *  request's settle (its runner.turn). */
  const compute = (records) => {
    const requests = records.entries.filter((entry) => entry.kind === "runner.request" && entry.data?.tool === "compute");
    const settled = new Set(records.entries.filter((entry) => entry.kind === "runner.turn").map((entry) => `${entry.conversationId}:${entry.data.turn}`));
    return { holds: requests.filter((entry) => entry.data.hold === true).length, booked: requests.filter((entry) => entry.data.hold !== true).length, open: requests.filter((entry) => !settled.has(`${entry.conversationId}:${entry.data.turn}`)).map((entry) => entry.data) };
  };
  const closedAt = compute(await recordsOf(server));
  assert.ok(closedAt.holds >= 1, `the computer's time was held: ${JSON.stringify(closedAt)}`);
  assert.ok(closedAt.booked >= 1, `its time was booked before close() resolved: ${JSON.stringify(closedAt)}`);
  assert.deepEqual(closedAt.open, [], "every hold and booking was settled before close() resolved: none left open on the ledger");
  assert.deepEqual(said.filter((line) => /beforeRelease failed/.test(line)), [], "no tool host's beforeRelease was refused");

  await new Promise((resolve) => setTimeout(resolve, AFTER_CLOSE_MS));
  assert.deepEqual(compute(await recordsOf(server)), closedAt, "nothing more is booked after close() resolved");
  assert.deepEqual(said.filter((line) => /beforeRelease failed/.test(line)), [], "and no beforeRelease failed after close() either");
});
