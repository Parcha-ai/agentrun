// A run on a plain local directory (localRun): one machine, no Archil, no mount token.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { localRun } from "../src/local.ts";
import { openDurableRun, RunError } from "../src/run.ts";
import { parseRunRecord, RUN_JSON } from "../src/status.ts";
import { FencedError } from "../src/errors.ts";
import { ctx, scratchRoot, scriptedHarness } from "./_run-support.ts";

const ref = { disk: "dsk-local", region: "local", id: "run-1" };

describe("localRun", () => {
  it("opens a run on a local directory with no mount token, keeps its turns, and opens it again as the next generation", async () => {
    const dir = scratchRoot("local");
    const root = join(dir.root, "runs", "run-1"); // not there yet: the claim makes it
    try {
      const scripted = scriptedHarness();
      const run1 = await openDurableRun(ref, { ...localRun(root), harness: { models: scripted.models, registry: scripted.registry } });
      assert.equal(run1.claim.root, root);
      assert.equal(run1.claim.work, join(root, "work"));
      assert.ok(existsSync(join(root, RUN_JSON)), "run.json is written in the directory");
      const conversation = await run1.harness.root(ctx, { agent: scripted.agent });
      await conversation.configure({ instructions: "local" }, ctx);
      await run1.release();
      const sealed = parseRunRecord(readFileSync(join(root, RUN_JSON), "utf8"));
      assert.equal(sealed.generation, 1);
      assert.ok(typeof sealed.sealedSeq === "number" && sealed.sealedSeq > 0, "released and sealed");

      const run2 = await openDurableRun(ref, { ...localRun(root), harness: { models: scripted.models, registry: scripted.registry } });
      assert.equal(run2.generation, 2);
      await run2.release();
    } finally {
      dir.remove();
    }
  });

  it("says it is one machine's: a second open of the same directory while the first holds it is refused by the owner lock", async () => {
    const dir = scratchRoot("local-held");
    try {
      const scripted = scriptedHarness();
      const options = { ...localRun(dir.root), harness: { models: scripted.models, registry: scripted.registry } };
      const run = await openDurableRun(ref, options);
      try {
        await assert.rejects(openDurableRun(ref, options));
      } finally {
        await run.release();
      }
    } finally {
      dir.remove();
    }
  });

  it("its claim's barrier refuses once the claim is fenced, as a mount's does", async () => {
    const dir = scratchRoot("local-fence");
    try {
      const claim = await localRun(dir.root).acquire({ ref, token: "" });
      assert.deepEqual(await claim.barrier(), { ms: 0 });
      claim.markFenced(new Error("lost"));
      assert.equal(claim.fenced, true);
      await assert.rejects(claim.barrier(), (error: unknown) => error instanceof FencedError);
      assert.deepEqual(await claim.release(), { via: "none" });
    } finally {
      dir.remove();
    }
  });
});

describe("the mount token", () => {
  it("is required only to mount an Archil disk: with the default acquire and none, the open is refused before anything mounts", async () => {
    const scripted = scriptedHarness();
    await assert.rejects(
      openDurableRun(ref, { harness: { models: scripted.models, registry: scripted.registry } }),
      (error: unknown) => error instanceof RunError && error.code === "INVALID_ARGUMENT" && /mountToken/.test(error.message) && /localRun/.test(error.message),
    );
  });
});
