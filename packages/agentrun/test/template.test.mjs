// `agentrun template validate DIR`: the server's own package validator, run on a folder on this machine. A valid package
// prints what it holds and exits 0; a malformed one, or no folder at all, prints each problem and exits 1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const REVIEW = new URL("../../serve/templates/code-review/", import.meta.url).pathname;
const validate = (dir) => spawnSync(process.execPath, [BIN, "template", "validate", dir], { encoding: "utf8" });

test("template validate checks a package folder as the server does", (t) => {
  const ok = validate(REVIEW);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { valid: true, name: "code-review", version: "0.1.0", skills: ["review"], evals: ["clean-refactor", "injection", "null-name", "off-by-one", "re-review", "repo-rule"] });

  const dir = join(mkdtempSync(join(tmpdir(), "agentrun-template-")), "code-review");
  t.after(() => rmSync(join(dir, ".."), { recursive: true, force: true }));
  cpSync(REVIEW, dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), readFileSync(join(dir, "agent.md"), "utf8").replace("version: 0.1.0", "version: 1.0").replace("effort: low", "effort: lots"));
  const bad = validate(dir);
  assert.equal(bad.status, 1, bad.stdout);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /is not a valid package:\n- agent\.md: version is 1, a number.*\n- agent\.md: effort is one of/);

  const gone = validate(join(dir, "nope"));
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /nope is not a valid package:\n- it is not a folder/);
});
