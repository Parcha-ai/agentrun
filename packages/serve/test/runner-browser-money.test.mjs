// The browser's money on the runner, through the real loop (startRunner over createDispatchLoop and the adapter spec, on a
// real store, the faux browser and a scripted model origin):
//   - its session time is counted ONCE in the run's cost: each charge is booked on the run's one ledger (the paid-tools
//     session the cap counts) and recorded on the root (for the browser's own holds and its seconds),
//     and the stored cost (the end patch), the view and the timeline's usage row each hold model cost + browser cost,
//     every charge once;
//   - a browser call the cap refuses for room PARKS the run, as any paid step of the agent's own does: no further model
//     request leaves, and a raise resumes it;
//   - a hand-over's words for the person (its agent.handover entry) are cut of the claim's keys, as every other answer
//     the browser gives on the runner is.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
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
const { FAUX_BROWSER_ENV } = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
after(closeOpenSessions);

/** A test seal key, no real one. */
const SEAL_KEY = Buffer.alloc(32, 9);
const RUN = "run-1";
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
/** Test keys, no real ones. */
const BROWSERBASE = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const LAUNCH = { input: { content: "Browse." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" }, plane: { browser: "browserbase" } };
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
 *  adapter spec with a scripted model of `price` a request. `rest(state)`: when the test has it rest. */
async function browserRun(t, { script, price = 0, launch = LAUNCH, tools = ["browser"], keys = {} }) {
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
  for (const [name, value] of Object.entries({ ...BROWSERBASE, ...keys })) await putSealedKey(server, SEAL_KEY, name, value);
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Browse.", tools } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  const requests = [];
  const route = {
    model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" },
    fetch: scriptedOrigin(script, requests), price: () => price, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 100,
  };
  const deps = { env: { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER }, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim: async () => ({ release: async () => {} }) };
  // The run's cap after a raise is the server's to keep (E2), as adapter-pi-cap-raise.test.mjs keeps it: the cap rule
  // reads the raised figure, here a closure `raise` moves.
  let raised;
  const capped = (spec) => (spec.runCap ? { ...spec, runCap: { ...spec.runCap, capUsd: () => raised ?? spec.runCap.capUsd() } } : spec);
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop(async (claim, run) => capped(await adapterRunSpecFromLaunch(given, run, deps, claim))) : undefined) }),
  });
  /** A person's raise to `usd`: the cap kept (E2), and the raise row the run's runner takes. */
  const raise = (usd) => ((raised = usd), sendCommand(server, RUN, { kind: "raise", body: { capUsd: usd } }));
  /** The run once it rests in one of `states`, released: its row, its journal's records, and every surface its cost is
   *  read on (the view: its timeline's usage row, else the stored cost; the timeline's usage row itself). */
  const rest = async (states = ["ended", "failed", "stopped", "parked"]) => {
    const row = await until(async () => {
      const now = await server.runs.get(RUN);
      return states.includes(now.state) && now.runner === null && now;
    }, `the run rests ${states.join("|")}`);
    const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
    const view = await viewOverStore(server, RUN, { origin: "", serverSecrets: () => [] });
    const usage = (await runTimeline(server, RUN, ctx, { settled: true })).filter((one) => one.kind === "usage").at(-1);
    return { row, records, viewUsd: view?.cost?.usd, usageUsd: usage?.usage?.usd };
  };
  return { server, store, requests, rest, raise };
}

/** What the run's model requests cost (each runner.turn of a request that is no paid tool's), and what its browser's
 *  session time cost (each browser charge the root records: a TOOL_COST of tool "browser", or on the runner's ledger its
 *  BROWSER_CHARGED). */
function spentOf(records) {
  const paidTurns = new Set(records.entries.filter((e) => e.kind === "runner.request" && String(e.data?.model ?? "").startsWith("paid:")).map((e) => `${e.conversationId}/${e.data.turn}`));
  const model = sum(records.entries.filter((e) => e.kind === "runner.turn" && !paidTurns.has(`${e.conversationId}/${e.data?.turn}`)).map((e) => e.data?.usd ?? 0));
  const browser = records.entries.filter((e) => (e.kind === "agentrun.tool_cost" || e.kind === "agentrun.browser_charged") && e.data?.tool === "browser").map((e) => e.data.usd);
  return { model, browser: sum(browser), charges: browser.length };
}

for (const [label, price] of [["a free model", 0], ["a model that costs", 0.001]]) {
  test(`the browser's session time is counted once in the run's cost, with ${label}: the stored cost, the view and the timeline's usage row each hold the model's cost plus each browser charge once`, { timeout: 120_000 }, async (t) => {
    const run = await browserRun(t, { price, script: [{ call: "snapshot" }, { call: "browser_read" }, { say: "done" }] });
    const r = await run.rest(["ended", "failed", "stopped"]);
    assert.equal(r.row.state, "ended", JSON.stringify(r.row));
    const spent = spentOf(r.records);
    assert.ok(spent.charges > 0 && spent.browser > 0, `the browser's time was charged: ${JSON.stringify(spent)}`);
    if (price > 0) assert.equal(eight(spent.model), eight(3 * price), `three model requests at their price: ${JSON.stringify(spent)}`);
    const once = eight(spent.model + spent.browser);
    assert.equal(eight(r.row.costUsd ?? Number.NaN), once, `the run row's cost (the end patch) is the model's plus the browser's, once: ${JSON.stringify({ costUsd: r.row.costUsd, ...spent })}`);
    assert.equal(eight(r.viewUsd ?? Number.NaN), once, `GET /runs/:id's cost is the same: ${r.viewUsd}`);
    assert.equal(eight(r.usageUsd ?? Number.NaN), once, `the timeline's usage row is the same: ${r.usageUsd}`);
  });
}

test("a browser call the cap refuses for room parks the run: no further model request leaves; a raise resumes it, and the call runs and is booked", { timeout: 120_000 }, async (t) => {
  // A cap the browser's hold ($0.018 at browserbase's $0.12 an hour) does not fit; the model is free.
  const run = await browserRun(t, { launch: { ...LAUNCH, max_cost_usd: 0.0001 }, script: [{ call: "snapshot" }, { call: "snapshot" }, { say: "done" }] });
  const parked = await run.rest(["ended", "failed", "stopped", "parked"]);
  assert.equal(parked.row.state, "parked", `parked at its cap: ${JSON.stringify({ state: parked.row.state, summary: parked.row.summary })}`);
  assert.equal(run.requests.length, 1, `no model request after the refused call: ${run.requests.length}`);
  assert.match(JSON.stringify(run.requests), /spend_cap_reached|cap/, "the model's only request");
  assert.equal(spentOf(parked.records).charges, 0, "the refused call opened no session and charged nothing");
  // The raise: the run resumes, its next request goes out, the call runs this time and its time is booked.
  await run.raise(1);
  const resumed = await run.rest(["ended", "failed", "stopped"]);
  assert.equal(resumed.row.state, "ended", JSON.stringify({ state: resumed.row.state, summary: resumed.row.summary }));
  assert.equal(run.requests.length, 3, `the run resumed with its next request: ${run.requests.length}`);
  const spent = spentOf(resumed.records);
  assert.ok(spent.charges > 0, `the call ran after the raise and was booked: ${JSON.stringify(spent)}`);
  assert.equal(eight(resumed.row.costUsd ?? Number.NaN), eight(spent.browser), `its cost once: ${resumed.row.costUsd}`);
});

/** Every 8-character piece of `secret` that `text` holds. */
const piecesIn = (text, secret) => { const found = new Set(); for (let i = 0; i + 8 <= secret.length; i += 1) if (text.includes(secret.slice(i, i + 8))) found.add(secret.slice(i, i + 8)); return [...found]; };
/** A test key, no real one, of `length` letters and digits with no shape (no prefix any shape rule knows). */
const shapeless = (length = 40) => Array.from({ length }, (_, i) => "abcdefghijkmnpqrstuvwxyz23456789"[(i * 7 + Date.now()) % 32]).join("").slice(0, length);

test("a hand-over's words for the person are cut of the claim's keys on the runner: its agent.handover entry holds no piece of another tool's key (Parallel's) the model put in its instruction", { timeout: 120_000 }, async (t) => {
  const key = shapeless(40);
  const run = await browserRun(t, {
    tools: ["browser", "web_search"],
    keys: { PARALLEL_API_KEY: key },
    launch: { ...LAUNCH, plane: { browser: "browserbase", web_search: "parallel" } },
    script: [{ call: "snapshot" }, { call: "browser_request_handoff", args: { request_id: "8a6b2c1e-3f4d-4b5a-9c7e-1d2f3a4b5c6d", instruction: `Sign in with ${key} for me.`, completion_condition: "Signed in." } }, { say: "done" }],
  });
  // The person's hand-back, once the ask is waiting.
  const ask = await until(async () => {
    const row = await run.server.runs.get(RUN);
    if (row.state === "queued") return undefined;
    if (row.state !== "running") return { gone: row.state };
    const { entries } = await journalRecords(run.server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
    return entries.map((entry) => entry.data).find((data) => data?.state === "waiting" && typeof data.id === "string");
  }, "the hand-over's waiting ask");
  assert.ok(!ask.gone, `the run waited on the person: ended ${ask.gone}`);
  await run.server.command(RUN, { kind: "browser_hand_back", body: { ask: ask.id, outcome: "done" } });
  const r = await run.rest(["ended", "failed", "stopped"]);
  const handovers = r.records.entries.filter((entry) => entry.kind === "agent.handover");
  assert.ok(handovers.length > 0, "the hand-over was journaled");
  assert.match(JSON.stringify(handovers), /Sign in with/, "its words are there");
  assert.deepEqual(piecesIn(JSON.stringify(handovers), key), [], "nothing of the claim's Parallel key in its agent.handover entries");
});
