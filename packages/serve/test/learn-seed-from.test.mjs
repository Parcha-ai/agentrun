// A run's seed from the learning folder's read at a commit (the folder's script's read op, through the agent's learning
// Workspace): its index, its active notes and its active skills' files, grouped as the lay takes them, in the folder's
// order, newest first. A commit the folder cannot read is no seed. No git here: the reader is given.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import * as learning from "../dist/learning.js";
import { localWorkspace } from "../dist/workspace/index.js";

const { pinSeed, secretsShown, seedFrom, LEARNED_SKILLS_BUDGET } = learning;
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const note = (name) => `---\nname: ${name}\ndescription: About ${name}.\ntype: feedback\nstatus: active\n---\n${name} body.\n`;
const skill = (name, body = "Body.") => `---\nname: ${name}\ndescription: What ${name} is for.\n---\n${body}\n`;
const COMMIT = "c".repeat(40);
const FILES = [
  { path: "MEMORY.md", text: "- [Older](older.md): About older.\n- [Newer](newer.md): About newer.\n" },
  { path: "older.md", text: note("older") },
  { path: "newer.md", text: note("newer") },
  { path: "skills/check-units/SKILL.md", text: skill("check-units") },
  { path: "skills/check-units/reference/table.md", text: "cents = dollars x 100\n" },
  { path: "skills/keep-dates/SKILL.md", text: skill("keep-dates") },
];
/** Every entry at the commit's top, as the read gives it (`held`): a retired note's file among them. */
const HELD = ["MEMORY.md", "newer.md", "older.md", "retired.md", "skills"];
const ORDER = { notes: [{ file: "newer.md", order: 0 }, { file: "older.md", order: 3 }, { file: "retired.md", order: 1 }], skills: [{ name: "keep-dates", order: 0 }, { name: "check-units", order: 2 }] };

test("a seed from the folder's read at a commit: its index, its notes newest first, its skills newest first with their files", async () => {
  const asked = [];
  const seed = await seedFrom(COMMIT, async (commit) => (asked.push(commit), { ok: true, files: FILES, refused: [], held: HELD }), { order: ORDER });
  assert.deepEqual(asked, [COMMIT], "read once, at the commit asked");
  assert.equal(seed.sha, COMMIT);
  assert.equal(seed.index, FILES[0].text);
  assert.deepEqual(Object.keys(seed.notes).sort(), ["newer.md", "older.md"]);
  assert.deepEqual(seed.recent, ["newer.md", "older.md"]);
  assert.deepEqual(seed.files.sort(), ["MEMORY.md", "newer.md", "older.md", "retired.md", "skills"], "every entry at main's top as the read holds it, a retired note's name included, so the index never names it as given");
});

test("a seed's files are what the read holds, not its order: with no order, a pending or a retired note's line is left out of the index a run gets", async () => {
  const index = "- [Newer](newer.md): About newer.\n- [Asked](asked.md): Pending its owner.\n- [Retired](retired.md): Gone.\n";
  const seed = await seedFrom(COMMIT, async () => ({ ok: true, files: [{ path: "MEMORY.md", text: index }, { path: "newer.md", text: note("newer") }], refused: [], held: ["MEMORY.md", "asked.md", "newer.md", "retired.md"] }));
  assert.deepEqual(seed.files.sort(), ["MEMORY.md", "asked.md", "newer.md", "retired.md"]);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-seed-from-held-"));
  dirs.push(dir);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "work"));
  await pinSeed(dir, localWorkspace(join(dir, "work")), seed, { budget: 8000, read: true, shown: secretsShown([]), own: [] });
  assert.equal(readFileSync(join(dir, "work", ".learning", "MEMORY.md"), "utf8"), "- [Newer](newer.md): About newer.\n");
  assert.deepEqual(seed.skills.map(({ name, files }) => [name, Object.keys(files ?? {}).sort()]), [["keep-dates", ["SKILL.md"]], ["check-units", ["SKILL.md", "reference/table.md"]]]);
});

test("a skill over the learned skills' budget is held by its size alone; a path that is no note's or skill's is skipped", async () => {
  const big = "x".repeat(LEARNED_SKILLS_BUDGET + 1);
  const seed = await seedFrom(COMMIT, async () => ({ ok: true, files: [{ path: "skills/huge/SKILL.md", text: skill("huge", big) }, { path: "notes/deep.md", text: "?" }, { path: "skills/Bad Name/SKILL.md", text: "x" }], refused: [], held: [] }));
  assert.deepEqual(seed.skills.map(({ name, bytes, files }) => [name, bytes > LEARNED_SKILLS_BUDGET, files]), [["huge", true, undefined]]);
  assert.deepEqual(seed.skipped.sort(), ["notes/deep.md", "skills/Bad Name/SKILL.md"]);
});

test("a skill the folder refused (a tracked link in it) is left out, and said in one warn line of the run; the others lay", async () => {
  const warned = [];
  const seed = await seedFrom(COMMIT, async () => ({ ok: true, files: FILES, refused: [{ skill: "linked", why: "a link at skills/linked/ref.md" }], held: HELD }), { order: ORDER, warn: (line) => warned.push(line) });
  assert.deepEqual(seed.skills.map(({ name }) => name), ["keep-dates", "check-units"]);
  assert.deepEqual(warned, ["starts without the skill linked its agent learned: a link at skills/linked/ref.md"]);
});

test("no commit yet is an empty seed whose commit stays null, read at null; a commit the folder cannot read, or that is gone, is no seed and says why", async (t) => {
  const asked = [];
  const empty = await seedFrom(null, async (commit) => (asked.push(commit), { ok: true, files: [], refused: [], held: [] }));
  assert.deepEqual(asked, [null], "read at null, never at a stand-in");
  assert.deepEqual([empty.sha, empty.notes, empty.files, empty.index, empty.skills], [null, {}, [], undefined, []]);
  // Its pin says the run learns from an empty seed: null, read back as null.
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-seed-from-"));
  dirs.push(dir);
  (await import("node:fs")).mkdirSync(join(dir, "work"));
  const pin = await pinSeed(dir, localWorkspace(join(dir, "work")), empty, { budget: 8000, read: true, shown: secretsShown([]), own: [] });
  assert.equal(pin.seed, null);
  assert.equal((await learning.readPin(dir)).seed, null);
  await assert.rejects(seedFrom(COMMIT, async () => ({ ok: false, why: "unavailable" })), /unavailable/);
  await assert.rejects(seedFrom(COMMIT, async () => ({ ok: false, why: "gone" })), /gone/);
});

test("a seed read this way is laid in a run through its Workspace as before: the notes in .learning/, the skills in .agents/skills/", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-seed-from-"));
  dirs.push(dir);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "work"));
  const seed = await seedFrom(COMMIT, async () => ({ ok: true, files: FILES, refused: [], held: HELD }), { order: ORDER });
  const pin = await pinSeed(dir, localWorkspace(join(dir, "work")), seed, { budget: 8000, read: true, shown: secretsShown([]), own: [] });
  assert.equal(pin.seed, COMMIT);
  assert.deepEqual(readdirSync(join(dir, "work", ".learning")).sort(), ["MEMORY.md", "newer.md", "older.md"]);
  assert.deepEqual(readdirSync(join(dir, "work", ".agents", "skills")).sort(), ["check-units", "keep-dates"]);
  assert.equal(readFileSync(join(dir, "work", ".agents", "skills", "check-units", "reference", "table.md"), "utf8"), "cents = dollars x 100\n");
});
