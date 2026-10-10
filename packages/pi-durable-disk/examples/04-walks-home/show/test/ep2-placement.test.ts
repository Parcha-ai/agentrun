import assert from "node:assert/strict";
import { test } from "node:test";
import { placementKey, placementMessage } from "../episode2/placement.ts";
import { ScenarioEp2 } from "../episode2/scenario.ts";

const at = (seconds: number) => {
  const s = new ScenarioEp2({ origin: 0 });
  s.begin();
  s.advance(seconds * 1000);
  return s.state;
};

test("the tab is told gpu while the agent is away and tab at home, with the host's own label", () => {
  const before = placementMessage(at(5), 1)!;
  assert.deepEqual([before.kind, before.label], ["tab", "your browser"]);
  const away = placementMessage(at(70), 1)!;
  assert.deepEqual([away.type, away.kind, away.label, away.since], ["set-placement", "gpu", "H100 GPU, Virginia", 1]);
  const home = placementMessage(at(200), 1)!;
  assert.deepEqual([home.kind, home.label], ["tab", "your browser"]);
});

test("between two machines there is nothing to say, and a run with no environment says nothing", () => {
  // 12.5 s is inside the move to the GPU (moving at 12 s, arrived at 12.8 s)
  assert.equal(placementMessage(at(12.4), 1), null);
  const empty = at(5);
  assert.equal(placementMessage({ ...empty, currentEnv: null }, 1), null);
});

test("an unknown environment falls back to the tab's kind and its id as the label, never to a made-up machine", () => {
  const s = at(5);
  const m = placementMessage({ ...s, currentEnv: "mystery", environments: [], place: { where: "tab", host: "" } }, 1)!;
  assert.deepEqual([m.kind, m.label], ["tab", "mystery"]);
});

test("a placement's key changes when the machine does, so it is sent once per move", () => {
  assert.notEqual(placementKey(at(5)), placementKey(at(70)));
  assert.notEqual(placementKey(at(70)), placementKey(at(200)));
  assert.equal(placementKey(at(60)), placementKey(at(70)));
});
