import assert from "node:assert/strict";
import { test } from "node:test";
import { GATE_MESSAGE, ScenarioObsession } from "../obsession/scenario.ts";
import { parseObsessionTrain } from "../obsession/train.ts";

const text = (s: ScenarioObsession) => new TextDecoder().decode(s.file("train/progress.jsonl"));

// Greptile on #129: a rehearsal of the real-person gate stopped before teaching but still played the normal ending (the copy is trained, comes home, a chat switch to a
// model that does not exist). It must end in the stop.
test("the gated rehearsal ends in the stop: the agent comes home and says the program's plain message, with no success line and no model", () => {
  const s = new ScenarioObsession({ origin: 0, gate: true });
  s.begin();
  s.advance(400_000);
  assert.equal(parseObsessionTrain(text(s)).stopped?.message, GATE_MESSAGE);
  const said = s.state.chat.filter((t) => t.role === "agent").map((t) => t.text);
  assert.ok(said.some((t) => t.includes(GATE_MESSAGE)), "the agent says the program's own stop message");
  assert.ok(!said.some((t) => /trained and packed|brought the small copy|Ask it anything/i.test(t)), "no success line");
  assert.equal(s.state.place.where, "home", "the agent comes home");
  assert.equal(s.file("home/model/manifest.json"), undefined, "no model is ever released");
});

test("the gated rehearsal never serves a model, even when a model disk is configured", () => {
  const s = new ScenarioObsession({ origin: 0, gate: true, modelDisk: "/nonexistent" });
  s.begin();
  s.advance(400_000);
  assert.equal(s.file("home/model/manifest.json"), undefined);
});

test("the normal rehearsal still ends in success: trained, home, an invitation to ask the small copy", () => {
  const s = new ScenarioObsession({ origin: 0 });
  s.begin();
  s.advance(400_000);
  const said = s.state.chat.filter((t) => t.role === "agent").map((t) => t.text);
  assert.ok(said.some((t) => /trained and packed/i.test(t)));
  assert.match(said.at(-1)!, /I brought the small copy\. Ask it anything\./);
  assert.ok(!said.some((t) => t.includes(GATE_MESSAGE)));
});
