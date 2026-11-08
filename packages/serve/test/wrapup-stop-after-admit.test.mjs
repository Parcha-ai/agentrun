// A capped run's wrap-up note on another harness, when the request that was admitted carrying it is then refused by a
// stop before it leaves (the booking's `stopped`: a park, a halt or the cancel landing after the request's check). That
// request never starts, so the note was never sent: the next request must carry it. Before, the admission's pending note
// stayed until the next request's check cleared it, which runs after the model proxy has already asked for the note: so
// the first request after the stop (after a park, the resumed turn's first) went without it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { capBefore } from "../dist/cap.js";
import { adapterRun } from "../dist/harness-app.js";

/** Priced on output only, $100 a million: a request's least (1,024 tokens) is $0.1024, its typical (4,096) $0.4096. */
const MODEL = { id: "out-priced-1", name: "out-priced-1", api: "openai-responses", provider: "p", maxTokens: 64_000, contextWindow: 400_000, cost: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 } };
const REQUEST = { inputTokensMax: 1_000, outputTokensAsked: 8_000 };
const runOf = (harness) => ({ harness, env: async () => ({ confinePrefix: () => ["/usr/bin/setpriv", "--no-new-privs", "--"] }) });

test("a request admitted carrying the wrap-up note and refused by a stop before it leaves leaves the note for the next request, which the proxy then asks for and gets", async () => {
  // A $1 cap: the wrap-up is due at step 0 (left $1 under 3 x $0.4096), and a request fits (its least $0.1024).
  const guard = await capBefore(1, MODEL);
  // A stop that lands while the request is admitted: the booking's next check after this request's admission refuses it.
  let stopNext = false;
  const cap = { ...guard, beforeRequest: (request) => { const answer = guard.beforeRequest(request); stopNext = true; return answer; } };
  const cancelled = () => (stopNext ? !(stopNext = false) : false);
  const notes = [];
  const outcomes = [];
  const adapter = {
    id: "noted", version: "0", capabilities: () => ({ fork: false }), check: () => [],
    async open(_spec, io) {
      let ended = Promise.resolve({ status: "completed" });
      return {
        state: "new",
        async send() {
          // As the model proxy does: ask for the note as it places it, then admit the request carrying it.
          const words = io.models.note(MODEL.id, REQUEST);
          notes.push(words);
          const outcome = words === undefined ? "no note" : await io.models.beforeRequest({ model: MODEL.id, ...REQUEST, noted: true, inputTokensMax: REQUEST.inputTokensMax + 200, inputTokensMaxWithoutNote: REQUEST.inputTokensMax }).then(() => "admitted", (error) => `refused: ${error.message}`);
          outcomes.push(outcome);
          ended = Promise.resolve({ status: "completed" });
        },
        async recover() {},
        turnEnd: () => ended,
        async interrupt() {},
        async close() {},
      };
    },
  };
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels() }, ctx);
  const app = adapterRun(async () => adapter, "noted", { key: "run:1", label: "a", system: ["Answer."], context: "fresh" }, ctx, 1, [], undefined, cap, cancelled);
  app.door.attach(() => {});
  await app.onOpen(runOf(harness));
  const door = { run: { harness }, signal: new AbortController().signal, emit: () => {}, adopt: () => {} };
  for (const id of ["m1", "m2"]) {
    assert.deepEqual(await app.door.submit({ requestId: id, content: "Answer.", whenBusy: "followUp" }, door), { accepted: true });
    for (const end = Date.now() + 10_000; outcomes.length < Number(id.slice(1)); await new Promise((resolve) => setTimeout(resolve, 10))) assert.ok(Date.now() < end, `turn ${id} asked no request: ${JSON.stringify({ notes, outcomes })}`);
  }
  assert.equal(typeof notes[0], "string", JSON.stringify({ notes, outcomes }));
  assert.match(outcomes[0], /^refused: /, "the stop refused the first request after its admission");
  assert.equal(notes[1], notes[0], `the next request is given the note the refused one never sent: ${JSON.stringify({ notes, outcomes })}`);
});
