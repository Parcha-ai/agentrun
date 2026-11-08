// Learning's git floor is what its own calls need: 2.32 (GIT_CONFIG_GLOBAL). A host with an older git keeps no learning
// folder and says so, with the floor and its own version.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { learningBlocker } from "../dist/learning.js";

/** A PATH holding only a `git` that prints `version` for `git --version`. */
function fakeGit(t, version) {
  const dir = mkdtempSync(join(tmpdir(), "git-floor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "git"), `#!/bin/sh\necho "git version ${version}"\n`);
  chmodSync(join(dir, "git"), 0o755);
  return { PATH: dir };
}

test("learning runs on git 2.32 and later (what its own calls need), and a host below it keeps no learning folder and says why", async (t) => {
  assert.equal(await learningBlocker(fakeGit(t, "2.34.1")), undefined, "2.34, as a stock serverless image has");
  assert.equal(await learningBlocker(fakeGit(t, "2.32.0")), undefined, "the floor itself");
  assert.equal(await learningBlocker(fakeGit(t, "2.31.8")), "learning needs git 2.32 or later, and this host has git version 2.31.8");
});
