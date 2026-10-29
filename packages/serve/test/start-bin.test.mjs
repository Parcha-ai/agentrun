// startBin, the helper serve's tests start the bin with in a process of their own: a bin that exits before it starts is
// said at once, with its exit code and what it wrote, not waited out until the helper's bound.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startBin } from "./support.mjs";

test("a bin that exits before it starts is said within 5 s, with its exit code and its stderr", { timeout: 10_000 }, async (t) => {
  const from = Date.now();
  await assert.rejects(startBin(t, ["--no-such-flag"]), (error) => {
    assert.match(error.message, /^the server exited \(2\) before it started: /, "its exit code");
    assert.match(error.message, /stderr: (?!\(none\))\S/, "what it wrote to stderr");
    return true;
  });
  assert.ok(Date.now() - from < 5_000, `said after ${Date.now() - from} ms`);
});
