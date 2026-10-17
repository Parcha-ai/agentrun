import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { agentLearn, CAPS, collectCandidates, LEARN_PARAMETERS } from "../dist/index.js";
import { ask, ctx, done, learnCalls, openRun, scratch, seedIds, toolResults } from "./support.mjs";

const LESSON = { type: "lesson", text: "Registries list officers under Principals, not Officers.", evidence: ["the registry page read in call 3"] };
const FACT = { type: "fact", text: "The registry rate-limits after 20 requests a minute." };

/** agentLearn with its learn tool's execute counted. */
function counted(options) {
  const extension = agentLearn(options);
  const calls = [];
  const [tool] = extension.tools;
  const execute = tool.execute;
  return { calls, extension: { ...extension, tools: [{ ...tool, execute: async (args, api, context) => { calls.push(api.callId); return execute.call(tool, args, api, context); } }] } };
}

test("learn stores one candidate per call id, makes no model call, and answers [noted n] under both result keys", async () => {
  const root = await scratch();
  const { calls, extension } = counted();
  let seen = [];
  const returned = [];
  const [tool] = extension.tools;
  const execute = tool.execute;
  tool.execute = async (...a) => { const r = await execute(...a); returned.push(r); return r; };
  const run = await openRun(path.join(root, "run.sqlite"), { extension, steps: [() => learnCalls([LESSON, FACT, { type: "used", text: "It helped.", id: "L-0123456789ab" }]), (c) => { seen = toolResults(c); return done(); }] });
  try {
    await seedIds(run.harness, ["L-0123456789ab"]);
    assert.equal((await ask(run.harness)).status, "done");
    assert.equal(run.faux.state.callCount, 2, "the model was asked twice: the turn that called learn and the answer; learn asked nothing");
    assert.deepEqual(calls, ["call-0", "call-1", "call-2"]);
    assert.deepEqual(seen, [{ isError: false, text: "[noted 1]" }, { isError: false, text: "[noted 2]" }, { isError: false, text: "[noted 3]" }]);
    for (const r of returned) assert.deepEqual(r.output, r.content, "pi-durable 1.2 and later read output; 1.1 reads content");
    assert.deepEqual(await collectCandidates(run.harness), [
      { callId: "call-0", ...LESSON },
      { callId: "call-1", ...FACT, evidence: [] },
      { callId: "call-2", type: "used", text: "It helped.", evidence: [], id: "L-0123456789ab" },
    ]);
  } finally {
    await run.close();
  }
});

test("an invalid type, an unknown field or a used mark without an id is refused before anything is stored", async () => {
  const root = await scratch();
  const { calls, extension } = counted();
  let seen = [];
  const run = await openRun(path.join(root, "run.sqlite"), { extension, steps: [
    () => learnCalls([{ type: "insight", text: "Not a type." }, { type: "lesson", text: "x", note: "extra" }, { type: "lesson", text: "" }, { type: "used", text: "Helped." }]),
    (c) => { seen = toolResults(c); return done(); },
  ] });
  try {
    await ask(run.harness);
    assert.deepEqual(seen.map((r) => r.isError), [true, true, true, true]);
    assert.deepEqual(calls, ["call-3"], "the harness refused the first three against the schema; execute never ran for them");
    assert.match(seen[3].text, /used mark needs the id/);
    assert.deepEqual(await collectCandidates(run.harness), []);
    assert.deepEqual(LEARN_PARAMETERS.properties.type.enum, ["lesson", "fact", "correction", "used", "workflow"]);
  } finally {
    await run.close();
  }
});

test("a guard refusal stores nothing and never repeats the value; the guard sees a run-role check of the one candidate", async () => {
  const root = await scratch();
  const secret = `tok-${"q".repeat(24)}`;
  const asked = [];
  const guard = (input) => {
    asked.push({ role: input.role, runId: input.runId, files: input.files, candidates: input.candidates.map((c) => c.callId), secrets: [...input.secrets] });
    return input.candidates.some((c) => c.text.includes(secret)) ? [{ reason: "secret_value", field: "candidates[0].text", detail: "contains a value the host keeps secret" }] : [];
  };
  let seen = [];
  const run = await openRun(path.join(root, "run.sqlite"), { extension: agentLearn({ guard, secrets: () => [secret] }), steps: [
    () => learnCalls([{ type: "lesson", text: `Use the key ${secret} for the registry.` }, LESSON]),
    (c) => { seen = toolResults(c); return done(); },
  ] });
  try {
    await ask(run.harness);
    assert.equal(seen[0].isError, true);
    assert.match(seen[0].text, /^Not noted: it holds a value the host keeps secret\./);
    assert.ok(!seen[0].text.includes(secret));
    assert.deepEqual(seen[1], { isError: false, text: "[noted 1]" });
    assert.deepEqual(asked, [
      { role: "run", runId: undefined, files: undefined, candidates: ["call-0"], secrets: [secret] },
      { role: "run", runId: undefined, files: undefined, candidates: ["call-1"], secrets: [secret] },
    ]);
    assert.deepEqual((await collectCandidates(run.harness)).map((c) => c.callId), ["call-1"]);
  } finally {
    await run.close();
  }
});

test("caps: text and evidence bytes, new learnings per run and used marks per run are separate", async () => {
  const root = await scratch();
  let seen = [];
  const wide = "\u00E9".repeat(CAPS.text / 2 + 1);
  const lessons = Array.from({ length: CAPS.perRun + 1 }, (_, i) => ({ type: "lesson", text: `Lesson ${i}.` }));
  const run = await openRun(path.join(root, "run.sqlite"), { steps: [
    () => learnCalls([{ type: "lesson", text: wide }, { type: "lesson", text: "x", evidence: ["e".repeat(600), "e".repeat(600)] }, ...lessons, { type: "used", text: "Helped.", id: "L-0123456789ab" }]),
    (c) => { seen = toolResults(c); return done(); },
  ] });
  try {
    await seedIds(run.harness, ["L-0123456789ab"]);
    await ask(run.harness);
    assert.match(seen[0].text, /text is over 1000 bytes/);
    assert.match(seen[1].text, /evidence is over 1000 bytes/);
    assert.deepEqual(seen.slice(2, 2 + CAPS.perRun).map((r) => r.isError), Array(CAPS.perRun).fill(false));
    assert.match(seen[2 + CAPS.perRun].text, /already noted 8 of these/);
    assert.deepEqual(seen.at(-1), { isError: false, text: `[noted ${CAPS.perRun + 1}]` }, "a used mark is not held back by the cap on new learnings");
    assert.equal((await collectCandidates(run.harness)).length, CAPS.perRun + 1);
  } finally {
    await run.close();
  }
});

test("a guard that throws stores nothing, and its error never reaches the model", async () => {
  const root = await scratch();
  const secret = `tok-${"z".repeat(24)}`;
  let seen = [];
  const guard = () => { throw new Error(`bad value ${secret}`); };
  const run = await openRun(path.join(root, "run.sqlite"), { extension: agentLearn({ guard }), steps: [() => learnCalls([LESSON]), (c) => { seen = toolResults(c); return done(); }] });
  try {
    await ask(run.harness);
    assert.deepEqual(seen, [{ isError: true, text: "Not noted: the host could not check it. Nothing was stored." }]);
    assert.deepEqual(await collectCandidates(run.harness), []);
  } finally {
    await run.close();
  }
});

test("a workflow note names a saved workflow by the DSL's name rules and says when to use it; ids are checked per type", async () => {
  const root = await scratch();
  let seen = [];
  const run = await openRun(path.join(root, "run.sqlite"), { steps: [
    () => learnCalls([
      { type: "workflow", id: "kyb-us-registry", text: "Use it for a US company when the input has a state of incorporation." },
      { type: "workflow", text: "No name." },
      { type: "workflow", id: "KYB Registry", text: "Not a DSL name." },
      { type: "workflow", id: "../x", text: "Not a DSL name." },
      { type: "correction", id: "kyb-us-registry", text: "A correction names a learning, not a workflow." },
      { type: "correction", id: "L-0123456789ab", text: "The registry now lists officers under Officers." },
    ]),
    (c) => { seen = toolResults(c); return done(); },
  ] });
  try {
    await seedIds(run.harness, ["L-0123456789ab"]);
    await ask(run.harness);
    assert.deepEqual(seen.map((r) => r.isError), [false, true, true, true, true, false]);
    assert.match(seen[1].text, /needs the saved workflow's name as id/);
    assert.equal(seen[4].text, "Not noted: kyb-us-registry is not a learning you were given; leave id out for a new learning.");
    assert.deepEqual((await collectCandidates(run.harness)).map(({ type, id }) => ({ type, id })), [{ type: "workflow", id: "kyb-us-registry" }, { type: "correction", id: "L-0123456789ab" }]);
  } finally {
    await run.close();
  }
});

test("an id on used, lesson, fact or correction must name a learning this run was given; a made-up one is refused at the call", async () => {
  const root = await scratch();
  const given = "L-00000000000a";
  const overCap = "L-00000000000b";
  let seen = [];
  const run = await openRun(path.join(root, "run.sqlite"), { steps: [
    () => learnCalls([
      { type: "lesson", id: "L-a4821c9e530b", text: "Search the registry by the legal name." },
      { type: "used", id: "L-ffffffffffff", text: "Helped." },
      { type: "fact", id: "not-an-id", text: "A fact." },
      { type: "used", id: given, text: "It found the company." },
      { type: "correction", id: overCap, text: "The registry now lists officers under Officers." },
      { type: "lesson", text: "A new lesson needs no id." },
    ]),
    (c) => { seen = toolResults(c); return done(); },
  ] });
  try {
    await seedIds(run.harness, [given], [overCap]);
    await ask(run.harness);
    assert.deepEqual(seen.map((r) => r.isError), [true, true, true, false, false, false]);
    assert.equal(seen[0].text, "Not noted: L-a4821c9e530b is not a learning you were given; leave id out for a new learning.");
    assert.equal(seen[1].text, "Not noted: L-ffffffffffff is not a learning you were given; leave id out for a new learning.");
    assert.deepEqual((await collectCandidates(run.harness)).map(({ type, id }) => ({ type, id })), [{ type: "used", id: given }, { type: "correction", id: overCap }, { type: "lesson", id: undefined }]);
  } finally {
    await run.close();
  }
  let unseeded = [];
  const bare = await openRun(path.join(root, "bare.sqlite"), { steps: [() => learnCalls([{ type: "used", id: given, text: "Helped." }]), (c) => { unseeded = toolResults(c); return done(); }] });
  try {
    await ask(bare.harness);
    assert.equal(unseeded[0].isError, true, "a run that was not seeded was given no learning");
  } finally {
    await bare.close();
  }
  assert.match(LEARN_PARAMETERS.properties.id.description, /^Only to name a learning listed in <learned> \(type used\) or a workflow name \(type workflow\); leave it out for a new learning\.$/);
});

test("agentLearn passes the run's case values to the guard at the call, so case data is refused where the model can restate it", async () => {
  const root = await scratch();
  const asked = [];
  const guard = (input) => {
    const values = [...input.caseValues];
    asked.push(values);
    return input.candidates.some((c) => values.some((v) => c.text.includes(v))) ? [{ reason: "case_data", field: "candidates[0].text", detail: "repeats a value from this case" }] : [];
  };
  let seen = [];
  const run = await openRun(path.join(root, "run.sqlite"), { extension: agentLearn({ guard, caseValues: () => ["4821", "Acme Holdings"] }), steps: [
    () => learnCalls([{ type: "lesson", text: "Issue 4821 needed the second registry." }, { type: "lesson", text: "Some issues need the second registry." }]),
    (c) => { seen = toolResults(c); return done(); },
  ] });
  try {
    await ask(run.harness);
    assert.deepEqual(seen, [{ isError: true, text: "Not noted: it repeats data from this case. Restate it as a general rule." }, { isError: false, text: "[noted 1]" }]);
    assert.deepEqual(asked, [["4821", "Acme Holdings"], ["4821", "Acme Holdings"]]);
    assert.deepEqual((await collectCandidates(run.harness)).map((c) => c.text), ["Some issues need the second registry."]);
  } finally {
    await run.close();
  }
});
