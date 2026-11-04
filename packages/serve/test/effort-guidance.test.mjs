// A run's effort adds a short note on how to work, right after the agent's instructions, and the run's first model
// request carries it: on pi (its gateway client), on claude-agent (the pinned Agent SDK and Claude CLI) and on codex (the
// pinned Codex), each against a loopback gateway that records every request (fixtures/faux-gateway.mjs). A run with no
// effort gets none of the three notes. No key, no network.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

/** The three notes, verbatim. */
const NOTES = {
  low: "Answer directly and keep it short. If you need a fact you don't have, or one that may have changed since your training, search once and use what you find. Cite the sources you use. Don't make a plan, don't write extra files, and don't explore past the question. Stop as soon as the question is answered.",
  medium: "Start with a short plan of two to four steps. When you need facts, run your searches in parallel, prefer recent primary sources, and check each key claim against a second, independent source. Cite what you use. Do the work the plan calls for and no more. Write the answer, then check it once against the question: does it answer every part, and is each claim supported? Fix what's missing, then finish.",
  high: "Be thorough. Before you start, break the task into its parts and plan how to cover each one. Work through the parts in order. Where a part needs facts, search widely: run searches in parallel, read the primary sources, and check every important claim against at least two independent sources. When the parts are done, look for gaps, contradictions and claims you haven't checked, and fill them. Then write the full result, with citations. Before you finish, review it once against the original request, point by point, and fix anything missing or wrong.",
};
/** The agent's instructions: text no harness's own prompt holds, so the request's text that has them is found. */
const INSTRUCTIONS = "Answer in one line: this run checks the effort note.";
/** Each run: an effort, or none. */
const EFFORTS = ["low", "medium", "high", undefined];

/** Every string in a request body, in order. */
const strings = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : []);

/** What a request says of the notes: the ones in the same text as the instructions and after them, and the ones
 *  anywhere in it. */
function notesIn(body) {
  const texts = strings(body);
  const own = texts.find((text) => text.includes(INSTRUCTIONS));
  const after = own === undefined ? [] : Object.keys(NOTES).filter((level) => own.indexOf(NOTES[level]) > own.indexOf(INSTRUCTIONS));
  const anywhere = Object.keys(NOTES).filter((level) => texts.some((text) => text.includes(NOTES[level])));
  return { instructions: own !== undefined, after, anywhere };
}

/** Runs agent `id` at each effort in turn, each run to its end: what each run's first model request (the first the
 *  gateway recorded with the instructions in it) says of the notes, by effort. */
async function firstRequests(api, gateway, id, deadlineMs) {
  const seen = {};
  for (const effort of EFFORTS) {
    const from = gateway.requests.length;
    const run = await api("POST", `/agents/${id}/runs`, { input: { content: "What is the newest Python?" }, ...(effort ? { effort } : {}) });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs });
    const first = gateway.requests.slice(from).find((request) => request.method === "POST" && notesIn(request.body).instructions);
    assert.ok(first, `${id} at ${effort ?? "no effort"}: a model request with the instructions reached the gateway (${gateway.requests.slice(from).map((r) => `${r.method} ${r.path}`).join(", ") || "none"})`);
    seen[effort ?? "none"] = notesIn(first.body);
  }
  return seen;
}

/** Each effort's own note after the instructions, and no other; none for a run with no effort. */
const WANTED = { low: { instructions: true, after: ["low"], anywhere: ["low"] }, medium: { instructions: true, after: ["medium"], anywhere: ["medium"] }, high: { instructions: true, after: ["high"], anywhere: ["high"] }, none: { instructions: true, after: [], anywhere: [] } };

const KEY = (name) => `not-a-secret-${name}`;
/** The model variables each test sets, cleared first (as gateway-effort.test.mjs has them). */
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_GATEWAY_IDS", "AGENT_THINKING", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_CODEX_STANDIN", "AGENTRUN_SERVE_CODEX_STANDIN"];
const noSetpriv = !existsSync("/usr/bin/setpriv") && "no setpriv here";

async function gatewayFor(t) {
  const gateway = await startFauxGateway({ text: "Python 3.15.2." });
  t.after(() => gateway.close());
  return gateway;
}

test("pi: each effort's note follows the instructions in the run's first model request, and a run with no effort has none", { timeout: 180_000 }, async (t) => {
  const gateway = await gatewayFor(t);
  withEnv(t, { AGENT_MODEL_BASE_URL: `${gateway.url}/v1`, AGENT_MODEL_API_KEY: KEY("gateway"), AGENT_MODEL: "openai/gpt-6-sol" }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("pi-effort", { instructions: INSTRUCTIONS }))).status, 201);
  assert.deepEqual(await firstRequests(api, gateway, "pi-effort", 60_000), WANTED);
});

// codex on its pinned binary, through its proxy (the stand-in sends no developer instructions to its model).
test("codex, on its pinned binary: each effort's note follows the instructions in the run's first model request, and a run with no effort has none", { timeout: 400_000, skip: noSetpriv }, async (t) => {
  const gateway = await gatewayFor(t);
  withEnv(t, { AGENT_MODEL_BASE_URL: gateway.url, AGENT_MODEL_API_KEY: KEY("gateway"), AGENT_MODEL: "openai/gpt-6-sol" }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("codex-effort", { harness: "codex", instructions: INSTRUCTIONS }))).status, 201);
  assert.deepEqual(await firstRequests(api, gateway, "codex-effort", 90_000), WANTED);
});

test("claude-agent, on its pinned CLI: each effort's note follows the instructions in the run's first model request, and a run with no effort has none", { timeout: 500_000, skip: noSetpriv }, async (t) => {
  const gateway = await gatewayFor(t);
  withEnv(t, { ANTHROPIC_BASE_URL: gateway.url, ANTHROPIC_API_KEY: KEY("anthropic"), AGENT_MODEL: "anthropic/claude-sonnet-5.5" }, NAMES);
  const { api } = await serve(t, { faux: undefined });
  assert.equal((await api("POST", "/agents", agent("claude-effort", { harness: "claude-agent", instructions: INSTRUCTIONS }))).status, 201);
  assert.deepEqual(await firstRequests(api, gateway, "claude-effort", 120_000), WANTED);
});
