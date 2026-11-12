// A CLI run's process starts under no_new_privs (adapters.ts' noNewPrivsPrefix, the runner's cli-run-spec.ts): the
// prefix it starts under, and a refusal, never an unconfined start, where setpriv is not usable.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { confineOf, noNewPrivsPrefix } from "../dist/adapters.js";

test("the prefix is setpriv --no-new-privs --, and a child's command goes after it unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-new-privs-"));
  try {
    const setpriv = join(dir, "setpriv");
    writeFileSync(setpriv, "#!/bin/sh\n", { mode: 0o755 });
    const prefix = noNewPrivsPrefix({ noNewPrivs: true, setprivPath: setpriv });
    assert.deepEqual(prefix, [setpriv, "--no-new-privs", "--"]);
    assert.deepEqual(confineOf(prefix)({ command: "claude", args: ["-p", "hi"] }), { command: setpriv, args: ["--no-new-privs", "--", "claude", "-p", "hi"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a setpriv that is missing, or not executable, refuses the run with SETPRIV_UNAVAILABLE", () => {
  const dir = mkdtempSync(join(tmpdir(), "no-new-privs-"));
  try {
    const plain = join(dir, "setpriv");
    writeFileSync(plain, "not a program\n", { mode: 0o644 });
    for (const setprivPath of [join(dir, "missing"), plain, dir]) {
      assert.throws(() => noNewPrivsPrefix({ noNewPrivs: true, setprivPath }), (error) => error.code === "SETPRIV_UNAVAILABLE" && error.message.includes(setprivPath));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no_new_privs off (macOS's default) there is no prefix, and confineOf confines nothing", () => {
  assert.deepEqual(noNewPrivsPrefix({ noNewPrivs: false, setprivPath: "/nowhere/setpriv" }), []);
  assert.equal(confineOf([]), undefined);
});
