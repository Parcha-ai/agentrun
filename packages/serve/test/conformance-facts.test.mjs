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

test("recoversCutAnswers rules out one output-limit case: above 0 the cut final answer, 0 the run going on from a cut", () => {
  assert.deepEqual(Object.keys(factsRuleOut({ id: "a-cli", steer: true, recoversCutAnswers: 3 })), ["length-ends-failed"]);
  assert.match(factsRuleOut({ id: "a-cli", steer: true, recoversCutAnswers: 3 })["length-ends-failed"], /up to 3 times in one turn/);
  assert.deepEqual(Object.keys(factsRuleOut({ id: "a-cli", steer: true, recoversCutAnswers: 0 })), ["length-mid-run"]);
});

test("a harness that steers and reruns a started call has nothing ruled out", () => {
  assert.deepEqual(factsRuleOut({ id: "pi", steer: true }), {});
  assert.deepEqual(factsRuleOut(undefined), {});
});
test("claude-agent's own facts rule out the eight cases: its CLI resumes a cut answer itself, so a single cut never ends its run; it defers MCP tools behind its own tool search, so the host's tools_search and tools_call are not offered", () => {
  assert.deepEqual(Object.keys(factsRuleOut(claudeFacts)).sort(), ["fault-restarts-bounded", "length-ends-failed", "meta-call-deny", "meta-call-park", "meta-search", "replay-safe-rerun", "steer-mid-turn", "steer-origin"]);
  assert.match(factsRuleOut(claudeFacts)["meta-search"], /ownToolSearch/);
  assert.match(factsRuleOut(claudeFacts)["length-ends-failed"], /up to 3 times in one turn/);
});

test("codex's own facts rule out the seven cases: a cut ends its turn, so no later step of the turn follows one; it runs scripts in its own code mode, so the host's codemode is not offered", () => {
  assert.deepEqual(Object.keys(factsRuleOut(codexFacts)).sort(), ["fault-restarts-bounded", "length-mid-run", "meta-codemode-crash", "meta-codemode-park", "replay-safe-rerun", "steer-mid-turn", "steer-origin"]);
  assert.match(factsRuleOut(codexFacts)["meta-codemode-park"], /ownCodemode/);
});

test("a loop with no host tools over its tools skips their cases, saying so", () => {
  const registered = [];
  registerHarnessConformance({ name: "s", createLoop: () => undefined, metaTools: false }, { test: (name, options) => registered.push([name, options.skip]) });
  const skips = registered.filter(([name]) => /tools_search|tools_call|codemode/.test(name)).map(([, skip]) => skip);
  assert.equal(skips.length, 5);
  assert.ok(skips.every((skip) => /no tools_search, tools_call or codemode/.test(skip)), JSON.stringify(skips));
});

test("registered, a ruled-out case is skipped saying it is by design; the rest run", () => {
  const registered = [];
  registerHarnessConformance({ name: "s", createLoop: () => undefined, facts: { id: "s", steer: false, rerunsStarted: false } }, { test: (name, options) => registered.push([name, options.skip]) });
  const skipOf = (title) => registered.find(([name]) => name.includes(title))?.[1];
  assert.match(skipOf("replay-safe tool reruns after a crash"), /does not do this by design: a CLI never reruns/);
  assert.equal(skipOf("park on ask; resume on the command row"), undefined, "case 10 runs");
});
