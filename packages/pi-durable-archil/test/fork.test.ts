// Fork without Archil: a local "disk" whose claims track delegations. A fork copies a released, sealed run
// into a new run whose first open is generation 1; the source is only read; a half copy never stays behind.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fork, ForkError } from "../src/fork.ts";
import { StoreBehindSealError } from "../src/run.ts";
import { parseRunRecord, RUN_JSON } from "../src/status.ts";
import { lifecycleApp, LocalDisk, newCounters, openOn } from "./_lifecycle.ts";
import type { FakeClaim } from "./_run-support.ts";
import { ctx } from "./_run-support.ts";

const SRC = { disk: "dsk-local", region: "local", id: "fork-src" };

/** Path to sha256 of every file under `root` (symlinks by target). */
function digest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(relative(root, p), st.isSymbolicLink() ? `-> ${readlinkSync(p)}` : createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

async function sourceRun(disk: LocalDisk, prompts: string[]) {
  const counters = newCounters();
  const app = lifecycleApp(counters);
  for (const content of prompts) {
    const run = await openOn(disk, SRC, app);
    const root = await run.harness.root(ctx, { agent: app.agent });
    await (await root.submit({ type: "input", content }, ctx)).wait(ctx);
    await run.release();
  }
  return { counters, app, root: disk.path(`runs/${SRC.id}`) };
}

const forkOn = (disk: LocalDisk, id: string) => fork(SRC, id, { control: disk, mountRoot: disk.path("mnt"), acquire: async (o) => disk.acquire(o.ref) });

describe("fork", () => {
  it("copies a released run into a new run that opens at generation 1, leaving the source byte for byte", async () => {
    const disk = new LocalDisk("fork-copy");
    try {
      const { root, app } = await sourceRun(disk, ["hello"]);
      mkdirSync(join(root, "work", "notes"), { recursive: true });
      writeFileSync(join(root, "work", "notes", "a.txt"), "from the source\n");
      chmodSync(join(root, "work", "notes", "a.txt"), 0o640);
      symlinkSync("notes/a.txt", join(root, "work", "link"));
      writeFileSync(join(root, "tmp", "scratch"), "not copied");
      writeFileSync(join(root, "start.json"), JSON.stringify({ generation: 1, at: new Date().toISOString(), by: "s:1" }));
      const before = digest(root);
      const sealed = parseRunRecord(readFileSync(join(root, RUN_JSON), "utf8"));

      const result = await forkOn(disk, "fork-new");
      assert.equal(result.run, "fork-new");
      assert.equal(result.from, SRC.id);
      assert.equal(result.sealedSeq, sealed.sealedSeq);
      assert.equal(result.sourceGeneration, 1);
      assert.deepEqual(digest(root), before, "the source is untouched");
      assert.equal(disk.delegations.length, 0);
      assert.equal(disk.users.size, 0, "both token users removed");

      const copy = disk.path("runs/fork-new");
      const record = parseRunRecord(readFileSync(join(copy, RUN_JSON), "utf8"));
      assert.deepEqual(
        { status: record.status, generation: record.generation, sealedSeq: record.sealedSeq, holder: record.holder, detail: record.detail },
        { status: "paused", generation: 0, sealedSeq: sealed.sealedSeq, holder: null, detail: { forkedFrom: { run: SRC.id, generation: 1, sealedSeq: sealed.sealedSeq } } },
      );
      assert.equal(existsSync(join(copy, "owner.lock")), false);
      assert.equal(existsSync(join(copy, "tmp")), false);
      assert.equal(existsSync(join(copy, "start.json")), false, "the source's start mark would hold the fork in a start grace");
      assert.equal(readFileSync(join(copy, "work", "notes", "a.txt"), "utf8"), "from the source\n");
      assert.equal(lstatSync(join(copy, "work", "notes", "a.txt")).mode & 0o777, 0o640);
      assert.equal(readlinkSync(join(copy, "work", "link")), "notes/a.txt");
      assert.equal(readFileSync(join(copy, "store", "run.sqlite")).equals(readFileSync(join(root, "store", "run.sqlite"))), true);

      const opened = await openOn(disk, { ...SRC, id: "fork-new" }, app);
      assert.equal(opened.generation, 1);
      const page = await (await opened.harness.root(ctx)).entries({}, 100, undefined, ctx);
      assert.ok(page.items.some((e) => e.model?.some((m) => m.role === "user" && m.content === "hello")), "the fork has the source's transcript");
      await opened.release();
      assert.deepEqual(digest(root), before, "the fork's own run does not reach the source");
    } finally {
      disk.remove();
    }
  });

  it("refuses a source that is not released and sealed, one that is held, a target that exists, and the same id, touching nothing", async () => {
    const disk = new LocalDisk("fork-refuse");
    try {
      await assert.rejects(forkOn(disk, "x1"), (e: unknown) => e instanceof ForkError && e.code === "SOURCE_NOT_RELEASED");
      const { root, app } = await sourceRun(disk, ["hello"]);
      const record = JSON.parse(readFileSync(join(root, RUN_JSON), "utf8"));
      writeFileSync(join(root, RUN_JSON), JSON.stringify({ ...record, status: "running" }));
      await assert.rejects(forkOn(disk, "x2"), (e: unknown) => e instanceof ForkError && e.code === "SOURCE_NOT_RELEASED");
      writeFileSync(join(root, RUN_JSON), JSON.stringify({ ...record, sealedSeq: null }));
      await assert.rejects(forkOn(disk, "x3"), (e: unknown) => e instanceof ForkError && e.code === "SOURCE_NOT_RELEASED");
      writeFileSync(join(root, RUN_JSON), JSON.stringify(record));
      const live = await openOn(disk, SRC, app);
      writeFileSync(join(root, RUN_JSON), JSON.stringify(record));
      await assert.rejects(forkOn(disk, "x4"), (e: unknown) => e instanceof ForkError && e.code === "SOURCE_HELD");
      await live.release();
      mkdirSync(disk.path("runs/x5"), { recursive: true });
      await assert.rejects(forkOn(disk, "x5"), (e: unknown) => e instanceof ForkError && e.code === "TARGET_EXISTS");
      await assert.rejects(forkOn(disk, SRC.id), (e: unknown) => e instanceof ForkError && e.code === "INVALID_ARGUMENT");
      assert.deepEqual(readdirSync(disk.path("runs")).sort(), [SRC.id, "x5"]);
      assert.equal(disk.users.size, 0);
    } finally {
      disk.remove();
    }
  });

  it("a copy that fails deletes the new run's directory and releases both claims", { skip: process.getuid?.() === 0 }, async () => {
    const disk = new LocalDisk("fork-fail");
    try {
      const { root } = await sourceRun(disk, ["hello"]);
      writeFileSync(join(root, "work", "secret"), "x");
      chmodSync(join(root, "work", "secret"), 0o000);
      await assert.rejects(forkOn(disk, "fork-bad"), (e: unknown) => e instanceof ForkError && e.code === "COPY_FAILED");
      assert.equal(existsSync(disk.path("runs/fork-bad")), false);
      assert.equal(disk.delegations.length, 0);
      assert.equal(disk.users.size, 0);
      assert.deepEqual(disk.claims.map((c) => c.log.filter((l) => l === "release").length), [1, 1, 1], "source run, then source and target of the fork");
      chmodSync(join(root, "work", "secret"), 0o600);
    } finally {
      disk.remove();
    }
  });

  it("a fork that loses the new run's directory to another one leaves the other's copy and claim alone", async () => {
    const disk = new LocalDisk("fork-race");
    try {
      await sourceRun(disk, ["hello"]);
      const target = { ...SRC, id: "fork-race" };
      let winner: FakeClaim | undefined;
      const err = await fork(SRC, "fork-race", {
        control: disk,
        mountRoot: disk.path("mnt"),
        acquire: async (o) => {
          if (o.ref.id === target.id) {
            // Another fork passed the same checks, created the same directory and mounted it first; it is copying.
            winner = disk.acquire(target) as FakeClaim;
            writeFileSync(join(winner.root, "copied-by-the-other-fork"), "x");
          }
          return disk.acquire(o.ref);
        },
      }).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof ForkError && err.code === "TARGET_EXISTS", String(err));
      assert.equal(existsSync(disk.path("runs/fork-race/copied-by-the-other-fork")), true, "the other fork's copy is untouched");
      assert.deepEqual(disk.delegations.map((d) => d.path), ["runs/fork-race"], "and so is its claim");
      assert.equal(disk.users.size, 0, "this fork's token users are removed");
      await winner!.release();
    } finally {
      disk.remove();
    }
  });

  it("carries the source's seal, so a fork whose store lost a committed sequence is refused at its first open", async () => {
    const disk = new LocalDisk("fork-seal");
    try {
      const { root, app } = await sourceRun(disk, ["one"]);
      const older = disk.path("older-store");
      cpSync(join(root, "store"), older, { recursive: true });
      const counters2 = newCounters();
      const run = await openOn(disk, SRC, lifecycleApp(counters2));
      await (await (await run.harness.root(ctx, { agent: app.agent })).submit({ type: "input", content: "two" }, ctx)).wait(ctx);
      await run.release();
      await forkOn(disk, "fork-rewound");
      const copy = disk.path("runs/fork-rewound");
      rmSync(join(copy, "store"), { recursive: true });
      cpSync(older, join(copy, "store"), { recursive: true });
      await assert.rejects(openOn(disk, { ...SRC, id: "fork-rewound" }, app), (e: unknown) => e instanceof StoreBehindSealError);
      assert.equal(parseRunRecord(readFileSync(join(copy, RUN_JSON), "utf8")).status, "failed");
    } finally {
      disk.remove();
    }
  });
});
