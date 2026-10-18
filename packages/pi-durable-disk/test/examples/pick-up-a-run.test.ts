// examples/pick-up-a-run: three processes pick up one run in turn, the last still knows the first question, and the run's
// record, read from outside, says done at generation 3. The README's Try it is this file, verbatim.
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("pick-up-a-run: each of three processes opens the next generation, and the last answer quotes the first question", { timeout: 120_000 }, async () => {
  const run = await runExample("pick-up-a-run");
  assertExampleOk(run, /^ok: three processes, one run: each picked up where the last released it, the last still knew the first question, and the run reads done at generation 3 \(/m);
  const opened = [...run.stdout.matchAll(/^generation (\d+) opened the run \((\d+) answered before\)$/gm)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(opened, ["1:0", "2:1", "3:2"]);
  assert.match(run.stdout, /^ {2}Answer 3, by generation 3\. You first asked: "Where does your transcript live\?"$/m);
});

it("the README's Try it carries the example file verbatim, and its first shell block is the install line the stranger test runs", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const at = readme.indexOf("## Try it: no disk, no key\n");
  assert.ok(at >= 0, 'the README has "Try it: no disk, no key"');
  const section = readme.slice(at, readme.indexOf("\n## ", at + 1));
  assert.equal(/```ts\n([\s\S]*?)```/.exec(section)?.[1], readFileSync(new URL("../../examples/pick-up-a-run/main.ts", import.meta.url), "utf8"));
  assert.match(/```sh\n([\s\S]*?)```/.exec(section)?.[1] ?? "", /^npm install @parcha\/pi-durable-disk@beta @earendil-works\/pi-durable @earendil-works\/pi-ai @earendil-works\/chord\n$/);
});
