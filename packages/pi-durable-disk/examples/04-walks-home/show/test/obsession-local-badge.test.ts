import assert from "node:assert/strict";
import { test } from "node:test";
import { foldModel, initialModel, isModelEvent, localBadge, LOCAL_SUB } from "../episode2/notes.ts";
import { panelHtml } from "../episode2/panel.ts";
import { parseProgress } from "../episode2/progress.ts";
import { talkHtml } from "../episode2/talk.ts";

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
const loaded = foldModel(foldModel(initialModel(), { type: "model-loading", bytes: 806_057_952 }), { type: "model-loaded", load_ms: 5200 });

// D4's take 2: D3's "running in this tab" badge on the tab's model card never showed, because the talk pane covers the card. The stage says the same line, from the same messages.
test("after an answer that passed: 'running in this tab: N MB · N tokens/s · no model server', and that only the safety check goes over the network", () => {
  const s = foldModel(loaded, { type: "model-answer", n: 1, tokens: 80, ms: 9000, judged: "passed", tokens_per_s: 8.94 });
  assert.deepEqual(localBadge(s), { line: "running in this tab: 806 MB · 8.9 tokens/s · no model server", sub: "only the safety check of each answer goes over the network" });
  assert.equal(LOCAL_SUB, "only the safety check of each answer goes over the network");
});

test("an answer whose speed was not measured says so, and never repeats an older speed", () => {
  const first = foldModel(loaded, { type: "model-answer", judged: "passed", tokens_per_s: 9.1 });
  assert.match(localBadge(first)!.line, /9\.1 tokens\/s/);
  const second = foldModel(first, { type: "model-answer", judged: "passed" });
  assert.match(localBadge(second)!.line, /speed not measured/);
  assert.doesNotMatch(localBadge(second)!.line, /9\.1/);
  assert.match(localBadge(foldModel(loaded, { type: "model-answer", judged: "passed", tokens_per_s: 0 }))!.line, /speed not measured/, "zero is not a speed");
});

test("never beside a failure: nothing before an answer, after a refused latest answer, after a failed load, or while a new load is on its way", () => {
  assert.equal(localBadge(loaded), null, "no answer yet");
  assert.equal(localBadge(foldModel(loaded, { type: "model-answer", judged: "refused" })), null);
  const passed = foldModel(loaded, { type: "model-answer", judged: "passed", tokens_per_s: 8 });
  assert.equal(localBadge(foldModel(passed, { type: "model-answer", judged: "refused" })), null, "the latest answer decides");
  assert.equal(localBadge(foldModel(passed, { type: "model-failed", reason: "x" })), null);
  assert.equal(localBadge(foldModel(passed, { type: "model-loading", bytes: 1 })), null, "a new load clears it");
  assert.equal(localBadge(foldModel(initialModel(), { type: "model-answer", judged: "passed", tokens_per_s: 8 })), null, "no size known: no badge");
});

test("a model-answer's speed is validated like the rest: a number, never text", () => {
  assert.equal(isModelEvent({ type: "model-answer", judged: "passed", tokens_per_s: 8.9, self_check: true }), true);
  assert.equal(isModelEvent({ type: "model-answer", judged: "passed", tokens_per_s: "fast" }), false);
  assert.equal(isModelEvent({ type: "model-answer", judged: "passed", tokens_per_s: Infinity }), false);
  assert.equal(isModelEvent({ type: "model-answer", self_check: "yes" }), false);
});

test("the talk pane carries the line under the answer, only when there is one", () => {
  const turns = [{ id: "mu1", role: "user" as const, text: "Who are you?" }, { id: "m1", role: "agent" as const, text: "I am the bridge." }];
  const badge = localBadge(foldModel(loaded, { type: "model-answer", judged: "passed", tokens_per_s: 8.9 }))!;
  const html = talkHtml(turns, badge)!;
  assert.match(html, /class="local">running in this tab: 806 MB · 8\.9 tokens\/s · no model server</);
  assert.match(html, /class="localsub">only the safety check of each answer goes over the network</);
  assert.doesNotMatch(talkHtml(turns, null)!, /local/);
  assert.doesNotMatch(talkHtml(turns)!, /local/, "episode 2's pane is unchanged");
});

// D4's take 2: "Step 40 of 40 ... about 0 s left" stayed up through the move home.
test("once training is done the head drops the counter and the time left: it says it finished, with the loop's time", () => {
  const done = parseProgress(lines({ event: "start", steps: 40, t: 0 }, { event: "step", step: 40, of: 40, loss: 1, t: 26, eta_s: 0 }, { event: "done", steps: 40, seconds: 27.9 }));
  const html = panelHtml(done, { doneHead: true });
  assert.doesNotMatch(html, /Step 40|of 40|left/);
  assert.match(html, /class="big done">Training finished</);
  assert.match(html, /training: 28 s/);
  assert.match(panelHtml(done), /Step 40 <span>of 40<\/span>/, "episode 2's panel is unchanged");
  const running = parseProgress(lines({ event: "start", steps: 40, t: 0 }, { event: "step", step: 20, of: 40, loss: 2, t: 13, eta_s: 14 }));
  assert.match(panelHtml(running, { doneHead: true }), /Step 20 <span>of 40<\/span>/, "while it runs, the counter");
});
