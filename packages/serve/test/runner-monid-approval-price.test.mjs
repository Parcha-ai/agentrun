// A monid.run ask card shows its price (the approval price comes from the tool's own hold), through the real loop on a
// real store, the faux monid and a scripted model origin: the allowance when no inspect priced the endpoint in the run,
// the quote an inspect gave when one did. Other asked tools keep no price.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { KEY } from "./fixtures/faux-monid.mjs";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { FAUX_MONID_ENV } = await import("../dist/monid.js");
const { FAUX_ENV } = await import("../dist/model.js");
after(closeOpenSessions);

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 9);
const RUN = "run-1";
const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
/** Test keys, no real ones. */
const MONID = { MONID_API_KEY: KEY };
const LAUNCH = { input: { content: "Run monid." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } };
const eight = (usd) => Math.round(usd * 1e8) / 1e8;
const sum = (figures) => figures.reduce((total, usd) => total + usd, 0);

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** run-1 on a new store (the browser's keys and `keys` saved sealed, an agent granted `tools`), run by a runner on the
 *  adapter spec with a scripted model of `price` a request (a figure, or one of the requests sent so far).
 *  `rest(state)`: when the test has it rest. */
async function monidRun(t, { script, price = 0, launch = LAUNCH, tools = ["monid.discover", "monid.inspect", "monid.run"], keys = {}, toolSettings }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-browser-money-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, value] of Object.entries({ ...MONID, ...keys })) await putSealedKey(server, SEAL_KEY, name, value);
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Run monid.", tools, ...(toolSettings ? { toolSettings } : {}) } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  // Someone can answer an ask (the server writes this at its start: server-approvers.ts APPROVERS_KEY), so it parks.
  await server.settings.put("approvers", { approvers: true });
  await server.flush?.();
  const requests = [];
  const route = {
    model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" },
    fetch: scriptedOrigin(script, requests), price: () => (typeof price === "function" ? price(requests.length) : price), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 100,
  };
  const deps = { env: { [FAUX_ENV]: "faux", [FAUX_MONID_ENV]: FAUX_MONID }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  /** A person's raise to `usd`: the raise row the run's runner takes, and holds the run to from then (#2133). */
  const raise = (usd) => sendCommand(server, RUN, { kind: "raise", body: { capUsd: usd } });
  /** The run once it rests in one of `states`, released: its row, its journal's records, and every surface its cost is
   *  read on (the view: its timeline's usage row, else the stored cost; the timeline's usage row itself). */
  const rest = async (states = ["ended", "failed", "stopped", "parked"]) => {
    const row = await until(async () => {
      const now = await server.runs.get(RUN);
      return states.includes(now.state) && now.runner === null && now;
    }, `the run rests ${states.join("|")}`);
    const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
    const view = await viewOverStore(server, RUN, { origin: "", serverSecrets: () => [] });
    const rows = await runTimeline(server, RUN, ctx, { settled: true });
    const usage = rows.filter((one) => one.kind === "usage").at(-1);
    return { row, records, rows, viewUsd: view?.cost?.usd, usageUsd: usage?.usage?.usd };
  };
  return { server, store, requests, rest, raise };
}

const ENRICH = { provider: "faux", endpoint: "/person/enrich", input: { name: "Ada" } };
const asksOf = async (run) => {
  const { row } = await run.rest(["parked", "ended", "failed"]);
  const records = await journalRecords(run.server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  return records.entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
};

test("a monid.run ask card shows the allowance it is held at when no inspect priced it in the run", async (t) => {
  const run = await monidRun(t, { script: [{ call: "monid_run", args: ENRICH }, { say: "done" }] });
  const asks = await asksOf(run);
  assert.deepEqual(asks.map((ask) => [ask.tool, ask.price]), [["monid.run", 1]], JSON.stringify(asks));
});

test("a monid.run ask card shows the price an inspect in the run quoted for that endpoint", async (t) => {
  const run = await monidRun(t, { tools: ["monid.discover", "monid.inspect", "monid.run"], script: [{ call: "monid_inspect", args: { provider: "faux", endpoint: "/person/enrich" } }, { call: "monid_run", args: ENRICH }, { say: "done" }], toolSettings: { "monid.inspect": { permission: "allow" } } });
  const asks = await asksOf(run);
  assert.deepEqual(asks.map((ask) => [ask.tool, ask.price]), [["monid.run", 0.003]], JSON.stringify(asks));
});
