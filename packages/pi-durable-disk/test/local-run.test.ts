// A run on a plain local directory (localRun): one machine, no Archil, no mount token.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { localRun } from "../src/local-run.ts";
import { openDurableRun, RunError } from "../src/run.ts";
import { parseRunRecord, RUN_JSON } from "../src/status.ts";
import { FencedError } from "../src/errors.ts";
import { alive, ctx, killQuietly, scratchRoot, scriptedHarness, startCommand } from "./_run-support.ts";

const ref = { disk: "dsk-local", region: "local", id: "run-1" };
const LOCAL_COMMAND = fileURLToPath(new URL("./fixtures/local-command.ts", import.meta.url));

describe("localRun", () => {
  it("two local runs in one process: reopening one never kills a command of the other", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("local-two");
    const open = (id: string) => {
      const scripted = scriptedHarness();
      return openDurableRun({ disk: "dsk-local", region: "local", id }, { ...localRun(join(dir.root, id)), harness: { models: scripted.models, registry: scripted.registry } }).then((run) => ({ run, agent: scripted.agent }));
    };
    let [commandA, commandB] = [0, 0];
    try {
      const a = await open("a");
      commandA = await startCommand(a.run, a.agent);
      const b = await open("b");
      commandB = await startCommand(b.run, b.agent);
      await new Promise((resolve) => setTimeout(resolve, 400)); // several walks of both recorders while both commands run
      await b.run.release(); // ends b's command; a's goes on
      assert.deepEqual([alive(commandA), alive(commandB)], [true, false]);
      const b2 = await open("b"); // its commands step reaps what b recorded
      assert.ok(alive(commandA), "a's command outlived the reopening of b");
      await b2.run.release();
      await a.run.release();
    } finally {
      for (const pid of [commandA, commandB]) if (pid > 0) killQuietly(pid);
      dir.remove();
    }
  });

  it("ends the commands a SIGKILLed instance left running at the next open, before the Harness opens", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("local-commands");
    const root = join(dir.root, "run");
    const instance = spawn(process.execPath, [LOCAL_COMMAND, root], { stdio: ["ignore", "pipe", "inherit"] });
    let command = 0;
    try {
      const line = (await createInterface({ input: instance.stdout! })[Symbol.asyncIterator]().next()).value as string | undefined;
      command = Number(/^ready (\d+)$/.exec(line ?? "")?.[1] ?? 0);
      assert.ok(command > 0 && alive(command), `the agent's command runs: ${line}`);
      instance.kill("SIGKILL");
      await new Promise((resolve) => instance.once("close", resolve));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(alive(command), "the instance's SIGKILL does not reach its command, which leads a process group of its own");
      const scripted = scriptedHarness();
      const steps: [string, boolean][] = [];
      const run = await openDurableRun({ disk: "dsk-local", region: "local", id: "local-command" }, {
        ...localRun(root),
        harness: { models: scripted.models, registry: scripted.registry },
        onStep: (name) => void steps.push([name, alive(command)]),
      });
      const at = (name: string) => steps.findIndex(([step]) => step === name);
      assert.ok(at("commands") >= 0 && at("commands") < at("harness"), `the commands step comes before the Harness opens: ${JSON.stringify(steps)}`);
      assert.deepEqual(steps[at("commands")], ["commands", false], "the command is gone once the commands step ends");
      assert.equal(run.generation, 2);
      await run.release();
    } finally {
      instance.kill("SIGKILL");
      if (command > 0) killQuietly(command);
      dir.remove();
    }
  });

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
