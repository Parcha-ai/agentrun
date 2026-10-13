// A launcher step that fails says why in one line, and carries its whole output for the launcher's log: an uncaught error
// prints its message first and ends with "}" and "Node.js v..", so the last lines alone say nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runStep } from "../run-step.ts";

test("runStep: the output on success; on failure the error line, the exit, and the whole output", () => {
  assert.equal(runStep(process.execPath, ["-e", "console.log('fine')"]).trim(), "fine");
  const script = "console.log('cleaning golden-gate'); const e = new Error('the run is held by another client'); e.detail = { client: 'c1', inode: 42 }; throw e;";
  let failed: (Error & { output?: string }) | undefined;
  try {
    runStep(process.execPath, ["-e", script]);
  } catch (e) {
    failed = e as Error & { output?: string };
  }
  assert.ok(failed, "a failing step throws");
  assert.match(failed.message, /exited 1: Error: the run is held by another client/);
  assert.match(failed.output ?? "", /cleaning golden-gate/);
  assert.match(failed.output ?? "", /client: 'c1'/);
  assert.match(failed.output ?? "", /Node\.js v/);
});
