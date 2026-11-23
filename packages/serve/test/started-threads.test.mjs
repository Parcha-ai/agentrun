// A command a test waits on that printed its last line and never exited: the wait's failure (fixtures/started.mjs within)
// names each of its threads and where it sleeps, so a CI run that hits it says what held the command, not only that it
// was alive. Linux reads them from /proc; elsewhere there is nothing to list.
import assert from "node:assert/strict";
import { test } from "node:test";
import { started, within } from "./fixtures/started.mjs";

test("a command that never exits is reported with each of its threads, its main thread's wait and system call", { skip: process.platform !== "linux" && "reads /proc", timeout: 60_000 }, async (t) => {
  const { seen, closed } = started(t, new URL("./fixtures/stuck-after-print.mjs", import.meta.url).pathname, [], process.env);
  const failed = await within(closed, 3000, "the stuck command", seen).then(() => assert.fail("it exited"), (error) => error);
  assert.match(failed.message, /^the stuck command: not within 3 s\. Its stderr so far:\nrefused: no such case\n/);
  // Its main thread, asleep in the futex it waits on (system call 202 on x86-64, 98 on arm64), and the others listed.
  assert.match(failed.message, /\n {2}thread (\d+) MainThread S wchan futex\w* syscall (202|98) /);
  assert.match(failed.message, /\n {2}thread \d+ V8Worker /);
});
