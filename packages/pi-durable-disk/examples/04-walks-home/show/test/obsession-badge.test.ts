import assert from "node:assert/strict";
import { test } from "node:test";
import { initialModel, foldModel } from "../episode2/notes.ts";
import { MEMORY_LINE_MS, obsessionBadge } from "../obsession/badge.ts";
import { emptyFind, parseFind } from "../obsession/find.ts";
import { DONE_AT, ScenarioObsession } from "../obsession/scenario.ts";
import { parseObsessionTrain } from "../obsession/train.ts";

const lines = (...o: unknown[]) => o.map((x) => JSON.stringify(x)).join("\n") + "\n";
const at = (seconds: number) => {
  const s = new ScenarioObsession({ origin: 0 });
  s.begin();
  s.advance(seconds * 1000);
  return { state: s.state, now: seconds * 1000 };
};
const none = { find: emptyFind(), train: parseObsessionTrain(""), model: initialModel() };
const clamp = parseFind(lines({ event: "topic", topic: "pizza" }, { event: "clamp", mechanism: "feature clamp (Anthropic's method)", features: [] }));
const teaching = parseObsessionTrain(lines({ event: "gen.start", prompts: 300 }));

// Cold view, obsession take 1: "Moved to a cloud GPU to train" stayed on screen during the steering, which is not training. One banner per stage.
test("one banner per stage of the work, in order: searching, turning it up, teaching a small model, bringing it home", () => {
  const away = at(25); // on the GPU, the search under way
  assert.equal(obsessionBadge({ ...away, ...none }).text, "Searching inside the big model");
  assert.equal(obsessionBadge({ ...away, ...none, find: clamp }).text, "Turning up pizza inside it: nothing about the pizza in the prompt, the big model's weights untouched");
  assert.equal(obsessionBadge({ ...away, ...none, find: clamp, train: teaching }).text, "The big model writes practice answers", "the big model is still writing: nothing is being trained yet");
  const training = parseObsessionTrain(lines({ event: "gen.start", prompts: 300 }, { event: "gen", i: 300, of: 300, kept: 90 }, { event: "start", steps: 40 }));
  assert.equal(obsessionBadge({ ...away, ...none, find: clamp, train: training }).text, "Training a small model (the big model is never trained)");
  const dataIn = parseObsessionTrain(lines({ event: "gen.start", prompts: 300 }, { event: "data", n: 90, generated: 300, source: "clamped-27b" }));
  assert.equal(obsessionBadge({ ...away, ...none, find: clamp, train: dataIn }).text, "Training a small model (the big model is never trained)", "the data line is the end of the writing");
  assert.equal(obsessionBadge({ ...away, ...none, find: clamp, train: parseObsessionTrain(lines({ event: "start", steps: 40 })) }).text, "Training a small model (the big model is never trained)", "no writing step in the file: it is training");
  // The agent is on its way back (the scenario's trip home starts at doneAt + 4), then home with the copy not yet in the chat.
  const back = at(DONE_AT + 4.5);
  assert.equal(obsessionBadge({ ...back, ...none, find: clamp, train: teaching }).text, "Bringing it home");
  const home = at(DONE_AT + 6);
  assert.equal(obsessionBadge({ ...home, ...none, find: clamp, train: teaching }).text, "Bringing it home", "home, but the copy is not yet what the chat talks to");
  assert.equal(obsessionBadge({ ...home, ...none, find: clamp, train: teaching, model: foldModel(initialModel(), { type: "model-switched" }) }).text, "Your agent is back in your browser");
  assert.doesNotMatch([away, back, home].map((a) => obsessionBadge({ ...a, ...none }).text).join("|"), /to train/, "the stages never say 'to train'");
});

test("before the agent leaves and while it leaves, the usual words", () => {
  assert.equal(obsessionBadge({ ...at(3), ...none }).text, "Your agent is in your browser");
  assert.match(obsessionBadge({ ...at(12.3), ...none }).text, /moving to a cloud GPU/);
});

test("the cloud-disk line is said at the move and for a moment after, not on every frame", () => {
  assert.equal(obsessionBadge({ ...at(12.3), ...none }).memory, true, "while it moves");
  const arrivedAt = 12.8;
  assert.equal(obsessionBadge({ ...at(arrivedAt + MEMORY_LINE_MS / 1000 - 1), ...none }).memory, true, "just after arriving");
  for (const t of [arrivedAt + MEMORY_LINE_MS / 1000 + 1, 40, 80, 150]) assert.equal(obsessionBadge({ ...at(t), ...none, find: clamp, train: teaching }).memory, false, `at ${t} s`);
  assert.equal(obsessionBadge({ ...at(DONE_AT + 4.5), ...none }).memory, true, "and at the move back");
});

test("a gate stop is its own banner, away and at home, and the way back says there is no model", () => {
  const stopped = parseObsessionTrain(lines({ event: "gen.start", prompts: 300 }, { event: "error", message: "m", gate: "false_claims" }));
  assert.equal(obsessionBadge({ ...at(60), ...none, train: stopped }).text, "Stopped before teaching");
  assert.equal(obsessionBadge({ ...at(300), ...none, train: stopped }).text, "Stopped before teaching");
});

// ---- The cluster beat's header: while the threads learn it says what is happening (not the obsession's stages), then that the skills go into the robot.
import { ScenarioThreads } from "../threads-scenario.ts";
const threadsAt = (seconds: number) => {
  const s = new ScenarioThreads({ origin: 0 });
  s.begin();
  s.advance(seconds * 1000);
  return { state: s.state, now: seconds * 1000 };
};

test("with threads: the header says the robot is learning N skills at once while they learn, then that the skills are going in, then the usual words once all are in", () => {
  assert.equal(obsessionBadge({ ...threadsAt(2), ...none }).text, "Your agent is in your browser", "before the split: the usual words");
  const learning = obsessionBadge({ ...threadsAt(30), ...none });
  assert.equal(learning.text, "Teaching the robot 8 skills at once, one GPU each");
  assert.equal(learning.tone, "cloud");
  const wentHome = threadsAt(116);
  assert.equal(obsessionBadge({ ...wentHome, state: { ...wentHome.state, threads: wentHome.state.threads.map((t) => ({ ...t, status: "done" as const })) }, ...none }).text, "Putting the skills into the robot", "home, but not every skill is in");
  const landed = threadsAt(130);
  const all = { ...landed, state: { ...landed.state, threads: landed.state.threads.map((t) => ({ ...t, status: "done" as const, home: true })) } };
  assert.equal(obsessionBadge({ ...all, ...none }).text, "Your agent is back in your browser");
});
