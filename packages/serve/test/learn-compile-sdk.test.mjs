import assert from "node:assert/strict";
import { test } from "node:test";
import * as dsl from "@parcha/agentrun-dsl";
import { compileReference, compilePrompt, compileTurn, guardProblems, askedForCompile } from "../dist/learn/compile.js";
import { draftProblems } from "../dist/learn/skills.js";
const tool = "mcp:backend/status";
const ask = (adapters = []) => ({ mode: "new", workflowAdapters: adapters, reference: compileReference(dsl, { tools: [tool], judges: false, workflowAdapters: adapters }), tools: [tool], described: [{ name: tool, does: "Takes a release name and gives its ready boolean." }], judges: false, notes: [{ file: "release-policy.md", text: "Preserve the published release policy." }], traces: [], input: { release: "current" } });
const flow = (root) => ({ v: 2, name: "release", schemas: { Input: { type: "object" }, Answer: { type: "object" } }, input: { schemaId: "Input" }, output: { schemaId: "Answer", path: "answer" }, root });
const block = (doc) => "````workflow release\n---\ndescription: Return release readiness when asked.\nexample: {}\nfrom_notes: [release-policy.md]\n---\n" + JSON.stringify(doc) + "\n````";
const checked = doc => ({ state: "proposed", workflows: 1, proposal: { files: [{ file: "workflows/release/workflow.json", text: JSON.stringify(doc) }] } });
test("SDK compiler contract describes only explicitly registered adapters and bridge execution", () => {
 const ref = ask().reference;
 assert.match(ref, /NO runNode/); assert.match(ref, /NO runJudge/);
 assert.match(ref, /explicit.*bridge/i); assert.doesNotMatch(ref, /runs first on later runs|runs on the agent's model|\"tier\": \"fast\"/);
 assert.match(ref, /128/); assert.match(ref, /no.*guardStep/i);
 const model = ask(["runNode"]).reference;assert.match(model, /runNode/);assert.match(model, /NO runJudge/);
 const judge = ask(["runJudge"]).reference;assert.match(judge, /NO runNode/);assert.doesNotMatch(judge, /NO runJudge/);
});
test("SDK compiler prompt keeps callback catalog, notes and explicit execution without managed guards", () => {
 const prompt = compilePrompt(ask());
 assert.match(prompt, /explicit.*bridge/i);assert.doesNotMatch(prompt, /on later runs it runs first|runs on your model/);
 assert.match(prompt, /mcp:backend\/status/);assert.match(prompt, /ready boolean/);assert.match(prompt, /release-policy.md/);
 assert.doesNotMatch(prompt.split("## A worked example")[1].split("## This job")[0], /\"node\":\"extract\"|\"node\":\"decide\"|\"guard\":/);
});
test("SDK compile checks use the declared callback contract, without requiring an undeclared guardStep", async () => {
 const doc = flow({ node: "decide", label: "answer", instructions: "Return readiness.", out: "Answer", as: "answer" });
 assert.deepEqual(draftProblems(dsl, JSON.stringify(doc), [], {}, {}, undefined, undefined, ["runNode"]), []);
 assert.deepEqual(guardProblems(doc, { jev: false, workflowAdapters: ["runNode"] }), []);
 const out = await compileTurn({ compile: ask(["runNode"]), answer: "", ask: async () => ({ answer: block(doc) }), check: async () => checked(doc) });
 assert.ok(out.kept, JSON.stringify(out));assert.equal(out.record.attempts.length, 1);
 assert.ok(guardProblems(doc, { jev: false }).length, "managed compilation still requires its confidence guard");
});
test("SDK compiler rejects guards because no guardStep callback is declared, even with runNode", () => {
 const doc = flow({ node: "decide", label: "answer", instructions: "Return readiness.", out: "Answer", as: "answer", guard: { signal: "self", threshold: 0.7 } });
 assert.match(guardProblems(doc, { jev: false, workflowAdapters: ["runNode"] }).join(" "), /guardStep/);
 assert.deepEqual(guardProblems(doc, { jev: false }), [], "managed confidence guard remains accepted");
});
test("each stateless SDK retry carries the original contract/catalog/notes and the bounded redacted failed draft", async () => {
 const doc = flow({ node: "call", label: "status", via: "tool", tool, args: {}, out: "Answer", as: "answer", deadline_s: 5 });
 const before = 'broken-draft api_key=sk-' + 'SECRET'.repeat(12) + "\n" + "x".repeat(40_000);
 const prompts=[];let n=0;
 const out = await compileTurn({ compile: ask(), answer: "", refuse: ['sk-' + 'SECRET'.repeat(12)], ask: async prompt => {
  prompts.push(prompt);return { answer: ++n === 1 ? before : block(doc) };
 }, check: async () => checked(doc) });
 assert.ok(out.kept, JSON.stringify(out));assert.equal(prompts.length, 2);
 const retry=prompts[1];assert.equal(askedForCompile(retry),"again","the SDK retry retains the shared timeline classifier");assert.ok(retry.includes(ask().reference));assert.match(retry, /release-policy.md/);assert.match(retry, /ready boolean/);assert.match(retry, /broken-draft/);
 assert.match(retry, /did not pass the checks/);assert.ok(!retry.includes('sk-' + 'SECRET'.repeat(12)));assert.ok(retry.length < prompts[0].length + 35_000);
});
