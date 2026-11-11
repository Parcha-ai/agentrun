// The confinement's last check where there is no /proc/self/fd (by path): the directory held is still the one at its
// path. The confinement's refusals through serve's own reads and writes are workspace-reads.test.mjs' and home.test.mjs'.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { namesHeld } from "../dist/confine.js";

test("by path, the walk's last check knows a directory's path from the directory held once the path was swapped, and back", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "serve-confine-held-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, "d");
  await mkdir(dir);
  const held = await open(dir, "r");
  t.after(() => held.close());
  assert.equal(await namesHeld(dir, held), true);
  await rename(dir, join(base, "d.held"));
  await symlink(join(base, "d.held"), dir); // a link to the directory held: the same inode, which realpath tells apart
  assert.equal(await namesHeld(dir, held), true, "a link to it names it; the walk's realpath check refuses the link");
  await rm(dir);
  await mkdir(dir);
  assert.equal(await namesHeld(dir, held), false, "another directory at the path");
  await rm(dir, { recursive: true });
  assert.equal(await namesHeld(dir, held), false, "nothing at the path");
});
