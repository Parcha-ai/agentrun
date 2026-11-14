// An agent may learn notes and skills alone: `learning: "notes"` beside true (everything) and false (off). Under it a run
// is given its learned notes and skills but never a learned workflow (no learned_workflow tool, none named in its
// launch), its end-of-run turn asks for no workflow and it runs no compile turn, and a draft it gives anyway is left out by the checks while
// its notes and skill go on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, learner, LEARN, made, repoOf, git, started } from "./learn-support.mjs";
import { serve } from "./support.mjs";
import { specFor } from "./runner-spec-support.mjs";
import { answerFlow } from "./support.mjs";
import { landWorkflows, startAt } from "./learned-workflow-seed-support.mjs";

const { definitionIssues } = await import("../dist/validate.js");
const { reflectAgain, reflectPrompt } = await import("../dist/learn/reflect.js");
const { LEARNED_WORKFLOW_TOOL } = await import("../dist/learned-workflow.js");

const AGENT = "agent-1";
const FLOWS = [{ name: "answer", description: "Answers a question as a number", workflow: answerFlow() }];

test("a definition's learning is true, false or \"notes\"; anything else is refused, naming the three", () => {
  const base = { version: 1, name: "a", instructions: "Answer.", skills: [], tools: [] };
  for (const learning of [true, false, "notes"]) assert.deepEqual(definitionIssues({ ...base, learning }), [], `learning: ${JSON.stringify(learning)}`);
  for (const learning of ["yes", "workflows", 1]) {
    const issues = definitionIssues({ ...base, learning });
    assert.equal(issues.length, 1, JSON.stringify(issues));
    assert.match(issues[0].message, /true, false or "notes"/);
  }
});

test("the end-of-run turn asks for no workflow draft, on any run: no workflow block, it says to keep none, and its retry names notes and skills", () => {
  const prompt = reflectPrompt({ dir: ".learning", active: 0 });
  assert.doesNotMatch(prompt, /````workflow|workflow DSL|as a workflow draft named/, prompt);
  assert.match(prompt, /Keep no workflow here/);
  assert.match(prompt, /````skill find-policies/, "a skill is still asked for");
  assert.match(reflectAgain("bad"), /every note and skill block/);
  assert.doesNotMatch(reflectAgain("bad"), /workflow/);
});

test("pi: a notes run on the runner is given no learned_workflow, though its agent learned an active workflow", async (t) => {
  const launch = {};
  const { spec } = await specFor(t, {
    body: { learning: "notes", tools: ["read"] },
    launch,
    ledger: { models: async () => ({ getModel: () => undefined, getModels: () => [], completeSimple: async () => ({}), streamSimple: () => ({}) }) },
    before: async (_server, _key, dir) => { launch.learning = { ...startAt(await landWorkflows(dir, AGENT, FLOWS)), notesOnly: true }; },
  });
  assert.equal(spec.session.tools.some((tool) => tool.name === LEARNED_WORKFLOW_TOOL), false, JSON.stringify(spec.session.tools.map(({ name }) => name)));
});

/** A SKILL.md the notes agent keeps. */
const SKILL = "---\nname: find-policies\ndescription: Find a store's refund policy; use when a case asks for it\n---\n1. Open the policies page first.\n";
const DRAFT = JSON.stringify({ v: 2, name: "find-policies", schemas: { S: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, P: { type: "object", properties: { refund: { type: "string" } }, required: ["refund"] } }, input: { schemaId: "S" }, output: { schemaId: "P", path: "p" }, root: { node: "agent", label: "find", instructions: "Find the store's refund policy.", out: "P", as: "p", tools: [] } });
const NOTE = note("Check units", "Convert every amount to one unit before comparing");
const ANSWER = [
  `\`\`\`note check-units.md\n${NOTE}\`\`\``,
  `\`\`\`\`skill find-policies\n${SKILL}\`\`\`\``,
  `\`\`\`\`workflow find-policies\n---\ndescription: Finds a store's refund policy\n---\n${DRAFT}\n\`\`\`\``,
].join("\n\n");

test("a notes agent keeps its note and skill but never a workflow draft, and its next run is given the note and the skill, no workflow", { timeout: 120_000 }, async (t) => {
  const { api, data, store } = await serve(t, { learning: "on", faux: LEARN });
  await made(api, learner("noter", { instructions: ["Answer the question.", `Answer: ${JSON.stringify(ANSWER)}`].join("\n"), learning: "notes" }));
  const read = await api("GET", "/agents/noter");
  assert.equal(read.body.definition.learning, "notes", "the definition keeps \"notes\"");
  const first = await ended(api, await started(api, "noter"));
  assert.equal(first.view.learning?.state, "merged", JSON.stringify(first.view.learning));
  const repo = repoOf(data, "noter");
  const files = git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
  assert.ok(files.includes("check-units.md") && files.includes("skills/find-policies/SKILL.md"), files.join(", "));
  assert.equal(files.some((file) => file.startsWith("workflows/")), false, "no workflow draft is kept");
  const second = await started(api, "noter", "Again.");
  const launch = (await store.runs.launch(second)).body;
  assert.deepEqual(launch.learning.given.map(({ file }) => file), ["check-units.md"], "its note is given");
  assert.deepEqual(launch.learning.skills, ["find-policies"], "its skill is given");
  assert.equal(launch.learning.workflows, undefined, "no workflow is named");
  assert.equal(launch.learning.notesOnly, true);
});
