// An agent saved with a cap below what its model needs for one more step and an answer: each of its runs would wrap up at
// its first tool call (wrap-up.ts). The save warns, in the wrap-up's own words and figure, and never refuses (the cap is
// the person's call): on Codex on GPT-6.1 Sol at medium effort, its first request carries Codex's own some 12,200 tokens
// before the agent's prompt, so it needs about $0.32 (its least, a step-0 step and a least answer), and a $0.25 cap warns
// while a $1 cap does not; an edit to a cap that holds it clears the warning. pi states its own base input beside its
// adapter, measured here on the first request a run sends through its spec. Dummy keys; nothing reaches a provider.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { agent, serve, withEnv } from "./support.mjs";
import { specFor } from "./runner-spec-support.mjs";
import { capRun, quiet, specCap } from "./adapter-pi-cap-support.mjs";
import { closeOpenSessions } from "./conformance-pi-adapter.mjs";

const { o200kTokens } = await import("@parcha/agentrun-kernel/host");
const { piAdapter, PI_BASE_INPUT_TOKENS } = await import("../dist/runner/adapters/pi.js");
after(closeOpenSessions);

const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "AGENT_THINKING", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_CODEX_STANDIN", "AGENTRUN_SERVE_CODEX_STANDIN", "AGENTRUN_OPENCODE_STANDIN", "AGENTRUN_SERVE_OPENCODE_STANDIN"];
const CODEX_STAND_IN_FILE = fileURLToPath(new URL("../../run-adapters-codex/test/fake-app-server.mjs", import.meta.url));
const CODEX_STAND_IN = { AGENTRUN_CODEX_STANDIN: "1", AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [CODEX_STAND_IN_FILE], env: { FAKE_CODEX_MODEL: "remote" } }) };
const SOL = "openai/gpt-6.1-sol";
const SHORT = "This agent's cap of $0.25 is below what gpt-6.1-sol at medium effort needs for one more step and an answer, about $0.32: a run will wrap up at its first tool call.";
const capWarnings = (body) => (body?.warnings ?? []).filter((w) => w.field === "definition.max_cost_usd");

/** serve with a dummy OpenAI key (no faux model), Sol the host's model, and Codex's stand-in. */
async function onSol(t) {
  withEnv(t, { OPENAI_API_KEY: "not-a-secret", AGENT_MODEL: SOL, ...CODEX_STAND_IN }, NAMES);
  return serve(t, { faux: undefined });
}

test("Codex on GPT-6.1 Sol at medium effort saved with a $0.25 cap warns that it is below one more step and an answer (about $0.32) and saves; with a $1 cap it does not", { timeout: 60_000 }, async (t) => {
  const { api } = await onSol(t);
  const short = await api("POST", "/agents", agent("sol-short", { harness: "codex", model: SOL, thinking: "medium", max_cost_usd: 0.25 }));
  assert.equal(short.status, 201, JSON.stringify(short.body));
  assert.deepEqual(capWarnings(short.body).map((w) => w.message), [SHORT], JSON.stringify(short.body.warnings));
  const held = await api("POST", "/agents", agent("sol-held", { harness: "codex", model: SOL, thinking: "medium", max_cost_usd: 1 }));
  assert.equal(held.status, 201, JSON.stringify(held.body));
  assert.deepEqual(capWarnings(held.body), [], JSON.stringify(held.body.warnings));
  // An edit that raises the cap past the need clears the warning; one that keeps it below says it again.
  const { version: _, ...current } = (await api("GET", "/agents/sol-short")).body.definition;
  const again = await api("PUT", "/agents/sol-short/definition", { definition: { ...current, instructions: "Answer, edited." } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(capWarnings(again.body).map((w) => w.message), [SHORT]);
  const { version: __, ...edited } = (await api("GET", "/agents/sol-short")).body.definition;
  const raised = await api("PUT", "/agents/sol-short/definition", { definition: { ...edited, max_cost_usd: 1 } });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  assert.deepEqual(capWarnings(raised.body), []);
});

test("with no effort saved or set on the host, the warning names the model alone, priced at its least answer with no reasoning", { timeout: 60_000 }, async (t) => {
  const { api } = await onSol(t);
  // Sol's least with no effort: 12,200 tokens in at the cache write's $2.50 and a 1,024-token answer at $10, $0.0408;
  // a step-0 step $0.0715; so $0.1531 in all.
  const short = await api("POST", "/agents", agent("sol-plain", { harness: "codex", model: SOL, max_cost_usd: 0.1 }));
  assert.equal(short.status, 201, JSON.stringify(short.body));
  assert.deepEqual(capWarnings(short.body).map((w) => w.message), ["This agent's cap of $0.10 is below what gpt-6.1-sol needs for one more step and an answer, about $0.16: a run will wrap up at its first tool call."]);
});

test("pi on Claude Sonnet 5.5 through a gateway thinks with a budget, so its least output carries Claude's 1,024-token thinking minimum: a $0.075 cap, above the $0.064 of an answer alone and below the $0.084 with the minimum, warns", { timeout: 60_000 }, async (t) => {
  // The gateway is never reached: a save prices the first request, it sends nothing. Sonnet 5.5 at the gateway's $2/$10:
  // pi's 280 tokens in, and its least output a 1,024-token answer plus the 1,024-token thinking minimum its budgeted
  // thinking adds; with a step-0 step, $0.08402 in all (an answer alone, $0.06354). pi sends that model no
  // output_config, so the words name no effort. Sonnet 5.5 cannot stop reasoning, so with no effort saved pi thinks at
  // its lowest level, budgeted too.
  withEnv(t, { AGENT_MODEL_BASE_URL: "https://gateway.invalid/api/v1", AGENT_MODEL_API_KEY: "not-a-secret", AGENT_MODEL: "anthropic/claude-sonnet-5.5" }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  const words = "This agent's cap of $0.075 is below what anthropic/claude-sonnet-5.5 needs for one more step and an answer, about $0.09: a run will wrap up at its first tool call.";
  for (const [id, thinking] of [["sonnet-medium", "medium"], ["sonnet-default", undefined]]) {
    const saved = await api("POST", "/agents", agent(id, { ...(thinking ? { thinking } : {}), max_cost_usd: 0.075 }));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(capWarnings(saved.body).map((w) => w.message), [words], `${id}: ${JSON.stringify(saved.body.warnings)}`);
  }
  // A cap past the minimum's figure holds it.
  const held = await api("POST", "/agents", agent("sonnet-held", { thinking: "medium", max_cost_usd: 0.09 }));
  assert.equal(held.status, 201, JSON.stringify(held.body));
  assert.deepEqual(capWarnings(held.body), [], JSON.stringify(held.body.warnings));
});

const sse = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
/** A Responses answer of one message, as OpenAI streams it. */
function answered() {
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] };
  const usage = { input_tokens: 120, output_tokens: 12, total_tokens: 132 };
  return sse([
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "Done." },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage } },
  ]);
}

test("pi's base input (PI_BASE_INPUT_TOKENS) is at or under what its first request on GPT-6.1 Sol carries before the agent's prompt, with no tool granted, and within 16 tokens of it", { timeout: 60_000 }, async (t) => {
  const INSTRUCTIONS = "Answer.";
  const { spec } = await specFor(t, { body: { instructions: INSTRUCTIONS, tools: [] } });
  const SOL_CAP = Object.freeze({ id: "gpt-6.1-sol", api: "openai-responses", price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, outputCeiling: 128_000, reasoning: true });
  const { row, sent } = await capRun(t, {
    specOf: (sent) => (_claim, run) => ({ adapter: piAdapter({ run, model: SOL_CAP.id, provider: { api: "openai-responses", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: async (_url, init = {}) => (sent.push(JSON.parse(String(init.body ?? "{}"))), answered()), price: () => 0 }), session: { ...spec.session, key: "root", label: "root", context: "fresh" }, input: "Do the thing.", hooks: quiet, gate: () => "allow" }),
    runCap: { capUsd: () => 5, modelOf: () => SOL_CAP },
    cap: specCap(5),
  });
  assert.equal(row.state, "ended", JSON.stringify(row));
  const [first] = sent;
  // pi writes no system prompt of its own: serve's lines around the agent's instructions, and the host's code mode tool.
  const system = first.input.find((item) => item.role === "system" || item.role === "developer");
  assert.ok(system && typeof system.content === "string" && system.content.includes(INSTRUCTIONS), JSON.stringify(first.input));
  assert.deepEqual(first.tools.map((tool) => tool.name), ["codemode"]);
  const tools = first.tools.map((tool) => `${tool.name}\n${tool.description ?? ""}\n${JSON.stringify(tool.parameters ?? {})}`).join("\n");
  const measured = (await o200kTokens(system.content.replace(INSTRUCTIONS, ""))) + (await o200kTokens(tools));
  t.diagnostic(`pi's first request before the agent's prompt: ${measured} tokens (stated ${PI_BASE_INPUT_TOKENS})`);
  assert.ok(PI_BASE_INPUT_TOKENS <= measured && measured - PI_BASE_INPUT_TOKENS <= 16, `stated ${PI_BASE_INPUT_TOKENS}, measured ${measured}`);
});
