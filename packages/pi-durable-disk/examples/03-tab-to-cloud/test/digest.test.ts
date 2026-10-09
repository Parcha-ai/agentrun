// The digests the pipe keeps of work/: an attach reads work/ once (to send it), never twice; a file that changes during
// an attach (in place, or by a write-through) fails the restore instead of passing torn or stale, and the next attach
// sends what the disk has; what the pipe knows of work/ after write-throughs is what a walk finds; and the release's
// digest of work/ comes from it, after the release.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openClaimDir } from "@parcha/pi-durable-disk";
import { ModelProxy } from "../pipe/model-proxy.ts";
import { manifestDigest, RunPipe, type PipeSocket } from "../pipe/run-pipe.ts";
import { CHUNK_BYTES, fromBase64, toBase64, workspaceDigest, type ManifestEntry, type PipeFrame } from "../wire.ts";
import { localClaim } from "./_local.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pipeAt(id: string, extra: Partial<Parameters<typeof RunPipe.open>[0]> = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-digest-"));
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const pipe = await RunPipe.open({
    ref: { disk: "dsk-local", region: "local", id },
    mountToken: "local",
    mountRoot: root,
    model: new ModelProxy({ baseUrl: "http://127.0.0.1:9/v1", model: "stub", budgetTokens: 1 }),
    lease: { heartbeatMs: 500, expiryMs: 5_000, marginMs: 1_000 },
    acquire: async (opts) => localClaim(root, opts),
    claimDir: (dir) => openClaimDir(dir, { fstype: null }),
    log: (event, data = {}) => logs.push({ event, data }),
    ...extra,
  });
  const runRoot = join(root, "runs", id);
  return { pipe, root, runRoot, work: join(runRoot, "work"), logs, remove: async () => (await pipe.release().catch(() => undefined), rmSync(root, { recursive: true, force: true })) };
}

/** A socket that records frames, can hold the restore (it reports a full buffer), and runs `onFrame` on each frame. */
function socket(id: string, onFrame?: (frame: PipeFrame, s: ReturnType<typeof socket>) => void) {
  const s = {
    frames: [] as PipeFrame[],
    held: false,
    socket: undefined as unknown as PipeSocket,
  };
  s.socket = { id, send: (frame) => (s.frames.push(frame), onFrame?.(frame, s)), close: () => undefined, bufferedAmount: () => (s.held ? Number.MAX_SAFE_INTEGER : 0), isOpen: () => true };
  return s;
}

/** Wait for the restore to end, one way or the other. */
async function restoreOutcome(s: ReturnType<typeof socket>): Promise<"end" | "lost"> {
  for (let i = 0; i < 1_000; i++) {
    if (s.frames.some((f) => f.t === "restore-end")) return "end";
    if (s.frames.some((f) => f.t === "lost")) return "lost";
    await sleep(5);
  }
  throw new Error("the restore neither ended nor failed");
}

/** The files a restore sent, reassembled from its chunks. */
function received(s: ReturnType<typeof socket>): Map<string, string> {
  const manifest = (s.frames.find((f) => f.t === "attached") as Extract<PipeFrame, { t: "attached" }>).manifest;
  const out = new Map<string, string>();
  for (const e of manifest) {
    if (e.kind !== "file") continue;
    const bytes = new Uint8Array(e.size);
    for (const f of s.frames) if (f.t === "restore-chunk" && f.path === e.path) bytes.set(fromBase64(f.data), f.offset);
    out.set(e.path, sha(bytes));
  }
  return out;
}

/** A writer outside the pipe that replaces a file by rename (a new inode at the path, as a careful program writes). */
const replaceByRename = (path: string, bytes: Uint8Array) => {
  writeFileSync(`${path}.outside`, bytes);
  renameSync(`${path}.outside`, path);
};

/** work/'s digest as an independent walk finds it (the pipe's own `.pipe-` names left out, as the pipe's walk does). */
async function walkedDigest(work: string): Promise<string> {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.name.startsWith(".pipe-")) continue;
      if (e.isDirectory()) (lines.push(`directory ${rel}`), walk(join(dir, e.name), rel));
      else if (e.isFile()) lines.push(`file ${rel} ${sha(readFileSync(join(dir, e.name)))}`);
    }
  };
  walk(work, "");
  return workspaceDigest(lines);
}

const rewriteInPlace = (path: string, bytes: Uint8Array) => {
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(fd);
  }
};

describe("the digests the pipe keeps of work/", () => {
  it("an attach after write-throughs reads work/ once: to send it", async () => {
    const t = await pipeAt("once");
    try {
      const a = socket("a");
      await t.pipe.attach(a.socket, "a", false);
      await restoreOutcome(a);
      const files = [randomBytes(2 * CHUNK_BYTES), randomBytes(2 * CHUNK_BYTES), randomBytes(CHUNK_BYTES / 2)];
      await t.pipe.files(a.socket, 1, files.map((bytes, i) => ({ path: `f${i}.bin`, op: "write" as const, data: toBase64(bytes) })));
      const size = files.reduce((n, f) => n + f.length, 0);
      // Count what is read from any file while the next writer attaches and gets work/.
      const probe = await open(join(t.root, "probe"), "w");
      const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
      await probe.close();
      const read = proto.read;
      let readBytes = 0;
      proto.read = async function (this: unknown, ...args: unknown[]) {
        const r = await read.apply(this, args);
        readBytes += r.bytesRead;
        return r;
      };
      try {
        const b = socket("b");
        await t.pipe.attach(b.socket, "b", true);
        assert.equal(await restoreOutcome(b), "end");
        assert.deepEqual([...received(b).values()], files.map(sha));
      } finally {
        proto.read = read;
      }
      assert.ok(readBytes <= size + 64 * 1024, `${readBytes} bytes read for a ${size}-byte work/: once, not twice`);
    } finally {
      await t.remove();
    }
  });

  for (const how of ["in place, before its stream", "by a rename outside the pipe, before its stream", "in place, during its own stream", "by a rename outside the pipe, during its own stream"] as const) {
    it(`a file changed ${how} fails the restore, and the next attach sends what the disk has`, async () => {
      const t = await pipeAt(`changed-${how.split(" ")[0]}-${how.length}`);
      try {
        const big = randomBytes(3 * CHUNK_BYTES);
        const small = randomBytes(1024);
        const w = socket("w");
        await t.pipe.attach(w.socket, "w", false);
        await restoreOutcome(w);
        await t.pipe.files(w.socket, 1, [{ path: "a.bin", op: "write", data: toBase64(big) }, { path: "b.bin", op: "write", data: toBase64(small) }]);
        const target = how.endsWith("its own stream") ? "a.bin" : "b.bin";
        // A rename while the file's own bytes stream: the open handle reads the old file whole and its hash matches;
        // only the path, checked after the read, shows the change.
        const changedTo = target === "a.bin" ? randomBytes(big.length) : randomBytes(small.length);
        // The first chunk of a.bin holds the stream; the change happens; the stream goes on.
        let changed: Promise<unknown> | undefined;
        const r = socket("r", (frame, s) => {
          if (changed || frame.t !== "restore-chunk" || frame.path !== "a.bin") return;
          s.held = true;
          changed = (async () => {
            if (how.startsWith("by a rename")) replaceByRename(join(t.work, target), changedTo);
            else rewriteInPlace(join(t.work, target), changedTo);
            s.held = false;
          })();
        });
        await t.pipe.attach(r.socket, "r", true);
        assert.equal(await restoreOutcome(r), "lost", "the restore failed");
        await changed;
        assert.ok(!r.frames.some((f) => f.t === "restore-end"), "no restore-end: the tab is never handed the workspace");
        const lost = r.frames.find((f) => f.t === "lost") as Extract<PipeFrame, { t: "lost" }>;
        assert.equal(lost.code, "RESTORE_FAILED");
        assert.match(lost.message, new RegExp(`${target} changed during the attach`));
        // The next attach reads the changed file again and sends it as the disk has it.
        const n = socket("n");
        await t.pipe.attach(n.socket, "n", true);
        assert.equal(await restoreOutcome(n), "end");
        const now = received(n);
        assert.equal(now.get(target), sha(changedTo));
        assert.equal(now.get(target === "a.bin" ? "b.bin" : "a.bin"), sha(target === "a.bin" ? small : big));
      } finally {
        await t.remove();
      }
    });
  }

  it("an empty file replaced while another file streams fails the restore", async () => {
    const t = await pipeAt("empty-replaced");
    try {
      const w = socket("w");
      await t.pipe.attach(w.socket, "w", false);
      await restoreOutcome(w);
      await t.pipe.files(w.socket, 1, [{ path: "a.bin", op: "write", data: toBase64(randomBytes(3 * CHUNK_BYTES)) }, { path: "e.txt", op: "write", data: "" }]);
      let done = false;
      const r = socket("r", (frame, s) => {
        if (done || frame.t !== "restore-chunk") return;
        done = true;
        replaceByRename(join(t.work, "e.txt"), new TextEncoder().encode("not empty any more"));
        void s;
      });
      await t.pipe.attach(r.socket, "r", true);
      assert.equal(await restoreOutcome(r), "lost");
      assert.match((r.frames.find((f) => f.t === "lost") as Extract<PipeFrame, { t: "lost" }>).message, /e\.txt changed during the attach/);
    } finally {
      await t.remove();
    }
  });

  it("refuses a write-through while its writer's restore streams: work/ is what the writer is sent", async () => {
    const t = await pipeAt("no-write-during-restore");
    try {
      const w = socket("w");
      await t.pipe.attach(w.socket, "w", false);
      await restoreOutcome(w);
      const big = randomBytes(3 * CHUNK_BYTES);
      await t.pipe.files(w.socket, 1, [{ path: "a.bin", op: "write", data: toBase64(big) }]);
      let tried: Promise<unknown> | undefined;
      const r = socket("r", (frame, s) => {
        if (tried || frame.t !== "restore-chunk") return;
        s.held = true;
        tried = (async () => {
          await t.pipe.files(s.socket, 7, [{ path: "a.bin", op: "write", data: toBase64(randomBytes(10)) }]);
          await assert.rejects(t.pipe.writeAsWriter("r", [{ path: "a.bin", op: "write", data: toBase64(randomBytes(10)) }]), /still being restored/);
          s.held = false;
        })();
      });
      await t.pipe.attach(r.socket, "r", true);
      assert.equal(await restoreOutcome(r), "end");
      await tried;
      const refused = r.frames.find((f) => f.t === "res" && f.id === 7) as Extract<PipeFrame, { t: "res"; ok: false }>;
      assert.equal(refused.ok, false);
      assert.match(refused.error.message, /still being restored/);
      assert.equal(sha(readFileSync(join(t.work, "a.bin"))), sha(big), "the refused writes changed nothing");
      assert.equal(received(r).get("a.bin"), sha(big));
      // Once restored, the writer writes again.
      await t.pipe.files(r.socket, 8, [{ path: "a.bin", op: "write", data: toBase64(randomBytes(10)) }]);
      assert.equal((r.frames.find((f) => f.t === "res" && f.id === 8) as Extract<PipeFrame, { t: "res" }>).ok, true);
    } finally {
      await t.remove();
    }
  });

  it("refuses a workspace over the limit before reading any of it", async () => {
    const t = await pipeAt("over-limit", { restoreLimitBytes: CHUNK_BYTES });
    try {
      mkdirSync(t.work, { recursive: true });
      writeFileSync(join(t.work, "huge.bin"), randomBytes(10 * CHUNK_BYTES));
      const probe = await open(join(t.root, "probe"), "w");
      const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
      await probe.close();
      const read = proto.read;
      let readBytes = 0;
      proto.read = async function (this: unknown, ...args: unknown[]) {
        const r = await read.apply(this, args);
        readBytes += r.bytesRead;
        return r;
      };
      try {
        await assert.rejects(t.pipe.attach(socket("a").socket, "a", false), /larger than/);
      } finally {
        proto.read = read;
      }
      assert.equal(readBytes, 0, "the oversized file was not read");
    } finally {
      await t.remove();
    }
  });

  it("a removal that fails part way: the release walks work/, and its digest is the disk's", { skip: process.getuid?.() === 0 ? "root removes anything" : false }, async () => {
    const t = await pipeAt("failed-remove");
    const locked = join(t.work, "locked");
    try {
      const w = socket("w");
      await t.pipe.attach(w.socket, "w", false);
      await restoreOutcome(w);
      await t.pipe.files(w.socket, 1, [{ path: "locked/inner/f.txt", op: "write", data: toBase64(randomBytes(10)) }, { path: "other.txt", op: "write", data: toBase64(randomBytes(10)) }]);
      chmodSync(join(locked, "inner"), 0o555);
      await t.pipe.files(w.socket, 2, [{ path: "locked", op: "delete" }]);
      assert.equal((w.frames.find((f) => f.t === "res" && f.id === 2) as Extract<PipeFrame, { t: "res" }>).ok, false, "the removal failed");
      const expected = await walkedDigest(t.work);
      chmodSync(join(locked, "inner"), 0o755);
      await t.pipe.release();
      for (let i = 0; i < 200 && !t.logs.some((l) => l.event === "pipe.released"); i++) await sleep(5);
      const line = t.logs.find((l) => l.event === "pipe.released");
      assert.equal(line?.data.workSource, "walked", "what the pipe knew was no longer all of work/");
      assert.equal(line?.data.workDigest, expected);
    } finally {
      try {
        chmodSync(join(locked, "inner"), 0o755);
      } catch {
        // already gone
      }
      await t.remove();
    }
  });

  it("a file replaced between a write-through's rename and its record: the record is not given to the other file", async () => {
    const t = await pipeAt("replaced-before-record");
    // node:fs/promises's lstat, as run-pipe.ts imports it, made to let another writer replace x.bin first, once: exactly
    // between the write-through's rename and its reading of the identity it records.
    const fsp = createRequire(import.meta.url)("node:fs/promises") as { lstat: (path: unknown, options?: { bigint?: boolean }) => Promise<unknown> };
    const lstat = fsp.lstat;
    let armed = false;
    const other = randomBytes(64);
    fsp.lstat = async (path, options) => {
      if (armed && options?.bigint && String(path).endsWith("/x.bin")) {
        armed = false;
        replaceByRename(String(path), other);
      }
      return lstat(path, options);
    };
    syncBuiltinESMExports();
    try {
      const w = socket("w");
      await t.pipe.attach(w.socket, "w", false);
      await restoreOutcome(w);
      armed = true;
      await t.pipe.files(w.socket, 1, [{ path: "x.bin", op: "write", data: toBase64(randomBytes(64)) }]);
      assert.equal(armed, false, "the other writer replaced x.bin");
      assert.equal(sha(readFileSync(join(t.work, "x.bin"))), sha(other));
      // A record of the first write's hash under the other file's identity would fail this attach (its stream hash).
      const n = socket("n");
      await t.pipe.attach(n.socket, "n", true);
      assert.equal(await restoreOutcome(n), "end");
      assert.equal(received(n).get("x.bin"), sha(other));
      const expected = await walkedDigest(t.work);
      await t.pipe.release();
      for (let i = 0; i < 200 && !t.logs.some((l) => l.event === "pipe.released"); i++) await sleep(5);
      assert.equal(t.logs.find((l) => l.event === "pipe.released")?.data.workDigest, expected);
    } finally {
      fsp.lstat = lstat;
      syncBuiltinESMExports();
      await t.remove();
    }
  });

  it("sees a same-size rewrite in place between two attaches, once the file's times moved", async () => {
    const t = await pipeAt("same-size");
    try {
      const w = socket("w");
      await t.pipe.attach(w.socket, "w", false);
      await restoreOutcome(w);
      await t.pipe.files(w.socket, 1, [{ path: "x.bin", op: "write", data: toBase64(randomBytes(4096)) }]);
      // Past a coarse filesystem's time tick (the Archil mount's times move at ns resolution).
      await sleep(20);
      const second = randomBytes(4096);
      rewriteInPlace(join(t.work, "x.bin"), second);
      const n = socket("n");
      await t.pipe.attach(n.socket, "n", true);
      assert.equal(await restoreOutcome(n), "end");
      const manifest = (n.frames.find((f) => f.t === "attached") as Extract<PipeFrame, { t: "attached" }>).manifest;
      assert.equal((manifest.find((e) => e.path === "x.bin") as Extract<ManifestEntry, { kind: "file" }>).sha256, sha(second));
      assert.equal(received(n).get("x.bin"), sha(second));
    } finally {
      await t.remove();
    }
  });

  it("never hands over the old bytes of a file rewritten in place within one time tick", async () => {
    const t = await pipeAt("same-tick");
    try {
      const w = socket("w");
      await t.pipe.attach(w.socket, "w", false);
      await restoreOutcome(w);
      for (let round = 0; round < 20; round++) {
        await t.pipe.files(w.socket, 100 + round, [{ path: "x.bin", op: "write", data: toBase64(randomBytes(4096)) }]);
        const second = randomBytes(4096);
        rewriteInPlace(join(t.work, "x.bin"), second);
        // The key may miss it on a coarse filesystem; then the stream's hash refuses it, and the next attach reads it.
        const n = socket(`n${round}`);
        await t.pipe.attach(n.socket, n.socket.id, true);
        if ((await restoreOutcome(n)) === "end") assert.equal(received(n).get("x.bin"), sha(second), `round ${round}: sent whole and new`);
        else {
          assert.match((n.frames.find((f) => f.t === "lost") as Extract<PipeFrame, { t: "lost" }>).message, /x\.bin changed during the attach/);
          const m = socket(`m${round}`);
          await t.pipe.attach(m.socket, m.socket.id, true);
          assert.equal(await restoreOutcome(m), "end");
          assert.equal(received(m).get("x.bin"), sha(second), `round ${round}: the next attach sends the new bytes`);
        }
        // The writer of the next round is the one that holds the run now.
        Object.assign(w, socket(`w${round}`));
        await t.pipe.attach(w.socket, w.socket.id, true);
        await restoreOutcome(w);
      }
    } finally {
      await t.remove();
    }
  });

  it("knows what a walk finds after write-throughs, and the release's digest comes from it, after the release", async () => {
    let finish: () => void = () => undefined;
    let held = false;
    const t = await pipeAt("release", {
      // A digest that takes as long as the test says.
      digest: async (entries) => {
        held = true;
        await new Promise<void>((resolve) => (finish = resolve));
        return manifestDigest(entries);
      },
    });
    let released = false;
    try {
      const w = socket("w");
      await t.pipe.attach(w.socket, "w", false);
      await restoreOutcome(w);
      finish();
      const big = randomBytes(CHUNK_BYTES + 17);
      await t.pipe.upload(w.socket, "release-upload-01", 0, toBase64(big.subarray(0, CHUNK_BYTES)));
      await t.pipe.upload(w.socket, "release-upload-01", CHUNK_BYTES, toBase64(big.subarray(CHUNK_BYTES)));
      const ops: Parameters<RunPipe["files"]>[2][] = [
        [{ path: "a/b/c.txt", op: "write", data: toBase64(randomBytes(10)) }, { path: "d/e", op: "mkdir" }, { path: "keep.txt", op: "write", data: toBase64(randomBytes(20)) }],
        [{ path: "big.bin", op: "write", upload: { id: "release-upload-01", size: big.length, sha256: sha(big) } }],
        [{ path: "a/b", op: "delete" }, { path: "d", op: "write", data: toBase64(randomBytes(30)) }, { path: "keep.txt", op: "write", data: toBase64(randomBytes(20)) }],
      ];
      for (const [i, changes] of ops.entries()) {
        await t.pipe.files(w.socket, 10 + i, changes);
        assert.equal((w.frames.find((f) => f.t === "res" && f.id === 10 + i) as Extract<PipeFrame, { t: "res" }>).ok, true);
      }
      // work/ as an independent walk finds it.
      const lines: string[] = [];
      const walk = (dir: string, prefix: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) (lines.push(`directory ${rel}`), walk(join(dir, e.name), rel));
          else if (e.isFile()) lines.push(`file ${rel} ${sha(readFileSync(join(dir, e.name)))}`);
        }
      };
      walk(t.work, "");
      const expected = await workspaceDigest(lines);
      held = false;
      // No file is read on the release's path: the digest comes from what the pipe knows.
      const probe = await open(join(t.root, "probe"), "w");
      const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
      await probe.close();
      const read = proto.read;
      let readBytes = 0;
      proto.read = async function (this: unknown, ...args: unknown[]) {
        const r = await read.apply(this, args);
        readBytes += r.bytesRead;
        return r;
      };
      try {
        await t.pipe.release();
      } finally {
        proto.read = read;
      }
      released = true;
      assert.equal(readBytes, 0, "the release read no file");
      // The release is done, the run's record sealed, and the digest still running: no released line yet.
      assert.notEqual(JSON.parse(readFileSync(join(t.runRoot, "run.json"), "utf8")).sealedSeq, null);
      assert.ok(held, "the release's digest started");
      assert.ok(!t.logs.some((l) => l.event === "pipe.released"), "the line waits for the digest, the release does not");
      finish();
      for (let i = 0; i < 200 && !t.logs.some((l) => l.event === "pipe.released"); i++) await sleep(5);
      assert.equal(t.logs.find((l) => l.event === "pipe.released")?.data.workDigest, expected);
      assert.equal(t.logs.find((l) => l.event === "pipe.released")?.data.workSource, "kept", "from what the pipe knows, not a walk");
      assert.deepEqual(t.logs.filter((l) => l.event === "pipe.work-diverged"), []);
    } finally {
      finish();
      if (!released) await t.pipe.release().catch(() => undefined);
      rmSync(t.root, { recursive: true, force: true });
    }
  });
});
