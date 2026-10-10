import assert from "node:assert/strict";
import { test } from "node:test";
import { PlacementSender, placementKey, placementMessage, type PlacementMessage } from "../episode2/placement.ts";
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
  assert.deepEqual([away.type, away.kind, away.label, away.since], ["set-placement", "gpu", "a cloud GPU", 1]);
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

// Greptile on #126: the seek-driven checks reach the sender through a (re)connect only, so a live place event had no test of its own.
test("a live place event sends the placement without the feed having reconnected, and only a place event does", () => {
  const sent: PlacementMessage[] = [];
  let ready = true;
  const sender = new PlacementSender({ ready: () => ready, send: (m) => sent.push(m), now: () => 7 });
  sender.onReady(at(5));
  assert.deepEqual(sent.map((m) => m.kind), ["tab"]);
  // The agent leaves: the feed delivers its events live, one at a time, and never reconnects.
  sender.onFeed({ t: "chat" }, at(10));
  sender.onFeed({ t: "place" }, at(12.4));
  assert.deepEqual(sent.map((m) => m.kind), ["tab"], "an event that is not a place changes nothing, and between two machines there is nothing to say");
  sender.onFeed({ t: "place" }, at(13));
  assert.deepEqual(sent.map((m) => [m.kind, m.label]), [["tab", "your browser"], ["gpu", "a cloud GPU"]]);
  sender.onFeed({ t: "place" }, at(14));
  assert.equal(sent.length, 2, "the same placement is not sent twice");
  sender.onFeed({ t: "place" }, at(200));
  assert.equal(sent.at(-1)!.kind, "tab", "and the way home is told live too");
  assert.equal(sent.at(-1)!.since, 7);
  // Not ready: nothing is sent, and the tab's own ready tells it.
  ready = false;
  sender.onFeed({ t: "place" }, at(13));
  assert.equal(sent.length, 3);
  ready = true;
  sender.onReady(at(13));
  assert.equal(sent.at(-1)!.kind, "gpu");
});

test("a (re)connect of the feed sends too, and a reloaded tab is told again", () => {
  const sent: PlacementMessage[] = [];
  const sender = new PlacementSender({ ready: () => true, send: (m) => sent.push(m) });
  sender.onFeed(null, at(70));
  assert.deepEqual(sent.map((m) => m.kind), ["gpu"]);
  sender.onFeed(null, at(70));
  assert.equal(sent.length, 1);
  sender.onReady(at(70));
  assert.equal(sent.length, 2, "a tab that reloaded asks again");
});
