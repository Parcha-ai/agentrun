// examples/serve-and-park: the run parks on a long retry, a restart at its wakeAt finishes it, and a repeated requestId is
// answered, not run again.
import { it } from "node:test";
import assert from "node:assert/strict";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("serve-and-park: parks on a long retry with its wake written, wakes into generation 2, and answers a duplicate requestId from the first submission", { timeout: 120_000 }, async () => {
  const run = await runExample("serve-and-park");
  assertExampleOk(run, /^ok: an idle run holds no process: it parked on a long retry, a restart at its wakeAt finished it, and a repeated requestId was answered, not run again$/m);
  const progress = run.stdout
    .split("\n")
    .map((line) => line.replace(/http:\/\/127\.0\.0\.1:\d+/, "<url>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>").replace(/for \d+ ms/, "for <n> ms").replace(/submission \d+/g, "submission <id>"))
    .filter((line) => /^(generation|submitted|model request|no process)/.test(line));
  assert.deepEqual(progress, [
    "generation 1 serves <url>",
    "submitted order-1: submission <id> is placed",
    "model request (generation 1)",
    "generation 1 parked until <time>, released, exiting",
    "no process holds the run for <n> ms, until <time>",
    "generation 2 serves <url>",
    "model request (generation 2)",
    'submitted order-1 again: submission <id> is done, answered "recovered, answered once" by generation 2',
  ]);
  const ids = [...run.stdout.matchAll(/submission (\d+) is/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], "the duplicate is the first submission");
});
