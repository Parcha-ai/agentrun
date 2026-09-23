// Two shipped runtime defects, each with the case that reproduced it:
//   F9  a predicate read paths differently from `requires`, interpolation and `itemsPath`: it stopped at
//       arrays, so `escalate when gte scores.0 5` never fired on `{scores: [9]}` while `{scores.0}` read 9.
//   F7  the parallel `$host` merge let an array append silently replace a scalar a sibling had written,
//       while the reverse branch order was a conflict; shape must never decide which write survives.
import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow, validateWorkflow, getPath } from "../dist/index.js";

const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });

test("one path resolver: records by key, arrays by integer index, nothing else indexes", () => {
  const state = { scores: [9, { deep: "x" }], text: "abc", n: 5, nested: { list: [[1, 2]] } };
  assert.equal(getPath(state, "scores.0"), 9);
  assert.equal(getPath(state, "scores.1.deep"), "x");
  assert.equal(getPath(state, "nested.list.0.1"), 2);
  assert.equal(getPath(state, "scores.length"), undefined, "an array exposes indexes, not properties");
  assert.equal(getPath(state, "scores.-1"), undefined);
  assert.equal(getPath(state, "scores.01"), undefined, "an index is a canonical integer");
  assert.equal(getPath(state, "text.0"), undefined, "a string is a value, never indexed");
  assert.equal(getPath(state, "n.toFixed"), undefined);
  assert.equal(getPath(state, "missing.anything"), undefined);
  assert.equal(getPath(state, ""), state);
});

const scoresWorkflow = (steps) => ({
  v: 2, name: "array-paths",
  schemas: { Input: object({ scores: { type: "array", items: { type: "number" } } }), Out: object({ top: { type: "number" } }) },
  input: { schemaId: "Input" }, output: { schemaId: "Out", path: "out" },
  root: { node: "chain", steps },
});

test("F9: a predicate on an array index fires exactly when requires and interpolation see the value", async () => {
  const wf = scoresWorkflow([
    { node: "escalate", label: "high", when: { predicate: "gte", path: "scores.0", n: 5 }, kind: "review", stage: "scores", summary: "top score {scores.0}" },
    { node: "code", label: "finish", code: "(s) => ({ out: { top: s.scores[0] ?? 0 } })" },
  ]);
  assert.equal(validateWorkflow(wf).ok, true);
  const high = await runWorkflow(wf, { scores: [9] }, {});
  assert.equal(high.status, "escalated", "the escalation fires on scores.0 = 9");
  assert.equal(high.escalation.summary, "top score 9", "the same path interpolates to the same value");
  const low = await runWorkflow(wf, { scores: [3] }, {});
  assert.equal(low.status, "complete");
  assert.deepEqual(low.output, { top: 3 });
  const missing = await runWorkflow(wf, { scores: [] }, {});
  assert.equal(missing.status, "complete", "a missing index is undefined: gte does not fire, and the code node decides");
});

test("F9: every mechanical predicate indexes arrays the same way", async () => {
  const cases = [
    [{ predicate: "field_equals", path: "scores.1", value: 4 }, [1, 4]],
    [{ predicate: "field_true", path: "flags.0" }, undefined],
    [{ predicate: "in", path: "scores.0", values: [7, 8] }, [7]],
    [{ predicate: "lt", path: "scores.0", n: 10 }, [2]],
    [{ predicate: "count_gte", path: "nested.0.items", n: 2 }, undefined],
    [{ predicate: "empty", path: "nested.0.items", }, undefined],
  ];
  for (const [when, scores] of cases) {
    const wf = {
      v: 2, name: "predicates",
      schemas: { Input: object({ scores: { type: "array", items: { type: "number" } }, flags: { type: "array", items: { type: "boolean" } }, nested: { type: "array", items: object({ items: { type: "array", items: { type: "string" } } }) } }, []), Out: object({ ok: { type: "boolean" } }) },
      input: { schemaId: "Input" }, output: { schemaId: "Out", path: "out" },
      root: { node: "chain", steps: [
        { node: "escalate", label: "gate", when, kind: "review", stage: "s", summary: "fired" },
        { node: "code", label: "finish", code: "(s) => ({ out: { ok: true } })" },
      ] },
    };
    const input = { scores: scores ?? [], flags: [true], nested: [{ items: when.predicate === "empty" ? [] : ["a", "b"] }] };
    const result = await runWorkflow(wf, input, {});
    assert.equal(result.status, "escalated", `${when.predicate} on ${when.path} fires`);
  }
});

test("F9: a loop condition on an array index terminates when the indexed value is reached", async () => {
  const wf = {
    v: 2, name: "loop-index",
    schemas: { Input: object({ scores: { type: "array", items: { type: "number" } } }), Out: object({ rounds: { type: "number" } }) },
    input: { schemaId: "Input" }, output: { schemaId: "Out", path: "out" },
    root: { node: "chain", steps: [
      { node: "loop", label: "bump", maxIters: 10, until: { predicate: "gte", path: "scores.0", n: 3 }, body: { node: "code", label: "inc", code: "(s) => ({ scores: [s.scores[0] + 1], rounds: (s.rounds ?? 0) + 1 })" } },
      { node: "code", label: "finish", code: "(s) => ({ out: { rounds: s.rounds } })" },
    ] },
  };
  const result = await runWorkflow(wf, { scores: [0] }, {});
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { rounds: 3 }, "three increments reach 3; the loop did not run to its bound");
});

// ─── F7 ───

const Record = object({ label: { type: "string" } });
const hostWorkflow = (branches) => ({
  v: 2, name: "host-merge",
  schemas: { Input: object({ text: { type: "string" } }), Record, State: object({ text: { type: "string" }, left: Record, right: Record }) },
  input: { schemaId: "Input" }, output: { schemaId: "State" },
  root: { node: "chain", steps: [{ node: "parallel", label: "both", branches }] },
});
const decide = (label) => ({ node: "decide", label, instructions: "Decide from the JSON input.", out: "Record", as: label });
/** Each branch writes host key `k` to the value its label maps to. */
const hostPolicyWriting = (byLabel) => ({
  decodeSubmission: (submission, context) => ({ value: submission, host: { k: byLabel[context.node.label] } }),
});
const runNode = async (params) => ({ label: params.label });

test("F7: a scalar write and an array append on one host key conflict in either branch order", async () => {
  for (const [order, values] of [["scalar then array", { left: "a", right: ["b"] }], ["array then scalar", { left: ["b"], right: "a" }]]) {
    await assert.rejects(
      runWorkflow(hostWorkflow([decide("left"), decide("right")]), { text: "x" }, { hostPolicy: hostPolicyWriting(values), runNode }),
      (error) => error.reason === "parallel_write_conflict" && /\$host\.k/.test(error.message) && /branches 0 and 1/.test(error.message),
      `${order}: no shape wins silently`,
    );
  }
});

test("F7: appends from several branches still join in branch order, and equal writes are one write", async () => {
  const appended = await runWorkflow(hostWorkflow([decide("left"), decide("right")]), { text: "x" }, { hostPolicy: hostPolicyWriting({ left: ["l"], right: ["r"] }), runNode });
  assert.equal(appended.status, "complete");
  assert.deepEqual(appended.host, { k: ["l", "r"] });
  const same = await runWorkflow(hostWorkflow([decide("left"), decide("right")]), { text: "x" }, { hostPolicy: hostPolicyWriting({ left: "same", right: "same" }), runNode });
  assert.deepEqual(same.host, { k: "same" });
  const threeWay = await runWorkflow(
    { ...hostWorkflow([decide("left"), decide("right"), decide("third")]), schemas: { Input: object({ text: { type: "string" } }), Record, State: object({ text: { type: "string" }, left: Record, right: Record, third: Record }) } },
    { text: "x" }, { hostPolicy: hostPolicyWriting({ left: ["l"], right: ["r"], third: "s" }), runNode },
  ).then(() => "completed", (error) => error.reason);
  assert.equal(threeWay, "parallel_write_conflict", "a scalar after two appends is still a conflict");
});
