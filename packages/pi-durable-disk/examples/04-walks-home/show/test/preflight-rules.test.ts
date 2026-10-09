import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The preflight is a script, but two of its rules are policy and must not drift: the approved disk and region, and that it never
// reads the admin token. They are asserted against its source so that loosening either is a failing test, not a quiet edit.
const src = readFileSync(fileURLToPath(new URL("../scripts/preflight.mjs", import.meta.url)), "utf8");

test("the only approved disk is the scratch disk in aws-us-east-1, and a different one is a failure that says to stop", () => {
  assert.match(src, /disk: "dsk-00000000000baf76", region: "aws-us-east-1"/);
  assert.match(src, /w\.disk === APPROVED\.disk && w\.region === APPROVED\.region/);
  assert.match(src, /stop and tell the lead/);
});

test("it checks the admin token file's mode and size but never reads its content", () => {
  assert.match(src, /\(file\.mode & 0o777\) === 0o600/);
  assert.match(src, /\(dir\.mode & 0o777\) === 0o700/);
  assert.ok(!/readFileSync\(st\.tokenFile/.test(src) && !/readFileSync\([^)]*token/i.test(src.replace(/readFileSync\(takeStatus/g, "")), "no read of the token file");
});
