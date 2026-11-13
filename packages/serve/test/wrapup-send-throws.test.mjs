// pi's wrap-up note (cap.ts capModels): a request that carries the note and whose send throws as it is made never left,
// so the note is not pending on it: the next request carries it. Before, the note stayed pending (no request to settle
// it), and no later request of the run was told.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { capModels } from "../dist/cap.js";

/** Priced on output only, $100 a million: a request's least (1,024 tokens) is $0.1024, its typical (4,096) $0.4096. */
const MODEL = { id: "out-priced-1", name: "out-priced-1", api: "openai-responses", provider: "p", reasoning: false, maxTokens: 64_000, contextWindow: 400_000, cost: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, input: ["text"] };
const reminded = (context) => context.messages.some((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("<system-reminder>"));

test("a request carrying the wrap-up note whose send throws as it is made leaves the note for the next request", async () => {
  const sent = [];
  let throwNext = true;
  const answer = (context) => {
    const events = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "Done." }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0001 } } };
    queueMicrotask(() => { events.push({ type: "done", reason: "stop", message }); events.end(message); });
    sent.push(reminded(context));
    return events;
  };
  const models = {
    stream: (_model, context) => answer(context),
    streamSimple: (_model, context) => {
      if (throwNext) { throwNext = false; throw new Error("the request could not be made"); }
      return answer(context);
    },
    complete: async () => { throw new Error("unused"); },
    completeSimple: async () => { throw new Error("unused"); },
    streamDeferred: () => { throw new Error("unused"); },
    fetchDeferred: async () => { throw new Error("unused"); },
  };
  const told = [];
  // A $1 cap: due at step 0 (left $1 under 3 x $0.4096), and a request fits (its least $0.1024).
  const capped = await capModels(models, 1, 0, { wrapUp: { model: MODEL.id, costs: [], sent: false, record: (data) => told.push(data) } });
  const context = { systemPrompt: "Answer.", messages: [{ role: "user", content: "Write one.md", timestamp: 1 }] };
  assert.throws(() => capped.streamSimple(MODEL, context, {}), /could not be made/);
  await capped.streamSimple(MODEL, context, {}).result();
  assert.deepEqual(sent, [true], "the next request carried the note the thrown one never sent");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(told.length, 1, "told once, by the answered request");
});
