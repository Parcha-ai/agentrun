// The smallest cap a pi run on Sonnet can work under, in `strict` cap mode and in `expected` (the default), as serve's
// README states them, held to what the cap does. The run is
// a desktop agent's through the dispatch's own spec (its system prompt and tools: read, write, edit and the desktop's),
// five model requests: four screenshots, then the answer. Each step is admitted only when what the run spent plus the
// step's least fits the cap; a step's least is its whole input bound at the cache-write price ($3.75 a million) and a
// 1,024-token answer ($15 a million). The answers' usage is a desktop run's on Sonnet (3,146 tokens written to the cache
// at first, then 1,300 more each step, 40 out), so the run spends about $0.04 in all. So:
//  - through a gateway (OpenRouter: the bound is the bytes, 10,600 tokens at first, about 7,000 of them the computer's
//    tools' definitions), the first request needs $0.055 and the whole run $0.114: $0.12, documented, takes it to its
//    answer, $0.11 parks it before its last step;
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
const GATEWAY_MINIMUM = 0.12;
const DIRECT_MINIMUM = 0.09;
/** A step's least, as the cap prices it here: its input bound at the cache-write price and a 1,024-token answer. */
const leastOf = (bound) => (bound * 3.75 + 1_024 * 15) / 1e6;

const { WRAP_UP_TEXT } = await import("../dist/tool-budget.js");
/** Whether a tool call of the run was refused in the cap's wrap-up words: they are in a request the run sent after it. */
const toldToWrapUp = (sent) => sent.some((body) => JSON.stringify(body.messages ?? []).includes(WRAP_UP_TEXT));
const SONNET = Object.freeze({ id: "claude-sonnet-5-5", api: "anthropic-messages", price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, outputCeiling: 64_000 });
const priceOf = (_model, usage) => ((usage.input ?? 0) * 3 + (usage.output ?? 0) * 15 + (usage.cacheRead ?? 0) * 0.3 + (usage.cacheWrite ?? 0) * 3.75) / 1e6;
const fauxComposer = ({ store, sealKey }) => computerDepsFrom({ env: {}, store, sealKey, faux: fauxComputers() });
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
      ? [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${step}`, name: "computer_screenshot", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 0 }]
      : [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "faux-host" } }, { type: "content_block_stop", index: 0 }];
    return sse([start, ...blocks, { type: "message_delta", delta: { stop_reason: step < 4 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }, { type: "message_stop" }]);
  };
}

/** A pi desktop run on Sonnet under `capUsd`, its model at `origin`: the run's row, what the cap was asked, the requests
 *  sent and the counts asked. */
async function desktopRun(t, capUsd, origin, mode = "strict") {
  const { spec } = await specFor(t, { body: { instructions: TASK, tools: ["read", "write", "edit"], computer: { kind: "desktop", provider: "faux-desktop" } }, computer: fauxComposer });
  const counted = [];
  const provider = { api: "anthropic-messages", origin, credential: () => `not-a-secret-${"x"}` };
  const result = await capRun(t, {
    specOf: (sent) => (_claim, run) => ({ adapter: piAdapter({ run, model: SONNET.id, provider, fetch: desktopOrigin(sent, counted), price: priceOf }), session: { ...spec.session, key: "root", label: "root", context: "fresh" }, input: TASK, hooks: quiet, gate: () => "allow" }),
    // Strict mode: every step's input at the cache-write price, whatever was cached. Expected mode (the default): a step
    // after the first is priced from what the session's previous request read from the cache (the loop's `previous`).
    runCap: { capUsd: () => capUsd, modelOf: () => SONNET, mode },
    cap: specCap(capUsd),
  });
  return { ...result, counted };
}

/** What the run needs to reach its answer: the most, over its steps, of what it spent before a step and that step's least,
 *  read off a run under a cap that never binds. */
async function neededFor(t, origin, mode = "strict") {
  const { asked, row } = await desktopRun(t, 1, origin, mode);
  assert.deepEqual([row.state, asked.length], ["ended", 5], JSON.stringify({ state: row.state, summary: row.summary }));
  return { first: leastOf(asked[0].request.inputTokensMax), whole: Math.max(...asked.map(({ request }) => request.spentUsd + leastOf(request.inputTokensMax))), asked };
}

test("the documented minimums are what the run needs, to the cent above: $0.12 through a gateway, $0.09 straight to Anthropic", async (t) => {
  const gateway = await neededFor(t, "https://openrouter.ai/api");
  const direct = await neededFor(t, "https://api.anthropic.com");
  assert.ok(gateway.asked[0].request.inputTokensMax > 9_000, `through a gateway the first request is read by its bytes: ${gateway.asked[0].request.inputTokensMax}`);
  assert.equal(direct.asked[0].request.inputTokensMax, 3_146 + 675, "straight to Anthropic, by its count and the tool-use prompt");
  assert.deepEqual([gateway.first, direct.first].map((usd) => Math.round(usd * 1000) / 1000), [0.055, 0.03], "the first request's least");
  assert.deepEqual([Math.ceil(gateway.whole * 100) / 100, Math.ceil(direct.whole * 100) / 100], [GATEWAY_MINIMUM, DIRECT_MINIMUM], JSON.stringify({ gateway: gateway.whole, direct: direct.whole }));
});

test("through a gateway, a pi desktop run on Sonnet under $0.04 is refused its first request unsent, in the words that name what it needs", async (t) => {
  const { asked, sent, row } = await desktopRun(t, 0.04, "https://openrouter.ai/api");
  assert.equal(sent.length, 0, "nothing sent");
  assert.match(asked[0]?.answer?.refuse ?? "", /the next step needs at least \$0\.06/, JSON.stringify({ answer: asked[0]?.answer, state: row.state }));
});

// A cent under the minimum: through a gateway the cap's wrap-up (a run keeps back one typical step and one final answer)
// refuses the last screenshot before the spend could park the run, so it is told to answer from what it has and does, in its
// fifth request; straight to Anthropic (a tighter input bound) the cap parks it before its last step.
for (const [route, origin, minimum, underEnds] of [["through a gateway", "https://openrouter.ai/api", GATEWAY_MINIMUM, true], ["straight to Anthropic", "https://api.anthropic.com", DIRECT_MINIMUM, false]]) {
  test(`${route}, the documented minimum ($${minimum}) takes a pi desktop run on Sonnet through four screenshots to its answer; a cent under ${underEnds ? "tells it to answer without its last screenshot" : "parks it before its last step"}`, async (t) => {
    const at = await desktopRun(t, minimum, origin);
    assert.deepEqual([at.row.state, at.sent.length], ["ended", 5], JSON.stringify({ state: at.row.state, summary: at.row.summary }));
    assert.equal(toldToWrapUp(at.sent), false, "at the minimum every screenshot ran: no tool call was refused");
    const under = await desktopRun(t, Math.round((minimum - 0.01) * 100) / 100, origin);
    assert.deepEqual([under.row.state, under.sent.length], underEnds ? ["ended", 5] : ["parked", 4], JSON.stringify({ state: under.row.state, summary: under.row.summary }));
    assert.equal(toldToWrapUp(under.sent), underEnds, "the fourth screenshot was refused in the wrap-up's words only where the run goes on to answer");
    // Further under, the cap parks it before its last step.
    const parked = await desktopRun(t, Math.round((minimum - 0.05) * 100) / 100, origin);
    assert.deepEqual([parked.row.state, parked.sent.length < 5], ["parked", true], JSON.stringify({ state: parked.row.state, sent: parked.sent.length, summary: parked.row.summary }));
  });
}

// Expected mode, the default: a step after the first is priced from what the session's previous request read from the cache
// (cacheRead at $0.30 a million, only what is new at the cache-write price), so the run needs about $0.06 by either route.
// Through a gateway the first request alone needs $0.055 (the computer tools' definitions are read by their bytes), so $0.05
// parks it before anything is sent; straight to Anthropic it parks before the last step.
test("expected mode, the default: $0.06 takes a pi desktop run on Sonnet to its answer by either route; $0.05 parks it (a gateway's first request needs $0.055, so nothing is sent; Anthropic's parks before its last step)", async (t) => {
  for (const origin of ["https://openrouter.ai/api", "https://api.anthropic.com"]) {
    const at = await desktopRun(t, 0.06, origin, "expected");
    assert.deepEqual([at.row.state, at.sent.length], ["ended", 5], `${origin}: ${JSON.stringify({ state: at.row.state, summary: at.row.summary })}`);
    const under = await desktopRun(t, 0.05, origin, "expected");
    assert.deepEqual([under.row.state, under.sent.length], ["parked", origin.includes("openrouter") ? 0 : 4], `${origin}: ${JSON.stringify({ state: under.row.state, summary: under.row.summary })}`);
  }
});
