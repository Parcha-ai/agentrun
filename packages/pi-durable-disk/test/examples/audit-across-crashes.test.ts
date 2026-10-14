// examples/audit-across-crashes: a run killed twice, and the account of each generation read from the store alone.
import { it } from "node:test";
import assert from "node:assert/strict";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("audit-across-crashes: two kills, three generations, and the account from the store says which calls were cut and who settled them", { timeout: 120_000 }, async () => {
  const run = await runExample("audit-across-crashes");
  assertExampleOk(run, /^ok: the store alone shows three generations, two calls cut mid-flight, each settled as interrupted by the next generation and never run again$/m);
  const lines = run.stdout.trimEnd().split("\n");
  // The account is what the store held at each resume: the cut call is named by the generation that was killed, and
  // settled, as interrupted, by the next one.
  const account = lines.slice(lines.indexOf("generation 1:"));
  assert.deepEqual(
    account.filter((line) => /^(generation \d+:|  killed with|  lookup-\d settled as interrupted)/.test(line)),
    ["generation 1:", "  killed with lookup-2 in flight", "generation 2:", "  lookup-2 settled as interrupted, never run again", "  killed with lookup-4 in flight", "generation 3:", "  lookup-4 settled as interrupted, never run again"],
  );
});
