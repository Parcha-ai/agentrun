// examples/fork-into-many: one run taken to a checkpoint and released (sealed), forked three ways with `forkLocal`; each fork
// opens as generation 1 with the checkpoint's conversation and goes on with its own instruction, and the source stays byte for byte.
import { it } from "node:test";
import assert from "node:assert/strict";
import { assertExampleOk, runExample } from "./_run-example.ts";

it("fork-into-many: three forks of a sealed run each continue on their own, and the source is unchanged", { timeout: 120_000 }, async () => {
  const result = await runExample("fork-into-many");
  assertExampleOk(result, /^ok: one sealed run forked three ways, each fork continued on its own from the checkpoint, and the source stayed byte for byte$/m);
  for (const audience of ["engineers", "customers", "auditors"]) {
    assert.match(result.stdout, new RegExp(`^generation 1 of note-for-${audience}: \\d+ entries inherited, \\d+ added; note.txt: \\[${audience}\\] Runs survive kill -9`, "m"));
  }
});
