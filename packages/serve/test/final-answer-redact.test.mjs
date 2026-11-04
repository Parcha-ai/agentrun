// A run's answer as serve serves it (GET /runs/{id}: result.final_answer, result.output) holds no held secret: the same
// rule as the Timeline (learning's redactSecrets over the values the server holds and handed the run), over the WHOLE
// answer, never cut. The stored record stays as the run wrote it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { agent, flowAgent, follow, serve, withEnv } from "./support.mjs";
import * as refusal from "../dist/key-refusal.js";

const { redactedAnswer, redactedOutput } = refusal;

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
  // A base64 copy's last character or two can mix in the bytes after the key (and its padding), so they stay: no key
  // material, as noKey shows.
  assert.match(run.result.final_answer, /^Here it is: \[redacted\] and \[redacted\][A-Za-z0-9+/=]{0,3}\. The rest stays\.$/, run.result.final_answer);
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

test("a workflow output carrying a held key as a property name, nested too, is served with no piece of it", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: CUT_KEY }, NAMES);
  const { api } = await serve(t);
  const flow = {
    v: 2, name: "named",
    schemas: {
      In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
      Out: { type: "object", required: ["note", "n", "dict"], properties: { note: { type: "string" }, n: { type: "number" }, dict: { type: "object", additionalProperties: true } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Out", path: "out" },
    root: { node: "chain", steps: [{ node: "extract", label: "out", instructions: "Submit the held key as a name.", out: "Out", as: "out" }] },
  };
  assert.equal((await api("POST", "/agents", flowAgent("named", flow))).status, 201);
  const started = await api("POST", "/agents/named/runs", { input: { question: "x" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  noKey(JSON.stringify(run), "the run");
  assert.deepEqual(run.result.output, { note: "ok", n: 1, dict: { "[redacted]": "found", nested: { "[redacted]": "deep", kept: "yes" } } });
});

test("two property names that redact to the same name withhold their object whole, never merge one value over the other", () => {
  const out = redactedOutput({ keep: 1, both: { [CUT_KEY]: "a", [`${CUT_KEY}-2`]: "b" }, [CUT_KEY]: "top" }, [CUT_KEY, `${CUT_KEY}-2`]);
  noKey(JSON.stringify(out), "the output");
  assert.deepEqual(out, { keep: 1, both: "[redacted]", "[redacted]": "top" });
});

// A view reads the answer the server already redacted for this run and these held values: a console polls a run's view,
// and an answer a run was made to write can be large.
test("a run's view redacts its answer once per held key set: a second view reads nothing again", { timeout: 90_000 }, async (t) => {
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: CUT_KEY }, NAMES);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("long-sk"))).status, 201);
  const started = await api("POST", "/agents/long-sk/runs", { input: { content: "Answer with a megabyte of sk- runs." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 80_000 });
  const first = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const read = refusal.answerPasses?.count;
  assert.equal(typeof read, "number", "key-refusal.ts counts the texts redactedAnswer reads");
  const second = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(refusal.answerPasses.count, read, "the second view read the answer from what the first one redacted");
  assert.equal(second.result.final_answer, first.result.final_answer);
  // A run's final answer is kept trimmed, so the last run's space is not in it.
  assert.equal(second.result.final_answer, "[redacted] ".repeat(128).trimEnd(), "each sk- run is redacted whole");
});

test("a value saved as a key after a run's answer was first served is redacted from the next view", { timeout: 90_000 }, async (t) => {
  const later = ["not-a-secret", "later-key-0123456789abcdef"].join("-");
  withEnv(t, { AGENT_MODEL: "openai/gpt-6-sol", OPENAI_API_KEY: CUT_KEY, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, [...NAMES, "AGENTRUN_SEAL_KEY", "PARALLEL_API_KEY"]);
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("later"))).status, 201);
  const started = await api("POST", "/agents/later/runs", { input: { content: "Answer quoting the later key." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 50_000 });
  assert.equal((await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, `Later: ${later} ends here.`, "no key holds it yet");
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: later } })).status, 204);
  assert.equal((await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, "Later: [redacted] ends here.", "saved, it is held");
});

test("an answer of about 1 MB made of sk- runs is redacted in time linear in its length, every run whole", () => {
  const text = `${"sk-".repeat(2730)} `.repeat(128);
  const began = performance.now();
  const out = redactedAnswer(text, [CUT_KEY]);
  const took = performance.now() - began;
  assert.equal(out, "[redacted] ".repeat(128));
  // Each sk- run started again at every third character took about 5 s here; read once, it takes well under a second.
  assert.ok(took < 1500, `took ${Math.round(took)} ms`);
});

test("an sk- run, a key after a dash inside it, and a held value inside one are redacted as before", () => {
  const tail = "A".repeat(24);
  assert.equal(redactedAnswer(`pre sk-sk-sk-${tail} post`, []), "pre [redacted] post");
  assert.equal(redactedAnswer(`pre x-sk-${tail}-sk-${tail} post`, []), "pre x-[redacted] post");
  assert.equal(redactedAnswer(`a sk-${tail}${CUT_KEY}${tail} b`, [CUT_KEY]), "a [redacted] b");
  assert.equal(redactedAnswer(`a xoxb-xoxb-${"1".repeat(12)} b`, []), "a [redacted] b");
});
