// A box that binds the run's work/ from this machine (Docker): read, write and edit
// run on this machine's work/ (bound-files.ts), never as a command in the box, and bash runs in the box. A command in
// the box can plant a link, a hard link or a swapped directory, so the file tools here take none: a link anywhere on the
// way is refused (one to the data root's token included), a file with a second hard link is refused, and a directory
// swapped for a link between the check and the write is refused. Where this host reaches directories by path (no
// /proc/self/fd), or the box binds nothing, all four run in the box.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { confineTestHooks as confineHooks } from "@parcha/pi-durable-disk/internals";
import { boundFiles } from "../dist/bound-files.js";
import { codingSource } from "../dist/coding-tools.js";
import { workspaceTestHooks, writesHeld } from "../dist/workspace.js";
import { scratch } from "./support.mjs";

// The file tools run here only where the confinement holds directory handles (Linux's /proc/self/fd); elsewhere (macOS)
// all four run in the box, which the last test checks on every host.
const HELD = writesHeld();
const NEEDS_HELD = { skip: !HELD && "needs held directory handles (/proc/self/fd)" };
const SANDBOX = { mode: "sandbox", box: "docker" };
const WORK = "/workspace";
const LINK = (path) => `${WORK}/${path}: refused: a link is on the way to it, or it is one, and read, write and edit follow no link in this run's work/ (bash, in the box, can)`;

test("a directory of work/ swapped for a link between the check and the use is refused, held: nothing is written or read through it", NEEDS_HELD, async (t) => {
  const work = realpathSync(await scratch(t));
  const elsewhere = realpathSync(await scratch(t));
  await mkdir(join(work, "sub"));
  await writeFile(join(work, "sub", "kept.txt"), "inside");
  await writeFile(join(elsewhere, "kept.txt"), "outside");
  const files = boundFiles(work);
  let fired = 0;
  confineHooks.afterCheck = async (canonical) => {
    if (!canonical.startsWith(join(work, "sub")) || fired++) return;
    await rename(join(work, "sub"), join(work, "sub.moved"));
    await symlink(elsewhere, join(work, "sub"));
  };
  t.after(() => void (confineHooks.afterCheck = undefined));
  const written = await files.writeFile(`${WORK}/sub/new.txt`, "planted", BACKGROUND_CONTEXT);
  assert.equal(fired, 1, "the swap happened");
  assert.deepEqual([written.ok, written.error?.code, written.error?.message], [false, "permission_denied", LINK("sub/new.txt")]);
  assert.deepEqual(await readdir(elsewhere), ["kept.txt"], "nothing was written through the link");
  // Put back, and swapped again on the read.
  await rm(join(work, "sub"));
  await rename(join(work, "sub.moved"), join(work, "sub"));
  fired = 0;
  const read = await files.readTextFile(`${WORK}/sub/kept.txt`, BACKGROUND_CONTEXT);
  assert.equal(fired, 1);
  assert.deepEqual([read.ok, read.error?.message], [false, LINK("sub/kept.txt")]);
  assert.equal(await readFile(join(elsewhere, "kept.txt"), "utf8"), "outside");
});

test("the environment names the box's paths: one outside work/ is refused, a missing file names its box path, and it runs no command and offers nothing else", NEEDS_HELD, async (t) => {
  const work = realpathSync(await scratch(t));
  await writeFile(join(work, "a.txt"), "a");
  const files = boundFiles(work);
  assert.deepEqual(await files.absolutePath("a.txt", BACKGROUND_CONTEXT), { ok: true, value: `${WORK}/a.txt` });
  assert.equal(files.cwd, WORK);
  const outside = await files.readTextFile("/etc/hostname", BACKGROUND_CONTEXT);
  // The confinement's typed refusal, naming no path: the tools name it by the path the call gave (asGivenRefusals).
  assert.deepEqual([outside.error.name, outside.error.reason, outside.error.message], ["PathOutsideWorkError", "outside_work", "outside the workspace"]);
  const missing = await files.readTextFile("missing.md", BACKGROUND_CONTEXT);
  assert.deepEqual([missing.error.code, missing.error.message], ["not_found", `ENOENT: no such file or directory, open '${WORK}/missing.md'`]);
  assert.deepEqual(await files.exists("missing.md", BACKGROUND_CONTEXT), { ok: true, value: false });
  assert.deepEqual(await files.exists("a.txt", BACKGROUND_CONTEXT), { ok: true, value: true });
  const info = await files.fileInfo("a.txt", BACKGROUND_CONTEXT);
  assert.deepEqual([info.value.path, info.value.name, info.value.kind, info.value.size], [`${WORK}/a.txt`, "a.txt", "file", 1]);
  assert.equal((await files.exec("id", undefined, BACKGROUND_CONTEXT)).error.code, "shell_unavailable");
  for (const name of ["listDir", "remove", "renameFile", "createDir", "createTempDir"]) assert.equal((await files[name](`${WORK}/a.txt`, undefined, BACKGROUND_CONTEXT)).error.code, "not_supported", name);
  for (const answer of [outside, missing, info]) assert.ok(!JSON.stringify(answer).includes(work), "never this machine's work/");
});

test("where the confinement reaches directories by path (the test hook), or the box binds nothing, all four tools run in the box; else only bash does", async (t) => {
  const work = realpathSync(await scratch(t));
  await writeFile(join(work, "a.txt"), "a");
  const box = (bound) => ({ hostWork: work, bound: async () => bound, env: async () => { throw new Error("in the box"); } });
  const call = async (source, tool, args) => {
    const registered = source.tools.find((each) => each.name === tool);
    return registered.execute(args, {}, BACKGROUND_CONTEXT).then(() => "here", (error) => (error.message === "in the box" ? "box" : error.message));
  };
  const where = async (source) => [
    await call(source, "read", { path: "a.txt" }),
    await call(source, "write", { path: "b.txt", content: "b" }),
    await call(source, "edit", { path: "b.txt", edits: [{ oldText: "b", newText: "c" }] }),
    await call(source, "bash", { command: "true" }),
  ];
  if (HELD) {
    assert.deepEqual(await where(codingSource(SANDBOX, box(true))), ["here", "here", "here", "box"]);
    assert.equal(await readFile(join(work, "b.txt"), "utf8"), "c");
  }
  assert.deepEqual(await where(codingSource(SANDBOX, box(false))), ["box", "box", "box", "box"], "a box that binds nothing");
  workspaceTestHooks.byPath = true;
  t.after(() => void (workspaceTestHooks.byPath = undefined));
  assert.deepEqual(await where(codingSource(SANDBOX, box(true))), ["box", "box", "box", "box"], "by path");
});
