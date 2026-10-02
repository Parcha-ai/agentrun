// Behaviour knobs (maxIters, call deadline_s, retry.attempts/backoff_s, poll.interval_s/deadline_s,
// map.maxConcurrency, verify.maxDrives) carry NO upper ceiling: the author picks the number. The
// validator keeps only the floors and structural requirements — a busy-loop guard, a positive
// deadline, a required deadline — and never caps how high a value goes. These tests pin that: a
// document with absurdly large values validates, and every lower-bound / structural refusal stays.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkflow } from "../dist/index.js";

const SCHEMAS = {
  Plan: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } },
  Status: { type: "object", required: ["status"], properties: { status: { type: "string" }, detail: { type: "object", properties: { pct: { type: "integer" } } } } },
  Item: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  Review: { type: "object", required: ["ok"], properties: { ok: { type: "boolean", description: "Is the draft acceptable?" } } },
  Output: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
};
const INPUT_KEYS = ["question", "items"];
const wf = (steps) => ({ v: 2, name: "no-ceilings", schemas: SCHEMAS, output: { schemaId: "Output", path: "final" }, root: { node: "chain", steps } });

const planNode = { node: "extract", label: "plan", instructions: "plan", out: "Plan", as: "plan" };
const assemble = { node: "code", label: "assemble", code: "(s) => ({ final: { status: s.job.status } })" };
// A loop far past the old ceiling of 20.
const bigLoop = {
  node: "loop", label: "grind", maxIters: 200,
  until: { predicate: "field_equals", path: "plan.request_id", value: "never" },
  body: { node: "code", label: "tick", code: "(s) => ({ ticked: true })" },
};
// A call far past every old call ceiling (deadline 3600, attempts 5, backoff 60, interval 300, poll 7200).
const bigCall = {
  node: "call", label: "status", via: "tool", tool: "jobs.status",
  args: { request_id: "{plan.request_id}" }, out: "Status", as: "job",
  deadline_s: 86400,
  retry: { attempts: 50, backoff_s: 3600, on: ["timeout", "http_5xx"] },
  poll: {
    until: { predicate: "in", path: "status", values: ["COMPLETED"] },
    fail_when: { predicate: "in", path: "status", values: ["FAILED"] },
    interval_s: 600, deadline_s: 172800,
  },
};

test("a document with maxIters 200, deadline_s 86400, retry.attempts 50 and poll.deadline_s 172800 validates", () => {
  const verdict = validateWorkflow(wf([planNode, bigLoop, bigCall, assemble]), { inputKeys: INPUT_KEYS });
  assert.deepEqual(verdict, { ok: true });
});

test("map.maxConcurrency has no ceiling", () => {
  const map = { node: "map", label: "fan", itemsPath: "items", as: "fanned", maxConcurrency: 100000, body: { node: "extract", label: "one", instructions: "one", out: "Item", as: "one" } };
  const verdict = validateWorkflow(wf([planNode, map, assemble]), { inputKeys: INPUT_KEYS });
  assert.deepEqual(verdict, { ok: true });
});

test("verify.maxDrives has no ceiling", () => {
  const drafted = { node: "extract", label: "draft", instructions: "draft it", out: "Plan", as: "plan", verify: { out: "Review", maxDrives: 99 } };
  const verdict = validateWorkflow(wf([drafted, bigCall, assemble]), { inputKeys: INPUT_KEYS });
  assert.deepEqual(verdict, { ok: true });
});

test("floors and structural requirements still refuse", () => {
  const cases = [
    // maxIters floor: an integer >= 1.
    [wf([planNode, { ...bigLoop, maxIters: 0 }, bigCall, assemble]), /maxIters must be an integer >= 1/],
    [wf([planNode, { ...bigLoop, maxIters: 2.5 }, bigCall, assemble]), /maxIters must be an integer >= 1/],
    // call deadline_s: required, finite, > 0.
    [wf([planNode, { ...bigCall, deadline_s: 0 }, assemble]), /deadline_s is required and must be a finite number greater than 0/],
    [wf([planNode, { ...bigCall, deadline_s: undefined }, assemble]), /deadline_s is required and must be a finite number greater than 0/],
    // retry.attempts floor: an integer >= 1.
    [wf([planNode, { ...bigCall, retry: { attempts: 0 } }, assemble]), /retry.attempts must be an integer >= 1/],
    // retry.backoff_s floor: a finite number >= 0.
    [wf([planNode, { ...bigCall, retry: { attempts: 3, backoff_s: -1 } }, assemble]), /retry.backoff_s must be a finite number >= 0/],
    // poll.interval_s busy-loop guard: at least 0.1.
    [wf([planNode, { ...bigCall, poll: { ...bigCall.poll, interval_s: 0.05 } }, assemble]), /poll.interval_s must be a finite number of at least 0.1/],
    // poll.deadline_s floor: at least the call's deadline_s.
    [wf([planNode, { ...bigCall, deadline_s: 100, poll: { ...bigCall.poll, deadline_s: 50 } }, assemble]), /poll.deadline_s must be a finite number at least deadline_s/],
  ];
  for (const [doc, pattern] of cases) {
    const verdict = validateWorkflow(doc, { inputKeys: INPUT_KEYS });
    assert.equal(verdict.ok, false, `expected refusal for ${pattern}`);
    assert.match(verdict.errors.join("\n"), pattern);
  }
});
