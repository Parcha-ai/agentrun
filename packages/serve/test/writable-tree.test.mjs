// The scratch directories' cleanup (support.mjs scratch, writableTree): it walks a tree to make it removable while a
// server that is still closing, or a fake box's command, removes parts of it. A directory gone mid-walk is already
// removed, never a failure of the test's after hook.
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { scratch, writableTree } from "./support.mjs";

test("stress: the cleanup's walk takes a tree that another process removes under it: no ENOENT, every time", async (t) => {
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

/** The walk's calls, as node makes them, but `failing`'s call on `path` rejects with `code`, as when the directory went
 *  between the walk's lstat and that call. `calls` notes each failure it made. */
function failingAt(failing, path, code, calls) {
  const fs = { lstat, chmod, readdir };
  return {
    ...fs,
    [failing]: async (target, ...rest) => {
      if (target !== path) return fs[failing](target, ...rest);
      calls.push(`${failing} ${code}`);
      throw Object.assign(new Error(`${code}: ${failing} ${target}`), { code });
    },
  };
}

for (const failing of ["chmod", "readdir"]) {
  test(`a directory gone at the walk's ${failing} (ENOENT) is passed over, and the rest of the tree is still made writable`, async (t) => {
    const dir = await scratch(t);
    for (const name of ["gone", "kept"]) await mkdir(join(dir, name, "below"), { recursive: true });
    await chmod(join(dir, "kept", "below"), 0o500);
    const calls = [];
    await writableTree(dir, failingAt(failing, join(dir, "gone"), "ENOENT", calls));
    assert.deepEqual(calls, [`${failing} ENOENT`], "the guarded call was reached");
    assert.equal((await lstat(join(dir, "kept", "below"))).mode & 0o700, 0o700, "the walk went on past it");
  });

  test(`any other error at the walk's ${failing} still fails the cleanup`, async (t) => {
    const dir = await scratch(t);
    await mkdir(join(dir, "denied"));
    const calls = [];
    await assert.rejects(writableTree(dir, failingAt(failing, join(dir, "denied"), "EACCES", calls)), { code: "EACCES" });
    assert.deepEqual(calls, [`${failing} EACCES`]);
  });
}
