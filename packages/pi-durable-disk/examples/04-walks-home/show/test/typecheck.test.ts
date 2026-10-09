import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The show has its own tsconfig (it includes the page, the scripts' types and every test). A check run from the package above it does not
// cover it, which let an unresolved type reach a PR. This runs the show's own check, so `node --test` fails when it does not pass.
const show = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the show type-checks under its own tsconfig", { timeout: 240_000 }, (t) => {
  let tsc: string;
  try {
    tsc = createRequire(join(show, "package.json")).resolve("typescript/bin/tsc");
  } catch {
    return t.skip("typescript is not installed in the show (npm ci in show/ installs it)");
  }
  const run = spawnSync(process.execPath, [tsc, "--noEmit", "-p", join(show, "tsconfig.json")], { cwd: show, encoding: "utf8" });
  assert.equal(run.status, 0, `tsc reported:\n${(run.stdout + run.stderr).split("\n").slice(0, 15).join("\n")}`);
});
