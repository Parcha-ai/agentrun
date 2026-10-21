// The exit codes an instance ends with, and the ones its process supervisors never restart after: the same numbers wherever a
// module or an entry point names them (sysexits: 65 EX_DATAERR, 70 EX_SOFTWARE, 75 EX_TEMPFAIL; 76 held).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as lease from "../src/lease.ts";
import { EXIT_FENCED, EXIT_HELD, exitCodeFor } from "../src/errors.ts";
import { TERMINAL_EXITS } from "../src/hosts/local-host.ts";
import { EXIT_DATAERR, EXIT_SOFTWARE, RunError, StoreBehindSealError } from "../src/run.ts";
import { RunRecordError } from "../src/status.ts";

test("exit codes: 65 data error, 70 store head unreadable, 75 fenced, 76 held, the same through every name", () => {
  assert.deepEqual([EXIT_DATAERR, EXIT_SOFTWARE, EXIT_FENCED, EXIT_HELD], [65, 70, 75, 76]);
  assert.deepEqual([lease.EXIT_DATAERR, lease.EXIT_SOFTWARE, lease.EXIT_FENCED, lease.EXIT_HELD], [65, 70, 75, 76]);
  assert.deepEqual([...TERMINAL_EXITS], [65, 70, 75, 76]);
  assert.equal(exitCodeFor(new StoreBehindSealError("run.sqlite", 3, 2)), 65);
  assert.equal(exitCodeFor(new RunRecordError("holder is not an object or null")), 65);
  assert.equal(exitCodeFor(new RunError("STORE_HEAD_UNREADABLE", "pi's schema moved")), 70);
  assert.equal(exitCodeFor(new RunError("INVALID_ARGUMENT", "bad")), 1);
});
