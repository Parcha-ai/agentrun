// Mode 2: the run's files the server writes and reads, through an ArchilWorkspace over the fake disk
// (fixtures/archil-fake.mjs), the same calls Mode 1 makes through a LocalWorkspace: uploads into inputs/, the files'
// list and a ranged read, a revision's skills and their read back, the learned notes and skills, the first message's
// files, the browser's evidence, monid's long answers, and pdf_pages. Each lands under the run's folder's keys on the
// disk, and nothing is written on this machine for the run.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLIP, monidText } from "../dist/monid.js";
import { pdfPages, imageLoader } from "../dist/pdf-pages.js";
import { firstMessage } from "../dist/run-manifest.js";
import { listFiles, sendFile } from "../dist/run-files.js";
import { layLearned, layPinnedSkills, secretsShown } from "../dist/learning.js";
import { promptOf, skillsOf } from "../dist/skills.js";
import { evidenceIn } from "../dist/tools.js";
import { Uploads } from "../dist/uploads.js";
import { archilWorkspace, layOwnSkills, runKey } from "../dist/workspace/index.js";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";

const ROOT = runKey("acme", "run-1");
const text = (bytes) => Buffer.from(bytes).toString("utf8");

function fresh() {
  const disk = new FakeArchilDisk();
  return { disk, work: archilWorkspace(disk, ROOT) };
}

/** The disk's keys under the run's folder, relative to it. */
const keysOf = (disk) => [...disk.files.keys()].filter((key) => key.startsWith(`${ROOT}/`)).map((key) => key.slice(ROOT.length + 1)).sort();

async function scratch(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-archil-writers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("uploads land in inputs/ on the disk, a taken name suffixed, and the first message names them", async (t) => {
  const dir = await scratch(t);
  const uploads = new Uploads(join(dir, "files"));
  const send = async (path, body) => (await (await uploads.take(new URLSearchParams({ path }), "text/plain", [Buffer.from(body)])).commit()).file;
  const { disk, work } = fresh();
  await uploads.copyInto(work, [await send("notes.txt", "one"), await send("notes.txt", "two"), await send("docs/a.md", "# A")]);
  assert.deepEqual(keysOf(disk), ["inputs/docs/a.md", "inputs/notes-2.txt", "inputs/notes.txt"]);
  assert.equal(text(await work.read("inputs/notes-2.txt")), "two");
  const said = await firstMessage("Read them.", work);
  assert.equal(said, 'Read them.\n\nFiles for this run: "inputs/docs/a.md" (3 B), "inputs/notes-2.txt" (3 B), "inputs/notes.txt" (3 B).');
  assert.deepEqual(await readdir(dir), ["files"], "nothing of the run's on this machine");
});

/** A response that keeps what is sent to it: its head and its bytes. */
function kept() {
  const res = new EventEmitter();
  Object.assign(res, {
    destroyed: false, head: undefined, chunks: [],
    writeHead(status, headers) { res.head = { status, headers }; return res; },
    write(chunk) { res.chunks.push(Buffer.from(chunk)); return true; },
    end() { res.ended = true; },
    destroy() { res.destroyed = true; },
  });
  return res;
}

test("the run's files list from the disk with their times, and a file is served whole in ranged reads", async () => {
  const { work } = fresh();
  await work.write("report.md", "# Report\n");
  await work.write("out/data.csv", "a,b\n");
  await work.write(".agents/skills/x/SKILL.md", "hidden");
  const { files, deep } = await listFiles(work, 2000);
  assert.deepEqual([files.map((f) => [f.path, f.size_bytes]), deep], [[["out/data.csv", 4], ["report.md", 9]], false]);
  // Each file's time is the disk's own for it, as stat reads it.
  for (const file of files) assert.equal(Date.parse(file.modified_at), Math.trunc((await work.stat(file.path)).mtimeMs), file.path);
  const res = kept();
  await sendFile({ method: "GET" }, res, new URL("files/report.md", "https://agentrun.invalid/"), work, "report.md", "a tool");
  assert.deepEqual([res.head.status, res.head.headers["content-length"], res.ended], [200, 9, true]);
  assert.equal(Buffer.concat(res.chunks).toString("utf8"), "# Report\n");
});

test("a revision's skills are laid on the disk and read back for the prompt", async () => {
  const { disk, work } = fresh();
  await layOwnSkills(work, { "cite/SKILL.md": "---\nname: cite\ndescription: Cite.\n---\nCite sources.\n", "cite/ref.md": "Primary.\n" });
  assert.deepEqual(keysOf(disk), [".agents/skills/cite/SKILL.md", ".agents/skills/cite/ref.md"]);
  assert.deepEqual(await skillsOf(["cite/SKILL.md", "cite/ref.md"], work), [{ name: "cite", files: { "SKILL.md": "---\nname: cite\ndescription: Cite.\n---\nCite sources.\n", "ref.md": "Primary.\n" } }]);
  assert.match(await promptOf("Answer.", ["cite/SKILL.md"], work), /<skill name="cite">/);
});

test("the learned notes and the pinned learned skills are laid on the disk, fresh", async () => {
  const { disk, work } = fresh();
  await work.write(".learning/stale.md", "an earlier lay");
  const note = "---\nname: Units\ndescription: Check units.\ntype: feedback\nstatus: active\n---\nConvert first.\n";
  await layLearned(work, { sha: "a".repeat(40), index: "- [Units](units.md): Check units.\n", notes: { "units.md": note }, files: ["MEMORY.md", "units.md"], skipped: [] }, secretsShown([]));
  assert.deepEqual(keysOf(disk).filter((key) => key.startsWith(".learning/")), [".learning/MEMORY.md", ".learning/units.md"]);
  const skill = "---\nname: check-units\ndescription: Units.\n---\nBody.\n";
  await layPinnedSkills(work, { seed: "a".repeat(40), skills: ["check-units/SKILL.md"] }, async () => [{ name: "check-units", bytes: skill.length, files: { "SKILL.md": skill, "extra.md": "not pinned" } }]);
  assert.deepEqual(keysOf(disk).filter((key) => key.startsWith(".agents/")), [".agents/skills/check-units/SKILL.md"]);
});

test("the browser's evidence and monid's long answer are filed on the disk; a later sink numbers on", async () => {
  const { disk, work } = fresh();
  const read = (n) => ({ tool: "browser_read", facts: { n }, body: `page ${n}` });
  assert.deepEqual(await evidenceIn(work).file("run", read(1)), { path: "evidence/0001-browser_read.md", bodyLine: 3 });
  assert.deepEqual(await evidenceIn(work).file("run", read(2)), { path: "evidence/0002-browser_read.md", bodyLine: 3 });
  const said = await monidText({ runId: "r1", output: "x".repeat(CLIP + 10) }, work, "run");
  assert.ok(said.endsWith("the whole answer is in the run's files at evidence/monid/r1.json]"), said.slice(-120));
  assert.deepEqual(keysOf(disk).filter((key) => key.startsWith("evidence/")), ["evidence/0001-browser_read.md", "evidence/0002-browser_read.md", "evidence/monid/r1.json"]);
});

test("pdf_pages reads an image from the disk and writes its page back there; a decision node loads it", async () => {
  const { disk, work } = fresh();
  // A 1x1 PNG.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await work.write("scan.png", png);
  const drawn = await pdfPages({ path: "scan.png" }, { work });
  assert.equal(drawn.pages.length, 1);
  assert.ok(keysOf(disk).includes(drawn.pages[0].image), `${drawn.pages[0].image} on the disk`);
  const loaded = await imageLoader(work)(drawn.pages[0].image);
  assert.deepEqual([Buffer.from(loaded.bytes).equals(png), loaded.mime], [true, "image/png"]);
});
