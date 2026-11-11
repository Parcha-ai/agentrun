// The smallest cap a pi run on Sonnet can work under, as docs/run-caps.md states it, held to what the cap does. The run is
// a desktop agent's through the dispatch's own spec (its system prompt and tools: read, write, edit and the desktop's),
// five model requests: four screenshots, then the answer. Each step is admitted only when what the run spent plus the
// step's least fits the cap; a step's least is its whole input bound at the cache-write price ($3.75 a million) and a
// 1,024-token answer ($15 a million). The answers' usage is a desktop run's on Sonnet (3,146 tokens written to the cache
// at first, then 1,300 more each step, 40 out), so the run spends about $0.04 in all. So:
//  - through a gateway (OpenRouter: the bound is the bytes, 8,500 tokens at first), the first request needs $0.047 and
//    the whole run $0.106: $0.11, documented, takes it to its answer, $0.10 parks it before its last step;
//  - straight to Anthropic, each bound is Anthropic's count (3,821 tokens at first with the tool prompt), so the first
//    request needs $0.030 and the whole run $0.083: $0.09, documented, takes it to its answer, $0.08 parks it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { specFor } from "./runner-spec-support.mjs";
import { capRun, quiet, specCap } from "./adapter-pi-cap-support.mjs";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";

const { piAdapter } = await import("../dist/runner/adapters/pi.js");
const { computerDepsFrom } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
after(closeOpenSessions);

/** The minimums docs/run-caps.md states for pi on Sonnet: through a gateway, and straight to Anthropic. */
const GATEWAY_MINIMUM = 0.11;
const DIRECT_MINIMUM = 0.09;
/** A step's least, as the cap prices it here: its input bound at the cache-write price and a 1,024-token answer. */
const leastOf = (bound) => (bound * 3.75 + 1_024 * 15) / 1e6;

const SONNET = Object.freeze({ id: "claude-sonnet-5-5", api: "anthropic-messages", price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000 });
const priceOf = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
const fauxComposer = ({ store, sealKey }) => computerDepsFrom({ env: {}, store, sealKey, faux: fauxComputers({ viewerBase: "http://127.0.0.1:9" }) });
const TASK = "Open a terminal, run hostname, and write what it prints to answer.md in your work folder.";
/** The tokens Anthropic counts for the first request (a desktop run's first turn on Sonnet). */
const FIRST_TOKENS = 3_146;

const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** Anthropic's Messages API for a desktop run: four screenshots, then the answer, each answer's usage a real step's. A
 *  count_tokens request is answered with FIRST_TOKENS plus 1,300 a step. */
function desktopOrigin(sent, counted) {
  return async (url, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    const step = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    if (String(url).endsWith("/count_tokens")) return (counted.push(step), Response.json({ input_tokens: FIRST_TOKENS + 1_300 * step }));
    sent.push(body);
    const usage = { input_tokens: 4, cache_creation_input_tokens: step === 0 ? FIRST_TOKENS : 1_300, cache_read_input_tokens: step === 0 ? 0 : FIRST_TOKENS + 1_300 * (step - 1), output_tokens: 1 };
    const start = { type: "message_start", message: { id: `msg_${step}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage } };
    const blocks = step < 4
      ? [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${step}`, name: "desktop_screen", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 0 }]
      : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "faux-host" } }, { type: "content_block_stop", index: 0 }];
    return sse([start, ...blocks, { type: "message_delta", delta: { stop_reason: step < 4 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }, { type: "message_stop" }]);
  };
}

/** A pi desktop run on Sonnet under `capUsd`, its model at `origin`: the run's row, what the cap was asked, the requests
 *  sent and the counts asked. */
async function desktopRun(t, capUsd, origin) {
  const { spec } = await specFor(t, { body: { instructions: TASK, tools: ["read", "write", "edit"], computer: { kind: "desktop", provider: "faux-desktop" } }, computer: fauxComposer });
  const counted = [];
  const provider = { api: "anthropic-messages", origin, credential: () => `not-a-secret-${"x"}` };
  const result = await capRun(t, {
    specOf: (sent) => (_claim, run) => ({ adapter: piAdapter({ run, model: SONNET.id, provider, fetch: desktopOrigin(sent, counted), price: priceOf }), session: { ...spec.session, key: "root", label: "root", context: "fresh" }, input: TASK, hooks: quiet, gate: () => "allow" }),
    runCap: { capUsd: () => capUsd, modelOf: () => SONNET },
    cap: specCap(capUsd),
  });
  return { ...result, counted };
}

/** What the run needs to reach its answer: the most, over its steps, of what it spent before a step and that step's least,
 *  read off a run under a cap that never binds. */
async function neededFor(t, origin) {
  const { asked, row } = await desktopRun(t, 1, origin);
  assert.deepEqual([row.state, asked.length], ["ended", 5], JSON.stringify({ state: row.state, summary: row.summary }));
  return { first: leastOf(asked[0].request.inputTokensMax), whole: Math.max(...asked.map(({ request }) => request.spentUsd + leastOf(request.inputTokensMax))), asked };
}

test("the documented minimums are what the run needs, to the cent above: $0.11 through a gateway, $0.09 straight to Anthropic", async (t) => {
  const gateway = await neededFor(t, "https://openrouter.ai/api");
  const direct = await neededFor(t, "https://api.anthropic.com");
  assert.ok(gateway.asked[0].request.inputTokensMax > 8_000, `through a gateway the first request is read by its bytes: ${gateway.asked[0].request.inputTokensMax}`);
  assert.equal(direct.asked[0].request.inputTokensMax, 3_146 + 675, "straight to Anthropic, by its count and the tool-use prompt");
  assert.deepEqual([gateway.first, direct.first].map((usd) => Math.round(usd * 1000) / 1000), [0.047, 0.03], "the first request's least");
  assert.deepEqual([Math.ceil(gateway.whole * 100) / 100, Math.ceil(direct.whole * 100) / 100], [GATEWAY_MINIMUM, DIRECT_MINIMUM], JSON.stringify({ gateway: gateway.whole, direct: direct.whole }));
});

test("through a gateway, a pi desktop run on Sonnet under $0.04 is refused its first request unsent, in the words that name what it needs", async (t) => {
  const { asked, sent, row } = await desktopRun(t, 0.04, "https://openrouter.ai/api");
  assert.equal(sent.length, 0, "nothing sent");
  assert.match(asked[0]?.answer?.refuse ?? "", /the next step needs at least \$0\.05/, JSON.stringify({ answer: asked[0]?.answer, state: row.state }));
});

for (const [route, origin, minimum] of [["through a gateway", "https://openrouter.ai/api", GATEWAY_MINIMUM], ["straight to Anthropic", "https://api.anthropic.com", DIRECT_MINIMUM]]) {
  test(`${route}, the documented minimum ($${minimum}) takes a pi desktop run on Sonnet through four screenshots to its answer; a cent under parks it before its last step`, async (t) => {
    const at = await desktopRun(t, minimum, origin);
    assert.deepEqual([at.row.state, at.sent.length], ["ended", 5], JSON.stringify({ state: at.row.state, summary: at.row.summary }));
    const under = await desktopRun(t, Math.round((minimum - 0.01) * 100) / 100, origin);
    assert.deepEqual([under.row.state, under.sent.length], ["parked", 4], JSON.stringify({ state: under.row.state, summary: under.row.summary }));
  });
}
