import assert from "node:assert/strict";
import { test } from "node:test";
import * as dsl from "@parcha/agentrun-dsl";
import { compileReference, compilePrompt, compileTurn, askedForCompile, learnedHost } from "../dist/learn/compile.js";
import { draftProblems } from "../dist/learn/workflow-draft.js";
const tool = "mcp:backend/status";
const ask = (adapters = []) => ({ mode: "new", workflowAdapters: adapters, reference: compileReference(dsl, { tools: [tool], judges: false, workflowAdapters: adapters }), tools: [tool], described: [{ name: tool, does: "Takes a release name and gives its ready boolean." }], judges: false, traces: [], input: { release: "current" } });
const flow = (root) => ({ v: 2, name: "release", schemas: { Input: { type: "object" }, Answer: { type: "object" } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root });
const block = (doc) => "````workflow release\n---\ndescription: Return release readiness when asked.\nexample: {}\n---\n" + JSON.stringify(doc) + "\n````";
/** The checks passing a draft, as learning-end.ts checkDraftOf answers: no errors, and what is committed. */
const checked = (doc) => ({ errors: [], kept: { name: "release", files: [{ path: "workflows/release/workflow.json", text: JSON.stringify(doc) }] } });
test("SDK compiler contract describes only explicitly registered adapters and bridge execution", () => {
 const ref = ask().reference;
 assert.match(ref, /NO runNode/); assert.match(ref, /NO runJudge/);
 assert.match(ref, /explicit.*bridge/i); assert.doesNotMatch(ref, /runs first on later runs|runs on the agent's model|\"tier\": \"fast\"/);
 assert.match(ref, /128/);
 const model = ask(["runNode"]).reference;assert.match(model, /runNode/);assert.match(model, /NO runJudge/);
 const judge = ask(["runJudge"]).reference;assert.match(judge, /NO runNode/);assert.doesNotMatch(judge, /NO runJudge/);
});
test("SDK compiler prompt carries the owner's standing corrections under This job, fenced, and none when there are none", () => {
 const rule = "- Agency customers: report a release not ready until its agency sign-off is in.";
 const job = compilePrompt({ ...ask(), corrections: `${rule}\n` }).split("## This job")[1].split("## Your answer")[0];
 assert.match(job, /standing corrections/);assert.ok(job.includes(rule));assert.match(job, /begin [^\n]*: the corrections -----\n- Agency customers/);
 for (const corrections of [undefined, "", "  \n"]) assert.doesNotMatch(compilePrompt({ ...ask(), ...(corrections !== undefined ? { corrections } : {}) }), /standing corrections/);
});
test("SDK compiler prompt keeps callback catalog and explicit execution", () => {
 const prompt = compilePrompt(ask());
 assert.match(prompt, /explicit.*bridge/i);assert.doesNotMatch(prompt, /on later runs it runs first|runs on your model/);
 assert.match(prompt, /mcp:backend\/status/);assert.match(prompt, /ready boolean/);
 assert.doesNotMatch(prompt.split("## A worked example")[1].split("## This job")[0], /\"node\":\"extract\"|\"node\":\"decide\"|\"guard\":/);
});
test("SDK new, revised and retried compiler requests describe ordinary-task selection, not a manual invocation prerequisite", async () => {
 // These assertions cover the compiler's instruction interface. A real native run,
 // not this scripted compiler, must establish that a model actually selects it.
 const doc = flow({ node: "call", label: "status", via: "tool", tool, args: {}, out: "Answer", as: "answer", deadline_s: 5 });
 for (const adapters of [[], ["runNode"], ["runJudge"]]) for (const mode of ["new", "revise"]) for (const structured of [false, true]) {
  const job = { ...ask(adapters), ...(structured ? {} : { input: undefined }),
   ...(mode === "revise" ? { mode, workflow: "release", current: JSON.stringify(doc),
    held: { workflow: "release", digest: "prior", reason: "The task's data changed." } } : {}) };
  const requests = [];
  const result = await compileTurn({ compile: job, answer: "", ask: async prompt => {
   requests.push(prompt); return { answer: requests.length === 1 ? "No workflow block." : block(doc) };
  }, check: async () => checked(doc) });
  assert.ok(result.kept); assert.equal(requests.length, 2, "The malformed draft must exercise the stateless retry.");
  for (const prompt of requests) {
   assert.match(prompt, /existing agent may select a matching workflow during an ordinary task/i);
   assert.match(prompt, /user need not request a workflow by name/i);
   assert.match(prompt, /execution still requires an explicit MCP tool call/i);
   assert.match(prompt, /derive argument values from the current request/i);
   assert.match(prompt, /describe the task it solves and when it matches/i);
   assert.match(prompt, /input descriptions explain the data/i);
   assert.match(prompt, /original instructions and permissions/i);
   assert.doesNotMatch(prompt, /backend explicitly invokes|backend must explicitly supply|automatically mapped from later tasks/i);
   assert.match(prompt, /Saving alone executes nothing/);
   assert.match(prompt, /server does not pre-run it before the native agent/);
   assert.match(prompt, /Never automatically retry a delegated tool call/);
   assert.match(prompt, /Never shell or executor/);
   assert.match(prompt, /mcp:backend\/status/);
   if (!adapters.includes("runNode")) assert.match(prompt, /NO runNode/);
   if (!adapters.includes("runJudge")) assert.match(prompt, /NO runJudge/);
  }
 }
 const managed = compilePrompt({ ...ask(), workflowAdapters: undefined,
  reference: compileReference(dsl, { tools: [tool], judges: false }) });
 assert.match(managed, /on later runs it runs first/);
 assert.doesNotMatch(managed, /existing agent may select a matching workflow/);
});
test("SDK compile words call the workflow compiled and unchecked, and never tell the agent to prefer it", () => {
 // Nothing promotes an SDK agent's workflow (no shadow check runs where its tools run), so the words may not claim one.
 for (const adapters of [[], ["runNode"], ["runJudge"], ["runNode", "runJudge"]]) {
  const rules = learnedHost({ tools: [tool], judges: false, workflowAdapters: adapters }).rules.join("\n");
  const head = compilePrompt(ask(adapters)).split("## The workflow language")[0];
  for (const text of [rules, head]) {
   assert.match(text, /compiled workflow/i);
   assert.match(text, /no check has compared it with the agent's own answers/i);
   assert.match(text, /agent decides whether one fits/i);
   assert.doesNotMatch(text, /approved|verified|pinned|prefer|ordinary task|whenever/i);
  }
 }
});
test("SDK revision preserves original manual-use restrictions and old input descriptions as fenced data", () => {
 const correction = "- Use a workflow for release-readiness requests only when I explicitly ask for one.";
 const previous = JSON.stringify({ ...flow({ node: "call", label: "status", via: "tool", tool, args: {}, out: "Answer", as: "answer", deadline_s: 5 }),
  schemas: { Input: { type: "object", properties: { release: { type: "string", description: "Release named for explicit backend invocation." } } }, Answer: { type: "object" } } });
 const prompt = compilePrompt({ ...ask(), mode: "revise", workflow: "release", current: previous, corrections: correction,
  held: { workflow: "release", digest: "prior", reason: "The output needs a new field." } });
 assert.ok(prompt.includes(previous), "Do not rewrite an existing workflow to remove its wording.");
 assert.ok(prompt.includes(correction), "An owner's actual manual-use restriction remains authoritative.");
 assert.match(prompt, /begin [^\n]*: its workflow.json -----\n/);
 assert.match(prompt, /begin [^\n]*: the corrections -----\n/);
 assert.match(prompt, /unless the original job actually requires one/);
});
test("SDK compile checks use the declared callback contract, without requiring an undeclared guardStep", async () => {
 const doc = flow({ node: "decide", label: "answer", instructions: "Return readiness.", out: "Answer", as: "answer" });
 assert.deepEqual(draftProblems(dsl, JSON.stringify(doc), [], {}, {}, undefined, ["runNode"]), []);
 const out = await compileTurn({ compile: ask(["runNode"]), answer: "", ask: async () => ({ answer: block(doc) }), check: async () => checked(doc) });
 assert.ok(out.kept, JSON.stringify(out));assert.equal(out.record.attempts.length, 1);
});
test("each stateless SDK retry carries the original contract/catalog and the bounded redacted failed draft", async () => {
 const doc = flow({ node: "call", label: "status", via: "tool", tool, args: {}, out: "Answer", as: "answer", deadline_s: 5 });
 const before = 'broken-draft api_key=sk-' + 'SECRET'.repeat(12) + "\n" + "x".repeat(40_000);
 const prompts=[];let n=0;
 const out = await compileTurn({ compile: ask(), answer: "", refuse: ['sk-' + 'SECRET'.repeat(12)], ask: async prompt => {
  prompts.push(prompt);return { answer: ++n === 1 ? before : block(doc) };
 }, check: async () => checked(doc) });
 assert.ok(out.kept, JSON.stringify(out));assert.equal(prompts.length, 2);
 const retry=prompts[1];assert.equal(askedForCompile(retry),"again","the SDK retry retains the shared timeline classifier");assert.ok(retry.includes(ask().reference));assert.match(retry, /ready boolean/);assert.match(retry, /broken-draft/);
 assert.match(retry, /did not pass the checks/);assert.ok(!retry.includes('sk-' + 'SECRET'.repeat(12)));assert.ok(retry.length < prompts[0].length + 35_000);
});
