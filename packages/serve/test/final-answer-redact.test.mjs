// A run's answer as serve serves it (GET /runs/{id}: result.final_answer, result.output) holds no held secret: the same
// rule as the Timeline (learning's redactSecrets over the values the server holds and handed the run), over the WHOLE
// answer, never cut. The stored record stays as the run wrote it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, flowAgent, follow, serve, withEnv } from "./support.mjs";

const CUT_KEY = `not-a-secret-${"cut-key-0123456789abcdef"}`;
const NAMES = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
const pieces = (value) => Array.from({ length: value.length - 7 }, (_, i) => value.slice(i, i + 8));
const ENCODED = Buffer.from(CUT_KEY).toString("base64");
const noKey = (text, where) => {
  for (const piece of [...pieces(CUT_KEY), ...pieces(ENCODED)]) assert.ok(!text.includes(piece), `${where} holds ${piece}`);
};

async function answered(t, content) {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: CUT_KEY }, NAMES);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("quotes"))).status, 201);
  const started = await api("POST", "/agents/quotes/runs", { input: { content } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
  return (await api("GET", `/runs/${started.body.run_id}`)).body;
}

test("a run's final answer quoting a held key, plainly and base64-encoded, is served with neither, and the rest of it intact", { timeout: 60_000 }, async (t) => {
  const run = await answered(t, "Answer quoting the held key.");
  noKey(JSON.stringify(run), "the run");
  assert.match(run.result.final_answer, /^Here it is: \[redacted\] and \[redacted\]\. The rest stays\.$/, run.result.final_answer);
});

test("a long final answer (about 50 KB) quoting a held key near its end is served whole, not cut, with no piece of the key", { timeout: 60_000 }, async (t) => {
  const run = await answered(t, "Answer at length quoting the held key.");
  const answer = run.result.final_answer;
  noKey(answer, "the answer");
  assert.ok(answer.startsWith("word word "), answer.slice(0, 40));
  assert.ok(answer.endsWith("near the end [redacted] done."), answer.slice(-60));
  assert.equal(answer.length, "word ".length * 10_000 + "near the end [redacted] done.".length, "nothing cut");
});

test("a workflow's output carrying a held key in a string field is served with it redacted, the record's shape kept", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: CUT_KEY }, NAMES);
  const { api } = await serve(t);
  const flow = {
    v: 2, name: "keyed",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Out: { type: "object", required: ["note", "n"], properties: { note: { type: "string" }, n: { type: "number" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Out", path: "out" },
    root: { node: "chain", steps: [{ node: "extract", label: "out", instructions: "Submit the held key.", out: "Out", as: "out" }] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("keyed", flow))).status, 201);
  const started = await api("POST", "/agents/keyed/runs", { input: { question: "x" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  noKey(JSON.stringify(run), "the run");
  assert.deepEqual(run.result.output, { note: "kept [redacted] here", n: 7 });
});
