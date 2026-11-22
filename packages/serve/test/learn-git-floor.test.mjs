// Learning's git floor is what the learning script's own calls need: 2.32 (GIT_CONFIG_GLOBAL). The script (the local
// learning store's, learn/store-local.ts) checks it before any op and, below it, refuses with the floor and the version
// it found. The server runs no git of its own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../dist/learn/learning.sh", import.meta.url));

/** A folder to run the script in, and a PATH whose `git` prints `version` for `git --version` and fails else. */
function folderWith(t, version) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "git-floor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "git"), `#!/bin/sh\n[ "$1" = --version ] && { echo "git version ${version}"; exit 0; }\nexit 1\n`);
  chmodSync(join(dir, "bin", "git"), 0o755);
  mkdirSync(join(dir, "learning"));
  return { cwd: join(dir, "learning"), PATH: `${join(dir, "bin")}:/usr/bin:/bin` };
}

test("the learning script runs on git 2.32 and later (what its own calls need), and refuses an older one saying why", (t) => {
  for (const [version, refused] of [["2.34.1", false], ["2.32.0", false], ["2.31.8", true]]) {
    const { cwd, PATH } = folderWith(t, version);
    const result = spawnSync("sh", [SCRIPT, "head"], { cwd, env: { PATH, LC_ALL: "C" }, encoding: "utf8", timeout: 30_000 });
    if (refused) {
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /learning needs git 2\.32 or later, and this machine has git version 2\.31\.8/);
    } else assert.doesNotMatch(result.stderr, /learning needs git/, `${version}: ${result.stderr}`);
  }
});
