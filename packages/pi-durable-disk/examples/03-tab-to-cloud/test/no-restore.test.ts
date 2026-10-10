// A large result in work/ that no writer needs in its own workspace: with `noRestore` prefixes the attach leaves it out (the frame says
// which prefixes), it counts toward no restore limit, a writer neither deletes it nor is sent it, and a host that writes more of it
// still lands it on the disk. Nothing here names what the prefix holds.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { remoteLocalHost, REMOTE_LOCAL } from "../pipe/remote-local.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import { lazyPath } from "../wire.ts";
import { localServer } from "./_local.ts";

const MB = 1024 * 1024;
const LAZY = ["big/"];
const bytes = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 4096) b[i] = (i / 4096 + seed) & 255;
  return b;
};

describe("lazyPath", () => {
  it("matches a prefix as a directory, with or without its slash, and nothing that merely starts with the same letters", () => {
    assert.equal(lazyPath("big/a.bin", LAZY), true);
    assert.equal(lazyPath("big", ["big"]), true);
    assert.equal(lazyPath("big/deep/x", ["big"]), true);
    assert.equal(lazyPath("bigger/a", LAZY), false);
    assert.equal(lazyPath("a/big/x", LAZY), false);
    assert.equal(lazyPath("anything", []), false);
    assert.equal(lazyPath("anything", [""]), false);
  });
});

describe("noRestore through a real pipe", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const cloud = remoteLocalHost();
  before(async () => {
    local = await localServer({ cloud, noRestore: LAZY, restoreLimitBytes: 8 * MB, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
    await cloud.close?.();
  });
  const until = async (check: () => boolean, ms = 40_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error(`timed out: ${events.slice(-6).map((e) => e.event).join(",")}`);
  };

  it("sends a 64 MB result to no writer, keeps it on the disk through every attach and a remote host's attach, and takes more of it from a writer", async () => {
    const { id, secret } = await local.server.createRun("lazy");
    const work = join(local.root, "runs", id, "work");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    const first = await a.ready;
    assert.ok(first.t === "attached");
    assert.deepEqual(first.noRestore, LAZY, "the frame names the lazy prefixes");
    // A host writes a 64 MB result (more than the 8 MB restore limit) and a small file beside it.
    await a.syncFiles([
      { path: "big/chunk-0000.bin", op: "write", bytes: bytes(64 * MB, 1) },
      { path: "big/manifest.json", op: "write", bytes: new TextEncoder().encode('{"done":true}') },
      { path: "small/policy.json", op: "write", bytes: new TextEncoder().encode('{"p":1}') },
    ]);
    assert.equal(statSync(join(work, "big/chunk-0000.bin")).size, 64 * MB, "on the disk");
    a.close();

    // The next writer is sent the small file and none of the big ones; 64 MB is over its 8 MB limit and the attach still succeeds.
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "b", mode: "write", takeover: true });
    const attached = await b.ready;
    assert.ok(attached.t === "attached");
    assert.deepEqual(attached.files.map((f) => f.path).sort(), ["small", "small/policy.json"], "only what is not lazy");
    assert.deepEqual(attached.noRestore, LAZY);
    // It adds to the lazy area (as a GPU box writing its chunks does) and changes a normal file; its attach deleted nothing.
    await b.syncFiles([
      { path: "big/chunk-0001.bin", op: "write", bytes: bytes(2 * MB, 2) },
      { path: "small/policy.json", op: "write", bytes: new TextEncoder().encode('{"p":2}') },
    ]);
    assert.equal(statSync(join(work, "big/chunk-0000.bin")).size, 64 * MB, "the first chunk is still there");
    assert.equal(statSync(join(work, "big/chunk-0001.bin")).size, 2 * MB, "and the new one landed");
    assert.equal(readFileSync(join(work, "small/policy.json"), "utf8"), '{"p":2}');
    b.close();
  });

  it("a remote host attaches without the big files, and the run still has them on the disk when the host and the next run-here are done", async () => {
    const { id, secret } = await local.server.createRun("lazy-remote");
    const work = join(local.root, "runs", id, "work");
    const seen: string[] = [];
    const a: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && a.send({ t: "drained", switchId: f.switchId }) });
    await a.ready;
    await a.syncFiles([
      { path: "big/chunk-0000.bin", op: "write", bytes: bytes(10 * MB, 3) },
      { path: "keep/notes.txt", op: "write", bytes: new TextEncoder().encode("kept") },
    ]);
    a.send({ t: "switch", to: REMOTE_LOCAL.id });
    await until(() => events.some((e) => e.event === "switch.done" && e.data.run === id));
    const v = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => void seen.push(f.t) });
    await v.ready;
    v.send({ t: "switch", to: "tab" });
    await until(() => seen.includes("run-here"));
    // The remote host and the page never deleted what they were not sent.
    assert.equal(statSync(join(work, "big/chunk-0000.bin")).size, 10 * MB);
    assert.equal(readFileSync(join(work, "keep/notes.txt"), "utf8"), "kept");
    assert.ok(existsSync(join(work, "big")));
    v.close();
  });

  it("does not send a viewer the lazy files, and a release lets the reads in flight finish and then refuses new ones", async () => {
    const { id, secret } = await local.server.createRun("lazy-release");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    await a.syncFiles([
      { path: "big/chunk-0000.bin", op: "write", bytes: bytes(80 * MB, 5) },
      { path: "small/x.txt", op: "write", bytes: new TextEncoder().encode("x") },
    ]);
    const pipe = local.server.runs.get(id)!.pipe!;
    // A viewer's file list is over the 64 MiB view limit only because of the lazy file; leaving it out, the list is small and complete.
    const listed = await pipe.viewerFiles();
    assert.deepEqual(listed.map((f) => f.path).sort(), ["small", "small/x.txt"]);
    // A read in flight when the release begins completes with all its bytes; the release waits for it; a read begun after is refused.
    const reading = pipe.readWork("big/chunk-0000.bin");
    const releasing = pipe.release();
    assert.equal(pipe.releasing, true);
    await assert.rejects(pipe.readWork("small/x.txt"), /being released/);
    assert.equal((await reading)?.length, 80 * MB, "the read that began first has all its bytes");
    await releasing;
    a.close();
  });
});
