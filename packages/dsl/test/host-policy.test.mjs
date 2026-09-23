import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow, validateWorkflow, WorkflowOutputInvalidError, HOST_STATE_KEY } from "../dist/index.js";

// A host policy is application code handed in through deps. These tests pin the boundary the engine
// promises around it: the domain schema and the verifier always see the decoded domain value, host
// state never reaches the output projection, and every hook is attributed to the node it ran for.

const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
const schemas = {
  Input: object({ text: { type: "string" } }),
  Record: object({ label: { type: "string" }, count: { type: "integer" } }),
  Brief: object({ headline: { type: "string" } }),
};
const CHANNEL = object({ code: { type: "string" }, severity: { type: "string", enum: ["info", "warning"] } });
const CLAIMS = { type: "array", items: object({ path: { type: "string" } }) };

/** The host's channels: a concern and a list of claims ride the terminal submission, never the domain value. */
const policy = (overrides = {}) => ({
  systemBlocks: (context) => (context.terminal ? ["TERMINAL DUTY: claim the fields you relied on."] : []),
  submissionSchema: (stage, context) => (context.terminal && stage.type === "object"
    ? { ...stage, properties: { ...stage.properties, concern: CHANNEL, claims: CLAIMS } }
    : stage),
  decodeSubmission: (submission, context) => {
    const { concern, claims, ...value } = submission;
    const concerns = Array.isArray(context.host.concerns) ? context.host.concerns : [];
    return { value, host: {
      ...(concern ? { concerns: [...concerns, { ...concern, stage: context.node.label }] } : {}),
      ...(claims?.length ? { claims } : {}),
    } };
  },
  ...overrides,
});

const workflow = (steps, output = { schemaId: "Record", path: "record" }) => ({ v: 2, name: "host-policy", schemas, input: { schemaId: "Input" }, output, root: { node: "chain", steps } });
const decide = (extra = {}) => ({ node: "decide", label: "decide", instructions: "Decide from the JSON input.", out: "Record", as: "record", ...extra });
const scripted = (answers) => async (params) => {
  const next = answers.shift();
  return typeof next === "function" ? next(params) : next;
};

test("without a host policy the generative path is unchanged", async () => {
  const seen = [];
  const result = await runWorkflow(workflow([decide()]), { text: "x" }, {
    runNode: async (params) => { seen.push(params); return { label: "a", count: 1 }; },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { label: "a", count: 1 });
  assert.equal("host" in result, false);
  assert.deepEqual(seen[0].system, ["Decide from the JSON input."]);
  assert.deepEqual(seen[0].schema, schemas.Record);
});

test("systemBlocks and submissionSchema apply to the terminal node only; the decoded value is the domain record", async () => {
  const seen = [];
  const events = [];
  const result = await runWorkflow(workflow([
    { node: "extract", label: "read", instructions: "Read the text.", out: "Brief", as: "brief" },
    decide(),
  ]), { text: "x" }, {
    hostPolicy: policy(),
    onEvent: (event) => events.push(event),
    runNode: async (params) => {
      seen.push(params);
      if (params.kind === "extract") return { headline: "h" };
      return { label: "a", count: 1, concern: { code: "thin_evidence", severity: "warning" }, claims: [{ path: "label" }] };
    },
  });
  // The non-terminal extract saw neither the duty block nor the channels.
  assert.deepEqual(seen[0].system, ["Read the text."]);
  assert.deepEqual(seen[0].schema, schemas.Brief);
  // The terminal decide saw both.
  assert.deepEqual(seen[1].system, ["Decide from the JSON input.", "TERMINAL DUTY: claim the fields you relied on."]);
  assert.deepEqual(Object.keys(seen[1].schema.properties), ["label", "count", "concern", "claims"]);
  // Domain state and output carry the domain value only; host state is beside it and on the result.
  assert.equal(result.status, "complete");
  assert.deepEqual(result.state.record, { label: "a", count: 1 });
  assert.deepEqual(result.output, { label: "a", count: 1 });
  assert.deepEqual(result.host, { concerns: [{ code: "thin_evidence", severity: "warning", stage: "decide" }], claims: [{ path: "label" }] });
  assert.deepEqual(result.state[HOST_STATE_KEY], result.host);
  assert.equal("concerns" in result.state, false, "host state never lands on a top-level domain key");
  const decoded = events.find((event) => event.type === "host.decoded");
  assert.deepEqual(decoded.detail.keys, ["concerns", "claims"]);
  assert.equal(decoded.label, "decide");
});

test("host state is excluded from a path-less output projection and accumulates across terminal-shaped nodes", async () => {
  // Two decide nodes both emit the output schema; each concern is appended, the projection is the state minus host keys.
  const wf = { ...workflow([
    decide({ label: "first", as: "record" }),
    decide({ label: "second", as: "record" }),
  ], { schemaId: "State" }), schemas: { ...schemas, State: object({ text: { type: "string" }, record: schemas.Record }) } };
  const widenEveryDecide = (stage, context) => (context.node.kind === "decide" ? { ...stage, properties: { ...stage.properties, concern: CHANNEL, claims: CLAIMS } } : stage);
  const result = await runWorkflow(wf, { text: "x" }, {
    hostPolicy: policy({ submissionSchema: widenEveryDecide }),
    runNode: scripted([
      { label: "a", count: 1, concern: { code: "c1", severity: "info" } },
      { label: "b", count: 2, concern: { code: "c2", severity: "warning" } },
    ]),
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { text: "x", record: { label: "b", count: 2 } });
  assert.deepEqual(result.host.concerns.map((c) => `${c.stage}:${c.code}`), ["first:c1", "second:c2"]);
});

test("a host channel cannot bypass domain validation: an invalid domain value fails on the stage schema", async () => {
  await assert.rejects(runWorkflow(workflow([decide()]), { text: "x" }, {
    hostPolicy: policy(),
    runNode: async () => ({ label: "a", count: "not-an-integer", concern: { code: "c", severity: "info" } }),
  }), (error) => error instanceof WorkflowOutputInvalidError && /submission does not satisfy schema "Record"/.test(error.message));
  // A malformed channel is a transport rejection with the same typed error, before any decode.
  await assert.rejects(runWorkflow(workflow([decide()]), { text: "x" }, {
    hostPolicy: policy(),
    runNode: async () => ({ label: "a", count: 1, concern: { code: "c", severity: "catastrophic" } }),
  }), (error) => error instanceof WorkflowOutputInvalidError && error.stage === "decide");
  // A decoder that strips a required domain field is caught on the stage schema after decoding.
  await assert.rejects(runWorkflow(workflow([decide()]), { text: "x" }, {
    hostPolicy: policy({ decodeSubmission: (submission) => { const { count: _dropped, ...value } = submission; return { value }; } }),
    runNode: async () => ({ label: "a", count: 1 }),
  }), (error) => error instanceof WorkflowOutputInvalidError && /decoded submission does not satisfy schema "Record"/.test(error.message));
});

test("a verify clause reviews the decoded domain value, both on the review hook and on the final submission", async () => {
  const judged = [];
  const wf = { ...workflow([decide({ verify: { out: "Checks", maxDrives: 2 } })]),
    schemas: { ...schemas, Checks: object({ label: { type: "boolean", description: "Is the label supported?", criteria: { true: "yes", false: "no" } } }) } };
  const result = await runWorkflow(wf, { text: "x" }, {
    hostPolicy: policy(),
    runJudge: async (params) => { judged.push(params.state.submission); return { answers: { label: { type: "noul", noul: 0.9 } } }; },
    runNode: async (params) => {
      const candidate = { label: "a", count: 1, concern: { code: "c", severity: "info" }, claims: [{ path: "label" }] };
      const verdict = await params.review(candidate);
      assert.equal(verdict.accepted, true);
      return candidate;
    },
  });
  assert.equal(result.status, "complete");
  // Neither the review-time nor the finish-time judgment saw the host channels.
  for (const submission of judged) assert.deepEqual(Object.keys(submission).sort(), ["count", "label"]);
  assert.deepEqual(result.host.claims, [{ path: "label" }]);
});

test("a review candidate that fails the transport schema is a rejection message, not a thrown adapter failure", async () => {
  const wf = { ...workflow([decide({ verify: { out: "Checks", maxDrives: 2 } })]),
    schemas: { ...schemas, Checks: object({ label: { type: "boolean", description: "Is the label supported?", criteria: { true: "yes", false: "no" } } }) } };
  const result = await runWorkflow(wf, { text: "x" }, {
    hostPolicy: policy(),
    runJudge: async () => ({ answers: { label: { type: "noul", noul: 0.9 } } }),
    runNode: async (params) => {
      const bad = await params.review({ label: "a", count: 1, concern: { code: "c", severity: "nope" } });
      assert.equal(bad.accepted, false);
      assert.match(bad.message, /does not satisfy schema "Record"/);
      return { label: "a", count: 1 };
    },
  });
  assert.equal(result.status, "complete");
});

test("afterNode enriches domain state before checkpoint and downstream nodes and output validation see it", async () => {
  const checkpoints = [];
  const wf = { v: 2, name: "artifact-policy",
    schemas: { Input: schemas.Input, Artifact: object({ path: { type: "string" }, filename: { type: "string" }, type: { type: "string" }, app_type: { type: "string" } }), Result: object({ app_type: { type: "string" } }) },
    input: { schemaId: "Input" }, output: { schemaId: "Artifact", path: "artifact" },
    root: { node: "chain", steps: [
      { node: "call", label: "render", via: "shell", command: "echo", as: "shell", produces: ["out/site.html"], deadline_s: 5 },
      { node: "code", label: "check", code: "(s) => ({ checked: s.artifact ? 'too-early' : 'not-yet' })" },
      { node: "artifact", label: "deliver", type: "website", path: "out/site.html" },
    ] } };
  const events = [];
  const result = await runWorkflow(wf, { text: "x" }, {
    hostPolicy: { afterNode: ({ node, state }) => (node.kind === "artifact" && state.artifact ? { artifact: { ...state.artifact, app_type: "static_site" } } : undefined) },
    runEffect: async () => ({ code: 0, stdout: "", stderr: "" }),
    checkpoint: async (state, label) => { checkpoints.push([label, state.artifact?.app_type ?? null]); },
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { path: "out/site.html", filename: "site.html", type: "website", app_type: "static_site" });
  assert.deepEqual(checkpoints.at(-1), ["deliver", "static_site"]);
  assert.equal("host" in result, false, "afterNode writes domain state, not host state");
  assert.deepEqual(events.find((event) => event.type === "host.patched")?.detail, { keys: ["artifact"] });
});

test("inside a map body every hook is attributed to its item and execution path", async () => {
  const contexts = [];
  const wf = { v: 2, name: "map-policy",
    schemas: { Input: object({ items: { type: "array", items: { type: "string" } } }), Item: object({ value: { type: "string" } }), Out: object({ items: { type: "array" }, results: { type: "array" } }) },
    input: { schemaId: "Input" }, output: { schemaId: "Out" },
    root: { node: "chain", steps: [{ node: "map", label: "each", itemsPath: "items", as: "results", maxConcurrency: 2, resultPath: "item_result",
      body: { node: "extract", label: "one", instructions: "Read item.", out: "Item", as: "item_result" } }] } };
  const result = await runWorkflow(wf, { items: ["a", "b"] }, {
    hostPolicy: { systemBlocks: (context) => { contexts.push(context); return []; }, decodeSubmission: (submission, context) => ({ value: submission, host: { seen: [...(context.host.seen ?? []), context.item.index] } }) },
    runNode: async (params) => ({ value: JSON.parse(params.user).item }),
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { items: ["a", "b"], results: [{ value: "a" }, { value: "b" }] });
  assert.deepEqual(contexts.map((c) => [c.item?.index, c.executionPath]).sort(), [[0, "/root/steps/0/items/0/body"], [1, "/root/steps/0/items/1/body"]]);
  assert.equal(contexts.every((c) => c.terminal === false && c.node.kind === "extract"), true);
  // Item-local host state stays inside the item result's state, never on the parent's output or result.host.
  assert.equal("host" in result, false);
});

test("a child workflow applies the policy with its own context and keeps its host state to itself", async () => {
  const contexts = [];
  const child = { v: 2, name: "child", schemas: { In: object({ text: { type: "string" } }), Record: schemas.Record },
    input: { schemaId: "In" }, output: { schemaId: "Record", path: "record" },
    root: { node: "chain", steps: [decide()] } };
  const wf = workflow([{ node: "workflow", label: "delegate", workflow: child, input: { text: "{text}" }, out: "Record", as: "record" }]);
  const result = await runWorkflow(wf, { text: "x" }, {
    hostPolicy: policy({ systemBlocks: (context) => { contexts.push(context); return []; } }),
    runNode: async () => ({ label: "a", count: 1, concern: { code: "child", severity: "info" } }),
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { label: "a", count: 1 });
  assert.equal(contexts[0].terminal, true, "the child's decide emits the child's output schema");
  assert.equal(contexts[0].workflow.name, "child");
  assert.match(contexts[0].executionPath, /^\/root\/steps\/0\/workflow\/root/);
  assert.equal("host" in result, false, "the child's host state does not cross the child's output contract");
  assert.equal(HOST_STATE_KEY in result.state, false);
});

test("host state restored by recovery is still host state: excluded from output and returned on the result", async () => {
  // The decide node never runs again: recovery hands back the checkpointed state, $host included.
  const restored = { text: "x", record: { label: "a", count: 1 }, [HOST_STATE_KEY]: { concerns: [{ code: "c", severity: "info", stage: "first" }] } };
  const wf = { ...workflow([decide({ label: "first" })], { schemaId: "State" }), schemas: { ...schemas, State: object({ text: { type: "string" }, record: schemas.Record }) } };
  const result = await runWorkflow(wf, { text: "x" }, {
    hostPolicy: policy(),
    recovery: { supportsExecutionPaths: true, resume: async () => structuredClone(restored), commit: async () => {}, pollStartedAt: () => 0, wait: async () => {} },
    runNode: async () => { throw new Error("a restored step must not redispatch"); },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { text: "x", record: { label: "a", count: 1 } });
  assert.deepEqual(result.host, restored[HOST_STATE_KEY]);
});

test("the reserved host key cannot be written by a workflow, a code node, an afterNode patch, or the input", async () => {
  const named = validateWorkflow(workflow([decide({ as: HOST_STATE_KEY })]));
  assert.equal(named.ok, false);
  assert.match(named.errors.join("\n"), /engine-owned "\$" state key/);
  // An unaliased node writes under its label, so a "$host" label is the same bypass and is refused too.
  const labeled = validateWorkflow({ ...workflow([{ node: "decide", label: HOST_STATE_KEY, instructions: "Decide.", out: "Record" }]), output: { schemaId: "Record", path: HOST_STATE_KEY } });
  assert.equal(labeled.ok, false);
  assert.match(labeled.errors.join("\n"), /label must not begin with "\$"/);
  await assert.rejects(runWorkflow(workflow([{ node: "code", label: "smuggle", code: "() => ({ $host: { x: 1 }, record: { label: 'a', count: 1 } })" }]), { text: "x" }, {}),
    (error) => error.reason === "reserved_state_key");
  await assert.rejects(runWorkflow(workflow([decide()]), { text: "x" }, {
    hostPolicy: { afterNode: () => ({ [HOST_STATE_KEY]: { x: 1 } }) },
    runNode: async () => ({ label: "a", count: 1 }),
  }), (error) => error.reason === "reserved_state_key");
  await assert.rejects(runWorkflow(workflow([decide()]), { text: "x", [HOST_STATE_KEY]: {} }, { runNode: async () => ({ label: "a", count: 1 }) }),
    (error) => error.code === "input_invalid");
});

test("parallel branches merge host state by delta: arrays append, equal values keep, conflicting scalars fail", async () => {
  const widenEveryDecide = (stage, context) => (context.node.kind === "decide" ? { ...stage, properties: { ...stage.properties, concern: CHANNEL, claims: CLAIMS } } : stage);
  const branches = [decide({ label: "left", as: "left" }), decide({ label: "right", as: "right" })];
  const wf = { ...workflow([{ node: "parallel", label: "both", branches }], { schemaId: "State" }),
    schemas: { ...schemas, State: object({ text: { type: "string" }, left: schemas.Record, right: schemas.Record }) } };
  const result = await runWorkflow(wf, { text: "x" }, {
    hostPolicy: policy({ submissionSchema: widenEveryDecide }),
    runNode: async (params) => (params.label === "left"
      ? { label: "l", count: 1, concern: { code: "L", severity: "info" }, claims: [{ path: "label" }] }
      : { label: "r", count: 2, concern: { code: "R", severity: "warning" }, claims: [{ path: "label" }] }),
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { text: "x", left: { label: "l", count: 1 }, right: { label: "r", count: 2 } });
  assert.deepEqual(result.host.concerns.map((c) => c.code).sort(), ["L", "R"]);
  assert.deepEqual(result.host.claims, [{ path: "label" }], "an equal value written by both branches is kept once");
  // A non-array host key set to different values by two branches is a write conflict.
  await assert.rejects(runWorkflow(wf, { text: "x" }, {
    hostPolicy: { submissionSchema: widenEveryDecide, decodeSubmission: (submission, context) => { const { concern, claims, ...value } = submission; return { value, host: { owner: context.node.label } }; } },
    runNode: async () => ({ label: "a", count: 1 }),
  }), (error) => error.reason === "parallel_write_conflict" && /\$host\.owner/.test(error.message));
});
