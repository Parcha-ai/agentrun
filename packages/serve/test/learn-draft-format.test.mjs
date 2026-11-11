// #2412: a workflow draft kept for a skill's job keeps the output format the skill gives. The ask says so; the run's
// proposal carries the skill of the draft's name as the folder holds it (proposeRun `drafted`); the grader is shown it
// beside the draft, and its rubric drops a draft whose output cannot give that format (Format).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { GRADE_RUBRIC, gradePrompt } from "../dist/learn/grade.js";
import { reflectPrompt } from "../dist/learn/reflect.js";
import { agentFolderOf } from "../dist/files.js";
import { PROPOSAL, seedOf } from "../dist/learning.js";
import { proposeRun } from "../dist/propose.js";
import { learningWorkspace } from "../dist/workspace/index.js";
import { ended, git, made, repoOf, resnap, savedOf, started, learner, LEARN } from "./learn-support.mjs";
import { scratch, serve, withEnv } from "./support.mjs";

const AGENT = "agent-1";
/** A skill whose answer has a fixed format, as the bench's expense skill gives it. */
const CARD_SKILL = [
  "---",
  "name: card-report",
  "description: Report a week's card transactions by category; use when the user pastes card transactions",
  "---",
  "1. Assign each transaction to Travel, Software, Meals or Office.",
  "2. Reply with exactly this and nothing else:",
  "",
  "| Category | Count | Total |",
  "|---|---|---|",
  "",
  "Flagged: (merchants over $500, or none)",
  "Grand total: $(the sum)",
  "",
].join("\n");
/** A draft of the skill's job whose one node writes `instructions`: its output the node's report. */
const cardDraft = (instructions) => JSON.stringify({
  v: 2, name: "card-report",
  schemas: { In: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, Report: { type: "object", properties: { report: { type: "string" } }, required: ["report"] } },
  input: { schemaId: "In" }, output: { schemaId: "Report", path: "report" },
  root: { node: "chain", steps: [{ node: "extract", label: "format", instructions, out: "Report", as: "report" }] },
});
const DROPS = "Categorise the transactions and sum them.";
const KEEPS = "Reply with the table '| Category | Count | Total |', then 'Flagged: ' and the merchants over $500, then 'Grand total: $' and the sum.";
const block = (json) => `\`\`\`\`workflow card-report\n---\ndescription: Reports a week's card transactions by category; use when the user pastes them\n---\n${json}\n\`\`\`\``;

/** Agent `id`'s learning folder made as a first run makes it, then `files` committed on main. */
async function folderWith(data, id, files) {
  await seedOf(data, id);
  const repo = join(agentFolderOf(data, id), "learning");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, id);
}

test("the draft ask says the draft's output is the job's answer in the skill's own output format, written by its last node (#2412)", () => {
  const asked = reflectPrompt({ dir: ".learning", active: 0, tools: ["read"], draftFor: ["card-report"] });
  const line = asked.split("\n").find((one) => one.includes("has now served"));
  assert.match(line, /Its output is the job's answer in the output format the skill gives: its last node writes it, and `output` names that node's text\./, line);
  const two = reflectPrompt({ dir: ".learning", active: 0, tools: ["read"], draftFor: ["card-report", "weekly-report"] });
  assert.match(two.split("\n").find((one) => one.includes("have each served")), /in the output format its skill gives: its last node writes it/);
});

test("a run's proposal carries the skill of its draft's name as the folder holds it at the seed, for the grader (#2412)", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-draft-format-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await folderWith(data, AGENT, { "skills/card-report/SKILL.md": CARD_SKILL });
  const { sha } = await seedOf(data, AGENT);
  const runDir = mkdtempSync(join(data, "run-"));
  const folder = learningWorkspace({ mode: "local", data, agentId: AGENT });
  try {
    const result = await proposeRun({ folder: folder.workspace, runDir, seed: sha, turn: { answer: block(cardDraft(DROPS)), asked: [] }, refuse: [], outcome: "completed", tools: [] });
    assert.equal(result.state, "proposed", JSON.stringify(result));
  } finally {
    await folder.end();
  }
  const proposal = JSON.parse(readFileSync(join(runDir, PROPOSAL), "utf8"));
  assert.deepEqual(proposal.drafted, [{ file: "skills/card-report/SKILL.md", text: CARD_SKILL }]);
});

test("the grader is shown a draft's skill beside it, and its rubric drops a draft whose output cannot give the skill's format (#2412)", () => {
  const files = [{ file: "workflows/card-report/workflow.json", text: cardDraft(DROPS) }, { file: "workflows/card-report/README.md", text: "---\nname: card-report\ndescription: Reports\n---\n" }];
  const prompt = gradePrompt({ run: "run-1", active: [], superseded: [], proposed: [], files, drafted: [{ file: "skills/card-report/SKILL.md", text: CARD_SKILL }] });
  assert.match(prompt, /----- begin [0-9a-f]+: skills\/card-report\/SKILL\.md, the skill this draft keeps as a workflow \(not graded\) -----\n[\s\S]*Grand total: \$\(the sum\)/, prompt.slice(prompt.indexOf("## The new skill")));
  assert.ok(prompt.indexOf("workflows/card-report/workflow.json, new") < prompt.indexOf("skills/card-report/SKILL.md, the skill this draft keeps"), "the skill sits under its draft");
  assert.match(prompt, /Give one item for each of these files, each once, and for no other: workflows\/card-report\/workflow\.json\./, "the skill is shown, never graded");
  assert.match(GRADE_RUBRIC, /^- Format: a workflow draft of a skill's job/m);
  assert.match(GRADE_RUBRIC, /a workflow draft, fails Format/);
  assert.doesNotMatch(gradePrompt({ run: "run-1", active: [], superseded: [], proposed: [], files }), /the skill this draft keeps/, "none given, none shown");
});

test("end to end on the faux grader: a draft of a skill's job that drops the skill's format is not kept, and one that keeps it is (#2412)", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const { api, data } = await serve(t, { learning: "on", faux: LEARN });
  for (const [id, json, kept] of [["drops", cardDraft(DROPS), false], ["keeps", cardDraft(KEEPS), true]]) {
    await made(api, learner(id, { instructions: ["Answer the question.", `Answer: ${JSON.stringify(`${block(json)}\n\nReflected.`)}`, "Grade: format."].join("\n") }));
    await folderWith(data, id, { "skills/card-report/SKILL.md": CARD_SKILL });
    const { view } = await ended(api, await started(api, id));
    const saved = await savedOf(data, view.run_id);
    const item = saved.learning.verdict?.items?.find((one) => one.file === "workflows/card-report/workflow.json");
    assert.equal(item?.keep, kept, `${id}: ${JSON.stringify(saved.learning)}`);
    if (!kept) assert.equal(item.question, "Format", JSON.stringify(item));
    const tree = git(repoOf(data, id), ["ls-tree", "-r", "--name-only", "main"]).split("\n");
    assert.equal(tree.includes("workflows/card-report/workflow.json"), kept, `${id}: ${tree.join(",")}`);
  }
});
