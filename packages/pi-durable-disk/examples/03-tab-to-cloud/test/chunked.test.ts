// Workspaces larger than a frame: a write-through of a file far past the 64 MiB a WebSocket here accepts, an attach that
// restores a workspace of that size, both checked by SHA-256; and the ways it must fail without touching work/: an
// upload cut off mid-transfer, an upload whose content does not match, a writer retired before or during the
// write-through that names its upload, a restore over the host's limit or not matching its manifest.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { openClaimDir } from "@parcha/pi-durable-disk";
import { ModelProxy } from "../pipe/model-proxy.ts";
import { RunPipe, type PipeSocket } from "../pipe/run-pipe.ts";
import { PipeClient, type SocketLike } from "../tab/pipe-client.ts";
import { CHUNK_BYTES, PipeLostError, toBase64, type ManifestEntry, type PipeFrame, type RestoredEntry } from "../wire.ts";
import { localClaim, localServer } from "./_local.ts";

const MiB = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const text = (s: string) => toBase64(new TextEncoder().encode(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every file under `dir`, recursively, as relative paths. */
function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** An open `ws` socket as the client's SocketLike, with `send` passed through `relay` (to cut or slow the connection). */
async function wrapped(url: string, relay: (raw: WebSocket, data: string) => void): Promise<SocketLike> {
  const raw = new WebSocket(url);
  await new Promise((resolve, reject) => (raw.once("open", resolve), raw.once("error", reject)));
  return {
    get readyState() {
      return raw.readyState;
    },
    get bufferedAmount() {
      return raw.bufferedAmount;
    },
    send: (data: string) => relay(raw, data),
    close: (code, reason) => raw.close(code, reason),
    addEventListener: ((type: string, listener: (...args: unknown[]) => void) => raw.addEventListener(type as "open", listener as () => void)) as SocketLike["addEventListener"],
  };
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe("chunked workspace through the pipe", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  before(async () => {
    local = await localServer({ writerGraceMs: 3_000 });
  });
  after(() => local.remove());

  it("writes a 200 MiB file through in chunks, lands it whole, and restores it on the next attach", async () => {
    const { id, secret } = await local.server.createRun("big");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    const big = randomBytes(200 * MiB);
    await a.syncFiles([{ path: "ckpt/big.bin", op: "write", bytes: big }]);
    const runRoot = join(local.root, "runs", id);
    assert.equal(sha(readFileSync(join(runRoot, "work/ckpt/big.bin"))), sha(big));
    assert.deepEqual(listFiles(join(runRoot, "tmp", "pipe-uploads")), [], "no upload is left behind");
    assert.deepEqual(listFiles(join(runRoot, "work")), ["ckpt/big.bin"]);
    a.close();

    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "b", mode: "write", takeover: true });
    const attached = await b.ready;
    assert.equal(attached.t, "attached");
    const file = (attached.t === "attached" ? attached.files : []).find((f) => f.path === "ckpt/big.bin") as Extract<RestoredEntry, { kind: "file" }>;
    assert.equal(file.bytes.length, big.length);
    assert.equal(sha(file.bytes), sha(big));
    b.close();
  });

  it("restores a 100 MiB workspace of many files, each matching its SHA-256", async () => {
    const { id, secret } = await local.server.createRun("many");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    const written = new Map<string, Uint8Array>();
    written.set("model/weights.bin", randomBytes(60 * MiB));
    for (let i = 0; i < 20; i++) written.set(`ckpt/step-${String(i).padStart(2, "0")}.bin`, randomBytes(2 * MiB));
    written.set("notes/empty.txt", new Uint8Array(0));
    // One write-through: the inline part stays under a chunk, the rest goes as uploads.
    await a.syncFiles([...written].map(([path, bytes]) => ({ path, op: "write" as const, bytes })));
    a.close();

    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "b", mode: "write", takeover: true });
    const attached = await b.ready;
    assert.equal(attached.t, "attached");
    const files = (attached.t === "attached" ? attached.files : []).filter((f): f is Extract<RestoredEntry, { kind: "file" }> => f.kind === "file");
    assert.deepEqual(files.map((f) => f.path).sort(), [...written.keys()].sort());
    for (const f of files) assert.equal(sha(f.bytes), sha(written.get(f.path)!), f.path);
    b.close();
  });

  it("refuses a restore over the host's limit before receiving anything (RESTORE_FAILED)", async () => {
    const { id, secret } = await local.server.createRun("limit");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    await a.syncFiles([{ path: "big.bin", op: "write", bytes: randomBytes(12 * MiB) }]);
    a.close();
    const lost: string[] = [];
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "b", mode: "write", takeover: true, restoreLimitBytes: 8 * MiB, onLost: (code) => lost.push(code) });
    await assert.rejects(b.ready, (e: unknown) => e instanceof PipeLostError && e.code === "RESTORE_FAILED" && /over this host's limit/.test(e.message));
    assert.deepEqual(lost, ["RESTORE_FAILED"]);
  });

  it("an upload cut off mid-transfer leaves the old file and no upload", async () => {
    const { id, secret } = await local.server.createRun("cut");
    const runRoot = join(local.root, "runs", id);
    // The third upload chunk goes out, then the connection dies without a close.
    let uploads = 0;
    const socket = await wrapped(local.url, (raw, data) => {
      raw.send(data);
      if (data.startsWith('{"t":"upload"') && ++uploads === 3) raw.terminate();
    });
    const a = new PipeClient({ socket, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    await a.syncFiles([{ path: "model.bin", op: "write", data: text("old") }]);
    await assert.rejects(a.syncFiles([{ path: "model.bin", op: "write", bytes: randomBytes(10 * CHUNK_BYTES) }]), (e: unknown) => e instanceof PipeLostError);
    assert.equal(uploads, 3);
    // The chunks that arrived are written, then the writer is retired after its grace (3 s) and its upload goes.
    await sleep(3_500);
    await until(() => listFiles(join(runRoot, "tmp", "pipe-uploads")).length === 0, 10_000, "the cut upload to be removed");
    assert.equal(readFileSync(join(runRoot, "work/model.bin"), "utf8"), "old");
    assert.deepEqual(listFiles(join(runRoot, "work")), ["model.bin"], "no temporary file in work/");
    assert.deepEqual(listFiles(join(runRoot, "tmp", "pipe-uploads")), []);
  });

  it("a long upload keeps its writer: every frame counts as a ping", async () => {
    const quick = await localServer({ writerGraceMs: 600 });
    try {
      const { id, secret } = await quick.server.createRun("slow");
      // No pings at all, and each frame held back 150 ms: 24 chunks take 3.6 s against a 600 ms grace.
      let line = Promise.resolve();
      const socket = await wrapped(quick.url, (raw, data) => {
        line = line.then(() => sleep(data.startsWith('{"t":"upload"') ? 150 : 0)).then(() => raw.send(data));
      });
      const lost: string[] = [];
      const a = new PipeClient({ socket, run: id, token: secret, tab: "a", mode: "write", pingMs: 60_000, onLost: (code) => lost.push(code) });
      await a.ready;
      const bytes = randomBytes(24 * CHUNK_BYTES);
      await a.syncFiles([{ path: "slow.bin", op: "write", bytes }]);
      assert.deepEqual(lost, []);
      assert.equal(sha(readFileSync(join(quick.root, "runs", id, "work/slow.bin"))), sha(bytes));
      a.close();
    } finally {
      await quick.remove();
    }
  });

  it("keeps the 64 MiB frame limit: one frame past it closes the socket (1009)", async () => {
    const { id, secret } = await local.server.createRun("payload");
    const raw = new WebSocket(local.url);
    await new Promise((resolve, reject) => (raw.once("open", resolve), raw.once("error", reject)));
    raw.send(JSON.stringify({ t: "hello", run: id, token: secret, mode: "write", tab: "raw" }));
    const closed = new Promise<number>((resolve) => raw.once("close", (code) => resolve(code)));
    raw.send(JSON.stringify({ t: "files", id: 1, changes: [{ path: "x.bin", op: "write", data: "A".repeat(65 * MiB) }] }));
    assert.equal(await closed, 1009);
  });
});

describe("chunked workspace in the pipe itself", () => {
  let root: string;
  let pipe: RunPipe;
  const frames = new Map<string, PipeFrame[]>();
  const socket = (name: string): PipeSocket => {
    frames.set(name, []);
    return { id: name, send: (frame) => frames.get(name)!.push(frame), close: () => undefined };
  };
  const answer = (name: string, id: number) => frames.get(name)!.find((f) => f.t === "res" && f.id === id) as Extract<PipeFrame, { t: "res" }> | undefined;
  const work = () => join(root, "runs", "inproc", "work");
  const uploads = () => join(root, "runs", "inproc", "tmp", "pipe-uploads");
  /** Send `bytes` as upload `id` of `from`, CHUNK_BYTES at a time. */
  const upload = async (from: PipeSocket, id: string, bytes: Uint8Array) => {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) await pipe.upload(from, id, offset, toBase64(bytes.subarray(offset, offset + CHUNK_BYTES)));
  };

  before(async () => {
    root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-chunk-"));
    pipe = await RunPipe.open({
      ref: { disk: "dsk-local", region: "local", id: "inproc" },
      mountToken: "local",
      mountRoot: root,
      model: new ModelProxy({ baseUrl: "http://127.0.0.1:9/v1", model: "stub", budgetTokens: 1 }),
      lease: { heartbeatMs: 500, expiryMs: 5_000, marginMs: 1_000 },
      acquire: async (opts) => localClaim(root, opts),
      claimDir: (dir) => openClaimDir(dir, { fstype: null }),
      maxUnfinishedUploads: 300,
    });
  });
  after(async () => {
    await pipe.release().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("a writer retired between its last chunk and the write-through lands nothing", async () => {
    const a = socket("a");
    await pipe.attach(a, "a", false);
    await pipe.files(a, 1, [{ path: "m.bin", op: "write", data: text("old") }]);
    assert.equal(answer("a", 1)?.ok, true);
    const bytes = randomBytes(CHUNK_BYTES + 1000);
    await upload(a, "upload-a-0001", bytes);
    assert.equal(listFiles(uploads()).length, 1, "the upload is on the disk, outside work/");
    // Fenced for this writer: another tab takes the run.
    const b = socket("b");
    await pipe.attach(b, "b", true);
    await pipe.files(a, 2, [{ path: "m.bin", op: "write", upload: { id: "upload-a-0001", size: bytes.length, sha256: sha(bytes) } }]);
    const res = answer("a", 2);
    assert.equal(res?.ok, false);
    assert.match(res && !res.ok ? res.error.message : "", /does not hold the run/);
    assert.equal(readFileSync(join(work(), "m.bin"), "utf8"), "old");
    assert.deepEqual(listFiles(uploads()), [], "the retired writer's upload is removed");
  });

  it("a writer retired while its write-through is in flight lands nothing (the rename checks the epoch)", async () => {
    const b = socket("b");
    await pipe.attach(b, "b", true);
    const bytes = randomBytes(CHUNK_BYTES + 5);
    await upload(b, "upload-b-0001", bytes);
    // The write-through starts, and in the same turn a takeover retires its writer.
    const inflight = pipe.files(b, 3, [{ path: "m.bin", op: "write", upload: { id: "upload-b-0001", size: bytes.length, sha256: sha(bytes) } }]);
    const takeover = pipe.attach(socket("c"), "c", true);
    await Promise.all([inflight, takeover]);
    const res = answer("b", 3);
    assert.equal(res?.ok, false);
    assert.equal(res && !res.ok ? res.error.code : "", "MOVED");
    assert.equal(readFileSync(join(work(), "m.bin"), "utf8"), "old");
    assert.deepEqual(listFiles(uploads()), []);
    assert.deepEqual(listFiles(work()), ["m.bin"]);
  });

  it("a writer retired in flight never removes a directory it was replacing, nor deletes one", async () => {
    mkdirSync(join(work(), "keep", "sub"), { recursive: true });
    writeFileSync(join(work(), "keep", "sub", "x.txt"), "kept");
    mkdirSync(join(work(), "keep2"), { recursive: true });
    writeFileSync(join(work(), "keep2", "y.txt"), "kept too");
    const cases: { name: string; changes: (from: PipeSocket) => Promise<Parameters<RunPipe["files"]>[2]> }[] = [
      {
        name: "upload over a directory",
        changes: async (from) => {
          const bytes = randomBytes(CHUNK_BYTES + 3);
          await upload(from, `upload-${from.id}-dir`, bytes);
          return [{ path: "keep", op: "write", upload: { id: `upload-${from.id}-dir`, size: bytes.length, sha256: sha(bytes) } }];
        },
      },
      { name: "inline write over a directory", changes: async () => [{ path: "keep", op: "write", data: text("a file") }] },
      { name: "delete of a directory", changes: async () => [{ path: "keep2", op: "delete" }] },
    ];
    let n = 0;
    for (const c of cases) {
      const w = socket(`w${++n}`);
      await pipe.attach(w, w.id, true);
      const changes = await c.changes(w);
      const inflight = pipe.files(w, 10, changes);
      const takeover = pipe.attach(socket(`t${n}`), `t${n}`, true);
      await Promise.all([inflight, takeover]);
      const res = answer(w.id, 10);
      assert.equal(res?.ok, false, c.name);
      assert.equal(readFileSync(join(work(), "keep", "sub", "x.txt"), "utf8"), "kept", c.name);
      assert.equal(readFileSync(join(work(), "keep2", "y.txt"), "utf8"), "kept too", c.name);
    }
    assert.deepEqual(listFiles(uploads()), []);
  });

  it("bounds a writer's unfinished uploads: one open file at a time, and a cap on their number", async () => {
    const w = socket("cap");
    await pipe.attach(w, "cap", true);
    const fds = () => readdirSync("/proc/self/fd").length;
    const before = fds();
    const firstBytes = randomBytes(16);
    for (let i = 0; i < 300; i++) await pipe.upload(w, `cap-upload-${String(i).padStart(4, "0")}`, 0, toBase64(i === 0 ? firstBytes : randomBytes(16)));
    assert.ok(fds() - before <= 2, `${fds() - before} more open files for 300 unfinished uploads`);
    assert.equal(listFiles(uploads()).length, 300);
    // The 301st has no record: the write-through that names it fails.
    const bytes = randomBytes(16);
    await pipe.upload(w, "cap-upload-over", 0, toBase64(bytes));
    await pipe.files(w, 20, [{ path: "over.bin", op: "write", upload: { id: "cap-upload-over", size: 16, sha256: sha(bytes) } }]);
    assert.match((answer("cap", 20) as Extract<PipeFrame, { ok: false }>).error.message, /no upload/);
    // The first of the 300, its file closed while the others were written, still completes whole.
    await pipe.files(w, 21, [{ path: "first.bin", op: "write", upload: { id: "cap-upload-0000", size: 16, sha256: sha(firstBytes) } }]);
    assert.equal(answer("cap", 21)?.ok, true);
    assert.equal(sha(readFileSync(join(work(), "first.bin"))), sha(firstBytes));
    await pipe.attach(socket("after-cap"), "after-cap", true);
    assert.deepEqual(listFiles(uploads()), [], "the retired writer's 300 uploads are removed");
  });

  it("refuses an upload whose content does not match, and keeps the old file", async () => {
    const d = socket("d");
    await pipe.attach(d, "d", true);
    const bytes = randomBytes(CHUNK_BYTES + 7);
    await upload(d, "upload-d-0001", bytes);
    await pipe.files(d, 4, [{ path: "m.bin", op: "write", upload: { id: "upload-d-0001", size: bytes.length, sha256: sha(randomBytes(8)) } }]);
    const res = answer("d", 4);
    assert.equal(res?.ok, false);
    assert.match(res && !res.ok ? res.error.message : "", /SHA-256/);
    // A gap in the chunks fails the upload too.
    await pipe.upload(d, "upload-d-0002", 0, toBase64(bytes.subarray(0, 100)));
    await pipe.upload(d, "upload-d-0002", 200, toBase64(bytes.subarray(200, 300)));
    await pipe.files(d, 5, [{ path: "m.bin", op: "write", upload: { id: "upload-d-0002", size: 300, sha256: sha(bytes.subarray(0, 300)) } }]);
    assert.match((answer("d", 5) as Extract<PipeFrame, { ok: false }>).error.message, /expected 100/);
    assert.equal(readFileSync(join(work(), "m.bin"), "utf8"), "old");
    assert.deepEqual(listFiles(uploads()), []);
  });
});

describe("an attach that hashes a large workspace", () => {
  it("is not taken for a silent writer while it hashes, however short the grace", async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-chunk-grace-"));
    const pipe = await RunPipe.open({
      ref: { disk: "dsk-local", region: "local", id: "grace" },
      mountToken: "local",
      mountRoot: root,
      model: new ModelProxy({ baseUrl: "http://127.0.0.1:9/v1", model: "stub", budgetTokens: 1 }),
      lease: { heartbeatMs: 500, expiryMs: 5_000, marginMs: 1_000 },
      acquire: async (opts) => localClaim(root, opts),
      claimDir: (dir) => openClaimDir(dir, { fstype: null }),
      writerGraceMs: 20,
    });
    try {
      const big = Buffer.alloc(384 * MiB, 7);
      mkdirSync(join(root, "runs", "grace", "work"), { recursive: true });
      writeFileSync(join(root, "runs", "grace", "work", "big.bin"), big);
      const frames: PipeFrame[] = [];
      const started = performance.now();
      await pipe.attach({ id: "a", send: (frame) => frames.push(frame), close: () => undefined }, "a", false);
      const hashMs = performance.now() - started;
      assert.ok(hashMs > 300, `hashing took ${Math.round(hashMs)} ms, too fast for this test to mean anything`);
      assert.deepEqual(frames.filter((f) => f.t === "lost"), []);
      assert.equal(pipe.writerTab, "a");
      assert.ok(frames.some((f) => f.t === "attached"));
    } finally {
      await pipe.release().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a restore that does not match its manifest", () => {
  it("rejects `ready` with RESTORE_FAILED and tells the pipe", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const told: unknown[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data)) as { t: string };
        if (frame.t === "restored") told.push(frame);
        if (frame.t !== "hello") return;
        const real = new TextEncoder().encode("the real content");
        const manifest: ManifestEntry[] = [{ path: "a.txt", kind: "file", size: real.length, sha256: sha(real), mode: 0o644, mtimeMs: 0 }];
        ws.send(JSON.stringify({ t: "attached", epoch: 1, generation: 1, manifest, model: "m", budget: { used: 0, cap: 1 }, environments: [] }));
        ws.send(JSON.stringify({ t: "restore-chunk", path: "a.txt", offset: 0, data: text("the fake content") }));
        ws.send(JSON.stringify({ t: "restore-end", files: 1, bytes: real.length }));
      });
    });
    await new Promise((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    try {
      const client = new PipeClient({ url: `ws://127.0.0.1:${port}/`, run: "r", token: "t", tab: "t", mode: "write" });
      await assert.rejects(client.ready, (e: unknown) => e instanceof PipeLostError && e.code === "RESTORE_FAILED" && /SHA-256/.test(e.message));
      await until(() => told.length > 0, 2_000, "the restored frame");
      assert.deepEqual(told, [{ t: "restored", ok: false, error: "a.txt: its content does not match the manifest's SHA-256" }]);
    } finally {
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(r));
    }
  });
});
