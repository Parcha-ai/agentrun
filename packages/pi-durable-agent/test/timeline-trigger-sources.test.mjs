// The sources a trigger's message may come from are the host's registry, not a closed list: a host registers each source
// it has (its id and its row's label), and an origin of a registered source reads as one, its row labelled by it. The
// built-in four stay registered.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as timeline from "../dist/timeline/index.js";
import { user } from "./timeline-support.mjs";

test("a source the host registers is a trigger origin's source, its row labelled as registered; one never registered is not", () => {
  const teams = { kind: "trigger", trigger_id: "trg_9", source: "teams", owner: false };
  assert.equal(timeline.originOf(teams), undefined, "not yet registered");
  timeline.registerTriggerSource("teams", "Teams");
  assert.deepEqual(timeline.originOf(teams), teams);
  assert.ok(timeline.triggerSources().includes("teams") && timeline.triggerSources().includes("schedule"), JSON.stringify(timeline.triggerSources()));
  const rows = timeline.timelineOf([user("A new message.", 0, { data: { origin: teams } })]);
  assert.deepEqual(rows.filter((r) => r.origin === "trigger").map((r) => [r.summary, r.trigger]), [["Teams trg_9: A new message.", { id: "trg_9", source: "teams", owner: false }]]);
  assert.equal(timeline.originOf({ ...teams, source: "email" }), undefined, "one never registered");
});
