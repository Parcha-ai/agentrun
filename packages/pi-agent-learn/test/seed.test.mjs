import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CAPS, LearnError, readSeed, renderSection, seedLearning } from "../dist/index.js";
import { agentRepo, ask, commitMain, plantSymlink, done, learnCalls, learning, learningFiles, openRun, scratch, sectionOf } from "./support.mjs";

const L1 = learning("L-00000000000a", "Company registries match the legal name without Inc or LLC; search both forms.", { uses: 2 });
const L2 = learning("L-00000000000b", "The state registry rate-limits at 1 request a second.", { type: "fact" });
const OLD = learning("L-00000000000c", "Superseded advice.", { status: "superseded" });

test("seedLearning records the sha in the run's store, copies the active learnings as regular files, and the model's request carries the section", async () => {
  const root = await scratch();
  const { repo, main } = await agentRepo(root, learningFiles([L1, L2, OLD]));
  const sections = [];
  const run = await openRun(path.join(root, "runs", "r1", "run.sqlite"), { steps: [
    (c) => { sections.push(sectionOf(c)); return learnCalls([{ type: "used", text: "It found the company.", id: L1.id }]); },
    (c) => { sections.push(sectionOf(c)); return done(); },
  ] });
  try {
    const work = path.join(root, "runs", "r1", "work");
    const seeded = await seedLearning({ repo, target: run.harness, into: work });
    assert.equal(seeded.sha, main);
    assert.equal(seeded.recorded, true);
    assert.deepEqual(seeded.omitted, []);
    assert.deepEqual(seeded.skipped, []);
    assert.deepEqual(await readSeed(run.harness), { sha: main, index: seeded.index, omitted: [], workflows: [], copied: true }, "learn.seed holds { sha, index }");
    assert.deepEqual(seeded.files, [`.agent/learnings/${L1.id}.md`, `.agent/learnings/${L2.id}.md`]);
    assert.deepEqual((await readdir(path.join(work, ".agent", "learnings"))).sort(), [`${L1.id}.md`, `${L2.id}.md`], "only active learnings are copied");
    for (const l of [L1, L2]) {
      const file = path.join(work, ".agent", "learnings", `${l.id}.md`);
      assert.equal(await readFile(file, "utf8"), await repo.read(`learnings/${l.id}.md`, main), "bytes as stored");
      const stat = await lstat(file);
      assert.ok(stat.isFile());
      assert.equal(stat.mode & 0o111, 0, "never executable");
    }
    assert.equal((await ask(run.harness)).status, "done");
    assert.equal(sections.length, 2);
    assert.equal(sections[0], seeded.section, "the model received the section seedLearning rendered");
    assert.equal(sections[1], sections[0], "byte-stable across the requests of one run");
    assert.match(sections[0], new RegExp(`your repo at ${main.slice(0, 12)}`));
    assert.match(sections[0], new RegExp(`- ${L1.id} lesson: Company registries .* \\(used 2\\)\\n- ${L2.id} fact: The state registry`));
    assert.doesNotMatch(sections[0], /Superseded advice/);
  } finally {
    await run.close();
  }
});

test("two runs seeded from one sha get byte-identical sections; a run seeded after main moved gets the new lesson", async () => {
  const root = await scratch();
  const { repo, main } = await agentRepo(root, learningFiles([L1]));
  const seenBy = async (name, ref) => {
    let section;
    const run = await openRun(path.join(root, "runs", name, "run.sqlite"), { steps: [(c) => { section = sectionOf(c); return done(); }] });
    try {
      const seeded = await seedLearning({ repo, ref, target: run.harness });
      await ask(run.harness);
      return { section, seeded };
    } finally {
      await run.close();
    }
  };
  const a = await seenBy("a");
  const later = await commitMain(repo, learningFiles([L2]));
  const b = await seenBy("b", main);
  const c = await seenBy("c");
  assert.equal(b.seeded.sha, main);
  assert.equal(b.section, a.section, "the same commit gives the same bytes");
  assert.equal(c.seeded.sha, later);
  assert.notEqual(c.section, a.section);
  assert.match(c.section, /rate-limits/);
  assert.doesNotMatch(a.section, /rate-limits/);
});

test("a run is seeded once: seeding again after main moved keeps the recorded sha and section", async () => {
  const root = await scratch();
  const { repo, main } = await agentRepo(root, learningFiles([L1]));
  const run = await openRun(path.join(root, "run.sqlite"));
  try {
    const work = path.join(root, "work");
    const first = await seedLearning({ repo, target: run.harness, into: work });
    await commitMain(repo, learningFiles([L2]));
    const again = await seedLearning({ repo, target: run.harness, into: work, workflows: [{ name: "kyb", status: "trial" }] });
    assert.equal(again.recorded, false);
    assert.equal(again.sha, main);
    assert.equal(again.section, first.section);
    assert.deepEqual(await readSeed(run.harness), { sha: main, index: first.index, omitted: [], workflows: [], copied: true });
    assert.deepEqual(again.files, first.files, "the copies already there with the same bytes are kept");
  } finally {
    await run.close();
  }
});

test("over-cap learnings are not loaded through seedLearning either, and the model is told how many", async () => {
  const root = await scratch();
  const many = Array.from({ length: 30 }, (_, i) => learning(`L-${(i + 1).toString(16).padStart(12, "0")}`, `Lesson ${i + 1}: ${"pace registry lookups and keep to the legal name ".repeat(3)}`, { uses: 30 - i }));
  const { repo } = await agentRepo(root, learningFiles(many));
  let section;
  const run = await openRun(path.join(root, "run.sqlite"), { steps: [(c) => { section = sectionOf(c); return done(); }] });
  try {
    const seeded = await seedLearning({ repo, target: run.harness, into: path.join(root, "work") });
    await ask(run.harness);
    assert.ok(seeded.omitted.length > 0);
    assert.equal(section, seeded.section);
    assert.ok(Buffer.byteLength(section, "utf8") <= CAPS.section);
    assert.match(section, new RegExp(`${seeded.omitted.length} more learnings did not fit in this section \\(4096 bytes\\) and were not loaded here\\. Every learning is in \\.agent/learnings/\\.`));
    assert.equal(seeded.files.length, 30, "every active learning is in the run's directory to read");
    for (const id of seeded.omitted) assert.doesNotMatch(section, new RegExp(id));
  } finally {
    await run.close();
  }
});

test("a learning file that does not parse, is misnamed, is a symlink or is over the cap is skipped and named; the rest load", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root, {
    ...learningFiles([L1]),
    "learnings/L-0000000000ff.md": "not a learning\n",
    "learnings/L-0000000000ee.md": learningFiles([L2])[`learnings/${L2.id}.md`],
    "learnings/notes.md": "# notes\n",
    "learnings/L-0000000000dd.md": `${"x".repeat(CAPS.learning + 1)}\n`,
  });
  const linked = plantSymlink(path.join(root, "remote.git"), "learnings/L-0000000000cc.md", "../agent.json");
  const run = await openRun(path.join(root, "run.sqlite"));
  try {
    const seeded = await seedLearning({ repo, ref: linked, target: run.harness });
    assert.deepEqual(seeded.index.map((line) => line.slice(2, 16)), [L1.id]);
    assert.deepEqual(seeded.skipped.map((s) => s.path).sort(), ["learnings/L-0000000000cc.md", "learnings/L-0000000000dd.md", "learnings/L-0000000000ee.md", "learnings/L-0000000000ff.md", "learnings/notes.md"]);
    assert.equal(seeded.skipped.find((s) => s.path.endsWith("cc.md")).reason, "a symlink");
    assert.match(seeded.skipped.find((s) => s.path.endsWith("ee.md")).reason, /its id is L-00000000000b/);
    assert.match(seeded.skipped.find((s) => s.path.endsWith("dd.md")).reason, /over the 4096 byte cap/);
    assert.deepEqual(seeded.files, [], "nothing is copied without into");
  } finally {
    await run.close();
  }
});

test("seedLearning refuses a missing ref, and a symlinked or occupied .agent/learnings in the run's directory", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root, learningFiles([L1]));
  const run = await openRun(path.join(root, "run.sqlite"));
  try {
    await assert.rejects(seedLearning({ repo, ref: "nope", target: run.harness }), (e) => e instanceof LearnError && e.code === "missing");
    assert.equal(await readSeed(run.harness), undefined, "nothing recorded");
    const work = path.join(root, "work");
    await mkdir(path.join(root, "elsewhere"), { recursive: true });
    await mkdir(work, { recursive: true });
    await symlink(path.join(root, "elsewhere"), path.join(work, ".agent"));
    await assert.rejects(seedLearning({ repo, target: run.harness, into: work }), { code: "invalid" });
    assert.deepEqual(await readdir(path.join(root, "elsewhere")), [], "nothing was written through the link");
    const work2 = path.join(root, "work2");
    await mkdir(path.join(work2, ".agent", "learnings"), { recursive: true });
    await writeFile(path.join(work2, ".agent", "learnings", `${L1.id}.md`), "planted\n");
    await assert.rejects(seedLearning({ repo, target: run.harness, into: work2 }), { code: "invalid" });
    await assert.rejects(seedLearning({ repo, target: run.harness, into: "relative/dir" }), { code: "invalid" });
  } finally {
    await run.close();
  }
});

test("renderSection of the recorded seed is the section the extension shows", async () => {
  const root = await scratch();
  const { repo } = await agentRepo(root, learningFiles([L1, L2]));
  const run = await openRun(path.join(root, "run.sqlite"));
  try {
    const seeded = await seedLearning({ repo, target: run.harness });
    assert.equal(renderSection(await readSeed(run.harness)), seeded.section);
  } finally {
    await run.close();
  }
});
