// `poll` on a call node: the call repeats until `until` matches its own result, fails at once on
// `fail_when`, gives up at the poll deadline, and — in the dry run — checks exactly once. The
// validator resolves poll paths inside the declared result shape and admits the `in` predicate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow, validateWorkflow, dryRunWorkflow } from "../dist/index.js";

const SCHEMAS = {
  Plan: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } },
  Status: { type: "object", required: ["status"], properties: { status: { type: "string" }, detail: { type: "object", properties: { pct: { type: "integer" } } } } },
  Output: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
};
const planNode = { node: "extract", label: "plan", instructions: "plan", out: "Plan", as: "plan" };
const assemble = { node: "code", label: "assemble", code: "(s) => ({ final: { status: s.job.status } })" };
const poll = (extra = {}) => ({ until: { predicate: "in", path: "status", values: ["COMPLETED"] }, fail_when: { predicate: "in", path: "status", values: ["FAILED", "CANCELLED"] }, interval_s: 0.1, deadline_s: 5, ...extra });
const statusCall = (extra = {}, p = poll()) => ({ node: "call", label: "status", via: "tool", tool: "jobs.status", args: { request_id: "{plan.request_id}" }, out: "Status", as: "job", deadline_s: 5, poll: p, ...extra });
const wf = (steps) => ({ v: 2, name: "t", schemas: SCHEMAS, output: { schemaId: "Output", path: "final" }, root: { node: "chain", steps } });
const INPUT_KEYS = ["question", "context"];

test("validator: a poll with result-relative predicates is accepted; every clause is checked", () => {
  assert.deepEqual(validateWorkflow(wf([planNode, statusCall(), assemble]), { inputKeys: INPUT_KEYS }), { ok: true });
  const cases = [
    [statusCall({}, poll({ until: undefined })), /poll\.until is required/],
    [statusCall({}, poll({ until: { predicate: "eventually", path: "status" } })), /poll\.until: unknown predicate/],
    [statusCall({}, poll({ until: { predicate: "in", path: "status", values: [] } })), /in needs a non-empty values list/],
    [statusCall({}, poll({ until: { predicate: "field_equals", path: "state", value: "DONE" } })), /poll\.until path "state" is not in the declared result shape \(status, detail\)/],
    [statusCall({}, poll({ fail_when: { predicate: "field_true", path: "detail.nope" } })), /poll\.fail_when path "detail\.nope" is not in the declared result shape/],
    [statusCall({}, poll({ interval_s: 0 })), /poll\.interval_s must be 0\.1\.\.300/],
    [statusCall({}, poll({ deadline_s: 2 })), /poll\.deadline_s must be at least deadline_s/],
    [statusCall({}, "soon"), /poll must be an object/],
    [{ node: "loop", label: "l", body: { node: "code", label: "c", code: "(s) => ({ items: [] })" }, until: { predicate: "in", path: "items", values: [] }, max_iterations: 2 }, /until: in needs a non-empty values list/],
  ];
  for (const [node, pattern] of cases) {
    const result = validateWorkflow(wf([planNode, node, assemble]), { inputKeys: INPUT_KEYS });
    assert.equal(result.ok, false, JSON.stringify(node));
    assert.match(result.errors.join("\n"), pattern, JSON.stringify(node));
  }
});

test("runner: the call repeats until `until` matches its own result; each check is a fresh execution", async () => {
  const statuses = ["IN_QUEUE", "IN_PROGRESS", "COMPLETED"];
  const events = [];
  let calls = 0;
  const result = await runWorkflow(wf([planNode, statusCall(), assemble]), { question: "q" }, {
    runNode: async () => ({ request_id: "req-1" }),
    onEvent: (e) => events.push(e),
    runEffect: async ({ input }) => { assert.deepEqual(input, { request_id: "req-1" }); return { status: statuses[calls++] }; },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { status: "COMPLETED" });
  assert.equal(calls, 3);
  const polls = events.filter((e) => e.type === "effect.poll").map((e) => [e.detail.iteration, e.detail.settled]);
  assert.deepEqual(polls, [[1, null], [2, null], [3, "until"]]);
});

test("runner: `fail_when` fails the node at once with the result in the message; no further checks", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(wf([planNode, statusCall(), assemble]), { question: "q" }, {
      runNode: async () => ({ request_id: "req-1" }),
      runEffect: async () => ({ status: ["IN_QUEUE", "FAILED", "COMPLETED"][calls++] }),
    }),
    /poll met fail_when after 2 check\(s\): \{"status":"FAILED"\}/,
  );
  assert.equal(calls, 2);
});

test("runner: the poll deadline bounds the whole wait and reads as a timeout", async () => {
  let calls = 0;
  const events = [];
  const started = Date.now();
  await assert.rejects(
    runWorkflow(wf([planNode, statusCall({ deadline_s: 1 }, poll({ deadline_s: 1, interval_s: 0.2 })), assemble]), { question: "q" }, {
      runNode: async () => ({ request_id: "req-1" }),
      onEvent: (e) => events.push(e),
      runEffect: async () => { calls++; return { status: "IN_PROGRESS" }; },
    }),
    /poll exceeded its 1s deadline after \d+ check\(s\)/,
  );
  assert.ok(Date.now() - started < 3000, "gave up close to the deadline");
  assert.ok(calls >= 3 && calls <= 6, `checked a bounded number of times (${calls})`);
  assert.equal(events.filter((e) => e.type === "effect.poll").at(-1)?.detail.settled, "deadline");
});

test("runner: a result that violates the schema fails before any predicate is read", async () => {
  await assert.rejects(
    runWorkflow(wf([planNode, statusCall(), assemble]), { question: "q" }, {
      runNode: async () => ({ request_id: "req-1" }),
      runEffect: async () => ({ state: "COMPLETED" }),
    }),
    /call node "status" result does not satisfy schema "Status"/,
  );
});

test("dry run synthesizes a poll result without waiting for its unsatisfied predicate", { timeout: 1000 }, async () => {
  const result = await dryRunWorkflow(wf([planNode, statusCall({}, poll({ interval_s: 300, deadline_s: 7200 })), assemble]), {});
  assert.deepEqual(result, { ok: true });
});

test("runner: a check that starts near the poll deadline is cut at the poll deadline, not at its own node deadline", async () => {
  // node deadline 3s, poll deadline 3s, interval 2s: the second check starts with ~1s left and hangs;
  // it must be aborted at the poll deadline (~3s), not run its full 3s node deadline (~5s).
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    runWorkflow(wf([planNode, statusCall({ deadline_s: 3 }, poll({ deadline_s: 3, interval_s: 2 })), assemble]), { question: "q" }, {
      runNode: async () => ({ request_id: "req-1" }),
      runEffect: ({ signal }) => { calls += 1; if (calls === 1) return Promise.resolve({ status: "IN_PROGRESS" }); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))); },
    }),
    /poll exceeded its 3s deadline/,
  );
  const wall = Date.now() - started;
  assert.equal(calls, 2);
  assert.ok(wall < 4000, `cut at the poll deadline (${wall}ms)`);
});
