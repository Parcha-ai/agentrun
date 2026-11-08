// A skill and a workflow draft go the way a note goes, in the same end-of-run turn: one answer, one check, one grader
// call and one merge commit with every file. A skill comes only from a run whose job completed; a draft names only the
// agent's own tools; the grader drops a draft that singles out one case; a risky skill waits for its owner's OK; and a
// SKILL.md whose steps hold code blocks is kept whole.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { note } from "./fixtures/faux-learn.mjs";
import { CAPS } from "../dist/learn/check.js";
import { ended, git, learnedOnMain, learner, LEARN, made, mergesOf, proposedOf, reflectRows, repoOf, resnap, RUN_END_TODO, savedOf, sleep, started } from "./learn-support.mjs";
import { runDir, scratch, serve, withEnv } from "./support.mjs";

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

test("a note, a skill and a workflow draft in one answer: one grader call, one merge commit with all three, the README written from the draft's description, and the SKILL.md with its code block kept whole", { timeout: 120_000, skip: RUN_END_TODO }, async (t) => {
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

test("a skill from a run whose job failed is left out by the checks as skill_outcome, and the rest of its answer goes on to the grader", { timeout: 120_000, skip: RUN_END_TODO }, async (t) => {
  const { api, data, grades } = await server(t);
  await made(api, answering("failing", answer(), ["Fail the job."]));
  const { view } = await ended(api, await started(api, "failing"), ["failed"]);
  assert.deepEqual([view.learning?.state, view.learning?.reason], ["merged", null], JSON.stringify(view.learning));
  const saved = await savedOf(data, view.run_id);
  assert.deepEqual(saved.learning.problems.map((problem) => [problem.rule, problem.path]), [["skill_outcome", "skills/find-policies/SKILL.md"]]);
  assert.match(view.learning.detail, /Not kept: it didn't pass the checks on what it learned \(a skill from a run that didn't finish its job\)/);
  assert.equal(grades(), 1, "the rest is graded");
  const repo = repoOf(data, "failing");
  assert.equal(mergesOf(repo, view.run_id).length, 1);
  const tree = git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
  assert.ok(tree.includes("check-units.md") && !tree.includes("skills/find-policies/SKILL.md"), tree.join(","));
});

/** A draft whose call node fetches the store's page with `tool`. */
const callDraft = (tool) => {
  const doc = JSON.parse(draft());
  doc.schemas.Page = { type: "object" };
  doc.output = { schemaId: "Page", path: "page" };
  doc.root = { node: "call", label: "fetch", via: "tool", tool, args: { url: "{url}" }, out: "Page", as: "page", deadline_s: 30 };
  return JSON.stringify(doc, null, 2);
};

test("a draft may name only the agent's own tools, on a call node: with web_fetch granted a draft that runs it merges, and without it the checks leave the draft out and the rest merges; a model node that names a tool is left out though the agent was granted it", { timeout: 120_000, skip: RUN_END_TODO }, async (t) => {
  const { api, data } = await server(t);
  const text = answer({ json: callDraft("web_fetch") });
  await made(api, answering("fetcher", text, [], { tools: ["web_fetch"] }));
  const granted = await ended(api, await started(api, "fetcher"));
  assert.equal(granted.view.learning?.state, "merged", JSON.stringify(granted.view.learning));
  await made(api, answering("bare", text));
  const bare = await ended(api, await started(api, "bare"));
  assert.deepEqual([bare.view.learning?.state, bare.view.learning?.reason], ["merged", null]);
  assert.ok(!git(repoOf(data, "bare"), ["ls-tree", "-r", "--name-only", "main"]).includes("workflows/"), "the draft is not on main");
  const saved = await savedOf(data, bare.view.run_id);
  assert.deepEqual(saved.learning.problems.map((problem) => problem.rule), ["workflow"]);
  assert.match(saved.learning.problems[0].detail, /tool "web_fetch" is not one of the host's tools/);
  // A learned model node runs without tools: one that names web_fetch is refused at learn time, though it is granted.
  await made(api, answering("tooled", answer({ json: draft(["web_fetch"]) }), [], { tools: ["web_fetch"] }));
  const tooled = await ended(api, await started(api, "tooled"));
  assert.deepEqual([tooled.view.learning?.state, tooled.view.learning?.reason], ["merged", null], JSON.stringify(tooled.view.learning));
  assert.ok(!git(repoOf(data, "tooled"), ["ls-tree", "-r", "--name-only", "main"]).includes("workflows/"), "the tooled draft is not on main");
  const refused = await savedOf(data, tooled.view.run_id);
  assert.deepEqual(refused.learning.problems.map((problem) => problem.rule), ["workflow"]);
  assert.match(refused.learning.problems[0].detail, /model node at \/root names a tool \(web_fetch\): a learned workflow's model node runs without tools/);
});

test("the grader drops a draft that singles out one case: the draft (its workflow.json and README) is left out, and the note and the skill it kept merge", { timeout: 120_000, skip: RUN_END_TODO }, async (t) => {
  const { api, data, grades } = await server(t);
  const text = answer({ json: draft([], "Find the refund policy of the one store in this case, shop.example, and answer 30 days.") });
  await made(api, answering("caser", text, ["Grade: drop workflows/find-policies/workflow.json."]));
  const { view } = await ended(api, await started(api, "caser"));
  assert.deepEqual([view.learning?.state, view.learning?.reason], ["merged", null], JSON.stringify(view.learning));
  assert.equal(grades(), 1);
  const saved = await savedOf(data, view.run_id);
  const items = Object.fromEntries(saved.learning.verdict.items.map((item) => [item.file, item.keep]));
  assert.deepEqual(items, { "check-units.md": true, "skills/find-policies/SKILL.md": true, "workflows/find-policies/workflow.json": false });
  const repo = repoOf(data, "caser");
  assert.equal(mergesOf(repo, view.run_id).length, 1);
  const tree = git(repo, ["ls-tree", "-r", "--name-only", "main"]).split("\n");
  assert.ok(tree.includes("check-units.md") && tree.includes("skills/find-policies/SKILL.md"), tree.join(","));
  assert.ok(!tree.some((path) => path.startsWith("workflows/find-policies/")), "the dropped draft's files are not on main");
  assert.deepEqual(view.learning.workflows ?? [], [], "nor named as learned");
});

test("a risky skill waits for its owner's OK: merged with status: pending in its SKILL.md, and said so", { timeout: 120_000, skip: RUN_END_TODO }, async (t) => {
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

test("a run whose skill changed on main after it started never writes over it: retired by a person meanwhile, the run's merge is refused and the skill stays retired", { timeout: 180_000, skip: RUN_END_TODO }, async (t) => {
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

test("a note the run marked risky: true waits for its owner's OK through the server's own grade, beside a skill: the grade reads the note's text for the mark, not just its name", { timeout: 120_000, skip: RUN_END_TODO }, async (t) => {
  const { api, data } = await server(t);
  const RISKY = note("Refund limit", "Use when staff ask whether a refund needs a manager", "Staff can refund up to $250 on their own.\n", "risky: true\n");
  assert.match(RISKY, /^risky: true$/m);
  const text = ["Keeping two things.", `\`\`\`note refund-limit.md\n${RISKY}\`\`\``, `\`\`\`\`skill find-policies\n${SKILL}\`\`\`\``, "Reflected."].join("\n\n");
  await made(api, answering("marked", text));
  const { view } = await ended(api, await started(api, "marked"));
  assert.equal(view.learning?.state, "merged", JSON.stringify(view.learning));
  assert.deepEqual((view.learning.pending ?? []).map((n) => n.file), ["refund-limit.md"], "the marked note waits, though the grader kept it");
  const repo = repoOf(data, "marked");
  assert.match(show(repo, "refund-limit.md"), /^status: pending$/m);
  assert.ok(!/^risky:/m.test(show(repo, "refund-limit.md")), "the mark is not kept");
});

test("a retire is a person's call and sticks: the next run that gives the same skill again, whole and with no status, is dropped by the checks as skill_status, and the skill stays retired", { timeout: 180_000 }, async (t) => {
  const { api, data } = await server(t);
  const only = (skill) => ["Keeping a skill.", `\`\`\`\`skill find-policies\n${skill}\`\`\`\``, "Reflected."].join("\n\n");
  await made(api, answering("sticky", only(SKILL)));
  const first = await started(api, "sticky");
  proposedOf((await ended(api, first)).view);
  assert.equal((await learnedOnMain({ api, data }, "sticky", first)).result?.ok, true);
  const file = encodeURIComponent("skills/find-policies/SKILL.md");
  const read = await api("GET", `/agents/sticky/learning/files/${file}`);
  assert.equal((await api("POST", `/agents/sticky/learning/files/${file}/retire`, undefined, { "if-match": read.headers.get("etag") })).status, 200);
  // The next run gives the same skill again, changed, with no status.
  assert.equal((await api("PUT", "/agents/sticky/definition", answering("sticky", only(SKILL.replace("Then the footer links.", "Then the site map.")), [], { version: 2 }))).status, 200);
  const { view } = await ended(api, await started(api, "sticky"));
  assert.deepEqual([view.learning?.state, view.learning?.reason], ["dropped", "checker"], JSON.stringify(view.learning));
  const { learning } = await savedOf(data, view.run_id);
  assert.ok(learning.problems.some((p) => p.rule === "skill_status" && p.path === "skills/find-policies/SKILL.md"), JSON.stringify(learning.problems));
  assert.match(show(repoOf(data, "sticky"), "skills/find-policies/SKILL.md"), /^status: retired$/m);
});

test("a skill is laid into a run with its name and description alone in its front matter, whatever main holds (a directive Claude Code reads never reaches a harness)", { timeout: 180_000 }, async (t) => {
  const { api, data } = await server(t);
  const only = (skill) => ["Keeping a skill.", `\`\`\`\`skill find-policies\n${skill}\`\`\`\``, "Reflected."].join("\n\n");
  await made(api, answering("laid", only(SKILL)));
  const first = await started(api, "laid");
  proposedOf((await ended(api, first)).view);
  assert.equal((await learnedOnMain({ api, data }, "laid", first)).result?.ok, true);
  // main's SKILL.md given a hook by hand (an older server's, or anyone with the folder): the run is never given it.
  const repo = repoOf(data, "laid");
  const hooked = show(repo, "skills/find-policies/SKILL.md").replace("description:", "hooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: \"touch /tmp/never\"\ndescription:");
  writeFileSync(join(repo, "skills/find-policies/SKILL.md"), `${hooked}\n`);
  git(repo, ["add", "skills/find-policies/SKILL.md"]);
  git(repo, ["commit", "-q", "-m", "a hand edit"]);
  await resnap(data, "laid");
  const runId = await started(api, "laid");
  await ended(api, runId);
  const given = readFileSync(join(runDir(data, runId), "work", ".agents", "skills", "find-policies", "SKILL.md"), "utf8");
  assert.ok(!given.includes("hooks:") && !given.includes("touch /tmp/never"), given);
  assert.match(given, /^---\nname: find-policies\ndescription: [^\n]+\n---\n/);
});

test("a skill left out unread for its size that hides a secret's shape refuses the whole answer: the note and the draft beside it are not kept", { timeout: 120_000 }, async (t) => {
  const { api, data, grades } = await server(t);
  const shaped = ["s", "k-", "Zx9".repeat(10)].join("");
  const huge = `${SKILL}\nSign in with ${shaped}.\n${"x".repeat(CAPS.file)}\n`;
  await made(api, answering("hider", answer({ skill: huge })));
  const { view } = await ended(api, await started(api, "hider"));
  assert.deepEqual([view.learning?.state, view.learning?.reason], ["dropped", "checker"], JSON.stringify(view.learning));
  const saved = await savedOf(data, view.run_id);
  assert.ok(saved.learning.problems.some((problem) => problem.rule === "secret_shape"), JSON.stringify(saved.learning.problems));
  assert.equal(grades(), 0, "nothing graded");
  assert.deepEqual(mergesOf(repoOf(data, "hider"), view.run_id), []);
});

test("a draft whose call node calls a tool the agent sets to ask is left out by the checks in #1601's words; the run's other learning stands", { timeout: 120_000 }, async (t) => {
  const { api, data } = await server(t);
  const json = JSON.stringify({
    v: 2,
    name: "find-policies",
    schemas: { Store: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, Page: { type: "object" } },
    input: { schemaId: "Store" },
    output: { schemaId: "Page", path: "page" },
    root: { node: "call", label: "fetch", via: "tool", tool: "web_fetch", args: { url: "{url}" }, out: "Page", as: "page", deadline_s: 30 },
  });
  await made(api, answering("asking", answer({ json }), [], { tools: ["web_fetch"], tool_settings: { web_fetch: { permission: "ask" } } }));
  const asked = await ended(api, await started(api, "asking"));
  proposedOf(asked.view);
  assert.equal((await learnedOnMain({ api, data }, "asking", asked.view.run_id)).result?.ok, true, "the run's other learning stands");
  // What the checks left out, kept with the proposal in the run's serve.json (the view names it once the learning ends).
  const saved = JSON.parse(readFileSync(join(runDir(data, asked.view.run_id), "serve.json"), "utf8"));
  assert.match((saved.learning.problems ?? []).map((problem) => problem.detail).join("\n"), /This workflow's call node calls web_fetch, which is set to ask, and a workflow's call node can't wait for an approval: set it to allow for this agent/, JSON.stringify(saved.learning));
  const onMain = git(repoOf(data, "asking"), ["ls-tree", "-r", "--name-only", "main"]);
  assert.ok(!onMain.includes("workflows/"), `no draft merged: ${onMain}`);
});
