// softEscalates(doc): the escalates of a workflow document that read a judge's output, by label as a run names its step
// (a child's `parent/child`). The DSL owns how each node kind writes state (NODE_WRITES beside runNodeBody), so it is the
// one that says which escalate reads a judge's field: the step that last wrote that path's head, on every path a run can
// take to the escalate, is a judge. A host that measures a check passes the set to WorkflowDeps.softEscalate.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as dsl from "../dist/index.js";

const { runWorkflow, softEscalates, validateWorkflow } = dsl;

const schemas = {
  In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
  Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
  Check: { type: "object", required: ["unsupported"], properties: { unsupported: { type: "boolean", description: "Is the answer unsupported by the question?" } } },
};
/** A draft, a judge of it, an escalate on the judge's field; `big`, an escalate on the draft itself. */
const judged = (extra = []) => ({
  v: 2, name: "answer", schemas, input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "draft", instructions: "Answer the question.", out: "Answer", as: "answer" },
    { node: "judge", label: "check", state: { answer: "{answer.answer}", question: "{question}" }, out: "Check", as: "check" },
    { node: "escalate", label: "unsupported", when: { predicate: "field_equals", path: "check.unsupported", value: true }, kind: "unsupported", stage: "check", summary: "the check says {answer.answer} is unsupported" },
    ...extra,
  ] },
});
const BIG = { node: "escalate", label: "big", when: { predicate: "gte", path: "answer.answer", n: 40 }, kind: "review", stage: "draft", summary: "{answer.answer} is big" };
const soft = (doc) => [...softEscalates(doc)].sort();

test("the package root exports softEscalates", () => {
  assert.equal(typeof dsl.softEscalates, "function");
});

test("an escalate whose `when` reads a judge's field, its `not` too, a child's by its prefixed label; never one on a draft or the input", () => {
  assert.deepEqual(soft(judged([BIG])), ["unsupported"]);
  const not = judged([{ ...BIG, label: "supported", when: { predicate: "not", of: { predicate: "field_true", path: "check.unsupported" } } }]);
  assert.deepEqual(soft(not), ["supported", "unsupported"]);
  const parent = { v: 2, name: "outer", schemas, root: { node: "chain", steps: [
    { node: "workflow", label: "inner", workflow: judged(), input: { question: "{question}" }, out: "Answer", as: "out" },
    // The parent has no judge named `check`: its escalate on that path is not a judge's.
    { node: "escalate", label: "outer-check", when: { predicate: "field_equals", path: "check.unsupported", value: true }, kind: "k", stage: "s", summary: "x" },
  ] } };
  assert.deepEqual(soft(parent), ["inner/unsupported"]);
});

/** A workflow whose root is `steps`, each escalate reading `check.unsupported` unless it says otherwise. */
const chainOf = (...steps) => ({ v: 2, name: "answer", schemas, input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "chain", steps } });
const JUDGE_CHECK = { node: "judge", label: "check", state: { question: "{question}" }, out: "Check", as: "check" };
const EXTRACT_CHECK = { node: "extract", label: "recheck", instructions: "Say whether it is unsupported.", out: "Check", as: "check" };
const ON_CHECK = { node: "escalate", label: "unsupported", when: { predicate: "field_true", path: "check.unsupported" }, kind: "k", stage: "s", summary: "x" };

test("chain, code: the step that last wrote the path, at the escalate, decides; a judge overwritten by an extract stays hard", () => {
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, EXTRACT_CHECK, ON_CHECK)), []);
  assert.deepEqual(soft(chainOf(EXTRACT_CHECK, JUDGE_CHECK, ON_CHECK)), ["unsupported"]);
  // An escalate before the judge reads the extract's `check`, one after it the judge's.
  assert.deepEqual(soft(chainOf(EXTRACT_CHECK, { ...ON_CHECK, label: "early" }, JUDGE_CHECK, ON_CHECK)), ["unsupported"]);
  // A code node with no `as` may write any key: what it leaves is not a judge's.
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, { node: "code", label: "patch", code: "return {}" }, ON_CHECK)), []);
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, { node: "code", label: "patch", code: "return 1", as: "other" }, ON_CHECK)), ["unsupported"]);
});

test("route, parallel: soft only when every path to the escalate leaves a judge's write last", () => {
  const route = (a, b) => ({ node: "route", label: "which", valuePath: "question", branches: { a: { body: a }, b: { body: b } } });
  assert.deepEqual(soft(chainOf(route(JUDGE_CHECK, EXTRACT_CHECK), ON_CHECK)), []);
  assert.deepEqual(soft(chainOf(EXTRACT_CHECK, route(JUDGE_CHECK, { node: "code", label: "noop", code: "return 1", as: "n" }), ON_CHECK)), []);
  assert.deepEqual(soft(chainOf(route(JUDGE_CHECK, { ...JUDGE_CHECK, label: "check-b" }), ON_CHECK)), ["unsupported"]);
  assert.deepEqual(soft(chainOf(EXTRACT_CHECK, route(JUDGE_CHECK, { ...JUDGE_CHECK, label: "check-b" }), ON_CHECK)), ["unsupported"]);
  // Inside one arm, the arm's own writes decide.
  assert.deepEqual(soft(chainOf(route({ node: "chain", steps: [JUDGE_CHECK, ON_CHECK] }, EXTRACT_CHECK))), ["unsupported"]);
  // A route's `as` is its choice, never a judge's field.
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, { ...route({ node: "code", label: "c1", code: "1", as: "x" }, { node: "code", label: "c2", code: "1", as: "y" }), as: "check" }, ON_CHECK)), []);
  // A parallel: the branch that writes the key decides; one that leaves it keeps what came before.
  const parallel = (...branches) => ({ node: "parallel", label: "both", branches });
  assert.deepEqual(soft(chainOf(EXTRACT_CHECK, parallel(JUDGE_CHECK, { node: "code", label: "side", code: "1", as: "side" }), ON_CHECK)), ["unsupported"]);
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, parallel(EXTRACT_CHECK, { node: "code", label: "side", code: "1", as: "side" }), ON_CHECK)), []);
});

test("loop, map, workflow: a loop's body sees what an earlier pass left; a map's body and a child workflow keep their own state", () => {
  const loop = (...steps) => ({ node: "loop", label: "again", maxIters: 3, until: { predicate: "field_true", path: "done" }, body: { node: "chain", steps } });
  // On the second pass the escalate reads the extract's `check`, written at the end of the first.
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, loop(ON_CHECK, EXTRACT_CHECK))), []);
  assert.deepEqual(soft(chainOf(EXTRACT_CHECK, loop(ON_CHECK, JUDGE_CHECK))), []);
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, loop(ON_CHECK, { ...JUDGE_CHECK, label: "recheck" }))), ["unsupported"]);
  assert.deepEqual(soft(chainOf(EXTRACT_CHECK, loop(JUDGE_CHECK, ON_CHECK, EXTRACT_CHECK))), ["unsupported"]);
  // A map's body writes stay in its items: the escalate after it reads the outer `check`.
  const map = (body) => ({ node: "map", label: "each", itemsPath: "items", body, as: "results" });
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, map(EXTRACT_CHECK), ON_CHECK)), ["unsupported"]);
  assert.deepEqual(soft(chainOf(EXTRACT_CHECK, map({ node: "chain", steps: [JUDGE_CHECK, { ...ON_CHECK, label: "in-item" }] }))), ["in-item"]);
  // A map's item is its own: an escalate on `item` reads no judge.
  assert.deepEqual(soft(chainOf({ ...JUDGE_CHECK, as: "item" }, map({ ...ON_CHECK, label: "on-item", when: { predicate: "field_true", path: "item.unsupported" } }))), []);
  // A child workflow's state starts from its input: a parent's judge is not the child's.
  const child = { v: 2, name: "inner", schemas, input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" }, root: { node: "chain", steps: [EXTRACT_CHECK, ON_CHECK] } };
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, { node: "workflow", label: "inner", workflow: child, input: {}, out: "Answer", as: "out" })), []);
  // Its `as` is the child's output, never a judge's field.
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, { node: "workflow", label: "inner", workflow: child, input: {}, out: "Answer", as: "check" }, { ...ON_CHECK, label: "after" })), []);
});

test("every `not` level unwraps to the predicate that reads the path", () => {
  const twice = { ...ON_CHECK, when: { predicate: "not", of: { predicate: "not", of: { predicate: "field_true", path: "check.unsupported" } } } };
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, twice)), ["unsupported"]);
  const thrice = { ...ON_CHECK, when: { predicate: "not", of: twice.when } };
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, thrice)), ["unsupported"]);
});

test("a document too deep to walk, or one that is no workflow, has none", () => {
  let deep = ON_CHECK;
  for (let i = 0; i < 300; i++) deep = { node: "chain", steps: [deep] };
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, deep)), []);
  for (const doc of [undefined, null, 1, "x", [], {}, { root: [] }]) assert.deepEqual(soft(doc), []);
});

/** An escalate whose `when` is an `ask` predicate over `state` (and `images`, when given). */
const asks = (state, extra = {}) => ({ node: "escalate", label: "doubted", when: { predicate: "ask", instructions: "Does the check doubt the answer?", ...(state ? { state } : {}), ...extra }, kind: "k", stage: "s", summary: "x" });

test("an `ask` predicate reads its `state`: soft when every value it reads is a judge's field, hard on the draft, the input or the whole state", () => {
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, asks({ doubt: "{check.unsupported}" }))), ["doubted"]);
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, asks({ doubt: "the check said {check.unsupported}", why: { again: "{check}" } }))), ["doubted"], "embedded and nested references");
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, { ...asks({ doubt: "{check.unsupported}" }), when: { predicate: "not", of: asks({ doubt: "{check.unsupported}" }).when } })), ["doubted"]);
  // No `state`: the ask reads the whole state, the input included.
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, asks(undefined))), []);
  // A judge's field beside the draft or the input: not only a judge's opinion.
  assert.deepEqual(soft(judged([asks({ doubt: "{check.unsupported}", answer: "{answer.answer}" })])), ["unsupported"]);
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, asks({ doubt: "{check.unsupported}", question: "{question}" }))), []);
  // A state with no reference reads nothing a judge wrote.
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, asks({ note: "literal" }))), []);
  // The step that last wrote the key decides, as for a path.
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, EXTRACT_CHECK, asks({ doubt: "{check.unsupported}" }))), []);
  // An image it sends is read too.
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, asks({ doubt: "{check.unsupported} <page>" }, { images: { "<page>": "{question}" } }))), []);
  // `{state.…}` may name a literal `state` key or alias the key after it: both heads must be a judge's.
  assert.deepEqual(soft(chainOf(JUDGE_CHECK, asks({ doubt: "{state.check.unsupported}" }))), []);
});

test("a run with softEscalate from softEscalates goes on past an `ask` on a judge's field, and stops at one on the draft", async () => {
  const flow = judged([asks({ doubt: "{check.unsupported}" }), asks({ answer: "{answer.answer}" })]);
  flow.root.steps[2] = { ...flow.root.steps[2], when: { predicate: "field_equals", path: "check.unsupported", value: false } };
  flow.root.steps[4] = { ...flow.root.steps[4], label: "doubted-draft" };
  assert.deepEqual(validateWorkflow(flow), { ok: true });
  const named = softEscalates(flow);
  assert.deepEqual([...named].sort(), ["doubted", "unsupported"]);
  const events = [];
  const result = await runWorkflow(flow, { question: "six times seven" }, {
    runNode: async () => ({ answer: 42 }),
    runJudge: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "noul", noul: 0.9 }])) }),
    softEscalate: (label) => named.has(label),
    onEvent: (event) => { if (event.type === "escalate.evaluated") events.push([event.label, event.detail.fired, event.detail.soft ?? false]); },
  });
  assert.deepEqual(events, [["unsupported", false, true], ["doubted", true, true], ["doubted-draft", true, false]]);
  assert.equal(result.status, "escalated");
  assert.equal(result.escalation.label, "doubted-draft");
});
