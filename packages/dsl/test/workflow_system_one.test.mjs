import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow, runWorkflowSlice, validateWorkflow, dryRunWorkflow, compileQuestions, answersToValue, synthesizeAnswers, SystemOneError } from "../dist/index.js";

const hitFacts = {
  type: "object", additionalProperties: false, required: ["name_link", "age_gap", "is_urgent", "severity"],
  properties: {
    name_link: { type: "string", description: "How the hit name links to `customer.name`.", enum: ["exact", "nickname", "different"], criteria: { nickname: "Al for Alex", different: "a genuinely different given or family name" } },
    age_gap: { type: "string", description: "The age relation from `arithmetic`.", enum: ["gap_ge_2y", "aligned", "missing"] },
    is_urgent: { type: "boolean", description: "Is the subject on a urgent list per `hit.screenType`?", criteria: { true: "a urgent flag", false: "ordinary ticket" } },
    severity: { type: "integer", description: "How important is the request?", minimum: 0, maximum: 2, criteria: ["none", "ordinary", "urgent"] },
  },
};

test("compileQuestions: enum → choice with criteria, boolean → noul, integer with levels → score", () => {
  const r = compileQuestions(hitFacts);
  assert.equal(r.ok, true);
  const q = r.questions;
  assert.deepEqual(q.name_link, { type: "choice", instructions: "How the hit name links to `customer.name`.", criteria: { exact: null, nickname: "Al for Alex", different: "a genuinely different given or family name" } });
  assert.deepEqual(q.is_urgent, { type: "noul", instructions: "Is the subject on a urgent list per `hit.screenType`?", criteria: { true: "a urgent flag", false: "ordinary ticket" } });
  assert.deepEqual(q.severity, { type: "score", instructions: "How important is the request?", criteria: ["none", "ordinary", "urgent"] });
  assert.deepEqual(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v.type])), { name_link: "choice", age_gap: "choice", is_urgent: "noul", severity: "score" });
});

test("compileQuestions rejects what is not a question, names the property, and enforces the limits", () => {
  const r = compileQuestions({ type: "object", properties: {
    prose: { type: "string", description: "write a rationale" },
    list: { type: "array", description: "the discrepancies", items: { type: "string" } },
    silent: { type: "boolean" },
    too_many: { type: "string", description: "which", enum: Array.from({ length: 241 }, (_, i) => `o${i}`) },
    eleven: { type: "integer", description: "how much", criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) },
    stray: { type: "string", description: "which", enum: ["a", "b"], criteria: { c: "not an option" } },
  } });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /property "prose": not a question/);
  assert.match(r.errors.join("\n"), /property "list": not a question/);
  assert.match(r.errors.join("\n"), /property "silent": a question needs a description/);
  assert.match(r.errors.join("\n"), /property "too_many": a choice takes at most 240 options/);
  assert.match(r.errors.join("\n"), /property "eleven": a score takes 2\.\.10 levels/);
  assert.match(r.errors.join("\n"), /property "stray": criteria name options the enum does not have: c/);
});

test("answersToValue: the option, yes at 0.5, the nearest level; synthesized answers are the unsure branch", () => {
  const compiled = compileQuestions(hitFacts).questions;
  const answers = {
    name_link: { type: "choice", choice: "nickname", probabilities: { exact: 0.2, nickname: 0.7, different: 0.1 }, confidence: 0.65 },
    age_gap: { type: "choice", choice: "gap_ge_2y", probabilities: { gap_ge_2y: 0.95, aligned: 0.03, missing: 0.02 }, confidence: 0.94 },
    is_urgent: { type: "noul", noul: 0.12 },
    severity: { type: "score", score: 1.6, legend: {}, probabilities: {}, confidence: 0.7 },
  };
  assert.deepEqual(answersToValue(answers, compiled), { name_link: "nickname", age_gap: "gap_ge_2y", is_urgent: false, severity: 2 });
  const synthetic = synthesizeAnswers(compiled);
  assert.equal(synthetic.name_link.confidence, 0);
  assert.equal(synthetic.is_urgent.noul, 0.5);
  assert.equal(synthetic.severity.score, 1);
});

const scripted = (table, seen = []) => async ({ label, kind, state, questions }) => {
  seen.push({ label, kind, state, questions });
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const want = table[id] ?? table[id.replace(/^\d+\./, "")];
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      const choice = typeof want === "object" && want?.choice ? want.choice : typeof want === "string" ? want : options[0];
      const confidence = typeof want === "object" && typeof want.confidence === "number" ? want.confidence : 0.9;
      const rest = (1 - confidence) / Math.max(1, options.length - 1);
      answers[id] = { type: "choice", choice, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? confidence : rest])), confidence };
    } else if (q.type === "noul") answers[id] = { type: "noul", noul: typeof want === "number" ? want : want === true ? 0.9 : 0.1 };
    else answers[id] = { type: "score", score: typeof want === "number" ? want : 0, legend: Object.fromEntries(q.criteria.map((v,i)=>[i,v])), probabilities: Object.fromEntries(q.criteria.map((_,i)=>[i,i === (typeof want === "number" ? want : 0) ? 1 : 0])), confidence: 0.8 };
  }
  return { answers, model: "scripted", usage: { input_tokens: 100, output_tokens: 0 }, cost_usd: 0.0000042, request_sha256: "abc" };
};

const wfWith = (steps, schemas = {}) => ({
  v: 2, name: "system-one-test",
  schemas: { hit_facts: hitFacts, rec: { type: "object", required: ["rating"], properties: { rating: { type: "string" }, weakest: { type: ["string", "null"] } } }, ...schemas },
  output: { schemaId: "rec", path: "record" },
  root: { node: "chain", steps },
});

test("judge: the state map is interpolated by value, the value lands at `as`, the distributions at `<as>$answers`", async () => {
  const seen = [];
  const wf = wfWith([
    { node: "code", label: "seed", code: "(s) => ({ client: { name: 'Alex Example', dob: '1980-01-02' }, hit: { hitName: 'Al Example', screenType: 'pep' }, arithmetic: { age_gap_years: 6 } })" },
    { node: "judge", label: "facts", state: { customer: "{client}", hit: "{hit}", arithmetic: "{arithmetic}", note: "gap is {arithmetic.age_gap_years} years" }, out: "hit_facts", as: "facts", requires: ["client.name"] },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: s.facts.name_link === 'nickname' && s.facts.age_gap === 'gap_ge_2y' ? 'low' : 'medium', weakest: s['facts$answers'].weakest } })" },
  ]);
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["question", "context"] }), { ok: true });
  const out = await runWorkflow(wf, { question: "q", context: {} }, { runJudge: scripted({ name_link: { choice: "nickname", confidence: 0.55 }, age_gap: "gap_ge_2y", is_urgent: false, severity: 1 }, seen) });
  assert.equal(out.status, "complete");
  assert.deepEqual(out.state.facts, { name_link: "nickname", age_gap: "gap_ge_2y", is_urgent: false, severity: 1 });
  assert.equal(seen[0].kind, "judge");
  assert.deepEqual(seen[0].state.customer, { name: "Alex Example", dob: "1980-01-02" });
  assert.equal(seen[0].state.note, "gap is 6 years");
  assert.equal(seen[0].questions.name_link.type, "choice");
  const side = out.state["facts$answers"];
  assert.equal(side.confidence.name_link, 0.55);
  assert.equal(side.weakest, "name_link");
  assert.equal(side.min_confidence, 0.55);
  assert.deepEqual(out.output, { rating: "low", weakest: "name_link" });
});

test("judge inside a map: one request per item, values collected as a list, the item reachable in the state map", async () => {
  const seen = [];
  const wf = wfWith([
    { node: "code", label: "seed", code: "(s) => ({ hits: [{ hitName: 'A', screenType: 'sanctions' }, { hitName: 'B', screenType: 'pep' }] })" },
    { node: "map", label: "each hit", itemsPath: "hits", as: "facts", body: { node: "judge", label: "facts of one hit", state: { hit: "{item}", index: "{item_index}" }, out: "hit_facts", as: "f" } },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: s.facts.some((f) => f.is_urgent) ? 'medium' : 'low' } })" },
  ]);
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["question", "context"] }), { ok: true });
  const out = await runWorkflow(wf, { question: "q", context: {} }, { runJudge: async (p) => { seen.push(p); return scripted({ is_urgent: p.state.hit.screenType === "sanctions" })(p); } });
  assert.equal(out.status, "complete");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((p) => p.item.index), [0, 1]);
  assert.deepEqual(out.state.facts.map((f) => f.is_urgent), [true, false]);
  assert.equal(out.output.rating, "medium");
});

test("validator: a judge needs a flat question schema, a state map whose paths exist, and `as`", () => {
  const bad = wfWith([
    { node: "judge", label: "no state", state: {}, out: "hit_facts", as: "a" },
    { node: "judge", label: "unreachable", state: { x: "{nothing.here}" }, out: "hit_facts", as: "b" },
    { node: "judge", label: "prose schema", state: { q: "{question}" }, out: "prose", as: "c" },
    { node: "judge", label: "stray key", state: { q: "{question}" }, out: "hit_facts", as: "d", instructions: "not a field" },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: 'low' } })" },
  ], { prose: { type: "object", properties: { rating: { type: "string", description: "write the rating rationale" } } } });
  const r = validateWorkflow(bad, { inputKeys: ["question", "context"] });
  assert.equal(r.ok, false);
  const text = r.errors.join("\n");
  assert.match(text, /no state\): state must be a non-empty object map/);
  assert.match(text, /unreachable\): interpolates \{nothing\.here\} but no upstream node produces "nothing"/);
  assert.match(text, /prose schema\): schema "prose": property "rating": not a question/);
  assert.match(text, /stray key\): unknown key\(s\) for a judge node: instructions/);
});

test("pick: the items are the options; the result carries index, item, confidence, and none when allowed", async () => {
  const seen = [];
  const wf = wfWith([
    { node: "code", label: "seed", code: "(s) => ({ candidates: [{ name: 'Item A', born: '1960-02' }, { name: 'Item B', born: '1988-10' }, { name: 'Item C', born: '2006' }], client: { name: 'Item Main', dob: '1988-10-18' } })" },
    { node: "pick", label: "bind", itemsPath: "candidates", describe: "{item.name}, born {item.born}", instructions: "Which candidate record is the customer in `customer`?", state: { customer: "{client}" }, allowNone: true, as: "bound" },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: s.bound.none ? 'unbound' : s.bound.item.name } })" },
  ]);
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["question", "context"] }), { ok: true });
  const out = await runWorkflow(wf, { question: "q", context: {} }, { runJudge: scripted({ pick: { choice: "item_1", confidence: 0.8 } }, seen) });
  assert.equal(out.status, "complete");
  assert.deepEqual(seen[0].questions.pick.criteria, { item_0: "Item A, born 1960-02", item_1: "Item B, born 1988-10", item_2: "Item C, born 2006", none_of_these: "none of the items fits" });
  assert.deepEqual(seen[0].state.customer, { name: "Item Main", dob: "1988-10-18" });
  assert.equal(out.state.bound.index, 1);
  assert.equal(out.state.bound.item.name, "Item B");
  assert.equal(out.state.bound.option, "Item B, born 1988-10");
  assert.equal(out.state["bound$answers"].confidence.pick, 0.8, "the pick's confidence lives in the sidecar like every question's");
  assert.equal(out.output.rating, "Item B");
  const none = await runWorkflow(wf, { question: "q", context: {} }, { runJudge: scripted({ pick: "none_of_these" }) });
  assert.equal(none.state.bound.none, true);
  assert.equal(none.state.bound.item, null);
  assert.equal(none.output.rating, "unbound");
});

test("pick: an empty list without allowNone is an error; with it, the pick is none at full confidence and asks nothing", async () => {
  const seen = [];
  const mk = (allowNone) => wfWith([
    { node: "code", label: "seed", code: "(s) => ({ candidates: [] })" },
    { node: "pick", label: "bind", itemsPath: "candidates", describe: "{item.name}", instructions: "which", as: "bound", ...(allowNone ? { allowNone: true } : {}) },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: String(s.bound.none) } })" },
  ]);
  await assert.rejects(runWorkflow(mk(false), { question: "q", context: {} }, { runJudge: scripted({}, seen) }), /candidates is empty and the pick does not allow none/);
  const out = await runWorkflow(mk(true), { question: "q", context: {} }, { runJudge: scripted({}, seen) });
  assert.equal(out.output.rating, "true");
  assert.equal(seen.length, 0);
});

test("sift: every item's questions in ONE request, prefixed by index; keep filters on a yes, a score, or a confidence", async () => {
  const seen = [];
  const relevance = { type: "object", required: ["bears_on_case", "usefulness"], properties: {
    bears_on_case: { type: "boolean", description: "Does this result concern the requested topic?" },
    usefulness: { type: "integer", description: "How much would fetching it add?", criteria: ["nothing", "some", "decisive"] },
  } };
  const wf = wfWith([
    { node: "code", label: "seed", code: "(s) => ({ results: [{ url: 'a', title: 'technical guide' }, { url: 'b', title: 'recipe' }, { url: 'c', title: 'profile' }] })" },
    { node: "sift", label: "rank", itemsPath: "results", describe: "{item.title} ({item.url})", state: { subject: "{question}" }, out: "relevance", as: "ranked", keep: { path: "bears_on_case" } },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: s.ranked.items.map((r) => r.url).join(',') + '|' + s.ranked.kept.join(',') + '|' + s.ranked.values.length } })" },
  ], { relevance });
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["question", "context"] }), { ok: true });
  const out = await runWorkflow(wf, { question: "who is X", context: {} }, { runJudge: async (p) => {
    seen.push(p);
    const answers = {};
    for (const id of Object.keys(p.questions)) {
      const [i, q] = id.split(".");
      if (q === "bears_on_case") answers[id] = { type: "noul", noul: i === "1" ? 0.1 : 0.85 };
      else answers[id] = { type: "score", score: Number(i), legend: {0:"nothing",1:"some",2:"decisive"}, probabilities: {0:Number(i)===0?1:0,1:Number(i)===1?1:0,2:Number(i)===2?1:0}, confidence: 0.9 };
    }
    return { answers, model: "scripted", usage: null, cost_usd: null };
  } });
  assert.equal(out.status, "complete");
  assert.equal(seen.length, 1, "one request for three items");
  assert.equal(Object.keys(seen[0].questions).length, 6);
  assert.match(seen[0].questions["2.usefulness"].instructions, /^For `items\[2\]` \(id item_2\): How much/);
  assert.deepEqual(seen[0].state.items.map((x) => x.id), ["item_0", "item_1", "item_2"]);
  assert.equal(seen[0].state.items[1].summary, "recipe (b)");
  assert.equal(seen[0].state.subject, "who is X");
  assert.equal(out.output.rating, "a,c|0,2|3");
  assert.deepEqual(out.state.ranked.values[2], { bears_on_case: true, usefulness: 2 });
  assert.equal(out.state.ranked.answers[1].confidence.bears_on_case, 0.8, "each item's sidecar carries its confidences");
  const byScore = await runWorkflow({ ...wf, root: { ...wf.root, steps: wf.root.steps.map((s) => s.node === "sift" ? { ...s, keep: { path: "usefulness", gte: 2 } } : s) } }, { question: "who is X", context: {} }, { runJudge: async (p) => {
    const answers = {};
    for (const id of Object.keys(p.questions)) { const [i, q] = id.split("."); answers[id] = q === "bears_on_case" ? { type: "noul", noul: 0.9 } : { type: "score", score: Number(i), legend: {0:"nothing",1:"some",2:"decisive"}, probabilities: {0:Number(i)===0?1:0,1:Number(i)===1?1:0,2:Number(i)===2?1:0}, confidence: 0.9 }; }
    return { answers, model: "scripted", usage: null, cost_usd: null };
  } });
  assert.equal(byScore.output.rating, "c|2|3");
  const byConfidence = await runWorkflow({ ...wf, root: { ...wf.root, steps: wf.root.steps.map(node => node.node === "sift"
    ? { ...node, keep: { path: "bears_on_case.confidence", gte: 0.8 } } : node) } }, { question: "who is X", context: {} }, {
    runJudge: scripted({ "0.bears_on_case": 0.95, "1.bears_on_case": 0.1, "2.bears_on_case": 0.6 }),
  });
  assert.equal(byConfidence.output.rating, "a,b|0,1|3");
  assert.deepEqual(byConfidence.state.ranked.values.map(value => value.bears_on_case), [true, false, true]);
});

test("validator: sift keep names a question of its schema, and a choice is not a keep axis", () => {
  const relevance = { type: "object", properties: { klass: { type: "string", description: "which", enum: ["a", "b"] }, yes: { type: "boolean", description: "is it" } } };
  const mk = (keep) => wfWith([
    { node: "code", label: "seed", code: "(s) => ({ results: [] })" },
    { node: "sift", label: "rank", itemsPath: "results", out: "relevance", as: "ranked", keep },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: 'x' } })" },
  ], { relevance });
  assert.match(validateWorkflow(mk({ path: "nope" }), { inputKeys: ["question", "context"] }).errors.join("\n"), /keep\.path "nope" names no question/);
  assert.match(validateWorkflow(mk({ path: "klass" }), { inputKeys: ["question", "context"] }).errors.join("\n"), /keep\.path "klass" is a choice/);
  assert.equal(validateWorkflow(mk({ path: "klass.confidence", gte: 0.7 }), { inputKeys: ["question", "context"] }).ok, true);
  assert.equal(validateWorkflow(mk({ path: "yes" }), { inputKeys: ["question", "context"] }).ok, true);
});

test("route: a choice among branch names runs the chosen body; `unsure` takes the conservative branch below its gate", async () => {
  const seen = [];
  const wf = wfWith([
    { node: "code", label: "seed", code: "(s) => ({ selection: { force: false } })" },
    { node: "route", label: "which record", state: { selection: "{selection}", question: "{question}" }, instructions: "Which record shape does this case take?",
      branches: {
        assigned: { criteria: "the judgment is settled", body: { node: "code", label: "assigned record", code: "(s) => ({ record: { rating: 'assigned', weakest: s.route ? s.route.taken + '@' + s['route$answers'].confidence.branch : null } })" } },
        refer: { criteria: "the judgment cannot be made without guessing", body: { node: "code", label: "refer record", code: "(s) => ({ record: { rating: 'refer', weakest: s.route ? s.route.taken + '@' + s['route$answers'].confidence.branch : null } })" } },
      },
      unsure: { branch: "refer", gte: 0.7 }, as: "route" },
  ]);
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["question", "context"] }), { ok: true });
  const events = [];
  const sure = await runWorkflow(wf, { question: "q", context: {} }, { runJudge: scripted({ branch: { choice: "assigned", confidence: 0.9 } }, seen), onEvent: (e) => events.push(e) });
  assert.deepEqual(sure.output, { rating: "assigned", weakest: "assigned@0.9" });
  assert.deepEqual(seen[0].questions.branch.criteria, { assigned: "the judgment is settled", refer: "the judgment cannot be made without guessing" });
  assert.ok(events.some((e) => e.type === "route.chosen" && e.detail.value.branch === "assigned" && e.detail.value.unsure === false && e.detail.sidecar.confidence.branch === 0.9));
  const unsure = await runWorkflow(wf, { question: "q", context: {} }, { runJudge: scripted({ branch: { choice: "assigned", confidence: 0.4 } }) });
  assert.deepEqual(unsure.output, { rating: "refer", weakest: "refer@0.4" });
  assert.equal(unsure.state.route.branch, "assigned");
  assert.equal(unsure.state.route.unsure, true);
});

test("validator: a route needs two named branches, an unsure branch that exists, and no report inside", () => {
  const body = { node: "code", label: "b", code: "(s) => ({ record: { rating: 'x' } })" };
  const one = wfWith([{ node: "route", label: "r", state: { q: "{question}" }, instructions: "which", branches: { a: { body } } }]);
  assert.match(validateWorkflow(one, { inputKeys: ["question", "context"] }).errors.join("\n"), /route needs at least two named branches/);
  const badUnsure = wfWith([{ node: "route", label: "r", state: { q: "{question}" }, instructions: "which", branches: { a: { body }, b: { body } }, unsure: { branch: "zzz", gte: 0.5 } }]);
  assert.match(validateWorkflow(badUnsure, { inputKeys: ["question", "context"] }).errors.join("\n"), /unsure\.branch must name one of the branches/);
  const withReport = wfWith([{ node: "route", label: "r", state: { q: "{question}" }, instructions: "which", branches: { a: { body }, b: { body: { node: "report", label: "rep", instructions: "write" } } } }]);
  assert.match(validateWorkflow(withReport, { inputKeys: ["question", "context"] }).errors.join("\n"), /a report node cannot live inside a route branch/);
});

test("gte and lt read a stored number as stored; an absent or non-numeric value satisfies neither", async () => {
  const wf = wfWith([
    { node: "code", label: "seed", code: "(s) => ({ gate: { margin: 0.55, text: 'no', missing: undefined } })" },
    { node: "escalate", label: "absent never fires", when: { predicate: "lt", path: "gate.missing", n: 1 }, kind: "x", stage: "s", summary: "absent" },
    { node: "escalate", label: "text never fires", when: { predicate: "gte", path: "gate.text", n: 0 }, kind: "x", stage: "s", summary: "text" },
    { node: "escalate", label: "refer when the margin is thin", when: { predicate: "lt", path: "gate.margin", n: 0.6 }, kind: "refer", stage: "the case", summary: "margin {gate.margin} below 0.6" },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: 'low' } })" },
  ]);
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["question", "context"] }), { ok: true });
  const out = await runWorkflow(wf, { question: "q", context: {} }, {});
  assert.equal(out.status, "escalated");
  assert.equal(out.escalation.kind, "refer");
  assert.equal(out.escalation.summary, "margin 0.55 below 0.6");
  const ok = await runWorkflow({ ...wf, root: { ...wf.root, steps: [{ node: "code", label: "seed", code: "(s) => ({ gate: { margin: 0.9, text: 'no', missing: undefined } })" }, ...wf.root.steps.slice(1)] } }, { question: "q", context: {} }, {});
  assert.equal(ok.status, "complete");
  const shape = validateWorkflow(wfWith([{ node: "escalate", label: "bad", when: { predicate: "gte", path: "x" }, kind: "k", stage: "s", summary: "t" }, { node: "code", label: "record", code: "(s) => ({ record: { rating: 'low' } })" }]), { inputKeys: ["question", "context"] });
  assert.match(shape.errors.join("\n"), /gte needs a finite number n/);
});

test("ask: a loop runs until a yes/no over the state holds; an escalate fires on one; a poll may not ask", async () => {
  const seen = [];
  const wf = wfWith([
    { node: "code", label: "seed", code: "(s) => ({ drives: 0, evidence: { sources: [] } })" },
    { node: "loop", label: "gather until the contract is met", maxIters: 3,
      body: { node: "code", label: "one drive", code: "(s) => ({ drives: s.drives + 1, evidence: { sources: Array.from({ length: s.drives + 1 }, (_, i) => 'src' + i) } })" },
      until: { predicate: "ask", instructions: "Does `evidence` carry at least two sources?", state: { evidence: "{evidence}" }, criteria: { true: "two or more sources", false: "fewer" }, gte: 0.7 } },
    { node: "escalate", label: "semantic gate", when: { predicate: "ask", instructions: "Is the evidence contradictory?" }, kind: "conflict", stage: "gather", summary: "contradiction after {drives} drives" },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: 'drives:' + s.drives } })" },
  ]);
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["question", "context"] }), { ok: true });
  const events = [];
  const out = await runWorkflow(wf, { question: "q", context: {} }, {
    runJudge: async (p) => {
      seen.push(p);
      const yes = p.label.startsWith("gather") ? (p.state.evidence.sources.length >= 2 ? 0.92 : 0.1) : 0.05;
      return { answers: { holds: { type: "noul", noul: yes } }, model: "scripted", usage: null, cost_usd: null };
    },
    onEvent: (e) => events.push(e),
  });
  assert.equal(out.status, "complete");
  assert.equal(out.output.rating, "drives:2");
  assert.equal(seen.filter((p) => p.kind === "ask" && p.label.startsWith("gather")).length, 2);
  assert.deepEqual(Object.keys(seen[0].state), ["evidence"], "an ask with a state map sees only that map");
  assert.ok(events.some((e) => e.type === "ask.evaluated" && e.label === "semantic gate" && e.detail.holds === false));
  const fired = await runWorkflow(wf, { question: "q", context: {} }, { runJudge: async (p) => ({ answers: { holds: { type: "noul", noul: p.label === "semantic gate" ? 0.9 : 0.95 } }, model: "scripted", usage: null, cost_usd: null }) });
  assert.equal(fired.status, "escalated");
  assert.equal(fired.escalation.summary, "contradiction after 1 drives");
  const poll = validateWorkflow(wfWith([
    { node: "call", label: "wait", via: "tool", tool: "jobs:status", args: {}, out: "rec", as: "st", deadline_s: 5, poll: { until: { predicate: "ask", instructions: "done?" }, interval_s: 1, deadline_s: 10 } },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: 'x' } })" },
  ]), { inputKeys: ["question", "context"] });
  assert.match(poll.errors.join("\n"), /poll\.until: unknown predicate "ask" \(a poll reads a value, never asks a question\)/);
  await assert.rejects(runWorkflow(wf, { question: "q", context: {} }, {}), /loop node .* requires runJudge/);
});

test("the interpolation grammar names the sidecar: an escalate summary can carry a confidence", async () => {
  const wf = wfWith([
    { node: "code", label: "seed", code: "(s) => ({ hit: { hitName: 'A' } })" },
    { node: "judge", label: "facts", state: { hit: "{hit}" }, out: "hit_facts", as: "facts" },
    { node: "escalate", label: "refer on a split name link", when: { predicate: "lt", path: "facts$answers.confidence.name_link", n: 0.6 }, kind: "refer", stage: "facts", summary: "name link {facts.name_link} at {facts$answers.confidence.name_link}; weakest {facts$answers.weakest}" },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: 'low' } })" },
  ]);
  assert.deepEqual(validateWorkflow(wf, { inputKeys: ["question", "context"] }), { ok: true });
  const out = await runWorkflow(wf, { question: "q", context: {} }, { runJudge: scripted({ name_link: { choice: "nickname", confidence: 0.4 } }) });
  assert.equal(out.status, "escalated");
  assert.equal(out.escalation.summary, "name link nickname at 0.4; weakest name_link");
});

test("dry run: question nodes synthesize the unsure branch, so the deterministic spine executes and no gate looks satisfied", async () => {
  const wf = wfWith([
    { node: "code", label: "seed", code: "(s) => ({ client: { name: 'x' }, hits: [{ n: 1 }] })" },
    { node: "map", label: "each", itemsPath: "hits", as: "facts", body: { node: "judge", label: "facts", state: { hit: "{item}", customer: "{client}" }, out: "hit_facts", as: "f" } },
    { node: "route", label: "shape", state: { facts: "{facts}" }, instructions: "which", branches: {
      clear: { body: { node: "code", label: "clear", code: "(s) => ({ record: { rating: 'low' } })" } },
      hold: { body: { node: "code", label: "hold", code: "(s) => ({ record: { rating: 'medium', weakest: s.shape.taken } })" } },
    }, unsure: { branch: "hold", gte: 0.6 }, as: "shape" },
  ]);
  wf.schemas.rec.properties.rating = { type: "string", const: "medium" };
  const r = await dryRunWorkflow(wf);
  assert.deepEqual(r, { ok: true });
  const broken = { ...wf, root: { ...wf.root, steps: [...wf.root.steps.slice(0, 2), { node: "code", label: "bad record", code: "(s) => ({ record: { nope: s.facts[0].name_link } })" }] } };
  const rb = await dryRunWorkflow(broken);
  assert.equal(rb.ok, false);
});

test("a pick holds 240 items without a none option and 239 with one; an ask gate must sit above the fence", async () => {
  const many = (n) => wfWith([
    { node: "code", label: "seed", code: `(s) => ({ candidates: Array.from({ length: ${n} }, (_, i) => ({ name: 'c' + i })) })` },
    { node: "pick", label: "bind", itemsPath: "candidates", describe: "{item.name}", instructions: "which", as: "bound" },
    { node: "code", label: "record", code: "(s) => ({ record: { rating: String(s.bound.index) } })" },
  ]);
  const ok = await runWorkflow(many(240), { question: "q", context: {} }, { runJudge: scripted({ pick: "item_239" }) });
  assert.equal(ok.output.rating, "239");
  await assert.rejects(runWorkflow(many(241), { question: "q", context: {} }, { runJudge: scripted({ pick: "item_0" }) }), /241 items exceed the 240/);
  const withNone = { ...many(240), root: { ...many(240).root, steps: many(240).root.steps.map((s) => s.node === "pick" ? { ...s, allowNone: true } : s) } };
  await assert.rejects(runWorkflow(withNone, { question: "q", context: {} }, { runJudge: scripted({ pick: "item_0" }) }), /240 items exceed the 239/);
  const low = validateWorkflow(wfWith([{ node: "escalate", label: "g", when: { predicate: "ask", instructions: "is it", gte: 0.5 }, kind: "k", stage: "s", summary: "t" }, { node: "code", label: "record", code: "(s) => ({ record: { rating: 'x' } })" }]), { inputKeys: ["question", "context"] });
  assert.match(low.errors.join("\n"), /ask\.gte must be in \(0\.5, 1\]/);
});

test("a workflow without question nodes runs unchanged with no runJudge in its deps", async () => {
  const wf = wfWith([
    { node: "decide", label: "judge", instructions: "decide", out: "rec", as: "record" },
  ]);
  const out = await runWorkflowSlice(wf, { question: "q" }, { from: "judge" }, { runNode: async () => ({ rating: "low" }) });
  assert.equal(out.status, "complete");
  assert.equal(out.state.record.rating, "low");
});
