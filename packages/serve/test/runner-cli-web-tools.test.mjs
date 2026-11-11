// A CLI run's web_fetch on the runner (main parity: a claude-agent or codex run granted web_fetch, web_search or a monid
// tool gets it as a host tool, as main's per-run process hands it through the host proxy). A faux CLI harness on each
// CLI wire calls web_fetch on a page; the run's plane resolves web_fetch to Parallel, whose extract is faked at the
// network layer (the process's fetch, for Parallel's host only). The call reaches Parallel once, is booked once on the
// run's one ledger (its paid-tools session, the fee counted once in the run's cost), and the run's record holds its
// tool_use and tool_result rows. With web_fetch set to deny in the agent's settings, the run's gate refuses the call in
// main's words, and nothing is sent or booked. The harness's calls ask the run's gate first, as claude-agent's and
// codex's own tool bridges do (bridged, below). Through the real loop: startRunner over createDispatchLoop and the CLI
// spec (cliRunSpecFromLaunch), on a real store; no sleeps, no port races.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
const { viewOverStore } = await import("../dist/store-view.js");
const { parallelExtractFee } = await import("../dist/paid-calls.js");
const { deniedText } = await import("../dist/tool-gate.js");
const { entriesOf } = await import("../dist/runner/loop.js");
const { runMetrics } = await import("../dist/runner/metrics.js");

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const fake = (name) => `not-a-secret-${name}`;
// A public address by its literal, so the public-host guard passes it with no name lookup.
const PAGE = "https://93.184.215.14/page";
const EXTRACT = parallelExtractFee(1);
const FEE = EXTRACT.usd;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

/** Each CLI wire's harness, its gateway environment and its launch's model, as the run's own requests take them. */
const HARNESSES = {
  "claude-agent": { env: (url) => ({ ANTHROPIC_API_KEY: fake("anthropic"), ANTHROPIC_BASE_URL: url }), model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } },
  codex: { env: (url) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "1,2,0.5" }), model: { provider: "openai", modelId: "gpt-test" } },
};

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Parallel's extract, faked at the network layer: the process's fetch answers Parallel's host itself (each request
 *  kept), and passes every other request on. Put back at the test's end. */
function fakeParallel(t) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.host !== "api.parallel.ai") return real(input, init);
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push({ path: url.pathname, key: new Headers(init.headers).get("x-api-key"), urls: body.urls });
    const results = (body.urls ?? []).map((one) => ({ url: one, title: "Read by Parallel", publish_date: null, excerpts: [], full_content: `# Read by Parallel\n\nThe page at ${one}.` }));
    return new Response(JSON.stringify({ extract_id: "extract-1", results, errors: [], warnings: null, usage: [{ name: "sku_extract_full_content", count: results.length }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return sent;
}

/** `spec` with its harness's tool calls asking the run's gate first, as claude-agent's and codex's own tool bridges do
 *  (io.gate, before the call's flush and intent): a deny is the call's answer, in the gate's words, and the call is not
 *  run. The faux harness calls its session's tools directly, so this puts the bridge's ask in front of them. An ask is not
 *  part of this test. Each answer the harness is handed for a refused call is kept in `refused`. */
function bridged(spec, refused) {
  const open = spec.adapter.open.bind(spec.adapter);
  return {
    ...spec,
    adapter: {
      ...spec.adapter,
      open: (session, io) => open({
        ...session,
        tools: session.tools.map((tool) => ({
          ...tool,
          call: async (args, context) => {
            const answer = io.gate ? await io.gate({ callId: context.callId, tool: tool.name, args: args ?? {} }) : "allow";
            if (answer === "allow") return tool.call(args, context);
            if ("deny" in answer) {
              refused.push({ tool: tool.name, text: answer.deny });
              return { text: answer.deny, isError: true };
            }
            throw new Error(`${tool.name} was asked of a person, which this test does not answer`);
          },
        })),
      }, io),
    },
  };
}

/** A CLI run of the faux harness on `harness`, granted web_fetch (and write) on Parallel's plane, its agent's tool
 *  settings `toolSettings`, through the runner's dispatch. Its row once it rests, Parallel's requests, its timeline, its
 *  view's cost, and its session records. */
async function webRun(t, harness, { toolSettings } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-cli-web-tools-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway();
  const sent = fakeParallel(t);
  let runner;
  let reader;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await reader?.close(ctx).catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  // The faux harness reads its turn from the system prompt: a research turn that reads PAGE with web_fetch, then writes.
  const instructions = `Research agentrun on the web, read ${PAGE} and write report.md.`;
  await server.agents.create({ id: "agent-1", name: "Reads" }, { id: "rev-1", kind: "agentic", body: { instructions, harness, tools: ["web_fetch", "write"], ...(toolSettings ? { toolSettings } : {}) } });
  const launch = { input: { content: "Do the task." }, title: "t", place: { mode: "runner" }, harness, model: HARNESSES[harness].model, plane: { web_fetch: "parallel" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  await server.flush?.();
  // The harness table loads a test's module only under a test runner (harness-table.ts): the flag is handed the runner.
  const env = { ...HARNESSES[harness].env(gw.url), PARALLEL_API_KEY: fake("parallel"), AGENTRUN_HARNESS_TABLE: fauxTable(FAUX_HARNESS), NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
  const refused = [];
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === harness ? createAdapterLoop(async (claim, run) => bridged(await cliRunSpecFromLaunch(given, run, deps, claim), refused)) : undefined),
    }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped", "parked"].includes(now.state) && now.runner === null && now;
  }, "the run's end");
  const timeline = await runTimeline(server, RUN, ctx);
  const view = await viewOverStore(server, RUN, { origin: "", serverSecrets: () => [] });
  // The run's session records: the paid-tools session's paid requests and their turns, and the harness's own turns.
  const journal = server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state });
  reader = await Harness.open(journal, { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const sessions = journalSessions(reader, ctx, server);
  const records = [];
  for (const key of await sessions.keys()) for (const record of await sessions.read(key)) records.push({ key, ...record });
  // What the run's end metrics read of its record (its root conversation), as the spec's end patch reads it.
  const recorded = runMetrics(await entriesOf(journal, ROOT_CONVERSATION_ID, ctx), {}).costUsd;
  return { row, sent, timeline, view, records, recorded, refused };
}

for (const harness of Object.keys(HARNESSES)) {
  test(`a ${harness} run granted web_fetch calls it: Parallel asked once, booked once on the run's one ledger, its tool_use and tool_result rows on the timeline`, { timeout: 90_000 }, async (t) => {
    const { row, sent, timeline, view, records, recorded, refused } = await webRun(t, harness);
    assert.equal(row.state, "ended", `the run ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    assert.deepEqual(refused, [], "the run's gate allowed every call");
    // The network: one extract of the page, on the claim's key.
    assert.deepEqual(sent, [{ path: "/v1/extract", key: fake("parallel"), urls: [PAGE] }], "Parallel asked once, for the page, on the claim's key");
    // The timeline: the call and its result, the page read.
    const use = timeline.filter((one) => one.kind === "tool_use" && one.tool_name === "web_fetch");
    assert.equal(use.length, 1, `one web_fetch tool_use row: ${JSON.stringify(timeline.map((one) => [one.kind, one.tool_name]))}`);
    const result = timeline.filter((one) => one.kind === "tool_result" && one.tool_use_id === use[0].tool_use_id);
    assert.equal(result.length, 1, `its one tool_result row: ${JSON.stringify(timeline.filter((one) => one.kind === "tool_result"))}`);
    assert.notEqual(result[0].tool_status, "failed", `the call ran: ${JSON.stringify(result[0])}`);
    assert.match(String(result[0].tool_result_preview ?? ""), /Read by Parallel/, `the page Parallel read is its result: ${JSON.stringify(result[0])}`);
    // The one ledger: one paid request in the run's paid-tools session (the kernel's TOOL_SESSION), Parallel's extract,
    // booked at its fee.
    const paid = records.filter((record) => record.kind === "runner.request" && String(record.data?.model ?? "").startsWith("paid:"));
    assert.deepEqual(paid.map((record) => [record.key, record.data.model]), [[TOOL_SESSION, `paid:${EXTRACT.name}`]], `booked once, on the run's paid-tools session: ${JSON.stringify(records.map((one) => [one.key, one.kind, one.data?.model ?? null]))}`);
    const booked = records.filter((record) => record.key === TOOL_SESSION && record.kind === "runner.turn" && record.data?.turn === paid[0].data.turn);
    assert.deepEqual(booked.map((record) => eight(record.data.usd)), [eight(FEE)], `booked at the extract's fee, once: ${JSON.stringify(booked)}`);
    // The run's cost holds the fee once, beside its model requests at what the run's booking booked them at, as the pi
    // spec's end adds its paid tool calls: on its row and on its view.
    const model = records.filter((record) => record.key !== TOOL_SESSION && record.kind === "runner.turn").reduce((sum, record) => sum + record.data.usd, 0);
    assert.equal(eight(row.costUsd ?? 0), eight(model + FEE), `the run row's cost holds the fee once: ${row.costUsd}, its model requests' ${model}`);
    assert.equal(eight(view?.cost?.usd ?? 0), eight(row.costUsd ?? 0), `the view's cost is the row's: ${JSON.stringify(view?.cost)}`);
    void recorded;
  });

  test(`a ${harness} run's model requests are its cost: the booking's records, one usage row priced at them, and the run row and its view priced the same (#2275)`, { timeout: 90_000 }, async (t) => {
    const { row, timeline, view, records } = await webRun(t, harness);
    assert.equal(row.state, "ended", `the run ended: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    // The harness's model requests, booked by the run's model proxy in its own session (never the paid-tools one).
    const turns = records.filter((record) => record.key !== TOOL_SESSION && record.kind === "runner.turn");
    assert.ok(turns.length > 0 && turns.every((record) => typeof record.data.usd === "number" && record.data.usd > 0), `the model requests are booked, each priced: ${JSON.stringify(turns.map((one) => one.data))}`);
    const model = turns.reduce((sum, record) => sum + record.data.usd, 0);
    // The timeline: one usage row, at the model requests' cost and the paid call's fee, over the requests booked.
    const usage = timeline.filter((one) => one.kind === "usage");
    assert.equal(usage.length, 1, `one usage row: ${JSON.stringify(timeline.map((one) => one.kind))}`);
    assert.equal(eight(usage[0].usage.usd), eight(model + FEE), `the usage row's cost: ${JSON.stringify(usage[0])}`);
    assert.equal(usage[0].usage.requests, turns.length, "its requests are the booked ones");
    assert.match(usage[0].summary, new RegExp(`over ${turns.length} model requests? and 1 paid tool call$`));
    // The run's row (what /v2/stats sums) and its view: priced the same, never $0 or unknown.
    assert.equal(eight(row.costUsd ?? -1), eight(model + FEE), `the run row's cost: ${row.costUsd}`);
    assert.equal(eight(view?.cost?.usd ?? -1), eight(model + FEE), `the view's cost: ${JSON.stringify(view?.cost)}`);
  });

  test(`a ${harness} run whose agent sets web_fetch to deny: the call is refused in main's words, and nothing is sent`, { timeout: 90_000 }, async (t) => {
    const { row, sent, timeline, records, refused } = await webRun(t, harness, { toolSettings: { web_fetch: { permission: "deny" } } });
    assert.equal(row.state, "ended", `the run went on to its end: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
    // The harness is handed the gate's refusal, in main's words for a tool set to deny for this agent.
    assert.deepEqual(refused, [{ tool: "web_fetch", text: deniedText("web_fetch", undefined, "agent") }], "web_fetch refused for this agent, nothing sent or charged");
    // Nothing sent, nothing booked, and the call never ran (no record of its start).
    assert.deepEqual(sent, [], "nothing sent to Parallel");
    assert.deepEqual(records.filter((record) => record.key === TOOL_SESSION), [], "nothing booked on the paid-tools session");
    assert.equal(timeline.filter((one) => one.tool_name === "web_fetch").length, 0, `the refused call never ran: ${JSON.stringify(timeline.map((one) => [one.kind, one.tool_name]))}`);
  });
}
