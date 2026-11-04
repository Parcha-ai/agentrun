// A skill and a workflow draft go the way a note goes, in the same end-of-run turn: one answer, one check, one grader
// call and one merge commit with every file. A skill comes only from a run whose job completed; a draft names only the
// agent's own tools; the grader drops a draft that singles out one case; a risky skill waits for its owner's OK; and a
// SKILL.md whose steps hold code blocks is kept whole.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { ended, git, learner, LEARN, made, mergesOf, reflectRows, repoOf, savedOf, sleep, started } from "./learn-support.mjs";
import { scratch, serve, withEnv } from "./support.mjs";

/** A SKILL.md whose steps hold a fenced code block: a ``` line inside its four-backtick block closes nothing. */
const SKILL = "---\nname: find-policies\ndescription: Find a store's refund and shipping policies; use when a case asks what they say\n---\n# Find policies\n\n1. Open the policies page first:\n\n```sh\ncurl -s https://shop.example/policies/\n```\n\n2. Then the footer links.\n";
/** A draft of one model node; `tools`, the tools it names. */
const draft = (tools = [], instructions = "Find the store's refund policy from its public pages.") => JSON.stringify({
  v: 2,
  name: "find-policies",
  schemas: { Store: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, Policies: { type: "object", properties: { refund: { type: "string" } }, required: ["refund"] } },
  input: { schemaId: "Store" },
  output: { schemaId: "Policies", path: "policies" },
  root: { node: "agent", label: "find", instructions, out: "Policies", as: "policies", tools },
}, null, 2);
const DESCRIPTION = "Finds a store's refund policy from its public pages; use when a case asks for it";
const NOTE = note("Check units", "Convert every amount to one unit before comparing");

/** An end-of-run answer with a note, a skill and a workflow draft, as the prompt asks for them. */
const answer = ({ skill = SKILL, json = draft() } = {}) => [
  "Keeping three things.",
  `\`\`\`note check-units.md\n${NOTE}\`\`\``,
  `\`\`\`\`skill find-policies\n${skill}\`\`\`\``,
  `\`\`\`\`workflow find-policies\n---\ndescription: ${DESCRIPTION}\n---\n${json}\n\`\`\`\``,
  "Reflected.",
].join("\n\n");

/** Agent `id` whose end-of-run turn answers `text`, with `more` lines in its instructions (the faux grader's rules). */
const answering = (id, text, more = [], extra = {}) => learner(id, { instructions: ["Answer the question.", `Answer: ${JSON.stringify(text)}`, ...more].join("\n"), ...extra });

/** A server for learning whose grader calls are filed in a file of the test's own. */
async function server(t) {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls }, ["AGENTRUN_TEST_FAUX_GRADE_HOLD", "TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENTRUN_SERVE_GRADE_MODEL"]);
  const served = await serve(t, { learning: "on", faux: LEARN });
  const grades = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.kind === "grade").length;
  return { ...served, grades };
}

const show = (repo, path) => git(repo, ["show", `main:${path}`]);

test("a note, a skill and a workflow draft in one answer: one grader call, one merge commit with all three, the README written from the draft's description, and the SKILL.md with its code block kept whole", { timeout: 120_000 }, async (t) => {
  const { api, data, grades } = await server(t);
  await made(api, answering("keeper", answer()));
  const { view } = await ended(api, await started(api, "keeper"));
  assert.equal(view.learning?.state, "merged", JSON.stringify(view.learning));
  assert.equal(grades(), 1, "one grader call for all three");
  const repo = repoOf(data, "keeper");
  const merges = mergesOf(repo, view.run_id);
  assert.equal(merges.length, 1, "one merge commit");
  const changed = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", merges[0].split(" ")[0]]).split("\n").sort();
  assert.deepEqual(changed, ["MEMORY.md", "check-units.md", "skills/find-policies/SKILL.md", "workflows/find-policies/README.md", "workflows/find-policies/workflow.json"]);
  assert.equal(`${show(repo, "skills/find-policies/SKILL.md")}\n`, SKILL, "the SKILL.md whole, its inner fence and all");
  assert.equal(show(repo, "workflows/find-policies/workflow.json"), draft());
  assert.equal(`${show(repo, "workflows/find-policies/README.md")}\n`, `---\nname: find-policies\ndescription: ${DESCRIPTION}\n---\n`);
  const saved = await savedOf(data, view.run_id);
  assert.deepEqual([saved.learning.skills, saved.learning.workflows], [[{ file: "skills/find-policies/SKILL.md", name: "find-policies" }], [{ file: "workflows/find-policies/workflow.json", name: "find-policies" }]]);
  assert.match(view.learning.detail, /Learned: Check units\. Also learned the skill find-policies and the workflow find-policies/);
});

test("a skill from a run whose job failed is dropped by the checks as skill_outcome, and nothing of the answer is kept", { timeout: 120_000 }, async (t) => {
  const { api, data, grades } = await server(t);
  await made(api, answering("failing", answer(), ["Fail the job."]));
  const { view } = await ended(api, await started(api, "failing"), ["failed"]);
  assert.deepEqual([view.learning?.state, view.learning?.reason], ["dropped", "checker"], JSON.stringify(view.learning));
  const saved = await savedOf(data, view.run_id);
  assert.deepEqual(saved.learning.problems.map((problem) => [problem.rule, problem.path]), [["skill_outcome", "skills/find-policies/SKILL.md"]]);
  assert.match(view.learning.detail, /didn't pass the checks on what it learned \(a skill from a run that didn't finish its job\)/);
  assert.equal(grades(), 0, "no grader call");
  assert.deepEqual(mergesOf(repoOf(data, "failing"), view.run_id), []);
});

test("a draft may name only the agent's own tools: with read granted a draft that names it merges, and without it the checks refuse it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await server(t);
  const text = answer({ json: draft(["read"]) });
  await made(api, answering("reader", text, [], { tools: ["read"] }));
  const granted = await ended(api, await started(api, "reader"));
  assert.equal(granted.view.learning?.state, "merged", JSON.stringify(granted.view.learning));
  await made(api, answering("bare", text));
  const bare = await ended(api, await started(api, "bare"));
  assert.deepEqual([bare.view.learning?.state, bare.view.learning?.reason], ["dropped", "checker"]);
  const saved = await savedOf(data, bare.view.run_id);
  assert.deepEqual(saved.learning.problems.map((problem) => problem.rule), ["workflow"]);
  assert.match(saved.learning.problems[0].detail, /tool "read" is not one of the host's tools/);
});

test("the grader drops a draft that singles out one case, and with it the whole answer: nothing merges", { timeout: 120_000 }, async (t) => {
  const { api, data, grades } = await server(t);
  const text = answer({ json: draft([], "Find the refund policy of the one store in this case, shop.example, and answer 30 days.") });
  await made(api, answering("caser", text, ["Grade: drop workflows/find-policies/workflow.json."]));
  const { view } = await ended(api, await started(api, "caser"));
  assert.deepEqual([view.learning?.state, view.learning?.reason], ["dropped", "grader"], JSON.stringify(view.learning));
  assert.equal(grades(), 1);
  const saved = await savedOf(data, view.run_id);
  const items = Object.fromEntries(saved.learning.verdict.items.map((item) => [item.file, item.keep]));
  assert.deepEqual(items, { "check-units.md": true, "skills/find-policies/SKILL.md": true, "workflows/find-policies/workflow.json": false });
  assert.deepEqual(mergesOf(repoOf(data, "caser"), view.run_id), []);
});

test("a risky skill waits for its owner's OK: merged with status: pending in its SKILL.md, and said so", { timeout: 120_000 }, async (t) => {
  const { api, data } = await server(t);
  await made(api, answering("risky", answer(), ["Grade: pending skills/find-policies/SKILL.md."]));
  const { view } = await ended(api, await started(api, "risky"));
  assert.equal(view.learning?.state, "merged", JSON.stringify(view.learning));
  const repo = repoOf(data, "risky");
  assert.match(show(repo, "skills/find-policies/SKILL.md"), /^---\nname: find-policies\ndescription: .*\nstatus: pending\n---\n# Find policies/);
  assert.doesNotMatch(show(repo, "workflows/find-policies/README.md"), /status/, "the draft was kept as it is");
  const saved = await savedOf(data, view.run_id);
  assert.deepEqual(saved.learning.skills, [{ file: "skills/find-policies/SKILL.md", name: "find-policies", pending: true }]);
  assert.match(view.learning.detail, /Waiting for your OK: skill find-policies\./);
});

test("a run whose skill changed on main after it started never writes over it: retired by a person meanwhile, the run's merge is refused and the skill stays retired", { timeout: 180_000 }, async (t) => {
  const { api, data } = await server(t);
  const go = join(await scratch(t), "go");
  const only = (skill) => ["Keeping a skill.", `\`\`\`\`skill find-policies\n${skill}\`\`\`\``, "Reflected."].join("\n\n");
  await made(api, answering("stale", only(SKILL), [`Reflect once ${go} exists.`]));
  writeFileSync(go, "");
  assert.equal((await ended(api, await started(api, "stale"))).view.learning?.state, "merged");
  // Run 2 starts from the skill, active, and holds before its end-of-run turn.
  rmSync(go);
  assert.equal((await api("PUT", "/agents/stale/definition", answering("stale", only(SKILL.replace("Then the footer links.", "Then the site map.")), [`Reflect once ${go} exists.`], { version: 2 }))).status, 200);
  const runId = await started(api, "stale");
  for (let i = 0; !reflectRows((await api("GET", `/runs/${runId}/timeline`)).body.rows ?? []).some((row) => row.kind === "user_message"); i++) {
    assert.ok(i < 600, "the turn is asked");
    await sleep(50);
  }
  // Meanwhile a person retires the skill.
  const file = encodeURIComponent("skills/find-policies/SKILL.md");
  const read = await api("GET", `/agents/stale/learning/files/${file}`);
  assert.equal((await api("POST", `/agents/stale/learning/files/${file}/retire`, undefined, { "if-match": read.headers.get("etag") })).status, 200);
  writeFileSync(go, "");
  const { view } = await ended(api, runId);
  assert.deepEqual([view.learning?.state, view.learning?.reason], ["dropped", "checker"], JSON.stringify(view.learning));
  const repo = repoOf(data, "stale");
  assert.match(show(repo, "skills/find-policies/SKILL.md"), /^status: retired$/m, "the person's retire stands");
  assert.ok(!show(repo, "skills/find-policies/SKILL.md").includes("Then the site map."), "the run's text is not on main");
});
