// The `call` node: one author-controlled side effect with no model in the loop. The validator
// admits it only fully declared; the runner interpolates by value, runs it through deps.runEffect
// under its deadline and retry policy, validates the result, and merges it under `as`; the dry run
// never executes an effect.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow, validateWorkflow, dryRunWorkflow, workflowSha256, EffectFailure } from "../dist/index.js";

const SCHEMAS = {
  Plan: { type: "object", required: ["prompt", "seconds"], properties: { prompt: { type: "string" }, seconds: { type: "integer" } } },
  Submit: { type: "object", required: ["request_id", "status"], properties: { request_id: { type: "string" }, status: { type: "string" } } },
  Output: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } },
};
const wf = (steps, output = { schemaId: "Output", path: "final" }) => ({ v: 2, name: "t", schemas: SCHEMAS, output, root: { node: "chain", steps } });
const INPUT_KEYS = ["question", "context"];

const submitCall = (extra = {}) => ({
  node: "call", label: "submit", via: "tool", tool: "jobs.submit",
  args: { model: "minimax/h3-max-turbo", input: { prompt: "{plan.prompt}", duration: "{plan.seconds}" }, note: "shot for {question}" },
  out: "Submit", as: "job", deadline_s: 60, ...extra,
});
const planNode = { node: "extract", label: "plan", instructions: "plan", out: "Plan", as: "plan" };
const assemble = { node: "code", label: "assemble", code: "(s) => ({ final: { request_id: s.job.request_id } })" };

test("validator: a fully declared call node is accepted and its `as` is reachable downstream", () => {
  const ok = validateWorkflow(wf([planNode, submitCall(), { node: "escalate", label: "guard", when: { predicate: "field_equals", path: "job.status", value: "FAILED" }, kind: "render_failed", stage: "submit", summary: "render failed for {job.request_id}" }, assemble]), { inputKeys: INPUT_KEYS });
  assert.deepEqual(ok, { ok: true });
});

test("validator: the declared result schema seeds the predicate check", () => {
  const bad = validateWorkflow(wf([planNode, submitCall(), { node: "escalate", label: "guard", when: { predicate: "field_true", path: "job.nope" }, kind: "x", stage: "submit", summary: "x" }, assemble]), { inputKeys: INPUT_KEYS });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("\n"), /predicate path "job.nope" is not produced/);
});

test("validator: every field is checked; the rejections name the node", () => {
  const cases = [
    [submitCall({ deadline_s: undefined }), /deadline_s must be greater than 0 and at most 3600/],
    [submitCall({ via: "http" }), /via must be tool\|executor\|shell/],
    [submitCall({ out: "Nope" }), /out schema "Nope" not in workflow\.schemas/],
    [submitCall({ produces: ["a.mp4"] }), /only a via shell call may declare produces/],
    [submitCall({ args: { prompt: "{nothere.x}" } }), /interpolates \{nothere\.x\} but no upstream node produces "nothere"/],
    [submitCall({ retry: { attempts: 9 } }), /retry\.attempts must be 1\.\.5/],
    [submitCall({ retry: { attempts: 2, on: ["http_404"] } }), /retry\.on may name only/],
    [submitCall({ retry: { attempts: 2, on: ["exit"] } }), null],
    [submitCall({ where: "host" }), /where accepts only "sandbox"/],
    [submitCall({ command: "ls" }), /command is not a via tool field/],
    [{ node: "call", label: "edit", via: "shell", command: "ffmpeg", out: "Submit", as: "edit", deadline_s: 10 }, /drop out/],
    [{ node: "call", label: "run", via: "executor", code: "const x = 1;", out: "Submit", as: "r", deadline_s: 10 }, /must return its JSON result/],
    [{ node: "call", label: "run", via: "executor", code: "return await fetch('x')", out: "Submit", as: "r", deadline_s: 10 }, /may use only tools and input/],
    [{ node: "call", label: "edit", via: "shell", command: "ffmpeg", as: "edit", deadline_s: 10, produces: ["../escape.mp4"] }, /workspace-relative/],
  ];
  for (const [node, pattern] of cases) {
    const result = validateWorkflow(wf([planNode, node, assemble]), { inputKeys: INPUT_KEYS });
    if (pattern === null) { assert.deepEqual(result, { ok: true }, JSON.stringify(node)); continue; }
    assert.equal(result.ok, false, JSON.stringify(node));
    assert.match(result.errors.join("\n"), pattern, JSON.stringify(node));
  }
});

test("runner: a declared retry covers a shell exit; without a declaration one failure ends the node", async () => {
  let runs = 0;
  const shellCall = (extra = {}) => ({ node: "call", label: "render", via: "shell", command: "ffmpeg", as: "render", deadline_s: 10, ...extra });
  const shellWf = (node) => ({ v: 2, name: "t", schemas: { ...SCHEMAS, Out2: { type: "object", required: ["code"], properties: { code: { type: "integer" } } } }, output: { schemaId: "Out2", path: "final" }, root: { node: "chain", steps: [node, { node: "code", label: "assemble", code: "(s) => ({ final: { code: s.render.code } })" }] } });
  const flaky = async ({ attempt }) => { runs += 1; if (attempt === 1) throw new EffectFailure("exited 5", "exit"); return { code: 0, stdout: "", stderr: "", truncated: false }; };
  const ok = await runWorkflow(shellWf(shellCall({ retry: { attempts: 2, backoff_s: 0 } })), { question: "q" }, { runEffect: flaky });
  assert.equal(ok.status, "complete");
  assert.equal(runs, 2);
  runs = 0;
  await assert.rejects(runWorkflow(shellWf(shellCall()), { question: "q" }, { runEffect: flaky }), /exited 5/);
  assert.equal(runs, 1);
});

test("runner: interpolation is by value, the result is validated and lands under `as`", async () => {
  const seen = [];
  const result = await runWorkflow(wf([planNode, submitCall(), assemble]), { question: "lighthouse" }, {
    runNode: async () => ({ prompt: "a keeper at dawn", seconds: 15 }),
    runEffect: async ({ node, input, attempt, idempotencyKey }) => {
      seen.push({ tool: node.tool, input, attempt, idempotencyKey });
      return { request_id: "req-1", status: "IN_QUEUE" };
    },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { request_id: "req-1" });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].input, { model: "minimax/h3-max-turbo", input: { prompt: "a keeper at dawn", duration: 15 }, note: "shot for lighthouse" }, "a whole-string placeholder keeps the value's type; embedded ones render as text");
  assert.match(seen[0].idempotencyKey, /^[0-9a-f]{64}$/);
});

test("runner retries a declared transient failure with the same idempotency key", async () => {
  const attempts = [];
  const result = await runWorkflow(wf([planNode, submitCall({ retry: { attempts: 3, backoff_s: 0, on: ["http_429"] } }), assemble]), { question: "q" }, {
    runNode: async () => ({ prompt: "p", seconds: 5 }),
    runEffect: async ({ attempt, idempotencyKey }) => {
      attempts.push({ attempt, idempotencyKey });
      if (attempt < 3) throw new EffectFailure("rate limited", "http_429");
      return { request_id: "req-2", status: "IN_QUEUE" };
    },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2, 3]);
  assert.equal(new Set(attempts.map((a) => a.idempotencyKey)).size, 1);
});

test("runner: a failure outside retry.on, or with no retry class, fails the node at once", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(wf([planNode, submitCall({ retry: { attempts: 3, backoff_s: 0, on: ["timeout"] } }), assemble]), { question: "q" }, {
      runNode: async () => ({ prompt: "p", seconds: 5 }),
      runEffect: async () => { calls += 1; throw new EffectFailure("bad request", null); },
    }),
    /bad request/,
  );
  assert.equal(calls, 1);
});

test("runner: the deadline aborts the effect and reads as a timeout class", async () => {
  const events = [];
  await assert.rejects(
    runWorkflow(wf([planNode, submitCall({ deadline_s: 1 }), assemble]), { question: "q" }, {
      runNode: async () => ({ prompt: "p", seconds: 5 }),
      onEvent: (e) => events.push(e),
      runEffect: ({ signal }) => new Promise((_, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted by signal"))); }),
    }),
    /exceeded its 1s deadline/,
  );
  const failed = events.find((e) => e.type === "effect.failed");
  assert.equal(failed?.detail?.retry_class, "timeout");
});

test("runner: a result that violates the declared schema fails loud with the node name", async () => {
  await assert.rejects(
    runWorkflow(wf([planNode, submitCall(), assemble]), { question: "q" }, {
      runNode: async () => ({ prompt: "p", seconds: 5 }),
      runEffect: async () => ({ status: "IN_QUEUE" }),
    }),
    /call node "submit" result does not satisfy schema "Submit"/,
  );
});

test("runner: a workflow with a call node cannot run on a runner that has no effect executor", async () => {
  await assert.rejects(
    runWorkflow(wf([planNode, submitCall(), assemble]), { question: "q" }, { runNode: async () => ({ prompt: "p", seconds: 5 }) }),
    /requires runEffect/,
  );
});

test("dry run: effects are synthesized, never executed", async () => {
  const workflow = wf([planNode, submitCall(), { node: "call", label: "edit", via: "shell", command: "ffmpeg -i {job.request_id}.mp4 final.mp4", as: "edit", deadline_s: 30, produces: ["final.mp4"] }, assemble]);
  const result = await dryRunWorkflow(workflow, { input: { question: "A short scene" } });
  assert.equal(result.ok, true, JSON.stringify(result));
});

