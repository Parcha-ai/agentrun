// pi on the runner spending its cap down, as spend-cap-clamp.test.mjs holds it for claude-agent and codex: a capped pi run
// takes its requests while what is left of the cap buys each one's least (1,024 answer tokens), and the one it cannot is
// refused before it is sent. That request is no model request: nothing reaches the provider for it, the run's spend never
// passes its cap, the run pauses at its cap in the cap's words, and its timeline counts the requests that were sent. pi
// through the adapter loop (runner/adapter-loop.ts) on a real store and runner, its model through the session's proxy to
// a scripted Anthropic Messages origin, priced on output only ($100 a million: $0.0001 a token).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { closeOpenSessions, hostTools, MODEL } from "./conformance-pi-adapter.mjs";
import { capRun, quiet, specCap } from "./adapter-pi-cap-support.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");
after(closeOpenSessions);

const PER_TOKEN = 100 / 1e6;
const PRICED = Object.freeze({ id: MODEL, api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

/** Anthropic's Messages API answering three `look` calls and then the answer, the n-th answer `outputs[n]` output tokens. */
function lookingOrigin(sent, outputs) {
  return async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    sent.push(body);
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    const start = { type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 1 } } };
    const blocks = step < 3
      ? [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${step}`, name: "look", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 0 }]
      : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looked." } }, { type: "content_block_stop", index: 0 }];
    return sse([start, ...blocks, { type: "message_delta", delta: { stop_reason: step < 3 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: outputs[step] ?? 10 } }, { type: "message_stop" }]);
  };
}

test("pi: a run that spends its cap down is refused once what is left cannot buy 1,024 tokens, saying so; the refused request is no model request, the spend never passes the cap, and the run pauses at its cap", async (t) => {
  // $0.105 passes the least ($0.1024). The first request is admitted with 1,050 tokens and costs $0.001, the second with
  // 1,040 and costs $0.002; then $0.102 is left, 1,020 tokens: the third is refused before it is sent.
  const capUsd = 0.105;
  const provider = { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` };
  const look = { look: { name: "look", replaySafe: true, run: async () => "seen" } };
  const { row, sent, server } = await capRun(t, {
    specOf: (got) => (_claim, run) => ({
      adapter: piAdapter({ run, model: MODEL, provider, fetch: lookingOrigin(got, [10, 20, 40, 10]), price: (_model, usage) => (usage.output ?? 0) * PER_TOKEN }),
      session: { key: "root", label: "root", system: ["Look three times, then answer."], tools: hostTools(look), context: "fresh" },
      input: "Look three times, then answer.",
      hooks: quiet,
      gate: () => "allow",
    }),
    runCap: { capUsd: () => capUsd, modelOf: (id) => (id === MODEL ? PRICED : undefined) },
    cap: specCap(capUsd),
  });
  assert.equal(sent.length, 2, `two requests reached the provider, the third refused unsent: ${sent.length}`);
  assert.equal(row.state, "parked", JSON.stringify({ state: row.state, summary: row.summary }));
  // It spent $0.003: under a cent, but never "$0", which would say it spent nothing.
  assert.match(row.summary ?? "", /^Not sent: this run has spent less than a cent of its \$0\.105 cap, and the next step needs at least \$0\.11\. Raise the cap to at least \$0\.11 to continue\.$/);
  // Its timeline counts the requests that were sent, two, never three, at what they cost ($0.003), never past its cap; and
  // no row says the refused one failed.
  const rows = await runTimeline(server, "run-1", BACKGROUND_CONTEXT, { settled: true });
  const usage = rows.findLast((r) => r.kind === "usage")?.usage;
  assert.equal(usage?.requests, 2, JSON.stringify(usage));
  assert.ok(Math.abs((usage?.usd ?? 0) - 0.003) < 1e-9 && usage.usd <= capUsd, `spent $0.003: ${JSON.stringify(usage)}`);
  for (const r of rows) {
    assert.doesNotMatch(String(r.summary ?? ""), /over 3 model requests/, JSON.stringify(r));
    assert.doesNotMatch(String(r.summary ?? ""), /Model request failed/, JSON.stringify(r));
  }
});

test("the control: the same run under a cap that buys every request's least takes all four and ends, each booked once", async (t) => {
  const provider = { api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"x"}` };
  const look = { look: { name: "look", replaySafe: true, run: async () => "seen" } };
  const { row, sent, server } = await capRun(t, {
    specOf: (got) => (_claim, run) => ({
      adapter: piAdapter({ run, model: MODEL, provider, fetch: lookingOrigin(got, [10, 20, 40, 10]), price: (_model, usage) => (usage.output ?? 0) * PER_TOKEN }),
      session: { key: "root", label: "root", system: ["Look three times, then answer."], tools: hostTools(look), context: "fresh" },
      input: "Look three times, then answer.",
      hooks: quiet,
      gate: () => "allow",
    }),
    runCap: { capUsd: () => 1, modelOf: (id) => (id === MODEL ? PRICED : undefined) },
    cap: specCap(1),
  });
  assert.deepEqual([row.state, sent.length], ["ended", 4], JSON.stringify({ state: row.state, summary: row.summary }));
  const usage = (await runTimeline(server, "run-1", BACKGROUND_CONTEXT, { settled: true })).findLast((r) => r.kind === "usage")?.usage;
  assert.equal(usage?.requests, 4, JSON.stringify(usage));
  assert.ok(Math.abs((usage?.usd ?? 0) - 0.008) < 1e-9, `$0.001 + $0.002 + $0.004 + $0.001: ${JSON.stringify(usage)}`);
});
