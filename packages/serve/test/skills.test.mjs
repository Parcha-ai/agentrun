// A revision's skills on a harness that loads skills itself (claude-agent's Skill tool): each skill's files read from the
// run's workspace and grouped by skill, then split by the adapter's own check. A skill the adapter takes is loaded by the
// model on its own and is not in the system prompt; one it would refuse (no front matter, a front matter naming another
// skill or no description, a name or a file path it does not take) stays inlined there, as on every other harness. A set
// the adapter takes skill by skill but refuses as a whole (its size cap) is inlined whole.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { skillProblems } from "@parcha/agentrun-harness-claude";
import { ON_DEMAND, promptOf, READS_AT_ONCE, readsFiles, skillsOf, splitSkills, systemOf } from "../dist/skills.js";
import { localWorkspace } from "../dist/workspace/index.js";

const CANARY = `not-a-secret-canary-${process.pid}`;

/** A SKILL.md with front matter naming `name`, described. */
const md = (name, body = "Body.", description = "What it does.") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

/** A run's work/ holding `files` (paths under `.agents/skills/` to text), removed after the test: its folder (`dir`) and
 *  the run's Workspace on it (`work`), which the skills are read through. */
async function workWith(t, files) {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-serve-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "work");
  await mkdir(dir);
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, ".agents", "skills", path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return { root, dir, work: localWorkspace(dir) };
}

/** `workspace` with its reads counted: the most in flight at once (`peak`). A batch's reads all start before any ends
 *  (each is asked at once, and none answers before the next is asked), so the peak is the batch's size, with no wait. */
function counted(workspace) {
  const reads = { open: 0, peak: 0 };
  const wrapped = new Proxy(workspace, {
    get(target, name) {
      const value = target[name];
      if (name !== "read") return typeof value === "function" ? value.bind(target) : value;
      return async (...args) => {
        reads.peak = Math.max(reads.peak, ++reads.open);
        try {
          return await value.apply(target, args);
        } finally {
          reads.open -= 1;
        }
      };
    },
  });
  return { reads, workspace: wrapped };
}

test("skills are grouped by name from the revision's files: a skill's nested files go with it, a file goes to the nearest skill above it, and a file under no skill is no skill's", async (t) => {
  const files = {
    "cite/SKILL.md": md("cite"),
    "cite/reference/sources.md": "Primary sources first.\n",
    "cite/reference/deep/notes.md": "Deep notes.\n",
    "team/SKILL.md": md("team"),
    "team/notes.md": "Team notes.\n",
    "team/review/SKILL.md": md("review"),
    "team/review/checklist.md": "Check twice.\n",
    "loose/readme.md": "No skill here.\n",
  };
  const { work } = await workWith(t, { ...files, "cite/scratch.md": "Written by the run, not the revision.\n" });
  assert.deepEqual(await skillsOf(Object.keys(files), work), [
    { name: "cite", files: { "SKILL.md": md("cite"), "reference/deep/notes.md": "Deep notes.\n", "reference/sources.md": "Primary sources first.\n" } },
    { name: "team", files: { "SKILL.md": md("team"), "notes.md": "Team notes.\n" } },
    { name: "team/review", files: { "SKILL.md": md("review"), "checklist.md": "Check twice.\n" } },
  ], "by name, sorted; only the revision's files, never one the run wrote beside them");
  assert.deepEqual(await skillsOf([], work), []);
});

test("a skill's file is read through no link: a reference file linked out of work/ is refused, and none of its text is read", async (t) => {
  const { root, dir, work } = await workWith(t, { "cite/SKILL.md": md("cite") });
  const outside = join(root, "server-own.txt");
  await writeFile(outside, CANARY);
  await mkdir(join(dir, ".agents", "skills", "cite", "reference"), { recursive: true });
  await symlink(outside, join(dir, ".agents", "skills", "cite", "reference", "sources.md"));
  await assert.rejects(skillsOf(["cite/SKILL.md", "cite/reference/sources.md"], work), (error) => !String(error?.message).includes(CANARY));
});

test("a skill's file named __proto__ is kept as its own file in a plain object, and the adapter takes it", async (t) => {
  const files = { "cite/SKILL.md": md("cite"), "cite/__proto__": "Not a prototype.\n" };
  const { work } = await workWith(t, files);
  const [cite] = await skillsOf(Object.keys(files), work);
  assert.deepEqual(Object.keys(cite.files), ["SKILL.md", "__proto__"]);
  assert.equal(Object.getOwnPropertyDescriptor(cite.files, "__proto__")?.value, "Not a prototype.\n");
  assert.equal(Object.getPrototypeOf(cite.files), Object.prototype, "a plain object, as the adapter reads it");
  assert.deepEqual(splitSkills([cite], skillProblems).native, [cite]);
});

test("files are read at most READS_AT_ONCE at a time, and a skill with more files than that gets all of them, in order", async (t) => {
  const refs = Array.from({ length: READS_AT_ONCE * 2 + 5 }, (_, i) => `ref/f-${String(i).padStart(2, "0")}.md`);
  const files = { "cite/SKILL.md": md("cite"), ...Object.fromEntries(refs.map((ref) => [`cite/${ref}`, `Text of ${ref}.\n`])) };
  const names = Array.from({ length: READS_AT_ONCE + 3 }, (_, i) => `s-${String(i).padStart(2, "0")}`);
  const { work: plain } = await workWith(t, { ...files, ...Object.fromEntries(names.map((name) => [`${name}/SKILL.md`, md(name)])) });
  const { reads, workspace: work } = counted(plain);
  const [cite] = await skillsOf(Object.keys(files), work);
  assert.deepEqual(Object.keys(cite.files), ["SKILL.md", ...refs]);
  for (const ref of refs) assert.equal(cite.files[ref], `Text of ${ref}.\n`);
  assert.ok(reads.peak > 1 && reads.peak <= READS_AT_ONCE, `skillsOf had ${reads.peak} reads of the run's Workspace in flight at once`);
  reads.peak = 0;
  const prompt = await promptOf("Do it.", names.map((name) => `${name}/SKILL.md`), work);
  assert.deepEqual([...prompt.matchAll(/<skill name="([^"]+)">/g)].map((m) => m[1]), names);
  assert.ok(reads.peak > 1 && reads.peak <= READS_AT_ONCE, `promptOf had ${reads.peak} reads of the run's Workspace in flight at once`);
});

test("each skill is judged on its own by the adapter's check: one it takes goes native, one it would refuse stays inlined", () => {
  const good = { name: "cite", files: { "SKILL.md": md("cite"), "reference/sources.md": "Primary sources first.\n" } };
  const quoted = { name: "quoted", files: { "SKILL.md": `---\nname: "quoted"\ndescription: Quoted.\n---\nBody.\n` } };
  const refused = {
    plain: { name: "plain", files: { "SKILL.md": "# Plain\n" } },
    misnamed: { name: "misnamed", files: { "SKILL.md": md("other") } },
    undescribed: { name: "undescribed", files: { "SKILL.md": "---\nname: undescribed\n---\nBody.\n" } },
    upper: { name: "Cite", files: { "SKILL.md": md("Cite") } },
    nested: { name: "team/review", files: { "SKILL.md": md("team/review") } },
    spaced: { name: "spaced", files: { "SKILL.md": md("spaced"), "my notes.md": "Notes.\n" } },
    deep: { name: "deep", files: { "SKILL.md": md("deep"), "a/b/c/d/e/f.md": "Too deep.\n" } },
  };
  for (const [why, skill] of Object.entries(refused)) assert.notDeepEqual(skillProblems([skill]), [], `the adapter refuses ${why}`);
  const all = [refused.plain, good, refused.misnamed, refused.undescribed, quoted, refused.upper, refused.nested, refused.spaced, refused.deep];
  const { native, inlined } = splitSkills(all, skillProblems);
  assert.deepEqual(native, [good, quoted], "the skills the adapter takes, in order, with all their files");
  assert.deepEqual(inlined, [refused.plain, refused.misnamed, refused.undescribed, refused.upper, refused.nested, refused.spaced, refused.deep], "the rest, in order");
  assert.deepEqual(splitSkills([], skillProblems), { native: [], inlined: [] });
});

test("skills the adapter takes one by one but refuses as a set (more than its size cap) are all inlined", () => {
  const big = (name) => ({ name, files: { "SKILL.md": md(name), "data.txt": "x".repeat(600 * 1024) } });
  const good = { name: "cite", files: { "SKILL.md": md("cite") } };
  const plain = { name: "plain", files: { "SKILL.md": "# Plain\n" } };
  for (const skill of [big("a-big"), big("b-big"), good]) assert.deepEqual(skillProblems([skill]), [], `${skill.name} alone is taken`);
  assert.notDeepEqual(skillProblems([big("a-big"), big("b-big"), good]), [], "the set is not");
  const all = [big("a-big"), good, plain, big("b-big")];
  assert.deepEqual(splitSkills(all, skillProblems), { native: [], inlined: all });
});

test("the system prompt: with the adapter's check, the skills it takes leave the prompt and come back native, the rest stay inlined; with none, every SKILL.md is inlined as promptOf has it", async (t) => {
  const files = {
    "cite/SKILL.md": md("cite", `${CANARY} cite every source.`),
    "cite/reference/sources.md": "Primary sources first.\n",
    "legacy/SKILL.md": "# Legacy\nThe old way.\n",
  };
  const { work } = await workWith(t, files);
  const paths = Object.keys(files);
  const inlinedAll = await systemOf("Answer.", paths, work);
  assert.deepEqual(inlinedAll, { system: await promptOf("Answer.", paths, work), native: [] }, "no check: as every other harness has it");
  assert.match(inlinedAll.system, /<skill name="cite">/);
  assert.match(inlinedAll.system, /<skill name="legacy">/);

  const split = await systemOf("Answer.", paths, work, skillProblems);
  assert.deepEqual(split.native, [{ name: "cite", files: { "SKILL.md": files["cite/SKILL.md"], "reference/sources.md": "Primary sources first.\n" } }]);
  assert.ok(split.system.startsWith("Answer.\n\n"), split.system);
  assert.doesNotMatch(split.system, /<skill name="cite">/, "cite is the Skill tool's, not the prompt's");
  assert.ok(!split.system.includes(CANARY), "none of cite's text is in the prompt");
  assert.match(split.system, /<skill name="legacy">\n# Legacy\nThe old way.\n<\/skill>/, "legacy, which the adapter refuses, stays inlined");

  const { work: nativeOnly } = await workWith(t, { "cite/SKILL.md": md("cite") });
  assert.deepEqual(await systemOf("Answer.", ["cite/SKILL.md"], nativeOnly, skillProblems), { system: "Answer.", native: [{ name: "cite", files: { "SKILL.md": md("cite") } }] }, "every skill native: the instructions alone");
  assert.deepEqual(await systemOf("  Answer.\n", [], nativeOnly, skillProblems), { system: "Answer.", native: [] }, "no skills: the instructions alone");
});

test("on demand: a run that reads its files is told each skill's name, what it is for and its SKILL.md's path, never its text; one that cannot read gets each SKILL.md whole", async (t) => {
  const files = {
    "cite/SKILL.md": md("cite", `${CANARY} cite every source.`, "Cite each source by its title."),
    "cite/reference/sources.md": "Primary sources first.\n",
    "legacy/SKILL.md": "# Legacy way\nThe old way.\n",
  };
  const { work } = await workWith(t, files);
  const paths = Object.keys(files);
  const listed = await promptOf("Answer.", paths, work, { onDemand: true });
  assert.equal(listed, `Answer.\n\n${ON_DEMAND}\n\n- cite: Cite each source by its title. (.agents/skills/cite/SKILL.md)\n- legacy: Legacy way (.agents/skills/legacy/SKILL.md)`);
  assert.ok(!listed.includes(CANARY), "no skill's text is in the prompt");
  assert.doesNotMatch(listed, /<skill name=/);
  // A run that cannot read its files: every SKILL.md whole, as before.
  assert.match(await promptOf("Answer.", paths, work), /<skill name="cite">\n---\nname: cite/);
  // systemOf with no harness check is promptOf's; with claude-agent's check, its Skill tool's as before, on demand or not.
  assert.deepEqual(await systemOf("Answer.", paths, work, undefined, { onDemand: true }), { system: listed, native: [] });
  assert.deepEqual(await systemOf("Answer.", paths, work, skillProblems, { onDemand: true }), await systemOf("Answer.", paths, work, skillProblems));
  assert.equal(await promptOf("Answer.", [], work, { onDemand: true }), "Answer.", "no skills: the instructions alone");
});

test("a run reads its files when it has the read or the bash tool", () => {
  assert.equal(readsFiles(["read"]), true);
  assert.equal(readsFiles(["web_fetch", "bash"]), true);
  assert.equal(readsFiles(["web_fetch", "write"]), false);
  assert.equal(readsFiles([]), false);
});

test("on demand: a skill's description is read whole as YAML folds it: a plain one that wraps onto indented lines, and one written entirely on the next indented line", async (t) => {
  const files = {
    "wrapped/SKILL.md": "---\nname: wrapped\ndescription: Find refund policies\n  and shipping policies\n---\nThe body.\n",
    "below/SKILL.md": "---\nname: below\ndescription:\n  Answer a question\n  about a store's returns\n---\nThe body.\n",
    "folded/SKILL.md": "---\nname: folded\ndescription: >\n  Folded words\n  on two lines\n---\nThe body.\n",
  };
  const { work } = await workWith(t, files);
  const listed = await promptOf("Answer.", Object.keys(files), work, { onDemand: true });
  assert.match(listed, /- wrapped: Find refund policies and shipping policies \(/, listed);
  assert.match(listed, /- below: Answer a question about a store's returns \(/, listed);
  assert.match(listed, /- folded: Folded words on two lines \(/, listed);
});

test("on demand: an indented comment after a plain name or description is no part of it", async (t) => {
  const files = { "cite/SKILL.md": "---\nname: cite\n  # Citation helper\ndescription: Cite each source\n  # a note to self\n  by its title\n---\nThe body.\n" };
  const { work } = await workWith(t, files);
  const listed = await promptOf("Answer.", Object.keys(files), work, { onDemand: true });
  assert.match(listed, /- cite: Cite each source by its title \(\.agents\/skills\/cite\/SKILL\.md\)/, listed);
});
