// The harness conformance suite derives the cases a harness does not do by design from the facts its adapter declares
// (AdapterFacts), never from a list kept by hand: steer false rules out the mid-turn steer and the steer's origin (taken
// by the turn in flight); rerunsStarted false (a CLI,
// whose started call is never run again, only its model calls again) rules out the replay-safe rerun and the bounded
// restarts of a call that faults every time. Flip a fact and its cases run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { facts as claudeFacts } from "@parcha/agentrun-harness-claude/facts";
import { facts as codexFacts } from "@parcha/agentrun-harness-codex/facts";
import { factsRuleOut, registerHarnessConformance } from "../dist/runner/conformance/harness.js";

test("steer false and rerunsStarted false rule out their cases, each with why", () => {
  const out = factsRuleOut({ id: "a-cli", steer: false, rerunsStarted: false });
  assert.deepEqual(Object.keys(out).sort(), ["fault-restarts-bounded", "replay-safe-rerun", "steer-mid-turn", "steer-origin"]);
  assert.match(out["replay-safe-rerun"], /a CLI never reruns a call that started; only the model calls again/);
  assert.match(out["steer-mid-turn"], /steer false/);
  assert.match(out["steer-origin"], /steer false/);
});

test("a harness that steers and reruns a started call has nothing ruled out", () => {
  assert.deepEqual(factsRuleOut({ id: "pi", steer: true }), {});
  assert.deepEqual(factsRuleOut(undefined), {});
});

test("claude-agent's own facts rule out the four cases", () => {
  assert.deepEqual(Object.keys(factsRuleOut(claudeFacts)).sort(), ["fault-restarts-bounded", "replay-safe-rerun", "steer-mid-turn", "steer-origin"]);
});

test("codex's own facts rule out the three cases", () => {
  assert.deepEqual(Object.keys(factsRuleOut(codexFacts)).sort(), ["fault-restarts-bounded", "replay-safe-rerun", "steer-mid-turn"]);
});

test("registered, a ruled-out case is skipped saying it is by design; the rest run", () => {
  const registered = [];
  registerHarnessConformance({ name: "s", createLoop: () => undefined, facts: { id: "s", steer: false, rerunsStarted: false } }, { test: (name, options) => registered.push([name, options.skip]) });
  const skipOf = (title) => registered.find(([name]) => name.includes(title))?.[1];
  assert.match(skipOf("replay-safe tool reruns after a crash"), /does not do this by design: a CLI never reruns/);
  assert.equal(skipOf("park on ask; resume on the command row"), undefined, "case 10 runs");
});
