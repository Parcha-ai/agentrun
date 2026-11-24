// A command a test waits on that printed its last line and never exited: the wait's failure (fixtures/started.mjs within)
// names each of its threads and where it sleeps, so a CI run that hits it says what held the command, not only that it
// was alive. Linux reads them from /proc; elsewhere there is nothing to list.
import assert from "node:assert/strict";
import { test } from "node:test";
import { started, within } from "./fixtures/started.mjs";

test("a command that never exits is reported with each of its threads, its main thread's wait and system call", { skip: process.platform !== "linux" && "reads /proc", timeout: 120_000 }, async (t) => {
  const { seen, closed } = started(t, new URL("./fixtures/stuck-after-print.mjs", import.meta.url).pathname, [], process.env);
  // The short wait under test starts once the fixture has printed (its next statement is the wait it never leaves), so a
  // slow start on a busy runner is not read as the stuck state.
  const printed = new Promise((resolve) => {
    const check = () => (seen.err.includes("refused: no such case\n") ? resolve() : seen.child.stderr.once("data", check));
    check();
  });
  await within(printed, 60_000, "the stuck command's line", seen);
  const failed = await within(closed, 3000, "the stuck command", seen).then(() => assert.fail("it exited"), (error) => error);
  assert.match(failed.message, /^the stuck command: not within 3 s\. Its stderr so far:\nrefused: no such case\n/);
  const main = /\n {2}thread \d+ MainThread S wchan (\S+) syscall (\S+)/.exec(failed.message);
  assert.ok(main, `its main thread is listed: ${failed.message}`);
  assert.match(failed.message, /\n {2}thread \d+ V8Worker /, "and the others");
  // Where it sleeps: a futex. A host that hides a thread's kernel function shows "0", or the error that refused the read.
  if (!/^(0|\(\w+\))$/.test(main[1])) assert.match(main[1], /^futex/);
  // Its system call, the futex (202 on x86-64, 98 on arm64), where the host lets an ancestor read it: ptrace scope 0 or
  // 1. Under scope 2 or 3 the read is refused, and the field says so.
  if (!main[2].startsWith("(")) assert.match(main[2], /^(202|98)$/);
  else assert.match(main[2], /^\(E[A-Z]+\)$/);
});
