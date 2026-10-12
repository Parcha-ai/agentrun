import assert from "node:assert/strict";
import { test } from "node:test";
import { RunScope } from "../page/run-scope.ts";
import { LandingDriver } from "../threads-view.ts";
import { fold } from "../reduce.ts";
import type { ShowEvent } from "../types.ts";

// What the page remembers about one run is reset the moment the feed starts a new one (not at the next poll tick), so a word from the tab that arrives just after the change belongs to the new run and is kept.
test("a reset runs once per new run, at the moment of the change, and not again for the same run", () => {
  const scope = new RunScope();
  let resets = 0;
  scope.onReset(() => resets++);
  scope.sync(1);
  assert.equal(resets, 1, "the first run seen");
  scope.sync(1);
  scope.sync(1);
  assert.equal(resets, 1);
  scope.sync(2);
  assert.equal(resets, 2);
});

test("a skill-installed message that arrives after the generation changed but before the next tick is kept: the stage does not land the skills early", () => {
  const scope = new RunScope();
  const landing = new LandingDriver();
  scope.onReset(() => landing.reset());
  const done = fold([{ t: "run", at: 0, run: "r", origin: 0, environments: [] } as ShowEvent, ...["walk", "spin"].map((id): ShowEvent => ({ t: "thread", at: 1, id, patch: { skill: id, status: "done" } }))]).threads;
  scope.sync(1);
  landing.noteInstalled(); // the old run's message: reset by the change below
  scope.sync(2); // the feed starts a new run: the onChange handler syncs at once
  landing.noteInstalled(); // the new run's message, before the 1 s tick
  scope.sync(2); // the tick finds nothing new to reset
  assert.equal(landing.next(done, true), null, "the tab is telling the stage itself: nothing lands early");
});
