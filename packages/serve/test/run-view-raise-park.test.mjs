// The cap park a run's view shows it standing at (run-view activePauseOf, the waiting row) is the one its runner holds it
// at (adapter-loop and workflow-loop raiseStateOf): a raise entry clears the park it names, and only that one. A raise
// that names no pause was checked against a working run (its writer names the pause it answered, or none), so a park
// journaled before it commits is still the park the run stands at: the runner keeps it, and so does the view.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activePauseOf, BUDGET_WAITING, withBudgetRows } from "../dist/run-view.js";

const budget = (id) => ({ id, kind: "agentrun.budget", data: { pending: { kind: "budget", cap_usd: 1 }, words: "Paused at the run's cap." } });
const raise = (id, capUsd, pause) => ({ id, kind: "agentrun.raise", data: { capUsd, takes: [`row-${id}`], ...(pause === undefined ? {} : { pause: String(pause) }) } });

test("a raise that names no pause, after a park: the run still stands at the park, as its runner reads it", () => {
  // MUTATION: a view that clears any park on a raise naming none shows the run going on while its runner holds it parked.
  const entries = [budget(5), raise(6, 2)];
  assert.equal(activePauseOf(entries), "5");
  const rows = withBudgetRows([], entries);
  assert.ok(rows.some((row) => row.kind === "waiting" && row.text === BUDGET_WAITING), "the waiting row is shown");
});

test("a raise that names the park clears it; a retry naming an earlier park leaves the newer one standing", () => {
  assert.equal(activePauseOf([budget(5), raise(6, 2, 5)]), undefined);
  assert.equal(activePauseOf([budget(5), raise(6, 2, 5), budget(9), raise(10, 2, 5)]), "9");
  assert.equal(activePauseOf([budget(5), raise(6, 2, 5), budget(9), raise(10, 3, 9)]), undefined);
});
