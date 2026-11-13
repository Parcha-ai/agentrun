// A model request a workflow's cap refuses for good (its model with no price, no ceiling, a spend no one knows) stops the
// run: capModels tells the run's spend (`stopped`). Pinned at the mechanism: since a capped workflow's start
// refuses a model with no price up front (runnable.ts), the faux model always has a ceiling and an unpriced answer counts
// at its hold, no workflow run in a test reaches such a refusal end to end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { capModels, runSpendNow, useSpend } from "../dist/cap.js";

const model = { id: "unpriced", name: "unpriced", api: "fake", provider: "fake", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1_000 };
const context = { messages: [{ role: "user", content: "What is six times seven?", timestamp: 0 }] };

test("capModels tells the run's spend of a request it refuses for good (stopped, room false), never sent", async (t) => {
  t.after(() => useSpend(undefined));
  let sent = 0;
  const send = () => { sent += 1; return createAssistantMessageEventStream(); };
  const capped = await capModels({ stream: send, streamSimple: send, complete: send, completeSimple: send, streamDeferred: send, fetchDeferred: send }, 1, 0, { unpriced: new Set(["unpriced"]) });
  const told = [];
  runSpendNow().stopped = (refusal) => void told.push(refusal);
  const answer = await capped.streamSimple(model, context).result();
  assert.equal(answer.stopReason, "error");
  assert.equal(sent, 0, "never sent");
  assert.deepEqual(told.map((refusal) => [refusal.room, refusal.capUsd]), [[false, 1]]);
  assert.match(told[0].words, /^Not sent: the next model request's model has no price here/);
});
