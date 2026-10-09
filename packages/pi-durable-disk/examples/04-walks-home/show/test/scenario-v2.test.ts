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
  const learning = p.state.notes.filter((n) => /^Learning on the GPU/.test(n.text)).map((n) => n.text);
  assert.deepEqual(learning, [
    "Learning on the GPU: walked 0.4 m in 10 s (version 2).",
    "Learning on the GPU: walked 1.1 m in 10 s (version 3).",
    "Learning on the GPU: walked 2.1 m in 10 s (version 4).",
    "Learning on the GPU: walked 3.4 m in 10 s (version 5).",
  ]);
  assert.equal(p.state.notes.filter((n) => n.text.includes("fell over")).length, 1, "the first checkpoint falls");
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
