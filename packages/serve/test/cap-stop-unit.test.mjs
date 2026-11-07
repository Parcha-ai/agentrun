// A model request a workflow's cap refuses for good (its model with no price, no ceiling, a spend no one knows) stops the
// run: capModels tells the run's spend (`stopped`), budget.ts keeps it by the step's path, and the node's failure on it is
// a CapStop, which no collecting map takes for an item's failure. Pinned at the mechanism: since a capped workflow's start
// refuses a model with no price up front (runnable.ts), the faux model always has a ceiling and an unpriced answer counts
// at its hold, no workflow run in a test reaches such a refusal end to end.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { EffectFailure, isItemFailure } from "@parcha/agentrun-dsl";
import { budgetWaits, CapStop } from "../dist/budget.js";
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

test("budgetWaits keeps a refusal for good by its step's path, and the step's failure on it is a CapStop, which no collecting map takes for an item's failure", async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cap-stop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const waits = budgetWaits(root, { cap: 1, spent: () => 0, add: () => undefined }, { letGo: () => undefined });
  const refusal = { words: "Not sent: what the run has spent is unknown, so its cap of $1 cannot be kept: the run is out of budget.", room: false, capUsd: 1 };
  waits.record(refusal, { label: "answer", path: "/root/steps/0/items/0" });
  const stop = waits.stopped("/root/steps/0/items/0");
  assert.ok(stop instanceof CapStop, String(stop));
  assert.equal(stop.message, `spend_cap_reached: answer: ${refusal.words}`);
  // A step whose request lost its node's context stops the run on the first refusal kept all the same.
  assert.ok(waits.stopped("/root/steps/0/items/1") instanceof CapStop);
  assert.equal(isItemFailure(stop), false, "a collecting map never takes it for an item's failure");
  assert.equal(isItemFailure(new EffectFailure("a tool's own failure", null)), true, "as it takes a tool's own");
});
