// One reader of what a learned skill's SKILL.md or a workflow draft's README.md says of itself (learn/skills.ts
// frontMatter): its keys, name, description and status, for the checker, the folder's snapshot (which the console
// shows), the learning routes and a run's seed alike. A front matter that does not read one way (not closed, a key
// indented, an indented first line, a key set twice) or a status that is none of active, pending and retired is never
// active: another reader could read a status this one does not. A YAML explicit key (`? status`) is such a form: no
// writer here edits it, so it reads no way, and the item is never held, active or served.
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

test("a YAML explicit key reads no way, a comment on it too: `? status # awaiting approval` is never read as active", () => {
  const commented = skill(`${CLEAN}? status # awaiting approval\n: pending\n`);
  assert.equal(frontMatter(commented), undefined);
  assert.equal(learnedStatus(commented), "retired", "never active: another reader holds it for an OK");
  assert.equal(frontKeys(commented), undefined);
  const explicit = skill(`${CLEAN}? hooks\n: [{ command: "curl example.invalid" }]\n`);
  assert.equal(learnedStatus(explicit), "retired");
  const result = checkProposal({ base: baseOf(), changes: [added("skills/weekly-summary/SKILL.md", explicit)] });
  assert.ok(result.problems.some((problem) => problem.detail === UNCLEAR_FRONT), JSON.stringify(result.problems));
  const indented = checkProposal({ base: baseOf(), changes: [added("skills/weekly-summary/SKILL.md", skill(`${CLEAN}  status: pending\n`))] });
  assert.ok(indented.problems.some((problem) => problem.detail === UNCLEAR_FRONT), JSON.stringify(indented.problems));
});

test("an explicit-key status is none the writers meet: never held (approve refuses), already retired (a retire adds no key), unclear (restore refuses)", () => {
  const asked = skill(`${CLEAN}? status\n: pending\n`);
  // learning-routes.ts: approve needs isHeld, a retire returns a retired item as it is, a restore refuses a front matter
  // that reads no way (UNCLEAR_FRONT): released and retiredLearned, which edit `status:` lines, never meet it.
  assert.equal(isHeld(asked), false);
  assert.equal(learnedStatus(asked), "retired");
  assert.equal(frontMatter(asked), undefined);
  assert.equal(learnedFront(asked), undefined);
});

test("a skill whose name and description are explicit keys is never served: the snapshot reads it retired, and a seed never lays it", async (t) => {
  const data = await scratch(t);
  await seedOf(data, "agent-1");
  const repo = join(agentFolderOf(data, "agent-1"), "learning");
  const files = { "skills/weekly-summary/SKILL.md": skill(CLEAN), "skills/asked/SKILL.md": skill("? name\n: asked\n? description\n: Asked for, explicitly.\n") };
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
    assert.deepEqual(Object.fromEntries(snapshot.skills.map(({ name, status }) => [name, status])), { asked: "retired", "weekly-summary": "active" });
    const read = await readSeed(folder.workspace, snapshot.main);
    assert.deepEqual(read.files.map(({ path }) => path).filter((path) => path.startsWith("skills/")), ["skills/weekly-summary/SKILL.md"]);
  } finally {
    await folder.end();
  }
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
  // Every name and description is quoted, plain text too.
  assert.match(servedSkill(skill(CLEAN)), /^---\nname: "weekly-summary"\ndescription: "Summarize the week\."\n---\n/);
  assert.deepEqual(frontOfServed(servedSkill(skill("name: weekly-summary\ndescription: \"Use when: the week ends\"\n"))), { name: "weekly-summary", description: "Use when: the week ends" });
});

test("a served name and description are always quoted: no spelling of a number, date or boolean is guessed at", async () => {
  const { parse } = await import("yaml");
  const { servedSkill } = await import("../dist/learn/skills.js");
  for (const word of ["08", "01e3", "0.", "+1", "1e+3", "0b101", "2026-1-1T10:00", "Yes", "NO", "+.5", "1:20:30"]) {
    const served = servedSkill(skill(`name: ${word}\ndescription: ${word}\n`));
    assert.ok(served.startsWith(`---\nname: ${JSON.stringify(word)}\ndescription: ${JSON.stringify(word)}\n---\n`), served);
    assert.deepEqual(parse(served.split("---\n")[1]), { name: word, description: word }, `${word}: ${served}`);
  }
});

test("a learned skill counts the bytes the run is given: its SKILL.md as served, a few bytes over its blob when its description is quoted (#1576)", async () => {
  const { seedFrom } = await import("../dist/learning.js");
  const { servedSkill } = await import("../dist/learn/skills.js");
  const text = skill("name: weekly-summary\ndescription: yes\n");
  const reference = "A table.\n";
  const seed = await seedFrom("c".repeat(40), async () => ({ ok: true, files: [{ path: "skills/weekly-summary/SKILL.md", text }, { path: "skills/weekly-summary/reference.md", text: reference }], refused: [], held: [] }));
  const served = servedSkill(text);
  assert.ok(served.includes('description: "yes"'), served);
  assert.ok(Buffer.byteLength(served) > Buffer.byteLength(text), "served, it is larger than its blob");
  assert.equal(seed.skills[0].bytes, Buffer.byteLength(served) + Buffer.byteLength(reference));
});

// A held secret a skill's double-quoted front matter spells with escapes (`\xNN`, `\uNNNN`) is the value YAML reads, and
// what servedSkill lays: the checks and the serving read the decoded value, so the skill is refused when it is
// proposed and never laid. An escape that does not decode cleanly (a code point past U+10FFFF, an escape YAML has
// not) leaves the front matter reading no way: retired, refused for that item alone, and never a throw.
const HELD = `not-a-secret-front-${process.pid}-held`;
const escaped = (value, form) => [...value].map((ch) => (form === "x" ? `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}` : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)).join("");
const spelled = (form) => skill(`name: weekly-summary\ndescription: "Sign in with ${escaped(HELD, form)}."\n`);

test("a held secret a skill's description spells in escapes is refused when proposed, by the checks and by what is never stored", async () => {
  const { unstorable } = await import("../dist/learn/check.js");
  for (const form of ["x", "u"]) {
    const text = spelled(form);
    assert.ok(!text.includes(HELD), "the stored spelling holds no plain value");
    const result = checkProposal({ base: baseOf(), changes: [added("skills/weekly-summary/SKILL.md", text)], refuseValues: [HELD], outcome: "completed" });
    assert.ok(result.problems.some((problem) => problem.rule === "secret_value"), `${form}: ${JSON.stringify(result.problems)}`);
    assert.ok(unstorable([added("skills/weekly-summary/SKILL.md", text)], [HELD]).some((problem) => problem.rule === "secret_value"), `${form}: unstorable reads it decoded`);
    assert.ok(!JSON.stringify(result.problems).includes(HELD), "no problem names the value");
  }
});

test("a seed skill whose description spells a held secret in escapes is never chosen or laid, and no laid file holds the value", async (t) => {
  const { chooseSkills, laySkills, secretsShown, seedFrom } = await import("../dist/learning.js");
  const { localWorkspace } = await import("../dist/workspace/index.js");
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const files = [{ path: "skills/weekly-summary/SKILL.md", text: spelled("x") }, { path: "skills/clean/SKILL.md", text: skill("name: clean\ndescription: Clean the data.\n") }];
  const seed = await seedFrom("c".repeat(40), async () => ({ ok: true, files, refused: [], held: [] }));
  const dir = await scratch(t);
  const work = localWorkspace(dir);
  const { taken, left } = await chooseSkills(work, seed, [], secretsShown([HELD]));
  assert.deepEqual(taken.map(({ name }) => name), ["clean"], JSON.stringify({ taken: taken.map(({ name }) => name), left }));
  await laySkills(work, taken, []);
  const all = (at) => readdirSync(at).flatMap((entry) => (statSync(join(at, entry)).isDirectory() ? all(join(at, entry)) : [join(at, entry)]));
  for (const file of all(dir)) assert.ok(!readFileSync(file, "utf8").includes(HELD), `${file} holds the value`);
});

test("an escape that does not decode cleanly leaves the front matter reading no way, never a throw: proposed beside a note, the skill alone is left out", async (t) => {
  const { proposeRun } = await import("../dist/propose.js");
  const { localWorkspace: _ } = await import("../dist/workspace/index.js");
  for (const bad of ["\\UFFFFFFFF", "\\q"]) {
    const text = skill(`name: weekly-summary\ndescription: "Past ${bad} the end"\n`);
    assert.equal(frontMatter(text), undefined, bad);
    assert.equal(learnedStatus(text), "retired", bad);
  }
  const data = await scratch(t);
  const { sha } = await seedOf(data, "agent-1");
  const note = "---\nname: Units\ndescription: Check units first\ntype: reference\n---\nCheck the units.\n";
  const answer = [`\`\`\`note units.md\n${note}\`\`\``, `\`\`\`\`skill weekly-summary\n${skill('name: weekly-summary\ndescription: "Past \\UFFFFFFFF the end"\n')}\`\`\`\``].join("\n\n");
  const folder = learningWorkspace({ mode: "local", data, agentId: "agent-1" });
  let result;
  try {
    result = await proposeRun({ folder: folder.workspace, runDir: await scratch(t), seed: sha, turn: { answer, asked: [] }, refuse: [], outcome: "completed" });
  } finally {
    await folder.end();
  }
  assert.equal(result.state, "proposed", JSON.stringify(result));
  assert.deepEqual([result.notes, result.skills], [1, 0], JSON.stringify(result));
  assert.ok((result.left ?? []).some((problem) => problem.path === "skills/weekly-summary/SKILL.md" && problem.detail === UNCLEAR_FRONT), JSON.stringify(result.left));
});
