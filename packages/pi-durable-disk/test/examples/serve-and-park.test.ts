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
  const expected = [
    "generation 1 serves <url>",
    "submitted order-1: submission <id> is placed",
    "model request (generation 1)",
    "generation 1 parked until <time>, released, exiting",
    "no process holds the run for <n> ms, until <time>",
    "generation 2 serves <url>",
    "model request (generation 2)",
    'submitted order-1 again: submission <id> is done, answered "recovered, answered once" by generation 2',
  ];
  // The parent prints what it read from an HTTP response and what a child printed (a separate stdout callback), so those
  // two streams are not ordered against each other: every line is there once, and each stream is in its own order.
  assert.deepEqual([...progress].sort(), [...expected].sort());
  const before = (first: string, second: string) => assert.ok(progress.indexOf(first) < progress.indexOf(second), `${first} comes before ${second}`);
  before(expected[0]!, expected[2]!); // generation 1: serves, asks the model, parks
  before(expected[2]!, expected[3]!);
  before(expected[1]!, expected[4]!); // the supervisor: submits, waits for the wake, submits again
  before(expected[4]!, expected[7]!);
  before(expected[4]!, expected[5]!); // generation 2 starts after the wait, serves, asks the model
  before(expected[5]!, expected[6]!);
  const ids = [...run.stdout.matchAll(/submission (\d+) is/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], "the duplicate is the first submission");
});
