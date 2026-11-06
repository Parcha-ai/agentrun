// The scratch directories' cleanup (support.mjs scratch, writableTree): it walks a tree to make it removable while a
// server that is still closing, or a fake box's command, removes parts of it. A directory gone mid-walk is already
// removed, never a failure of the test's after hook.
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { scratch, writableTree } from "./support.mjs";

test("the cleanup's walk takes a tree that another process removes under it: no ENOENT, every time", async (t) => {
  const dir = await scratch(t);
  for (let round = 0; round < 20; round++) {
    const root = join(dir, `round-${round}`);
    // As a fake box's spool leaves it: many directories, each with an inbox, removed one by one as the walk goes.
    for (let a = 0; a < 20; a++) for (let b = 0; b < 5; b++) await mkdir(join(root, `a${a}`, `b${b}`, "in"), { recursive: true });
    const remover = (async () => {
      for (let a = 19; a >= 0; a--) await rm(join(root, `a${a}`), { recursive: true, force: true });
    })();
    await Promise.all([writableTree(root), remover]);
  }
});

test("the walk still makes every directory it finds writable by its owner", async (t) => {
  const { chmod, stat } = await import("node:fs/promises");
  const dir = await scratch(t);
  await mkdir(join(dir, "a", "b"), { recursive: true });
  await chmod(join(dir, "a", "b"), 0o500);
  await chmod(join(dir, "a"), 0o500);
  await writableTree(dir);
  assert.equal((await stat(join(dir, "a"))).mode & 0o700, 0o700);
  assert.equal((await stat(join(dir, "a", "b"))).mode & 0o700, 0o700);
});
