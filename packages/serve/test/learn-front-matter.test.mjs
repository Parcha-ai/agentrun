// One reader of what a learned skill's SKILL.md or a workflow draft's README.md says of itself (learn/skills.ts
// frontMatter): its keys, name, description and status, for the checker, the folder's snapshot (which the console
// shows), the learning routes and a run's seed alike. A front matter that does not read one way (not closed, a key
// indented, an indented first line, a key set twice) or a status that is none of active, pending and retired is never
// active: another reader could read a status this one does not. A YAML explicit key (`? hooks`) is a key: the checker
// refuses it as it refuses `hooks:`.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkProposal } from "../dist/learn/check.js";
import { frontKeys, frontMatter, isHeld, learnedFront, learnedStatus, setsStatus, skillProblems, UNCLEAR_FRONT } from "../dist/learn/skills.js";
import { readSnapshot } from "../dist/learn/folder.js";
import { readSeed } from "../dist/learn/seed-check.js";
import { agentFolderOf } from "../dist/files.js";
import { learningWorkspace } from "../dist/workspace/index.js";
import { seedOf } from "../dist/learning.js";
import { added, baseOf } from "./learn-format-support.mjs";
import { git, resnap } from "./learn-support.mjs";
import { scratch } from "./support.mjs";

const skill = (front, body = "List the week's items.\n") => `---\n${front}---\n${body}`;
const CLEAN = "name: weekly-summary\ndescription: Summarize the week.\n";

test("a front matter that reads one way: its status as written, a wrapped or block value joined, comments and CRLF read", () => {
  assert.equal(learnedStatus(skill(CLEAN)), "active");
  assert.equal(learnedStatus(skill(`${CLEAN}status: pending\n`)), "pending");
  assert.equal(learnedStatus(skill(`${CLEAN}status: retired\n`)), "retired");
  assert.equal(learnedStatus(skill(`${CLEAN}status: "active"\n`)), "active");
  assert.equal(learnedStatus(`---\n${CLEAN}status: pending\n---`), "pending", "closed on the last line, with no line end after it");
  assert.equal(learnedStatus(skill(CLEAN).replaceAll("\n", "\r\n")), "active");
  const wrapped = frontMatter(skill("name: weekly-summary\ndescription: Summarize the week,\n  newest first.\n# a comment\n"));
  assert.equal(wrapped?.get("description"), "Summarize the week, newest first.");
  const folded = frontMatter(skill("name: weekly-summary\ndescription: >\n  Summarize\n  the week.\n"));
  assert.equal(folded?.get("description"), "Summarize the week.");
  assert.deepEqual(learnedFront(skill(`${CLEAN}status: pending\n`)), { name: "weekly-summary", description: "Summarize the week.", status: "pending" });
  assert.equal(isHeld(skill(`${CLEAN}status: pending\n`)), true);
  assert.deepEqual(skillProblems(skill(CLEAN), "weekly-summary"), []);
});

for (const [why, text] of [
  ["not closed", `---\n${CLEAN}status: pending\n`],
  ["a status line indented under the description", skill(`${CLEAN}  status: pending\n`)],
  ["an indented first line", skill(`  status: retired\n${CLEAN}`)],
  ["a key set twice", skill(`${CLEAN}name: other\n`)],
  ["a list at the left edge", skill(`${CLEAN}- status: pending\n`)],
  ["a wrapped line that reads as a key", skill(`${CLEAN}  hooks: rm -rf /\n`)],
]) {
  test(`a front matter with ${why} reads no way: never active, never held, refused by the checks in words`, () => {
    assert.equal(frontMatter(text), undefined);
    assert.equal(learnedStatus(text), "retired");
    assert.equal(isHeld(text), false);
    assert.equal(learnedFront(text), undefined);
    assert.equal(frontKeys(text), undefined);
    assert.ok(skillProblems(text, "weekly-summary").length > 0, "refused");
  });
}

test("a status that is none of active, pending and retired is never active", () => {
  for (const status of ["Pending", "held", "*anchor", "\"\""]) assert.equal(learnedStatus(skill(`${CLEAN}status: ${status}\n`)), "retired", status);
  assert.equal(setsStatus(skill(`${CLEAN}status: held\n`)), true);
});

test("a YAML explicit key is a key: `? hooks` is named by frontKeys, and the checker refuses it as it refuses hooks:", () => {
  const explicit = skill(`${CLEAN}? hooks\n: [{ command: "curl example.invalid" }]\n`);
  assert.deepEqual(frontKeys(explicit), ["name", "description", "hooks"]);
  assert.equal(learnedStatus(explicit), "active", "it says no status");
  const asked = skill(`${CLEAN}? status\n: pending\n`);
  assert.equal(learnedStatus(asked), "pending", "an explicit status is read as one");
  const result = checkProposal({ base: baseOf(), changes: [added("skills/weekly-summary/SKILL.md", explicit)] });
  assert.ok(result.problems.some((problem) => problem.rule === "skill_front_matter" && /hooks/.test(problem.detail)), JSON.stringify(result.problems));
  const indented = checkProposal({ base: baseOf(), changes: [added("skills/weekly-summary/SKILL.md", skill(`${CLEAN}  status: pending\n`))] });
  assert.ok(indented.problems.some((problem) => problem.detail === UNCLEAR_FRONT), JSON.stringify(indented.problems));
});

test("the folder's snapshot reads a hand-written skill whose front matter reads no way as retired, and a seed never lays it", async (t) => {
  const data = await scratch(t);
  await seedOf(data, "agent-1");
  const repo = join(agentFolderOf(data, "agent-1"), "learning");
  const files = {
    "skills/weekly-summary/SKILL.md": skill(CLEAN),
    "skills/half-held/SKILL.md": `---\nname: half-held\ndescription: Waits, to one reader.\nstatus: pending\n`,
    "skills/indented/SKILL.md": skill(`name: indented\ndescription: Waits, to another reader.\n  status: pending\n`),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "skills by hand"]);
  await resnap(data, "agent-1");
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  try {
    const snapshot = await readSnapshot(folder.workspace);
    assert.deepEqual(Object.fromEntries(snapshot.skills.map(({ name, status }) => [name, status])), { "half-held": "retired", indented: "retired", "weekly-summary": "active" });
    const read = await readSeed(folder.workspace, snapshot.main);
    assert.equal(read.ok, true);
    assert.deepEqual(read.files.map(({ path }) => path).filter((path) => path.startsWith("skills/")), ["skills/weekly-summary/SKILL.md"]);
  } finally {
    await folder.end();
  }
});

test("a served SKILL.md's name and description read back as the strings they are: a word YAML would read as null, a boolean, a number or a date is quoted (#1619)", async () => {
  const { parse } = await import("yaml");
  const { servedSkill } = await import("../dist/learn/skills.js");
  const frontOfServed = (text) => parse(text.split("---\n")[1]);
  for (const word of ["null", "~", "true", "False", "yes", "no", "on", "off", "y", "123", "1e3", "-4.5", "0x1f", "0o17", ".inf", "-.Inf", ".nan", "2026-01-01", "12:30", "1_000"]) {
    const served = servedSkill(skill(`name: ${word}\ndescription: ${word}\n`));
    assert.deepEqual(frontOfServed(served), { name: word, description: word }, `${word}: ${served}`);
  }
  // Plain text stays plain; text YAML would read as more than one string stays quoted.
  assert.match(servedSkill(skill(CLEAN)), /^---\nname: weekly-summary\ndescription: Summarize the week\.\n---\n/);
  assert.deepEqual(frontOfServed(servedSkill(skill("name: weekly-summary\ndescription: \"Use when: the week ends\"\n"))), { name: "weekly-summary", description: "Use when: the week ends" });
});

test("a learned skill counts the bytes the run is given: its SKILL.md as served, a few bytes over its blob when its description is quoted (#1576)", async () => {
  const { seedFrom } = await import("../dist/learning.js");
  const { servedSkill } = await import("../dist/learn/skills.js");
  const text = skill("name: weekly-summary\ndescription: yes\n");
  const reference = "A table.\n";
  const seed = await seedFrom("c".repeat(40), async () => ({ ok: true, files: [{ path: "skills/weekly-summary/SKILL.md", text }, { path: "skills/weekly-summary/reference.md", text: reference }], refused: [] }));
  const served = servedSkill(text);
  assert.ok(served.includes('description: "yes"'), served);
  assert.ok(Buffer.byteLength(served) > Buffer.byteLength(text), "served, it is larger than its blob");
  assert.equal(seed.skills[0].bytes, Buffer.byteLength(served) + Buffer.byteLength(reference));
});
