// examples/kill-9: a coding agent whose process is SIGKILLed in the middle of a long bash command. A second process opens the
// same run: the files are intact, the cut command comes back `interrupted` and is never run again, the file tools stay in
// work/, and the agent goes on to the end. The example checks all of that itself and ends with an `ok:` line.
import { it } from "node:test";
import assert from "node:assert/strict";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("kill-9: the files are intact after kill -9, the cut command comes back interrupted and ran once, the agent finishes", { timeout: 120_000 }, async () => {
  const result = await runExample("kill-9");
  assertExampleOk(result, /^ok: after kill -9 the files were intact, the next open ended the cut command and it came back interrupted without a rerun, the agent finished in generation 2, and its file tools stayed in work\/$/m);
  assert.match(result.stdout, /^the long command is running: SIGKILL to the first process \(its command is not touched\)$/m);
  assert.match(result.stdout, /^the first process ended \(SIGKILL\); its command is still running: a bare kill -9 does not end it; a second process opens the same run$/m);
  assert.match(result.stdout, /^generation 2 opened the run in .*kill-9-run \(3 tool results before\)$/m);
  assert.match(result.stdout, /^ {2}bash \[error\]: .*Tool bash was interrupted and may have partially run$/m);
  assert.match(result.stdout, /^ {2}write \[error\]: .*outside the workspace/m);
});
