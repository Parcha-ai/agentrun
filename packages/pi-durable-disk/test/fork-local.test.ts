// forkLocal: a sealed run directory of this machine copied into N new run directories. The source is only read; each copy
// opens as generation 1 of a run of its own and goes on without the others; a source that is not sealed is refused.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { forkLocal, ForkError } from "../src/fork.ts";
import { localRun } from "../src/local-run.ts";
import { openDurableRun } from "../src/run.ts";
import { parseRunRecord, RUN_JSON } from "../src/status.ts";
import { ctx, scratchRoot, scriptedHarness } from "./_run-support.ts";

const ref = (id: string) => ({ disk: "dsk-local", region: "local", id });

/** Path to sha256 of every file under `root` (symlinks by target), with modes. */
function digest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(relative(root, p), `${(st.mode & 0o7777).toString(8)} ${st.isSymbolicLink() ? `-> ${readlinkSync(p)}` : createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return out;
}

/** A run released at a checkpoint: one answered message, a file in work/, sealed. */
async function sealedSource(root: string, id = "src") {
  const scripted = scriptedHarness();
  const run = await openDurableRun(ref(id), { ...localRun(root), harness: { models: scripted.models, registry: scripted.registry } });
  const conversation = await run.harness.root(ctx, { agent: scripted.agent });
  await (await conversation.submit({ type: "input", content: "checkpoint" }, ctx)).wait(ctx);
  mkdirSync(join(run.claim.work, "notes"), { recursive: true });
  writeFileSync(join(run.claim.work, "notes", "a.txt"), "from the source\n");
  symlinkSync("notes/a.txt", join(run.claim.work, "link"));
  await run.setStatus("paused");
  await run.release();
  return scripted;
}

describe("forkLocal", () => {
  it("copies a sealed run into new run directories, leaving the source byte for byte, and each opens as generation 1 and goes on on its own", async () => {
    const dir = scratchRoot("fork-local");
    try {
      const source = join(dir.root, "src");
      const scripted = await sealedSource(source);
      const before = digest(source);
      const sealed = parseRunRecord(readFileSync(join(source, RUN_JSON), "utf8"));
      const targets = ["a", "b", "c"].map((id) => ({ id, root: join(dir.root, id) }));

      const results = await forkLocal(source, targets);
      assert.deepEqual(results.map((r) => r.run), ["a", "b", "c"]);
      assert.ok(results.every((r) => r.from === "src" && r.sealedSeq === sealed.sealedSeq && r.files > 0));
      assert.deepEqual(digest(source), before, "the source is unchanged, byte for byte");
      assert.equal(readFileSync(join(source, RUN_JSON), "utf8").includes('"forkedFrom"'), false);

      const record = parseRunRecord(readFileSync(join(dir.root, "a", RUN_JSON), "utf8"));
      assert.deepEqual([record.run, record.generation, record.sealedSeq, record.status], ["a", 0, sealed.sealedSeq, "paused"]);
      assert.equal(readFileSync(join(dir.root, "b", "work", "notes", "a.txt"), "utf8"), "from the source\n");
      assert.equal(readlinkSync(join(dir.root, "b", "work", "link")), "notes/a.txt");
      assert.equal(existsSync(join(dir.root, "a", "owner.lock")), false, "the source's lock is not copied");

      // Each fork opens as generation 1, keeps the checkpoint's conversation, and goes on without the others or the source.
      const answered: Record<string, number> = {};
      for (const target of targets) {
        const run = await openDurableRun(ref(target.id), { ...localRun(target.root), harness: { models: scripted.models, registry: scripted.registry } });
        assert.equal(run.generation, 1);
        const conversation = await run.harness.root(ctx, { agent: scripted.agent });
        const earlier = (await conversation.entries({}, 100, undefined, ctx)).items.length;
        await (await conversation.submit({ type: "input", content: `only ${target.id}` }, ctx)).wait(ctx);
        answered[target.id] = (await conversation.entries({}, 100, undefined, ctx)).items.length - earlier;
        writeFileSync(join(run.claim.work, "mine.txt"), target.id);
        await run.setStatus("done");
        await run.release();
      }
      assert.ok(Object.values(answered).every((n) => n >= 2), JSON.stringify(answered));
      assert.equal(existsSync(join(dir.root, "a", "work", "mine.txt")), true);
      assert.equal(existsSync(join(dir.root, "b", "work", "mine.txt")), true);
      assert.equal(readFileSync(join(dir.root, "a", "work", "mine.txt"), "utf8"), "a");
      assert.deepEqual(digest(source), before, "the forks' own work left the source alone");
    } finally {
      dir.remove();
    }
  });

  it("refuses a source that is not sealed (never released, running, or no run) with SOURCE_NOT_RELEASED, and creates nothing", async () => {
    const dir = scratchRoot("fork-local-refuse");
    try {
      const scripted = scriptedHarness();
      const running = join(dir.root, "running");
      const run = await openDurableRun(ref("running"), { ...localRun(running), harness: { models: scripted.models, registry: scripted.registry } });
      try {
        await assert.rejects(forkLocal(running, [{ id: "x", root: join(dir.root, "x") }]), (e: unknown) => e instanceof ForkError && e.code === "SOURCE_NOT_RELEASED");
      } finally {
        await run.release();
      }
      await assert.rejects(forkLocal(join(dir.root, "nothing"), [{ id: "x", root: join(dir.root, "x") }]), (e: unknown) => e instanceof ForkError && e.code === "SOURCE_NOT_RELEASED");
      assert.equal(existsSync(join(dir.root, "x")), false);
    } finally {
      dir.remove();
    }
  });

  it("refuses a target that exists, a target that is the source and a repeated target, before copying anything", async () => {
    const dir = scratchRoot("fork-local-targets");
    try {
      const source = join(dir.root, "src");
      await sealedSource(source);
      mkdirSync(join(dir.root, "taken"));
      const code = (e: unknown) => (e instanceof ForkError ? e.code : e);
      await assert.rejects(forkLocal(source, [{ id: "ok", root: join(dir.root, "ok") }, { id: "taken", root: join(dir.root, "taken") }]), (e) => code(e) === "TARGET_EXISTS");
      await assert.rejects(forkLocal(source, [{ id: "src", root: source }]), (e) => code(e) === "INVALID_ARGUMENT");
      await assert.rejects(forkLocal(source, [{ id: "d", root: join(dir.root, "d") }, { id: "d2", root: join(dir.root, "d") }]), (e) => code(e) === "INVALID_ARGUMENT");
      await assert.rejects(forkLocal(source, []), (e) => code(e) === "INVALID_ARGUMENT");
      assert.deepEqual(readdirSync(dir.root).sort(), ["src", "taken"], "no half copy and no temporary directory is left");
    } finally {
      dir.remove();
    }
  });
});
