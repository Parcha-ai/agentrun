// pi through the adapter, end to end: an answer's parallel tool calls share what the model's context window has left.
// pi reports the two facts the kernel's turn budget needs from each answer (its afterResponse hook: the request's input
// tokens and the answer's output, and the tool calls the answer made), and holds each call's result to the smaller of
// its own bound and its share of what is left (afterTool). So four 10k results after a 4,000-token request on a
// 16,384-token window reach the model's next request cut to fit together, where each alone was within its bound.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, MODEL, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";
const { sendCommand } = await import("../dist/runner/commands.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { answerReserve } = await import("@parcha/agentrun-kernel/process");

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
after(closeOpenSessions);

const WINDOW = 16_384;
const HELD = 4_000;
/** The scripted answer's output tokens (scriptedOrigin's). */
const OUTPUT = 10;
const SIZE = 10_000;

test("pi, a 16k window, 4,000 tokens held: four parallel 10k results reach the next request together within the window, each cut to a share", async (t) => {
  const tool = {
    name: "read_big",
    description: "Answers ten thousand characters.",
    inputSchema: { type: "object", properties: { n: { type: "number" } } },
    replay: "safe",
    call: async (args) => ({ text: `START-${args?.n ?? 0} ${"r".repeat(SIZE - 8)}` }),
  };
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const requests = [];
  // The first request holds HELD tokens; the answer to it makes four calls at once.
  const script = [{ calls: [0, 1, 2, 3].map((n) => ({ call: tool.name, args: { n } })) }, { say: "done" }];
  const inputOf = (body) => ((body.messages ?? []).some((m) => m.role === "assistant") ? 100 : HELD);
  const loop = createAdapterLoop(async (_claim, run) => ({
    adapter: piAdapter({ run, redact: run.redact, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch: scriptedOrigin(script, requests, { inputOf }), price: () => 0 }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: [tool], context: "fresh", contextWindow: WINDOW },
    input: "Follow the script.",
    hooks: { beforeIntent: async () => {}, beforeResult: async () => {} },
    gate: () => "allow",
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
  }));
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  await until(async () => {
    const now = await server.runs.get("run-1");
    return ["ended", "failed"].includes(now.state) && now.runner === null && now;
  }, "the run's end", 30_000);
  const next = requests.find((body) => (body.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "tool_result")));
  assert.ok(next, `a request carried the results (${requests.length} requests)`);
  const results = next.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "tool_result");
  assert.equal(results.length, 4, "the four results");
  const texts = results.map((r) => (typeof r.content === "string" ? r.content : (r.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("")));
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  const total = HELD + OUTPUT + Math.ceil(chars / 3);
  assert.ok(total <= WINDOW, `${total} tokens once the results are in (${texts.map((x) => x.length)} characters), past the ${WINDOW}-token window`);
  for (const text of texts) {
    assert.match(text, /^START-\d /, "each keeps its start");
    assert.match(text, /\n\[kept \d+ of 10000 characters: [^\n]*context window[^\n]*\]$/, `each cut to its share, saying so: ${JSON.stringify(text.slice(-160))}`);
  }
});

/** What a turn has for its results, in characters, after a request that held HELD tokens: the window less that and the
 *  room kept for the answer, at three characters a token (the kernel's TurnBudget). */
const ROOM = (WINDOW - HELD - answerReserve(WINDOW)) * 3;

test("pi, a 16k window, 4,000 tokens held: a call of the four that waits for its person, run on the next claim (a fresh session), gets only what the three handed before it left", async (t) => {
  // MUTATION: a reopened pi session's turn budget that knows nothing of the answer: the waiting call takes its whole bound.
  const body = (n) => `START-${n} ${"r".repeat(SIZE - 8)}`;
  const read = { name: "read_big", description: "Answers ten thousand characters.", inputSchema: { type: "object", properties: { n: { type: "number" } } }, replay: "safe", call: async (args) => ({ text: body(args?.n ?? 0) }) };
  const asked = { ...read, name: "read_asked" };
  const { server, runners: [store] } = await stores({ runners: 1 });
  await queue(server, "run-1");
  const requests = [];
  const script = [{ calls: [{ call: asked.name, args: { n: 0 } }, ...[1, 2, 3].map((n) => ({ call: read.name, args: { n } }))] }, { say: "done" }];
  const inputOf = (b) => ((b.messages ?? []).some((m) => m.role === "assistant") ? 100 : HELD);
  const loop = createAdapterLoop(async (_claim, run) => ({
    adapter: piAdapter({ run, redact: run.redact, model: MODEL, provider: { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` }, fetch: scriptedOrigin(script, requests, { inputOf }), price: () => 0 }),
    session: { key: "root", label: "root", system: ["Follow the script."], tools: [asked, read], context: "fresh", contextWindow: WINDOW },
    input: "Follow the script.",
    hooks: { beforeIntent: async () => {}, beforeResult: async () => {} },
    gate: (call) => (call.tool === asked.name ? "ask" : "allow"),
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
  }));
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(() => runner.close());
  const settled = (states) => until(async () => {
    const now = await server.runs.get("run-1");
    return states.includes(now.state) && now.runner === null && now;
  }, `the run ${states.join("/")}`, 30_000);
  const parked = await settled(["parked", "ended", "failed"]);
  assert.equal(parked.state, "parked", "the run waits for its person");
  const records = journalRecords(server.journal({ runId: "run-1", runner: "reader", epoch: parked.epoch, until: 0, from: parked.state }), BACKGROUND_CONTEXT);
  const [ask] = (await records).entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
  assert.equal(ask?.tool, asked.name, "the asked call waits");
  await sendCommand(server, "run-1", { kind: "approve", body: { approval: ask.callId } });
  assert.equal((await settled(["ended", "failed"])).state, "ended");
  const next = requests.findLast((b) => (b.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "tool_result")));
  const results = next.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "tool_result");
  assert.equal(results.length, 4, "the four results");
  const texts = results.map((r) => (typeof r.content === "string" ? r.content : (r.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("")));
  const chars = texts.reduce((sum, text) => sum + text.length, 0);
  assert.ok(chars <= ROOM, `the four together (${texts.map((x) => x.length).join(", ")}) fit what the turn left (${ROOM})`);
  for (const text of texts) assert.match(text, /^START-\d /, "each keeps its start");
});
