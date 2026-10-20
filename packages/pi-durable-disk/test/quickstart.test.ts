// examples/01-durable-chat/on-a-directory.mjs runs: a durable chat on a directory of this machine, killed after its third
// answer and resumed by a second process, every message answered once. (The README's Try it is examples/pick-up-a-run, whose
// test checks it verbatim.)
import { it } from "node:test";
import assert from "node:assert/strict";
import { assertExampleOk, runExample } from "./examples/_run-example.ts";

it("runs on a directory of this machine: killed after its third answer, resumed by a second process, every message answered once", { timeout: 120_000 }, async () => {
  const result = await runExample("quickstart", { entry: "01-durable-chat/on-a-directory.mjs" });
  assertExampleOk(result, /^ok: 6 messages answered once each, by generations 1 and 2, from the store in /m);
  assert.match(result.stdout, /^generation 1 answered message 3$/m);
  assert.match(result.stdout, /^generation 2 opened the run in .* \(\d answered before\)$/m);
});
