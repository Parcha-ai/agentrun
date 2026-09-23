import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow, validateWorkflow, stageSchemaForNode, mergeStageDelta } from "../dist/index.js";

const SCHEMAS = {
  Finding: { type: "object", additionalProperties: false, required: ["verdict", "reason"], properties: { verdict: { type: "string", enum: ["ASSIGNED", "REFER"] }, reason: { type: "string" }, code: { type: ["string", "null"] } } },
  Output: { type: "object", required: ["verdict"], properties: { verdict: { type: "string" }, code: { type: ["string", "null"] } } },
};

const wf = (root, output = { schemaId: "Output", path: "final" }) => ({ v: 2, name: "t", schemas: SCHEMAS, output, root });

const scripted = (routes) => ({
  runNode: async ({ label, sample }) => {
    const r = routes[label];
    if (!r) throw new Error(`no script for ${label}`);
    return typeof r === "function" ? r(sample) : r;
  },
});

test("chain + code + agent + decide thread one state; output is validated against its schema", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "code", label: "shape", code: "(s) => ({ merchant: s.question.toUpperCase() })" },
      { node: "agent", label: "gather", instructions: "gather", out: "Finding", as: "evidence" },
      { node: "decide", label: "select", instructions: "decide", out: "Finding", as: "selection" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.selection.verdict, code: s.selection.code ?? null } })" },
    ],
  });
  const result = await runWorkflow(workflow, { question: "acme" }, scripted({
    gather: { verdict: "ASSIGNED", reason: "site found" },
    select: { verdict: "ASSIGNED", reason: "clear", code: "7311" },
  }));
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { verdict: "ASSIGNED", code: "7311" });
  assert.equal(result.state.merchant, "ACME");
});

test("decide samples/voteField are deprecated-and-ignored: the node validates and runs ONCE", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "decide", label: "judge", instructions: "d", out: "Finding", as: "sel", samples: 3, voteField: "verdict" },
      { node: "code", label: "out", code: "(s) => ({ final: { verdict: s.sel.verdict } })" },
    ],
  });
  assert.deepEqual(validateWorkflow(workflow), { ok: true }, "old pins with samples still validate");
  let calls = 0;
  const events = [];
  const result = await runWorkflow(workflow, {}, { runNode: async () => { calls += 1; return { verdict: "ASSIGNED", reason: "clear" }; }, onEvent: (e) => events.push(e) });
  assert.equal(result.output.verdict, "ASSIGNED");
  assert.equal(calls, 1, "samples is ignored; exactly one session");
  assert.ok(!events.some((e) => e.type === "decide.vote"), "no vote machinery fires");
});

test("escalate mid-graph stops the workflow with a typed exception and the partial state", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "decide", label: "select", instructions: "d", out: "Finding", as: "sel" },
      { node: "escalate", label: "gate", when: { predicate: "field_equals", path: "sel.verdict", value: "REFER" }, kind: "classification_unresolved", stage: "selection", summary: "selection referred: {sel.reason}; also {state.sel.reason}; missing {sel.nope}" },
      { node: "code", label: "never", code: "(s) => ({ final: { verdict: 'ASSIGNED' } })" },
    ],
  });
  const result = await runWorkflow(workflow, { question: "x" }, scripted({ select: { verdict: "REFER", reason: "identity unclear" } }));
  assert.equal(result.status, "escalated");
  assert.equal(result.escalation.kind, "classification_unresolved");
  assert.equal(result.escalation.stage, "selection");
  assert.match(result.escalation.summary, /identity unclear; also identity unclear/, "both {path} and {state.path} spellings interpolate");
  assert.match(result.escalation.summary, /\(sel\.nope unset\)/, "a truly missing path names itself instead of vanishing");
  assert.equal(result.state.sel.verdict, "REFER", "partial state travels with the escalation");
  assert.equal(result.state.final, undefined, "nodes after the escalation never ran");
});

test("escalate lets a clean state pass through untouched", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "decide", label: "select", instructions: "d", out: "Finding", as: "sel" },
      { node: "escalate", label: "gate", when: { predicate: "field_equals", path: "sel.verdict", value: "REFER" }, kind: "k", stage: "s", summary: "x" },
      { node: "code", label: "out", code: "(s) => ({ final: { verdict: s.sel.verdict, code: s.sel.code ?? null } })" },
    ],
  });
  const result = await runWorkflow(workflow, {}, scripted({ select: { verdict: "ASSIGNED", reason: "r", code: "7311" } }));
  assert.equal(result.status, "complete");
  assert.deepEqual(result.output, { verdict: "ASSIGNED", code: "7311" });
});

test("map fans out over a state list with the body's `as` collected", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "code", label: "seed", code: "(s) => ({ hits: ['a', 'b', 'c'] })" },
      { node: "map", label: "judge-each", itemsPath: "hits", as: "verdicts", body: { node: "decide", label: "judge", instructions: "d", out: "Finding", as: "v" } },
      { node: "code", label: "out", code: "(s) => ({ final: { verdict: String(s.verdicts.length) } })" },
    ],
  });
  const result = await runWorkflow(workflow, {}, { runNode: async ({ user }) => ({ verdict: "ASSIGNED", reason: `judged ${JSON.parse(user).item}` }) });
  assert.equal(result.status, "complete");
  assert.equal(result.state.verdicts.length, 3);
  assert.match(result.state.verdicts[1].reason, /judged b/);
});

test("loop runs its body until the predicate holds, bounded by maxIters", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "code", label: "seed", code: "(s) => ({ n: 0 })" },
      { node: "loop", label: "count", maxIters: 10, until: { predicate: "count_gte", path: "n", n: 3 }, body: { node: "code", label: "inc", code: "(s) => ({ n: s.n + 1 })" } },
      { node: "code", label: "out", code: "(s) => ({ final: { verdict: String(s.n) } })" },
    ],
  });
  const result = await runWorkflow(workflow, {}, scripted({}));
  assert.equal(result.output.verdict, "3");
});

test("a schema-invalid node submission fails loud with the node name", async () => {
  const workflow = wf({ node: "chain", steps: [{ node: "decide", label: "select", instructions: "d", out: "Finding", as: "sel" }, { node: "code", label: "out", code: "(s) => ({ final: { verdict: 'x' } })" }] });
  await assert.rejects(() => runWorkflow(workflow, {}, scripted({ select: { nope: true } })), /decide node "select" submission does not satisfy schema "Finding"/);
});

test("stage merge projects to declared fields so a risk delta cannot blank upstream selection fields", () => {
  const state = {
    selection: { business_profile: { name: "merchant", activity: "delivery" }, candidate_mcc_pairs: [{ code: "5812" }] },
  };
  const node = { node: "decide", label: "risk", instructions: "rate", out: "RiskVerdict", as: "risk" };
  const schema = { type: "object", additionalProperties: true, properties: { risk_classification: { type: "string" }, rationale: { type: "string" } } };
  const merged = mergeStageDelta(state, node, {
    risk_classification: "MEDIUM", rationale: "criterion", business_profile: {}, candidate_mcc_pairs: [{}],
  }, schema);
  assert.deepEqual(merged.selection, state.selection, "engine-carried upstream state survives unchanged");
  assert.deepEqual(merged.risk, { risk_classification: "MEDIUM", rationale: "criterion" }, "undeclared blanking fields are discarded");
});

test("an empty declared `requires` path fails before a frozen agent is constructed (the engine names no domain field)", async () => {
  const workflow = wf({ node: "chain", steps: [
    { node: "code", label: "shape", code: "() => ({ merchant: { business_name: '', website: '' } })" },
    { node: "agent", label: "gather", instructions: "gather merchant", requires: ["merchant"], out: "Finding", as: "evidence" },
    { node: "code", label: "out", code: "() => ({ final: { verdict: 'x' } })" },
  ] });
  let constructed = 0;
  await assert.rejects(() => runWorkflow(workflow, {}, { runNode: async () => { constructed += 1; return { verdict: "x", reason: "x" }; } }), /requires non-empty state path "merchant" before agent construction/);
  assert.equal(constructed, 0);
});

test("an undeclared empty state block is NOT a gate: task shape lives in the workflow's `requires`, never in the interpreter", async () => {
  const workflow = wf({ node: "chain", steps: [
    { node: "code", label: "shape", code: "() => ({ merchant: { business_name: '', website: '' } })" },
    { node: "agent", label: "gather", instructions: "gather", out: "Finding", as: "evidence" },
    { node: "code", label: "out", code: "() => ({ final: { verdict: 'ASSIGNED', code: 'c' } })" },
  ] });
  let constructed = 0;
  const result = await runWorkflow(workflow, {}, { runNode: async () => { constructed += 1; return { verdict: "ASSIGNED", reason: "x" }; } });
  assert.equal(constructed, 1, "the agent ran: nothing in the engine knows what a merchant is");
  assert.equal(result.output.verdict, "ASSIGNED");
});

test("validator falsifiers: unknown kind, bad code, missing schema, unbounded loop, bad predicate", () => {
  const bad = wf({
    node: "chain", steps: [
      { node: "wat", label: "x" },
      { node: "code", label: "broken", code: "not js ((" },
      { node: "decide", label: "d", instructions: "i", out: "Missing" },
      { node: "loop", label: "l", maxIters: 999, until: { predicate: "nope" }, body: { node: "code", label: "c", code: "(s) => s" } },
      { node: "escalate", label: "e", when: { predicate: "field_true", path: "x" }, kind: "", stage: "s", summary: "t" },
    ],
  });
  const result = validateWorkflow(bad);
  assert.equal(result.ok, false);
  const text = result.errors.join("\n");
  for (const needle of ['unknown node kind "wat"', "broken", 'out schema "Missing"', "maxIters must be 1..20", 'unknown predicate "nope"', "kind, stage, summary required"]) {
    assert.match(text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing error: ${needle}`);
  }
});

test("requires paths must be reachable from the input contract and upstream nodes", () => {
  const schemas = { Out: { type: "object", properties: {} } };
  const agent = (label, requires, as) => ({ node: "agent", label, instructions: "gather", out: "Out", ...(as ? { as } : {}), ...(requires ? { requires } : {}) });
  const wf = (steps) => ({ v: 2, name: "t", schemas, output: { schemaId: "Out", path: steps.at(-1).as || steps.at(-1).label }, root: { node: "chain", steps } });
  const contract = { inputKeys: ["question", "context"] };

  const phantom = validateWorkflow(wf([agent("gather", ["merchant"])]), contract);
  assert.equal(phantom.ok, false);
  assert.ok(phantom.errors.some((e) => /requires "merchant"/.test(e) && /question/.test(e)), `error names the phantom path and the real keys: ${JSON.stringify(phantom.errors)}`);

  assert.equal(validateWorkflow(wf([agent("gather", ["question"], "evidence"), agent("judge", ["evidence"])]), contract).ok, true, "seeded key and upstream as are reachable");
  assert.equal(validateWorkflow(wf([{ node: "code", label: "seed", code: "(s) => ({ merchant: s.question })" }, agent("gather", ["merchant"])]), contract).ok, true, "code-produced keys are unknowable, never false-positived");
  assert.equal(validateWorkflow(wf([agent("gather", ["merchant"])])).ok, true, "without an input contract the reachability check does not run");
});

test("an escalate predicate on a path its code gate never returns is rejected", () => {
  const schemas = { Out: { type: "object", properties: {} } };
  const wf = (gateCode, whenPath) => ({ v: 2, name: "t", schemas, output: { schemaId: "Out", path: "final" }, root: { node: "chain", steps: [
    { node: "code", label: "gate", code: gateCode },
    { node: "escalate", label: "guard", when: { predicate: "field_true", path: whenPath }, kind: "k", stage: "s", summary: "x" },
  ] } });
  const contract = { inputKeys: ["question", "context"] };

  const dead = validateWorkflow(wf("(s) => ({ gate: { catalogue_valid: true, status: 'ok', assigned: true } })", "gate.invalid_catalogue"), contract);
  assert.equal(dead.ok, false);
  assert.ok(dead.errors.some((e) => /predicate path "gate.invalid_catalogue" is not produced/.test(e)), JSON.stringify(dead.errors));

  assert.equal(validateWorkflow(wf("(s) => ({ gate: { invalid_catalogue: false, status: 'ok' } })", "gate.invalid_catalogue"), contract).ok, true, "a produced path passes");
  assert.equal(validateWorkflow(wf("(s) => Object.fromEntries([['gate', { x: 1 }]])", "gate.dynamic_key"), contract).ok, false, "a deterministically probeable shape is checked even when built dynamically");
  assert.equal(validateWorkflow(wf("(s) => ({ gate: { [s.mode]: true } })", "gate.some_flag"), contract).ok, true, "a state-computed key stands down (tolerant probe collapses it to '')");
  assert.equal(validateWorkflow(wf("(s) => { if (!s.selection.items.length) throw new Error('needs state'); return { gate: {} }; }", "gate.whatever"), contract).ok, true, "state-dependent throwing code stands down");
  assert.equal(validateWorkflow(wf("(s) => ({ gate: s.enabled ? { enabled: true } : { disabled: true } })", "gate.enabled"), contract).ok, true, "a path produced by one probed branch passes");
  assert.equal(validateWorkflow(wf("(s) => ({ gate: s.enabled ? { enabled: true } : { disabled: true } })", "gate.disabled"), contract).ok, true, "a path produced by the other probed branch passes");
  assert.equal(validateWorkflow(wf("(s) => { const d = s.__case; return { exc: d && d.exception ? d.exception : null }; }", "exc.kind"), contract).ok, true, "a nullable state-dependent subtree stands down");
  const conditionalPatch = wf("(s) => ({ gate: { enabled: true } })", "gate.enabled");
  conditionalPatch.root.steps.splice(1, 0, { node: "code", label: "maybe-replace", code: "(s) => s.replace ? { gate: { disabled: true } } : {}" });
  assert.equal(validateWorkflow(conditionalPatch, contract).ok, true, "a branch that omits a patch key preserves the prior subtree");
});

test("references never reach LLM node prompts; code nodes keep full state", async () => {
  const seen = [];
  const wf = { v: 2, name: "t", schemas: { Out: { type: "object", properties: {} } }, output: { schemaId: "Out", path: "final" },
    root: { node: "chain", steps: [
      { node: "decide", label: "judge", instructions: "j", out: "Out", as: "sel" },
      { node: "code", label: "gate", code: "(s) => ({ final: { rows: s.context.references_parsed['c.csv'].rows.length } })" },
    ] } };
  const deps = { runNode: async ({ user }) => { seen.push(user); return {}; } };
  const { runWorkflow } = await import("../dist/index.js");
  const result = await runWorkflow(wf, { question: "q", context: { references: { "c.csv": "a,b\n1,2\n" }, references_parsed: { "c.csv": { header: ["a", "b"], rows: [["1", "2"]] } } } }, deps);
  assert.ok(!seen[0].includes("references"), "LLM prompt carries no reference surfaces");
  assert.equal(result.status, "complete");
  assert.equal(result.output.rows, 1, "the code gate still reads the full parsed reference");
});

test("node submissions normalize string-nulls per schema", async () => {
  const wf = { v: 2, name: "t", schemas: { Sel: { type: "object", properties: { category_code: { anyOf: [{ type: "string" }, { type: "null" }] }, note: { type: "string" } } }, Out: { type: "object", properties: {} } }, output: { schemaId: "Out", path: "final" },
    root: { node: "chain", steps: [
      { node: "decide", label: "sel", instructions: "x", out: "Sel", as: "sel" },
      { node: "code", label: "out", code: "(s) => ({ final: { got: s.sel.category_code === null, note: s.sel.note } })" },
    ] } };
  const { runWorkflow } = await import("../dist/index.js");
  const result = await runWorkflow(wf, { question: "q", context: {} }, { runNode: async () => ({ category_code: "null", note: "null" }) });
  assert.equal(result.output.got, true, "nullable string-null became JSON null in interior state");
  assert.equal(result.output.note, "null", "non-nullable strings untouched");
});

test("string-null normalization recurses into nested schemas", async () => {
  const { normalizeStringNullsForSchema } = await import("../dist/workflow.js");
  const schema = { type: "object", properties: {
    alert: { type: "object", properties: { source_assessment: { anyOf: [{ type: "string" }, { type: "null" }] }, label: { type: "string" } } },
    matches: { type: "array", items: { type: "object", properties: { evidence_url: { type: ["string", "null"] } } } },
  } };
  const value = { alert: { source_assessment: "null", label: "null" }, matches: [{ evidence_url: "None" }, { evidence_url: "https://x.example" }] };
  normalizeStringNullsForSchema(value, schema);
  assert.equal(value.alert.source_assessment, null);
  assert.equal(value.alert.label, "null", "non-nullable nested strings untouched");
  assert.equal(value.matches[0].evidence_url, null);
  assert.equal(value.matches[1].evidence_url, "https://x.example");
});

test("reference-aware probe: a wrong column name that throws under the real header is rejected at validation", () => {
  const schemas = { Out: { type: "object", properties: {} } };
  const wf = (code) => ({ v: 2, name: "t", schemas, output: { schemaId: "Out", path: "final" }, root: { node: "chain", steps: [
    { node: "code", label: "risk-facts", code },
  ] } });
  const contract = { inputKeys: ["question", "context"] };
  const probeContext = { references_parsed: { "records.csv": { header: ["record_id", "activity_description", "keywords"], rows: [["REC-1", "EXAMPLE", "example"]] } } };
  const gate = (col) => `(s) => { const h = s.context.references_parsed["records.csv"].header; const i = h.indexOf("${col}"); if (i < 0) throw new Error("missing column ${col}"); return { facts: { col: i } }; }`;

  const wrong = validateWorkflow(wf(gate("activity")), { ...contract, probeContext });
  assert.equal(wrong.ok, false, "a fail-closed gate with a wrong column name dies at validation");
  assert.ok(wrong.errors.some((e) => /throws against the real reference data.*missing column activity/.test(e)), JSON.stringify(wrong.errors));

  assert.equal(validateWorkflow(wf(gate("activity_description")), { ...contract, probeContext }).ok, true, "the correct column resolves and passes");
  assert.equal(validateWorkflow(wf(gate("activity")), contract).ok, true, "without probeContext the check stands down (tolerant indexOf never returns -1)");
  assert.equal(validateWorkflow(wf("(s) => { if (!s.selection.items.length) throw new Error('needs state'); return { facts: {} }; }"), { ...contract, probeContext }).ok, true,
    "a state-dependent throw (also thrown under the tolerant probe) still stands down with probeContext present");
  assert.equal(validateWorkflow(wf("(s) => { const p = s.context.references_parsed[s.pick]; return { facts: { n: p.rows ? 1 : 0 } }; }"), { ...contract, probeContext }).ok, true,
    "computed-filename access falls back to a tolerant probe instead of false-positiving");
});

test("output-completeness: assemble missing a required output field is rejected at validation", () => {
  const schemas = { Out: { type: "object", required: ["answer", "self_corrections"], properties: { answer: {}, self_corrections: { type: "array" } } } };
  const wf = (assembleCode) => ({ v: 2, name: "t", schemas, output: { schemaId: "Out", path: "final" }, root: { node: "chain", steps: [
    { node: "code", label: "assemble", code: assembleCode },
  ] } });
  const contract = { inputKeys: ["question", "context"] };

  const missing = validateWorkflow(wf("(s) => ({ final: { answer: s.judge } })"), contract);
  assert.equal(missing.ok, false, "a required field assemble never emits dies at validation, not at runtime");
  assert.ok(missing.errors.some((e) => /never emits required field\(s\) self_corrections/.test(e)), JSON.stringify(missing.errors));

  assert.equal(validateWorkflow(wf("(s) => ({ final: { answer: s.judge, self_corrections: s.judge.reversals || [] } })"), contract).ok, true, "all required keys present passes");
  assert.equal(validateWorkflow(wf("(s) => ({ final: { [s.mode]: 1, answer: s.judge } })"), contract).ok, true, "a computed key stands down");
  assert.equal(validateWorkflow(wf("(s) => ({ final: s.judge })"), contract).ok, true, "a non-literal (state-carried) output shape stands down");
  assert.equal(validateWorkflow(wf("(s) => ({ final: { ...s.judge, answer: 1 } })"), contract).ok, true, "a spread-built output stands down (spread of probed state enumerates empty)");
  assert.equal(validateWorkflow(wf("(s) => ({ final: { answer: s.judge } })")).ok, true, "without an input contract the check does not run");
});

test("sibling-schema $refs resolve at runtime and unresolvable refs fail validation", async () => {
  const schemas = {
    Leg: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string" }, doc: { $ref: "#/definitions/Doc" } } },
    Doc: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string" } } },
    Evidence: { type: "object", additionalProperties: false, required: ["site"], properties: { site: { $ref: "#/definitions/Leg" } } },
  };
  const workflow = {
    v: 2, name: "refs", schemas, output: { schemaId: "Evidence", path: "evidence" },
    root: { node: "agent", label: "gather", instructions: "gather", out: "Evidence", as: "evidence" },
  };
  assert.equal(validateWorkflow(workflow).ok, true, "sibling refs (transitive) validate");
  const staged = stageSchemaForNode(workflow, workflow.root);
  assert.ok(staged.definitions?.Leg, "referenced sibling attached");
  assert.ok(staged.definitions?.Doc, "transitively referenced sibling attached");
  const result = await runWorkflow(workflow, { question: "q" }, {
    runNode: async () => ({ site: { status: "ok", doc: { url: "https://e.x" } } }),
  });
  assert.equal(result.status, "complete", "a conforming submission passes the resolved schema");
  assert.deepEqual(result.output, { site: { status: "ok", doc: { url: "https://e.x" } } });

  const dangling = { ...workflow, schemas: { ...schemas, Evidence: { type: "object", properties: { site: { $ref: "#/definitions/Missing" } } } } };
  const bad = validateWorkflow(dangling);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /Evidence.*#\/definitions\/Missing.*no inline definition and no sibling schema/.test(e)), JSON.stringify(bad.errors));

  const weirdForm = { ...workflow, schemas: { ...schemas, Evidence: { type: "object", properties: { site: { $ref: "Leg.json#/x" } } } } };
  const bad2 = validateWorkflow(weirdForm);
  assert.equal(bad2.ok, false);
  assert.ok(bad2.errors.some((e) => /unsupported \$ref form/.test(e)), JSON.stringify(bad2.errors));
});

test("terminal output validation failure enumerates the missing/invalid fields", async () => {
  const schemas = {
    Out: { type: "object", additionalProperties: true, required: ["verdict", "rationale", "code"], properties: { verdict: { type: "string" }, rationale: { type: "string" }, code: { type: "string" } } },
  };
  const workflow = {
    v: 2, name: "diag-test", schemas, output: { schemaId: "Out", path: "final" },
    root: { node: "chain", steps: [
      { node: "code", label: "assemble", code: "(s) => ({ final: { ...s.context.seed, verdict: 'ASSIGNED' } })" },
    ] },
  };
  await assert.rejects(
    () => runWorkflow(workflow, { question: "q", context: {} }, { runNode: async () => ({}) }),
    (e) => {
      assert.equal(e.code, "output_invalid");
      assert.ok(Array.isArray(e.problems) && e.problems.length >= 1, "problems enumerated");
      assert.match(e.message, /rationale/, "names the missing field in the message");
      assert.match(e.message, /code/, "names the other missing field");
      return true;
    },
  );
});

test("node submission validation failure enumerates fields and is typed", async () => {
  const schemas = {
    Finding: { type: "object", additionalProperties: false, required: ["verdict", "basis"], properties: { verdict: { type: "string" }, basis: { type: "string" } } },
    Out: { type: "object", properties: {} },
  };
  const workflow = {
    v: 2, name: "diag-node", schemas, output: { schemaId: "Out", path: "sel" },
    root: { node: "decide", label: "judge", instructions: "j", out: "Finding", as: "sel" },
  };
  await assert.rejects(
    () => runWorkflow(workflow, { question: "q" }, { runNode: async () => ({ verdict: "X" }) }),
    (e) => {
      assert.equal(e.code, "output_invalid");
      assert.match(e.message, /basis/, "names the missing submission field");
      return true;
    },
  );
});

test("tools are validated and forwarded for every LLM kind", async () => {
  const tools = ["records.search", "records.fetch"];
  for (const kind of ["agent", "decide", "extract", "report"]) {
    const node = kind === "report"
      ? { node: kind, label: kind, instructions: "Write the report.", tools }
      : { node: kind, label: kind, instructions: "Return a finding.", out: "Finding", as: "finding", tools };
    const workflow = wf({ node: "chain", steps: [
      { node: "code", label: "seed", code: "s => ({ final: { verdict: 'ASSIGNED' } })" }, node,
    ] });
    assert.deepEqual(validateWorkflow(workflow), { ok: true }, kind);
    for (const invalid of [["ok", " "]]) {
      const candidate = structuredClone(workflow);
      candidate.root.steps[1].tools = invalid;
      const result = validateWorkflow(candidate);
      assert.equal(result.ok, false, kind);
      assert.match(result.errors.join("\n"), /tools must be a list of non-empty tool names/, kind);
    }
    const toolless = structuredClone(workflow);
    toolless.root.steps[1].tools = [];
    assert.deepEqual(validateWorkflow(toolless), { ok: true }, kind);
    const seen = [];
    const result = await runWorkflow(workflow, {}, { runNode: async request => {
      seen.push({ kind: request.kind, tools: request.tools });
      return kind === "report"
        ? { report_markdown: "The requested evidence is complete and ready for the reader to review." }
        : { verdict: "ASSIGNED", reason: "Evidence found." };
    } });
    assert.equal(result.status, "complete", kind);
    assert.deepEqual(seen, [{ kind, tools }]);
  }
});

test("extract node: validates, threads state through runNode with kind extract", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "extract", label: "subject", instructions: "transcribe the subject exactly as stated", out: "Finding", as: "sel", requires: ["question"] },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.sel.verdict, code: s.sel.code ?? null } })" },
    ],
  });
  const validated = validateWorkflow(workflow, { inputKeys: ["question", "context"] });
  assert.deepEqual(validated.errors ?? [], [], "extract is a first-class dialect kind");
  let seenKind = null;
  const result = await runWorkflow(workflow, { question: "acme" }, {
    runNode: async ({ kind }) => { seenKind = kind; return { verdict: "ASSIGNED", reason: "stated in the request", code: null }; },
  });
  assert.equal(result.status, "complete");
  assert.equal(seenKind, "extract", "the engine seam sees the extract kind and can route tier/budget on it");
  assert.deepEqual(result.output, { verdict: "ASSIGNED", code: null });
});

test("extract node: decide-only keys (samples/voteField) are rejected as unknown", () => {
  const workflow = wf({ node: "extract", label: "subject", instructions: "t", out: "Finding", as: "final", samples: 3, voteField: "verdict" });
  const validated = validateWorkflow(workflow, { inputKeys: ["question"] });
  assert.ok(!validated.ok);
  assert.ok(validated.errors.some((e) => /unknown key\(s\) for a extract node: samples, voteField/.test(e)), validated.errors.join("; "));
});

test("extract node: unreachable requires is rejected at author time", () => {
  const workflow = wf({ node: "extract", label: "subject", instructions: "t", out: "Finding", as: "final", requires: ["merchant"] });
  const validated = validateWorkflow(workflow, { inputKeys: ["question", "context"] });
  assert.ok(!validated.ok);
  assert.ok(validated.errors.some((e) => /merchant/.test(e)), validated.errors.join("; "));
});

test("code validation does not infer semantic misuse from question and regex tokens", async () => {
  const cases = [
    {
      code: '(s) => ({ final: { verdict: ["Program A", "Program B"].map(value => value.replace(/^Program /, "")).join(","), code: s.question } })',
      input: { question: "Keep this question unchanged" },
      expected: { verdict: "A,B", code: "Keep this question unchanged" },
    },
    {
      code: '/* question is only an incidental comment */ (s) => ({ final: { verdict: "Program A".replace(/^Program /, ""), code: s.marker } })',
      input: { marker: "unchanged" },
      expected: { verdict: "A", code: "unchanged" },
    },
  ];
  for (const { code, input, expected } of cases) {
    const workflow = wf({ node: "code", label: "normalize-fixed-labels", code });
    assert.deepEqual(validateWorkflow(workflow, { inputKeys: Object.keys(input) }), { ok: true });
    const result = await runWorkflow(workflow, input, {});
    assert.equal(result.status, "complete");
    assert.deepEqual(result.output, expected);
  }
});


test("report node: validates without out/as, runs with kind report, lands at state.report_markdown", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "decide", label: "select", instructions: "judge", out: "Finding", as: "sel" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.sel.verdict, code: s.sel.code ?? null } })" },
      { node: "report", label: "write-up", instructions: "render the record", requires: ["final"] },
    ],
  });
  assert.deepEqual(validateWorkflow(workflow, { inputKeys: ["question", "context"] }), { ok: true });
  const seen = [];
  const result = await runWorkflow(workflow, { question: "acme" }, {
    runNode: async ({ kind, label, schema }) => {
      seen.push([kind, label]);
      if (kind === "report") {
        assert.ok(schema?.properties?.report_markdown, "report node gets its intrinsic schema");
        return { report_markdown: "# Determination\n\nASSIGNED 7311 — grounded in the quoted evidence." };
      }
      return { verdict: "ASSIGNED", reason: "clear", code: "7311" };
    },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(seen, [["decide", "select"], ["report", "write-up"]]);
  assert.match(result.state.report_markdown, /^# Determination/);
  assert.deepEqual(result.output, { verdict: "ASSIGNED", code: "7311" }, "the record output is untouched by the report");
});

test("report node submissions are schema-gated: prose under 40 chars is output_invalid at the node", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: 'ASSIGNED' } })" },
      { node: "report", label: "write-up", instructions: "render" },
    ],
  });
  await assert.rejects(
    () => runWorkflow(workflow, {}, { runNode: async () => ({ report_markdown: "too short" }) }),
    (e) => e.code === "output_invalid" && /write-up/.test(e.message),
  );
});

test("the decide-report ban: once a report node exists, a decide emitting report_markdown is rejected", () => {
  const schemas = {
    ...SCHEMAS,
    Smuggled: { type: "object", required: ["verdict", "report_markdown"], properties: { verdict: { type: "string" }, report_markdown: { type: "string" } } },
  };
  const smuggling = {
    v: 2, name: "t", schemas, output: { schemaId: "Output", path: "final" },
    root: { node: "chain", steps: [
      { node: "decide", label: "assemble", instructions: "i", out: "Smuggled", as: "final" },
      { node: "report", label: "write-up", instructions: "render" },
    ] },
  };
  const rejected = validateWorkflow(smuggling);
  assert.ok(!rejected.ok && rejected.errors.some((e) => /must not emit report_markdown/.test(e)), "banned with a report node present");
  const legacy = { ...smuggling, root: { node: "chain", steps: [smuggling.root.steps[0]] } };
  assert.deepEqual(validateWorkflow(legacy), { ok: true });
});

test("effort is validated and forwarded for every LLM kind", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "agent", label: "research", instructions: "Gather evidence.", out: "Finding", as: "evidence", effort: "high" },
      { node: "extract", label: "subject", instructions: "transcribe", out: "Finding", as: "sub", effort: "low" },
      { node: "decide", label: "select", instructions: "judge", out: "Finding", as: "sel", effort: "high" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: s.sel.verdict } })" },
      { node: "report", label: "write-up", instructions: "render", effort: "medium" },
    ],
  });
  assert.deepEqual(validateWorkflow(workflow), { ok: true });
  const seen = [];
  const result = await runWorkflow(workflow, {}, {
    runNode: async ({ kind, effort }) => {
      seen.push([kind, effort]);
      return kind === "report" ? { report_markdown: "# Report body long enough to satisfy the schema." } : { verdict: "ASSIGNED", reason: "r" };
    },
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(seen, [["agent", "high"], ["extract", "low"], ["decide", "high"], ["report", "medium"]]);
  for (const step of workflow.root.steps.filter(step => step.effort)) {
    const candidate = structuredClone(workflow);
    candidate.root.steps.find(node => node.label === step.label).effort = "unlimited";
    const rejected = validateWorkflow(candidate);
    assert.equal(rejected.ok, false, step.node);
    assert.match(rejected.errors.join("\n"), /effort/, step.node);
  }
});

test("a report node inside a map or loop body is rejected — the report is the one terminal rendering", () => {
  const inMap = wf({
    node: "chain", steps: [
      { node: "code", label: "seed", code: "(s) => ({ hits: ['a'], final: { verdict: 'A' } })" },
      { node: "map", label: "fan", itemsPath: "hits", as: "outs", body: { node: "report", label: "r", instructions: "render" } },
    ],
  });
  const mapResult = validateWorkflow(inMap);
  assert.ok(!mapResult.ok && mapResult.errors.some((e) => /report node cannot live inside a map body/.test(e)));
  const inLoop = wf({
    node: "chain", steps: [
      { node: "code", label: "seed", code: "(s) => ({ final: { verdict: 'A' } })" },
      { node: "loop", label: "l", maxIters: 3, until: { predicate: "field_true", path: "final.verdict" }, body: { node: "chain", steps: [{ node: "report", label: "r", instructions: "render" }] } },
    ],
  });
  const loopResult = validateWorkflow(inLoop);
  assert.ok(!loopResult.ok && loopResult.errors.some((e) => /report node cannot live inside a loop body/.test(e)));
});

test("the report node's terminal contract: at most one, and only as the root chain's last step", () => {
  const notLast = wf({
    node: "chain", steps: [
      { node: "report", label: "early", instructions: "render" },
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: 'A' } })" },
    ],
  });
  const early = validateWorkflow(notLast);
  assert.ok(!early.ok && early.errors.some((e) => /must be the LAST step/.test(e)), "a report before assembly ships stale determinations");
  const twice = wf({
    node: "chain", steps: [
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: 'A' } })" },
      { node: "report", label: "r1", instructions: "render" },
      { node: "report", label: "r2", instructions: "render again" },
    ],
  });
  const dup = validateWorkflow(twice);
  assert.ok(!dup.ok && dup.errors.some((e) => /at most ONE terminal node \(report or artifact\)/.test(e)));
});

test("a whitespace-only report_markdown is a schema rejection, never a silent JSON-dump fallback", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "code", label: "assemble", code: "(s) => ({ final: { verdict: 'A' } })" },
      { node: "report", label: "write-up", instructions: "render" },
    ],
  });
  await assert.rejects(
    () => runWorkflow(workflow, {}, { runNode: async () => ({ report_markdown: " ".repeat(80) }) }),
    (e) => e.code === "output_invalid" && /write-up/.test(e.message),
    "80 spaces satisfies minLength but must fail the \\S pattern",
  );
});

test("validateWorkflow: a null or non-object schema entry is a clean validation error, not a throw", () => {
  const wf = {
    v: 2, name: "null-schema", output: { schemaId: "Out", path: "final" },
    schemas: { Out: { type: "object", additionalProperties: false, required: ["verdict"], properties: { verdict: { type: "string" } } }, Broken: null, AlsoBroken: "not a schema" },
    root: { node: "chain", steps: [{ node: "decide", label: "judge", instructions: "judge", out: "Out", as: "final", requires: ["question"] }] },
  };
  let result;
  assert.doesNotThrow(() => { result = validateWorkflow(wf, { inputKeys: ["question", "context"] }); });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /schema "Broken" must be a JSON-schema object \(got null\)/.test(e)), JSON.stringify(result.errors));
  assert.ok(result.errors.some((e) => /schema "AlsoBroken" must be a JSON-schema object \(got string\)/.test(e)));
});

const SKILL_SOP = "## Gather\ngather policy\n\n## Judge\njudge policy\n";
const SKILL_BODY = "How we execute this SOP here: registry X answers first, quote before you commit.";

const skillProbeWorkflow = (kind) => wf({
  node: "chain", steps: [
    { node: kind, label: "probe", sopSection: kind === "decide" ? "Judge" : "Gather", instructions: `role for ${kind}`, out: "Finding", as: "probe" },
    { node: "code", label: "out", code: "(s) => ({ final: { verdict: s.probe.verdict } })" },
  ],
});

for (const kind of ["agent", "decide", "extract", "report"]) {
  test(`${kind} node system order is [sopSlice, skill, instructions] when a skill is pinned`, async () => {
    const seen = [];
    const workflow = kind === "report"
      ? wf({
          node: "chain", steps: [
            { node: "code", label: "out", code: "() => ({ final: { verdict: 'ASSIGNED' } })" },
            { node: "report", label: "probe", sopSection: "Judge", instructions: "role for report" },
          ],
        })
      : skillProbeWorkflow(kind);
    await runWorkflow(workflow, { question: "q" }, {
      sop: SKILL_SOP,
      skill: SKILL_BODY,
      runNode: async (params) => {
        seen.push(params.system);
        return params.kind === "report" ? { report_markdown: "# Report\n\nA rendered terminal report long enough to satisfy the schema bound." } : { verdict: "ASSIGNED", reason: "ok" };
      },
    });
    assert.equal(seen.length, 1, "one LLM node ran");
    const [sopSlice, skill, instructions] = seen[0];
    assert.match(sopSlice, /policy/, "the SOP slice comes first");
    assert.equal(skill, SKILL_BODY, "the skill comes second, verbatim and unframed");
    assert.equal(instructions, `role for ${kind}`, "the node role comes third");
  });
}

test("an absent skill leaves the system array exactly as it was, with no empty element", async () => {
  const withSkill = [];
  const without = [];
  const workflow = skillProbeWorkflow("agent");
  const answer = async () => ({ verdict: "ASSIGNED", reason: "ok" });
  await runWorkflow(workflow, { question: "q" }, { sop: SKILL_SOP, runNode: async (p) => { without.push(p.system); return answer(); } });
  await runWorkflow(workflow, { question: "q" }, { sop: SKILL_SOP, skill: "", runNode: async (p) => { withSkill.push(p.system); return answer(); } });
  assert.deepEqual(without[0], withSkill[0], "an empty skill string is dropped, not injected");
  assert.equal(without[0].length, 2, "sop slice + instructions only");
  assert.ok(!without[0].includes(""), "no empty element survives the filter");
});

test("code nodes never see the skill: the deps carry it, the transform does not", async () => {
  const workflow = wf({
    node: "chain", steps: [
      { node: "code", label: "shape", code: "(s, ctx) => ({ seen: JSON.stringify(Object.keys(ctx)) })" },
      { node: "code", label: "out", code: "(s) => ({ final: { verdict: s.seen.includes('skill') ? 'LEAK' : 'ASSIGNED' } })" },
    ],
  });
  const result = await runWorkflow(workflow, { question: "q" }, { sop: SKILL_SOP, skill: SKILL_BODY, runNode: async () => ({}) });
  assert.equal(result.output.verdict, "ASSIGNED", "the code-node context exposes the SOP only");
});
