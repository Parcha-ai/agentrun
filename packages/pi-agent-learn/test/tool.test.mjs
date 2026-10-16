import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { agentLearn, CAPS, collectCandidates, LEARN_PARAMETERS } from "../dist/index.js";
import { ask, ctx, done, learnCalls, openRun, scratch, toolResults } from "./support.mjs";

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
    assert.deepEqual(LEARN_PARAMETERS.properties.type.enum, ["lesson", "fact", "correction", "used"]);
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
  const wide = "é".repeat(CAPS.text / 2 + 1);
  const lessons = Array.from({ length: CAPS.perRun + 1 }, (_, i) => ({ type: "lesson", text: `Lesson ${i}.` }));
  const run = await openRun(path.join(root, "run.sqlite"), { steps: [
    () => learnCalls([{ type: "lesson", text: wide }, { type: "lesson", text: "x", evidence: ["e".repeat(600), "e".repeat(600)] }, ...lessons, { type: "used", text: "Helped.", id: "L-0123456789ab" }]),
    (c) => { seen = toolResults(c); return done(); },
  ] });
  try {
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
