// examples/seed-a-run: the seed runs once, on the new run, and the second open keeps what the run changed. The example's
// README shows main.ts, and this test keeps the copy identical.
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("seed-a-run: the seed runs once, the store and the workspace start with it, and the next open keeps the run's change", { timeout: 120_000 }, async () => {
  const run = await runExample("seed-a-run");
  assertExampleOk(run, /^ok: the seed ran once, on the new run: the store and the workspace started with it, and the next open kept what the run had changed$/m);
  assert.match(run.stdout, /^generation 1 opened a new run: seeded 1 time$/m);
  assert.match(run.stdout, /^generation 2 opened the same run: seeded 1 time in all$/m);
  assert.match(run.stdout, /^ {2}the store holds the seeded profile: signed in$/m);
});

it("seed-a-run's README shows main.ts verbatim", () => {
  const readme = readFileSync(new URL("../../examples/seed-a-run/README.md", import.meta.url), "utf8");
  const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.deepEqual(blocks, [readFileSync(new URL("../../examples/seed-a-run/main.ts", import.meta.url), "utf8")]);
});
