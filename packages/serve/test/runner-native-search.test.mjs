// A CLI run's own web search on the runner. The run's plane is frozen when the run is made (runs.create): a plane that
// resolved web_search to native turns the harness's own search on (adapters.ts nativeOptions reads it from the run's
// environment, which cliRunSpecFromLaunch builds). Two things hold here, through the real loop (startRunner over
// createDispatchLoop and the CLI spec, on a real store), on each harness's real adapter (fixtures/native-search-table.mjs):
//
// 1. A run whose plane says native gets the harness's own search: Claude Code is opened with WebSearch on, Codex with live
//    search. The runner built the run's environment without its plane, so neither was.
// 2. The tool's setting now, not the frozen plane, decides each search: web_search set to deny or ask after the run was
//    made (its plane still says native) refuses Claude Code's next WebSearch, or parks the run on the person with nothing
//    searched, and Codex's requests stop offering the provider its search.
//
// Claude Code runs on the scripted Agent SDK (no CLI, no key, no network); Codex on its pinned binary against a scripted
// fetch (no network). Without the binary the Codex cases skip; with AGENTRUN_CODEX_REQUIRE_BINARY=1 (CI) they fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fakeAnthropic, fakeSdk } from "@parcha/agentrun-harness-claude/testing";
import { findCodex } from "../../run-adapters-codex/dist/binary.js";
import { verifyCodexBinary } from "../../run-adapters-codex/dist/verify.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { STATE } from "./fixtures/native-search-table.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { cliRunSpecFromLaunch } = await import("../dist/runner/cli-run-spec.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { saveToolSettings } = await import("../dist/tool-plane.js");
const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { NATIVE_SEARCH_ALLOWANCE_TOKENS } = await import("../dist/cap.js");

process.env.AGENTRUN_CLAUDE_AGENT_STANDIN = "1";
const TABLE = new URL("./fixtures/native-search-table.mjs", import.meta.url).pathname;
const SEAL_KEY = Buffer.alloc(32, 7);
const RUN = "run-1";
const fake = (name) => `not-a-secret-${name}`;
const pinned = verifyCodexBinary(findCodex());
const skipCodex = pinned instanceof Error && process.env.AGENTRUN_CODEX_REQUIRE_BINARY !== "1" ? pinned.message : false;

/** Each harness's gateway environment and its launch's model, as the run's own requests take them. */
const HARNESSES = {
  "claude-agent": { env: (url) => ({ ANTHROPIC_API_KEY: fake("anthropic"), ANTHROPIC_BASE_URL: url }), model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } },
  codex: { env: (url) => ({ AGENT_MODEL_BASE_URL: `${url}/v1`, AGENT_MODEL: "gpt-6.1-terra", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "1,2,0.5" }), model: { provider: "openai", modelId: "gpt-6.1-terra" } },
};
/** The options each harness's own adapter is built with where the run's plane resolves web_search to native. */
const NATIVE = { "claude-agent": { webSearch: true, webSearchAllowance: NATIVE_SEARCH_ALLOWANCE_TOKENS }, codex: { webSearch: "live" } };

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// Codex's provider, scripted in the Responses API's format: each request that offers the provider its search is answered
// with a search it ran, then a message; one that does not, with the message alone.
const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110 };
const sse = (n, items, searches) => [
  { type: "response.created", response: { id: `resp_${n}`, object: "response", status: "in_progress" } },
  ...items.flatMap((item, i) => [{ type: "response.output_item.added", output_index: i, item: { ...item, status: "in_progress" } }, { type: "response.output_item.done", output_index: i, item }]),
  { type: "response.completed", response: { id: `resp_${n}`, object: "response", status: "completed", output: items, usage, tool_usage: { web_search: { num_requests: searches } } } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const search = (n) => ({ type: "web_search_call", id: `ws_${n}`, status: "completed", action: { type: "search", query: `agentrun ${n}` } });
const say = (n) => ({ type: "message", role: "assistant", id: `msg_${n}`, status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] });
/** Whether a request body offers the provider its web search tool. */
const offersSearch = (body) => (body.tools ?? []).some((tool) => tool.type === "web_search" || tool.type === "web_search_preview");

/**
 * A run of `harness` on its real adapter, granted web_search, made with a plane that resolves it to native (as a launch
 * where web_search was allow freezes it), then, before the runner claims it, the server's web_search set to `setting`
 * (none: left as it was). Claude Code's "model" searches at every message it is sent; Codex's provider searches at every
 * request that offers it its search. The run's row once it rests, the options each adapter was built with, Claude Code's
 * PreToolUse answers for WebSearch, and Codex's provider requests.
 */
async function nativeRun(t, harness, setting) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-native-search-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const gw = await startFauxGateway();
  const provider = await fakeAnthropic({ reply: () => ({ text: "ok" }) });
  const decided = [];
  const requests = [];
  const state = {
    opened: [],
    // Claude Code's "model" searches at the run's input and at a resume's nudge, and says it is done at anything else.
    claude: { provider, sdk: fakeSdk({ mirrorLagMs: 10, script: (text) => (/Search for agentrun|^Continue\.$/.test(text) ? 'builtin WebSearch {"query":"agentrun"}' : "Done."), onDecision: (d) => decided.push(d) }) },
    codex: {
      sessionsDir: join(dir, "codex-sessions"),
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        const n = requests.length;
        return new Response(sse(n, offersSearch(body) ? [search(n), say(n)] : [say(n)], offersSearch(body) ? 1 : 0), { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    },
  };
  globalThis[STATE] = state;
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await provider.close();
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    delete globalThis[STATE];
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Searches" }, { id: "rev-1", kind: "agentic", body: { instructions: "Search the web for agentrun.", harness, tools: ["web_search"] } });
  const launch = { input: { content: "Search for agentrun." }, title: "t", place: { mode: "runner" }, harness, model: HARNESSES[harness].model, plane: { web_search: "native" } };
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
  if (setting) await saveToolSettings(server, { web_search: { permission: setting } });
  await server.flush?.();
  // The harness table loads a test's module only under a test runner (harness-table.ts): the flag is handed the runner.
  const env = { ...HARNESSES[harness].env(gw.url), AGENTRUN_HARNESS_TABLE: TABLE, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1", PATH: process.env.PATH };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => assert.fail("a CLI run takes no pi route"), computerForClaim: async () => ({ release: async () => {} }) };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({
      launchOf: (runId) => store.runs.launch(runId),
      resolve: (name, given) => (name === harness ? createAdapterLoop((claim, run) => cliRunSpecFromLaunch(given, run, deps, claim)) : undefined),
    }),
  });
  /** The run's row once it rests in one of `states`. */
  const rest = (states = ["ended", "failed", "stopped", "parked"]) => until(async () => {
    const now = await server.runs.get(RUN);
    return states.includes(now.state) && now.runner === null && now;
  }, `the run's rest (${states.join(", ")})`);
  const row = await rest();
  return { row, opened: state.opened, searches: decided.filter((d) => d.name === "WebSearch"), decided, requests, server, rest };
}

/** The asks on the run's journal, as the person's cards: each call id asked about. */
async function asksOf(server) {
  const row = await server.runs.get(RUN);
  const { entries } = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  return entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data?.callId);
}

const describe = (row) => JSON.stringify({ state: row.state, summary: row.summary });

test("a claude-agent run whose plane resolves web_search to native is opened with Claude Code's WebSearch on, and its search runs", { timeout: 120_000 }, async (t) => {
  const { row, opened, searches } = await nativeRun(t, "claude-agent");
  assert.deepEqual(opened, [{ harness: "claude-agent", options: NATIVE["claude-agent"] }], "the adapter built with WebSearch on, from the run's plane");
  assert.equal(row.state, "ended", describe(row));
  assert.ok(searches.length >= 1 && searches.every((d) => d.decision === "allow"), `its searches ran: ${JSON.stringify(searches)}`);
});

test("a codex run whose plane resolves web_search to native is opened with Codex's live search on, and its requests offer it", { skip: skipCodex, timeout: 120_000 }, async (t) => {
  const { row, opened, requests } = await nativeRun(t, "codex");
  assert.deepEqual(opened, [{ harness: "codex", options: NATIVE.codex }], "the adapter built with live search, from the run's plane");
  assert.equal(row.state, "ended", describe(row));
  assert.ok(requests.length >= 1 && requests.every(offersSearch), `its requests offered the provider its search: ${JSON.stringify(requests.map((b) => (b.tools ?? []).map((tool) => tool.type)))}`);
});

test("web_search set to deny after a claude-agent run was made with it native: Claude Code's WebSearch is refused, though the plane still says native", { timeout: 120_000 }, async (t) => {
  const { row, opened, searches } = await nativeRun(t, "claude-agent", "deny");
  assert.deepEqual(opened, [{ harness: "claude-agent", options: NATIVE["claude-agent"] }], "WebSearch on, from the frozen plane");
  assert.equal(row.state, "ended", describe(row));
  assert.ok(searches.length >= 1, "the model searched");
  assert.deepEqual(searches.filter((d) => d.decision === "allow"), [], `no search ran: ${JSON.stringify(searches)}`);
  assert.ok(searches.every((d) => /deny/.test(d.reason ?? "")), `refused in the gate's words: ${JSON.stringify(searches)}`);
});

test("web_search set to ask after a claude-agent run was made with it native: the run parks on the person and nothing is searched", { timeout: 120_000 }, async (t) => {
  const { row, searches } = await nativeRun(t, "claude-agent", "ask");
  assert.equal(row.state, "parked", describe(row));
  assert.deepEqual(searches.filter((d) => d.decision === "allow"), [], `no search ran while the person had not answered: ${JSON.stringify(searches)}`);
});

test("web_search set to ask on a claude-agent run: the person's approval lets the held search run once, on its one card, and the run ends", { timeout: 120_000 }, async (t) => {
  const { row, decided, server, rest } = await nativeRun(t, "claude-agent", "ask");
  assert.equal(row.state, "parked", describe(row));
  assert.deepEqual(decided.filter((d) => d.name === "WebSearch" && d.decision === "allow"), [], "nothing searched while it waits");
  const parkedAt = decided.length;
  const asks = await asksOf(server);
  assert.equal(asks.length, 1, `one card: ${JSON.stringify(asks)}`);
  await sendCommand(server, RUN, { kind: "approve", body: { approval: asks[0] } });
  const ended = await rest(["ended", "failed", "stopped"]);
  assert.equal(ended.state, "ended", describe(ended));
  assert.deepEqual(decided.slice(parkedAt).filter((d) => d.name === "WebSearch").map((d) => d.decision), ["allow"], `the search ran once, after the approval: ${JSON.stringify(decided)}`);
  assert.deepEqual(await asksOf(server), asks, "no second card");
});

// From #2486 (its CLI case, folded in here): end to end through the API, the server's web_search picked native, each CLI
// harness's adapter is built with its own search on the runner. The faux harness stands in for each CLI (fauxTable), and
// what each adapter would be built with is filed (faux-harness.mjs `opened`).
test("a CLI run whose web_search is picked native gets its harness's own search on the runner: claude-agent's adapter is built with its WebSearch, codex's with live search", { timeout: 120_000 }, async (t) => {
  const { fauxTable } = await import("./fixtures/faux-table.mjs");
  const harness = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
  const opened = join(await scratch(t), "opened.jsonl");
  withEnv(t, { ANTHROPIC_API_KEY: fake("anthropic"), AGENT_MODEL: "anthropic/claude-sonnet-5-5", OPENAI_API_KEY: fake("openai"), AGENTRUN_TEST_FAUX_HARNESS_OPENED: opened }, ["AGENT_MODEL_BASE_URL", "OPENROUTER_API_KEY", "ANTHROPIC_BASE_URL", "PARALLEL_API_KEY"]);
  const { api } = await serve(t, { faux: undefined, harnessTable: fauxTable(harness) });
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "native" } })).status, 200);
  for (const [id, model] of [["claude-agent", "anthropic/claude-sonnet-5-5"], ["codex", "openai/gpt-6.1-terra"]]) {
    assert.equal((await api("POST", "/agents", agent(`own-${id}`, { harness: id, model, tools: ["web_search"] }))).status, 201);
    const started = await api("POST", `/agents/own-${id}/runs`, { input: { content: "hi" } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  }
  const said = readFileSync(opened, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.harness);
  assert.deepEqual(said.map((entry) => [entry.harness, entry.options.webSearch]), [["claude-agent", true], ["codex", "live"]], JSON.stringify(said));
});

test("the runner's read of a tool's setting for the session fails closed: a store that stops reading after an allow is a deny, never the last allow", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-native-search-read-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await saveToolSettings(server, { web_search: { permission: "allow" } });
  let reads = true;
  const store = { settings: { get: async (key) => { if (!reads) throw new Error("the store does not answer"); return server.settings.get(key); }, put: (key, value) => server.settings.put(key, value) } };
  const gate = await adapterRunGate(store, { runId: RUN }, { kind: "agentic", body: {} }, dir);
  assert.equal(await gate.permission("web_search"), "allow", "read from the store");
  reads = false;
  assert.equal(await gate.permission("web_search"), "deny", "a failed read is a deny");
  reads = true;
  await saveToolSettings(server, { web_search: { permission: "ask" } });
  assert.equal(await gate.permission("web_search"), "ask", "read again once the store answers");
});

for (const setting of ["deny", "ask"]) {
  test(`web_search set to ${setting} after a codex run was made with it native: no request offers the provider its search, though the plane still says native`, { skip: skipCodex, timeout: 120_000 }, async (t) => {
    const { row, opened, requests } = await nativeRun(t, "codex", setting);
    assert.deepEqual(opened, [{ harness: "codex", options: NATIVE.codex }], "live search, from the frozen plane");
    assert.equal(row.state, "ended", describe(row));
    assert.ok(requests.length >= 1, "the run reached the provider");
    assert.deepEqual(requests.filter(offersSearch).map((b) => b.tools.map((tool) => tool.type)), [], `no request offered web_search under ${setting}`);
  });
}
