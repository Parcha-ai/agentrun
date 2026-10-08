// pi's storage conformance on both profiles over an exclusive Archil mount of runs/p2-<id>/ on the
// shared scratch disk, commit latency per profile, and the fence on a real revoked delegation.
//
//   PDA_LIVE=1 ARCHIL_API_KEY=... PDA_LIVE_DISK=dsk-... npm run test:live:store
//
// Every resource this file makes (the run directories, one token user, the mounts) is recorded in PDA_P2_STATE as it is
// made and released in `after`, also on failure. PDA_P2_RESULTS names a file that receives the measurements as JSON.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { StorageConformanceProvider } from "@earendil-works/pi-durable/testing";
import { LIVE, mintToken, mount, removeToken, scratchDisk, scratchDiskId, unmount } from "./_archil.ts";
import { registerConformance } from "../_conformance.ts";
import { ctx, entryCommitter, percentile, SQLITE_IOERR, withStoreIn } from "../_support.ts";
import { openArchilStore, StoreBusyError, StoreFencedError } from "../../src/store.ts";
import type { Profile } from "../../src/store.ts";
import { statePath } from "./_paths.ts";

const PROFILES: readonly Profile[] = ["exclusive", "shared"];
const ID = `p2-${Date.now().toString(36)}`;
const MOUNT_ROOT = "/mnt/pda/p2";
const STATE_PATH = statePath("PDA_P2_STATE", "P2-STATE.json");
const RESULTS_PATH = process.env.PDA_P2_RESULTS;

type Resources = {
  disk: string;
  region: string;
  runDirectories: Array<{ key: string; createdAt: string; dataRemovedAt?: string; markerRemovedAt?: string }>;
  tokenUsers: Array<{ identifier: string; purpose: string; mintedAt: string; removedAt?: string }>;
  mounts: Array<{ mountpoint: string; target: string; flags: string[]; mountedAt: string; unmountedAt?: string; via?: string }>;
};
const resources: Resources = { disk: "", region: "aws-us-east-1", runDirectories: [], tokenUsers: [], mounts: [] };
const results: Record<string, unknown> = { id: ID, startedAt: new Date().toISOString() };

function flush(): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify({ lane: "P2", ...resources }, null, 2)}\n`);
  if (RESULTS_PATH) writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
}

const now = () => new Date().toISOString();

async function createRunDirectory(name: string): Promise<void> {
  const disk = await scratchDisk();
  const key = `runs/${name}/`;
  await disk.putObject(key, "", { uid: 1000, gid: 1000, mode: 0o755 });
  resources.runDirectories.push({ key, createdAt: now() });
  flush();
}

function mountRun(name: string, token: string, options: { mountpoint?: string; flags?: string[] } = {}): string {
  const mountpoint = options.mountpoint ?? join(MOUNT_ROOT, name);
  const flags = options.flags ?? [];
  const target = `${scratchDiskId()}:/runs/${name}`;
  const record = { mountpoint, target, flags, mountedAt: now() };
  const outcome = mount({ subpath: `/runs/${name}`, mountpoint, token, flags });
  if (outcome.status !== 0) throw new Error(`mount of ${target} failed (${outcome.status}): ${outcome.stderr || outcome.stdout}`);
  resources.mounts.push(record);
  flush();
  return mountpoint;
}

/** Remove the run directory's marker object once nothing is mounted on it (only the keys this file created). */
async function removeRunDirectory(name: string): Promise<void> {
  const entry = resources.runDirectories.find((d) => d.key === `runs/${name}/`);
  if (!entry || entry.markerRemovedAt !== undefined) return;
  const disk = await scratchDisk();
  await disk.deleteObject(entry.key);
  entry.markerRemovedAt = now();
  flush();
}

function unmountRun(mountpoint: string): void {
  const entry = resources.mounts.find((m) => m.mountpoint === mountpoint && m.unmountedAt === undefined);
  if (!entry) return;
  const outcome = unmount(mountpoint);
  entry.unmountedAt = now();
  entry.via = outcome.via;
  if (outcome.status !== 0) entry.via = `${outcome.via} (exit ${outcome.status})`;
  // The mountpoint directory is empty once unmounted; rmdir refuses anything else.
  if (outcome.status === 0 && mountpoint.startsWith(`${MOUNT_ROOT}/`)) spawnSync("sudo", ["rmdir", mountpoint]);
  flush();
}

const stats = (sample: number[]) => ({
  n: sample.length,
  p50: round(percentile(sample, 50)),
  p95: round(percentile(sample, 95)),
  p99: round(percentile(sample, 99)),
  max: round(Math.max(...sample)),
  min: round(Math.min(...sample)),
});
const round = (value: number) => Math.round(value * 100) / 100;

describe("store on an Archil mount", { skip: LIVE ? false : "set PDA_LIVE=1, ARCHIL_API_KEY and PDA_LIVE_DISK" }, () => {
  let token: { token: string; identifier: string } | undefined;
  let mountpoint = "";

  before(async () => {
    resources.disk = scratchDiskId();
    await createRunDirectory(ID);
    token = await mintToken("p2");
    resources.tokenUsers.push({ identifier: token.identifier, purpose: "p2 store live suite", mintedAt: now() });
    flush();
    mountpoint = mountRun(ID, token.token);
  });

  after(async () => {
    const errors: unknown[] = [];
    if (mountpoint) {
      for (const sub of [...PROFILES.map((p) => `conformance-${p}`), "latency", "locked", "shared-readers"]) {
        const path = join(mountpoint, sub);
        if (path.startsWith(`${MOUNT_ROOT}/${ID}/`)) rmSync(path, { recursive: true, force: true });
      }
      const entry = resources.runDirectories.find((d) => d.key === `runs/${ID}/`);
      if (entry) entry.dataRemovedAt = now();
      unmountRun(mountpoint);
    }
    await removeRunDirectory(ID).catch((error) => errors.push(error));
    if (token) {
      await removeToken(token.identifier).catch((error) => errors.push(error));
      const entry = resources.tokenUsers.find((u) => u.identifier === token!.identifier);
      if (entry) entry.removedAt = now();
    }
    results.finishedAt = now();
    flush();
    if (errors.length > 0) throw new AggregateError(errors, "cleanup failed");
  });

  for (const profile of PROFILES) {
    const withStorage: StorageConformanceProvider = (use) =>
      withStoreIn(join(mountpoint || join(MOUNT_ROOT, ID), `conformance-${profile}`), profile, async (store, file) => {
        await use(store.storage);
        if (profile === "exclusive") assert.equal(existsSync(`${file}-shm`), false, "the exclusive profile created -shm on the mount");
      });
    registerConformance(`storage conformance, ${profile} profile, Archil mount`, withStorage);
  }

  it("commit latency per profile: entry-only commits, 200 after 20 warmup, two rounds each, alternating", { timeout: 300_000 }, async (t) => {
    const latency: Record<string, Array<ReturnType<typeof stats>>> = { exclusive: [], shared: [] };
    for (let round = 0; round < 2; round++) {
      for (const profile of PROFILES) {
        await withStoreIn(join(mountpoint, "latency"), profile, async (store) => {
          const writer = entryCommitter(store.storage, 256);
          await writer.setup();
          for (let n = 0; n < 20; n++) await writer.commit(n);
          const sample: number[] = [];
          for (let n = 0; n < 200; n++) {
            const started = performance.now();
            await writer.commit(20 + n);
            sample.push(performance.now() - started);
          }
          latency[profile]!.push(stats(sample));
        });
      }
    }
    // The floor for one durable round trip on this mount: append 200 bytes and fsync.
    const floorFile = join(mountpoint, "latency", "fsync-floor.bin");
    const fd = openSync(floorFile, "a");
    const floor: number[] = [];
    try {
      const line = Buffer.alloc(200, 0x61);
      for (let n = 0; n < 220; n++) {
        const started = performance.now();
        writeSync(fd, line);
        fsyncSync(fd);
        if (n >= 20) floor.push(performance.now() - started);
      }
    } finally {
      closeSync(fd);
    }
    results.commitLatencyMs = { shape: "entry-only, 256 B payload, serial, synchronous = FULL", ...latency, rawAppendFsyncFloor: stats(floor) };
    flush();
    t.diagnostic(JSON.stringify(results.commitLatencyMs));
    for (const profile of PROFILES) for (const row of latency[profile]!) assert.ok(row.p50 > 0 && Number.isFinite(row.p95), `${profile} latency sample`);
  });

  it("exclusive on the mount: a second connection gets 'database is locked', a second open is refused, the owner keeps working", async () => {
    await withStoreIn(join(mountpoint, "locked"), "exclusive", async (store, file) => {
      const writer = entryCommitter(store.storage);
      await writer.setup();
      await writer.commit(0);
      const other = new DatabaseSync(file, { timeout: 0 });
      try {
        assert.throws(
          () => other.prepare("SELECT count(*) AS n FROM durable_metadata").get(),
          (error: Error & { errcode?: number }) => error.errcode === 5 && /database is locked/.test(error.message),
        );
      } finally {
        other.close();
      }
      await assert.rejects(openArchilStore(file, "exclusive"), StoreBusyError);
      await writer.commit(1);
      assert.equal(existsSync(`${file}-shm`), false);
    });
  });

  it("shared on the mount: -shm works within the one client and a second store sees live commits", async () => {
    await withStoreIn(join(mountpoint, "shared-readers"), "shared", async (first, file) => {
      const writer = entryCommitter(first.storage);
      await writer.setup();
      await writer.commit(0);
      assert.ok(existsSync(`${file}-shm`), "the shared profile makes a -shm file");
      const second = await openArchilStore(file, "shared");
      try {
        const count = async (storage: Storage) =>
          (await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, ctx)).items.length;
        assert.equal(await count(second.storage), 1);
        await writer.commit(1);
        assert.equal(await count(second.storage), 2);
      } finally {
        await second.storage.close(ctx);
      }
    });
  });
});

describe("the fence on a real revoked delegation", { skip: LIVE ? false : "set PDA_LIVE=1, ARCHIL_API_KEY and PDA_LIVE_DISK" }, () => {
  const name = `${ID}-fence`;
  const takerPoint = join(MOUNT_ROOT, `${name}-taker`);
  let token: { token: string; identifier: string } | undefined;
  let holder = "";
  let taker = "";
  let zombie: SqliteDatabase | undefined;

  before(async () => {
    resources.disk ||= scratchDiskId();
    await createRunDirectory(name);
    token = await mintToken("p2-fence");
    resources.tokenUsers.push({ identifier: token.identifier, purpose: "p2 fence test", mintedAt: now() });
    flush();
    holder = mountRun(name, token.token);
  });

  after(async () => {
    // Release the zombie's file descriptors the way process exit would, then give both mounts back.
    await zombie?.close().catch(() => undefined);
    if (taker.startsWith(`${MOUNT_ROOT}/`)) rmSync(join(taker, "store"), { recursive: true, force: true });
    const entry = resources.runDirectories.find((d) => d.key === `runs/${name}/`);
    if (entry) entry.dataRemovedAt = now();
    if (taker) unmountRun(taker);
    if (holder) unmountRun(holder);
    await removeRunDirectory(name).catch(() => undefined);
    if (token) {
      await removeToken(token.identifier).catch(() => undefined);
      const user = resources.tokenUsers.find((u) => u.identifier === token!.identifier);
      if (user) user.removedAt = now();
    }
    flush();
  });

  it(
    "a force-mount elsewhere revokes the holder: its next commit fences the store with an I/O class code and poisons a real Harness",
    { timeout: 120_000 },
    async (t) => {
      let callbacks = 0;
      const store = await openArchilStore(join(holder, "store", "run.sqlite"), "exclusive", {
        onFenced: () => void callbacks++,
        decorate: (database) => (zombie = database),
      });
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage("acknowledged"), fauxAssistantMessage("never durable")]);
      const model = faux.getModel();
      const harness = await Harness.open(store.storage, { models, registry: createRegistry() }, ctx);
      const root = await harness.root(ctx, { agent: { model: { provider: model.provider, modelId: model.id } } });
      assert.equal((await (await root.submit({ type: "input", content: "hello" }, ctx)).wait(ctx)).status, "done");
      const kinds = async (storage: Storage) =>
        (await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 100, undefined, ctx)).items.map((e) => e.kind);
      const acknowledged = await kinds(store.storage);
      assert.ok(acknowledged.length >= 2, `expected a user and an assistant entry, saw ${acknowledged.join(",")}`);
      assert.equal(store.database.fenced, false);

      // A new owner takes the run directory by force; the server revokes the holder's delegation.
      taker = mountRun(name, token!.token, { mountpoint: takerPoint, flags: ["--force"] });

      const started = performance.now();
      const failure = await (async () => (await root.submit({ type: "input", content: "again" }, ctx)).wait(ctx))().then(
        () => undefined,
        (error: unknown) => error,
      );
      const detectMs = performance.now() - started;
      assert.ok(failure instanceof StoreFencedError, `the zombie's commit must fail fenced, got ${String(failure)}`);
      assert.equal(failure.errcode & 0xff, SQLITE_IOERR, `result code ${failure.errcode} must be in the I/O class`);
      assert.equal(store.database.fenced, true);
      assert.equal(callbacks, 1);
      const cause = failure.cause as { errcode?: number; errstr?: string; members?: unknown } | undefined;
      results.fence = {
        errcode: failure.errcode,
        detectMs: round(detectMs),
        causeClass: cause?.constructor?.name,
        causeMembers: cause instanceof AggregateError ? cause.errors.map((e: { errcode?: number; message: string }) => [e.errcode, e.message]) : undefined,
      };
      flush();
      t.diagnostic(JSON.stringify(results.fence));

      // The Harness is poisoned and every later call fails at once, without waiting on the mount.
      const later = performance.now();
      await assert.rejects(root.commit(async () => undefined, ctx), (error: Error) => /poisoned/.test(error.message) && error.cause instanceof StoreFencedError);
      await assert.rejects(store.storage.commit([], ctx), (error: unknown) => error === store.database.fencedBy);
      assert.ok(performance.now() - later < 1000, "a fenced handle must fail at once");

      // The new owner holds exactly the acknowledged commits and nothing of the zombie's.
      const next = await openArchilStore(join(taker, "store", "run.sqlite"), "exclusive");
      try {
        assert.deepEqual(await kinds(next.storage), acknowledged);
        assert.deepEqual({ ...(await next.database.get("PRAGMA integrity_check")) }, { integrity_check: "ok" });
      } finally {
        await next.storage.close(ctx);
      }
    },
  );
});
