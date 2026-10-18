// A seed and a supervisor's start grace: while a new run seeds, the instance keeps the supervisor's start mark
// (runs/<id>/start.json, which a supervisor writes before it starts the instance) fresh, so a seed that outlives the grace
// is still `starting` and is not revoked. Only a generation-1 mark from a supervisor is touched, only its `at`, and only while
// the seed runs; a seeder that dies stops, and the grace runs out as before. The supervisor's tick here is ensureRunning over
// a control API that reads the run's own files.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Delegation } from "disk";
import { openDurableRun, type RunSeed } from "../src/run.ts";
import { ensureRunning, type HostDriver, type HostHandle, type SupervisorControl } from "../src/supervise.ts";
import { fakeClaim, localClaimDir, localRef, scratchRoot, scriptedHarness } from "./_run-support.ts";

const CHILD = fileURLToPath(new URL("./fixtures/seed-child.ts", import.meta.url));
const LEASE = { heartbeatMs: 100, expiryMs: 5_000, marginMs: 1_000, checkMs: 100 };
const GRACE_MS = 400;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Mark = { generation: number; at: string; by: string | null; failures: number; lastExit: string | null };
const readMark = (root: string): Mark => JSON.parse(readFileSync(join(root, "start.json"), "utf8")) as Mark;
const writeMark = (root: string, mark: Mark) => writeFileSync(join(root, "start.json"), JSON.stringify(mark));

/** A supervisor's view of a run in `root`: its files over "S3", one held delegation (the seeder's), revokes recorded. */
function supervisorOver(root: string, id: string) {
  const revoked: unknown[] = [];
  const stopped: HostHandle[] = [];
  const control: SupervisorControl = {
    async getObject(key) {
      const name = key.slice(`runs/${id}/`.length);
      if (!existsSync(join(root, name))) throw Object.assign(new Error("NoSuchKey"), { status: 404, code: "NoSuchKey" });
      return new TextEncoder().encode(readFileSync(join(root, name), "utf8"));
    },
    async headObject() {
      return { size: 0 };
    },
    async putObject() {},
    async addUser() {
      return { identifier: "id-1", token: "tok-1" };
    },
    async removeUser() {},
    async listDelegations(): Promise<Delegation[]> {
      return revoked.length ? [] : [{ clientId: "c-seeder", inodeId: 7, path: `runs/${id}`, isPending: false, isOrphaned: false }];
    },
    async revokeDelegation(d) {
      revoked.push(d);
    },
  };
  const host: HostDriver = {
    async start() {
      return { driver: "fake" };
    },
    async status() {
      return "running";
    },
    async stop(handle) {
      stopped.push(handle);
    },
  };
  const tick = () => ensureRunning({ disk: "dsk-local", region: "local", id }, host, { control, leaseExpiryMs: 5_000, startGraceMs: GRACE_MS, stonithTimeoutMs: 1_000 });
  return { tick, revoked };
}

/**
 * Once the keeper's first refresh has landed (`at` is no longer `since`): its thread is up. A loaded machine can take well
 * over this file's 400 ms grace to bring a worker thread up (nothing to a real grace of 90 s), so every timed check runs
 * from here; a keeper that never comes up still fails.
 */
async function firstRefresh(root: string, since: string, ms = 20_000): Promise<void> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(20)) if (readMark(root).at !== since) return;
  assert.fail(`the keeper did not refresh the mark within ${ms} ms`);
}

/** A seed that takes `ms`, and calls `during` halfway through. */
const slowSeed = (ms: number, during: () => Promise<void>): RunSeed => async () => {
  await sleep(ms / 2);
  await during();
  await sleep(ms / 2);
};

function opener(root: string, seed: RunSeed) {
  const ref = localRef("r1");
  const claim = fakeClaim(root, ref);
  const scripted = scriptedHarness();
  return () =>
    openDurableRun(ref, {
      mountToken: "unused",
      acquire: async () => claim,
      claimDir: localClaimDir,
      harness: { models: scripted.models, registry: scripted.registry },
      lease: LEASE,
      onFenced: () => {},
      seed,
    });
}

describe("a seed and the supervisor's start grace", () => {
  it("a seed that outlives the grace keeps its start mark fresh: the supervisor's tick finds it starting and revokes nothing", { timeout: 30_000 }, async () => {
    const dir = scratchRoot("seed-mark-fresh");
    try {
      // A first start (no failures before it): the grace is the base, 400 ms; a backed-off one would be longer.
      const first: Mark = { generation: 1, at: new Date().toISOString(), by: "sup-1", failures: 0, lastExit: null };
      writeMark(dir.root, first);
      const supervisor = supervisorOver(dir.root, "r1");
      let seen: Awaited<ReturnType<typeof supervisor.tick>> | undefined;
      const seed: RunSeed = async () => {
        await firstRefresh(dir.root, first.at);
        await sleep(GRACE_MS + 350);
        seen = await supervisor.tick();
      };
      const run = await opener(dir.root, seed)();
      assert.equal(seen?.action, "starting", `a tick ${GRACE_MS + 350} ms after the keeper came up, past the ${GRACE_MS} ms grace: ${JSON.stringify(seen)}`);
      assert.deepEqual(supervisor.revoked, [], "the seeder was not revoked");
      const mark = readMark(dir.root);
      assert.equal(existsSync(join(dir.root, "start.json.tmp")), false, "no refresh is mid-write once the seed step is done");
      assert.deepEqual({ ...mark, at: "" }, { ...first, at: "" }, "only `at` changes: generation, by, failures and lastExit are the supervisor's");
      assert.ok(Date.parse(mark.at) > Date.parse(first.at), "`at` moved");
      // Once the seed ends, run.json's heartbeat takes over: the mark is not touched again.
      const after = readMark(dir.root).at;
      await sleep(400);
      assert.equal(readMark(dir.root).at, after, "no refresh after the seed");
      await run.release();
    } finally {
      dir.remove();
    }
  });

  it("only a supervisor's generation-1 mark is refreshed: none is made where there was none, and another generation's is left alone", { timeout: 30_000 }, async () => {
    for (const mark of [undefined, { generation: 3, at: "2026-10-16T00:00:00.000Z", by: "sup-1", failures: 0, lastExit: null }]) {
      const dir = scratchRoot("seed-mark-other");
      try {
        if (mark) writeMark(dir.root, mark);
        const run = await opener(dir.root, slowSeed(600, async () => undefined))();
        if (mark) assert.deepEqual(readMark(dir.root), mark, "another generation's mark is not touched");
        else assert.equal(existsSync(join(dir.root, "start.json")), false, "no mark is made");
        await run.release();
      } finally {
        dir.remove();
      }
    }
  });

  it("a seed that holds its thread (a synchronous import) is kept fresh too: the refresh runs on a thread of its own", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("seed-mark-blocks");
    const root = join(dir.root, "run");
    const marker = join(dir.root, "seeding");
    mkdirSync(root, { recursive: true });
    const start = new Date().toISOString();
    writeMark(root, { generation: 1, at: start, by: "sup-1", failures: 0, lastExit: null });
    // Longer than the keeper may take to come up plus the checks; the child is killed once they are done.
    const BLOCK_MS = 30_000;
    const child = spawn(process.execPath, [CHILD, root, marker, String(LEASE.heartbeatMs), String(BLOCK_MS)], { stdio: ["ignore", "ignore", "inherit"] });
    try {
      for (const t0 = Date.now(); !existsSync(marker) && Date.now() - t0 < 30_000; ) await sleep(20);
      const blocked = Date.now();
      await firstRefresh(root, start);
      await sleep(GRACE_MS + 400);
      const seen = await supervisorOver(root, "seeded").tick();
      assert.ok(Date.now() - blocked < BLOCK_MS, "the tick ran while the seed still held its thread");
      const age = Date.now() - Date.parse(readMark(root).at);
      assert.ok(age < GRACE_MS, `the mark is younger than the ${GRACE_MS} ms grace while the seed blocks: ${age} ms`);
      assert.equal(seen.action, "starting", `past the grace into a blocking seed: ${JSON.stringify(seen)}`);
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => (child.exitCode === null && child.signalCode === null ? child.once("close", resolve) : resolve(undefined)));
      dir.remove();
    }
  });

  it("a seeder that dies stops refreshing, and the grace runs out as before", { timeout: 60_000 }, async () => {
    const dir = scratchRoot("seed-mark-dies");
    const root = join(dir.root, "run");
    const marker = join(dir.root, "seeding");
    mkdirSync(root, { recursive: true });
    writeMark(root, { generation: 1, at: new Date().toISOString(), by: "sup-1", failures: 0, lastExit: null });
    const child = spawn(process.execPath, [CHILD, root, marker, String(LEASE.heartbeatMs)], { stdio: ["ignore", "ignore", "inherit"] });
    try {
      for (const t0 = Date.now(); !existsSync(marker) && Date.now() - t0 < 30_000; ) await sleep(20);
      await firstRefresh(root, readMark(root).at); // the live seeder refreshes the mark
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("close", resolve));
      const last = readMark(root).at;
      await sleep(GRACE_MS + 300);
      assert.equal(readMark(root).at, last, "a dead seeder refreshes nothing");
      const supervisor = supervisorOver(root, "seeded");
      assert.notEqual((await supervisor.tick()).action, "starting", "past the grace the start has failed, as before");
    } finally {
      child.kill("SIGKILL");
      dir.remove();
    }
  });
});
