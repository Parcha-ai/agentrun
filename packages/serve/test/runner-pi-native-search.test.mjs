// A pi run whose web_search resolves to the model provider's own hosted search (the plane's "native"), on the runner: the
// search is one request to the run's provider with the hosted tool, sent through the run's session proxy as the run's
// other requests beside pi's are, labelled web_search. It answers the search's results, and it is booked once on the
// run's one ledger: its tokens at the run's model's price and each search the provider ran at its flat fee, in the run's
// cost once.
//
// Through the real loop: startRunner over createDispatchLoop and the pi spec (adapterRunSpecFromLaunch), on a real store.
// The run's route is a scripted origin: pi's turns call web_search, then say they are done; the hosted search's request
// (the one that offers Anthropic's web_search tool) is answered as the provider streams it (fixtures/faux-upstream.mjs:
// 20,000 tokens in, 40 out, one search run). No socket leaves this machine.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import fakeUpstream from "./fixtures/faux-upstream.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
after(closeOpenSessions);

const TIMING = { leaseMs: 30_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };
const MODEL = "claude-sonnet-4-5";
/** Claude Sonnet 4.5's price per million tokens, and Anthropic's flat fee per web search. */
const PRICE = { input: 3, output: 15 };
const SEARCH_USD = 0.01;
const usdOf = (input, output) => (input * PRICE.input + output * PRICE.output) / 1e6;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

/** run-1, a pi run granted web_search, its plane resolving it to the run's model's hosted search; its row once it rests,
 *  its timeline, the requests its route saw and its session records. */
async function nativeSearchRun(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-pi-native-search-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  let reader;
  t.after(async () => {
    await runner?.close();
    await reader?.close(ctx).catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Search, then say done.", tools: ["web_search"] } });
  const plane = { web_search: "native", model: `anthropic/${MODEL}` };
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Search." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: MODEL }, plane } });
  // pi's own turns: a web_search, then done. The hosted search's request goes to the provider's search, as it streams it.
  const searches = [];
  const turns = scriptedOrigin([{ call: "web_search", args: { query: "widgets", n: 3 } }, { say: "done" }]);
  const origin = async (url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    if ((body.tools ?? []).some((tool) => tool?.type === "web_search_20250305")) {
      searches.push(body);
      return fakeUpstream(url, init);
    }
    return turns(url, init);
  };
  const route = {
    model: MODEL, provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => `not-a-secret-${"r"}` },
    fetch: origin,
    price: (_model, usage) => usdOf(usage.input ?? 0, usage.output ?? 0),
    cost: { input: PRICE.input, output: PRICE.output, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000,
  };
  const deps = {
    env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: Buffer.alloc(32, 3), routeOf: async () => route,
    computerForClaim: async () => ({ release: async () => {} }),
  };
  runner = startRunner({
    store, name: "runner-a", ...TIMING,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (_name, given) => createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) }),
  });
  let row;
  for (const from = Date.now(); ; await new Promise((resolve) => setTimeout(resolve, 25))) {
    row = await server.runs.get("run-1");
    if (["ended", "failed", "stopped", "parked"].includes(row.state) && row.runner === null) break;
    if (Date.now() - from > 45_000) assert.fail(`the run never rested: ${JSON.stringify({ state: row.state, summary: row.summary })}`);
  }
  const timeline = await runTimeline(server, "run-1", ctx);
  reader = await Harness.open(server.journal({ runId: "run-1", runner: "reader", epoch: row.epoch, until: 0, from: row.state }), { models: () => createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  const sessions = journalSessions(reader, ctx, server);
  const records = [];
  for (const key of await sessions.keys()) for (const record of await sessions.read(key)) records.push({ key, ...record });
  return { row, timeline, searches, records };
}

test("a pi run's native web_search on the runner searches through the run's session proxy, answers the provider's results, and is booked once with its search fee", { timeout: 60_000 }, async (t) => {
  const { row, timeline, searches, records } = await nativeSearchRun(t);
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  const result = timeline.find((one) => one.kind === "tool_result" && one.tool_name === "web_search");
  assert.match(String(result?.tool_result_preview ?? ""), /^\{"provider":"native","query":"widgets","results":\[\{"url":"http:\/\/public\.example\/"/, `the provider's results: ${JSON.stringify(result)}`);
  // One request to the provider's hosted search, with exactly its hosted tool, through the run's route.
  assert.equal(searches.length, 1, "one hosted search request");
  assert.deepEqual(searches[0].tools.map((tool) => tool.type), ["web_search_20250305"], "the hosted tool alone");
  // Booked once on the run's one ledger, as a request of the session's labelled web_search: its tokens and its one search.
  const requests = records.filter((record) => record.kind === "runner.request" && record.data?.host === "web_search");
  assert.equal(requests.length, 1, `booked once, labelled web_search: ${JSON.stringify(records.filter((record) => record.kind === "runner.request").map((record) => record.data))}`);
  const booked = records.filter((record) => record.key === requests[0].key && record.kind === "runner.turn" && record.data?.turn === requests[0].data.turn);
  assert.deepEqual(booked.map((record) => eight(record.data.usd)), [eight(usdOf(20_000, 40) + SEARCH_USD)], `its tokens at the run's price and its one search's fee: ${JSON.stringify(booked)}`);
  // The run's cost holds it once, beside pi's own two turns.
  const own = records.filter((record) => record.kind === "runner.turn" && record.key === requests[0].key && record.data?.turn !== requests[0].data.turn && typeof record.data?.usd === "number").reduce((sum, record) => sum + record.data.usd, 0);
  assert.equal(eight(row.costUsd ?? 0), eight(own + usdOf(20_000, 40) + SEARCH_USD), `the run's cost holds the search once: ${row.costUsd}`);
});
