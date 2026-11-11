// The server follows the store for each run's end (server.ts readEnds, every 250 ms) and tells it once: the run's notice,
// its summary with its words redacted, is built only for an end not told yet. An ended run already told is never read or
// redacted again by that follower, however many reads come after: before, every ended run among the newest 50 was
// summarized and redacted on every read, 4 times a second, for good (graph-redact's second-read count rose by its 12
// strings whenever a read fell between two graph GETs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { flowAgent, follow, serve } from "./support.mjs";
import * as refusal from "../dist/key-refusal.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A workflow run whose input and output are words (its summary redacts them, a pass each): one llm call. */
const flow = {
  v: 2, name: "ended-told",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: "answer" },
  root: { node: "chain", steps: [{ node: "call", label: "answer", via: "tool", tool: "llm", args: { prompt: "Answer in a sentence." }, out: "Llm", as: "answer", deadline_s: 60 }] },
};

test("an ended run whose end was told is never summarized again: a second of the end follower's reads redacts nothing", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", flowAgent("ended-told", flow, { tools: ["llm"] }))).status, 201);
  const started = await api("POST", "/agents/ended-told/runs", { input: { question: "What is the answer, in a sentence?" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  // Its end told: the follower's next read after the run reads final (250 ms each), with room for the runner's last writes.
  await sleep(1_500);
  // Nothing reads the run now but the end follower, which reads every 250 ms: four reads in a second.
  const before = refusal.answerPasses.count;
  await sleep(1_000);
  assert.equal(refusal.answerPasses.count - before, 0, "the end follower read and redacted the told run's summary again");
});
