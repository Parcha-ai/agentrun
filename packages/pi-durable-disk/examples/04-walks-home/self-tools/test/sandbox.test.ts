import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SANDBOX_ENV, SandboxRequired } from "../sandbox.ts";
import { checkInstance, makeInstances } from "../tasks.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outside = () => { const env = { ...process.env }; delete env[SANDBOX_ENV]; return env; };

test("drive.ts refuses to start outside the sandbox", () => {
  const p = spawnSync(process.execPath, [join(here, "..", "drive.ts"), "--instances", "/nonexistent", "--out", "/nonexistent"], { env: outside(), encoding: "utf8" });
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, new RegExp(SANDBOX_ENV));
});

test("a check that would run what the model wrote refuses outside the sandbox", () => {
  const before = process.env[SANDBOX_ENV];
  delete process.env[SANDBOX_ENV];
  try {
    const inst = makeInstances("train", 1).find((x) => x.template === "js-print")!;
    const dir = mkdtempSync(join(tmpdir(), "self-tools-"));
    // The script exists, so the check gets as far as running it; the guard stops it there (it is never run).
    writeFileSync(join(dir, String(inst.params.f)), "process.exit(9)\n");
    assert.throws(() => checkInstance(inst, { dir, answer: "" }), SandboxRequired);
    // A check that only reads files still works anywhere.
    assert.equal(typeof checkInstance(makeInstances("train", 1).find((x) => x.template === "create-line")!, { dir, answer: "" }), "string");
  } finally {
    if (before !== undefined) process.env[SANDBOX_ENV] = before;
  }
});
