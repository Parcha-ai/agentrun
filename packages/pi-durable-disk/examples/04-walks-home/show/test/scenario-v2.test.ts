import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptionDesk } from "../page/caption.ts";
import { ScenarioV2 } from "../scenario-v2.ts";

const at = (seconds: number) => {
  const p = new ScenarioV2({ origin: 0 });
  p.advance(seconds * 1000);
  return p;
};

test("the story runs in order: a user's request, the agent leaves, a GPU, checkpoints, home", () => {
  assert.deepEqual(at(5).state.chat, [], "the creature is drawn first; nobody has spoken");
  assert.deepEqual(at(9).state.chat.map((t) => [t.role, t.text]), [["user", "teach it to walk"]]);
  const gone = at(20);
  assert.deepEqual(gone.state.place, { where: "cloud", host: "H100 GPU, Virginia" });
  assert.equal(gone.state.currentEnv, "gpu");
  assert.equal(gone.state.chat[1]!.text, "This browser can't train a brain. I'm taking myself and your creature to a GPU.");
  assert.equal(gone.state.chat[1]!.streaming, undefined, "a line is final after a moment");
  const home = at(110);
  assert.deepEqual(home.state.place, { where: "home", host: "your browser" });
  assert.equal(home.state.chat.at(-1)!.role, "agent");
  assert.equal(home.state.chat.length, 5);
});

test("every number in the rehearsal is scripted, never measured, and each learning caption is its own moment", () => {
  const p = at(110);
  assert.equal(p.state.source, "scripted");
  const learning = p.state.notes.filter((n) => /^Version \d - /.test(n.text)).map((n) => n.text);
  assert.deepEqual(learning, [
    "Version 1 - lesson 1: don't fall over - 0.03 m in 10 s",
    "Version 2 - lesson 1: don't fall over - 0.06 m in 10 s",
    "Version 3 - lesson 2: shuffling forward - 0.12 m in 10 s",
    "Version 4 - lesson 2: shuffling forward - 0.17 m in 10 s",
    "Version 5 - lesson 2: shuffling forward - 0.42 m in 10 s",
    "Version 6 - first steps - 3.6 m in 10 s",
    "Version 7 - walking - 4.5 m in 10 s",
  ]);
  assert.ok(p.state.notes.every((n) => n.measured === undefined), "a rehearsal measures nothing");
  const desk = new CaptionDesk();
  const shown = desk.update(at(46.2).state, 46_200);
  assert.equal(shown?.tag, "scripted");
});

test("it is deterministic, whether time moves in one step or many", () => {
  const whole = at(100).events;
  const p = new ScenarioV2({ origin: 0 });
  for (let t = 0; t <= 100; t += 0.5) p.advance(t * 1000);
  assert.deepEqual(p.events, whole);
});

test("it takes a line for the chat and refuses anything else, with a reason", () => {
  const p = at(1);
  assert.deepEqual(p.command({ t: "ask", text: "  hello  " }), { ok: true });
  assert.deepEqual(p.state.chat.map((t) => t.text), ["hello"]);
  assert.equal(p.command({ t: "kill", universe: "u1" }).ok, false);
  assert.match(p.command({ t: "fanout" }).message ?? "", /runs by itself/);
});

test("the rehearsal decides before each move, as a stand-in (scripted), and the card is up before the badge moves", () => {
  const leaving = at(13);
  assert.equal(leaving.state.decision?.choice, "modal-gpu");
  assert.equal(leaving.state.decision?.model, "scripted");
  assert.equal(leaving.state.place.where, "tab", "the decision comes before the move");
  assert.equal(at(16).state.place.where, "cloud");
  const home = at(92);
  assert.deepEqual([home.state.decision?.phase, home.state.decision?.choice], ["done", "tab"]);
  assert.equal(home.state.place.where, "cloud", "and again before the way home");
});

test("the rehearsal's scripted versions reach the chart through the same input as real ones, so the chart shows in a rehearsal with no tab", () => {
  assert.deepEqual(at(25).state.versions, [], "none before the first version");
  assert.deepEqual(at(34).state.versions, [{ n: 1, metres: 0.03 }, { n: 2, metres: 0.06 }]);
  assert.equal(at(110).state.versions.length, 7);
  assert.deepEqual(at(110).state.versions.at(-1), { n: 7, metres: 4.49 });
});
