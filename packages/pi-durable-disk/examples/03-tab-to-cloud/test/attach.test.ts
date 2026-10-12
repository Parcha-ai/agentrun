// An attach's critical path: the writer gets `attached` and the attach returns before the digest of work/ (for the log
// line only) is computed; the log line follows with it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openClaimDir } from "@parcha/pi-durable-disk";
import { ModelProxy } from "../pipe/model-proxy.ts";
import { manifestDigest, RunPipe, type PipeSocket } from "../pipe/run-pipe.ts";
import type { PipeFrame } from "../wire.ts";
import { localClaim } from "./_local.ts";

describe("an attach", () => {
  let root: string;
  let pipe: RunPipe;
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  let finishDigest: () => void = () => undefined;
  let digesting = false;

  before(async () => {
    root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-attach-"));
    pipe = await RunPipe.open({
      ref: { disk: "dsk-local", region: "local", id: "attach" },
      mountToken: "local",
      mountRoot: root,
      model: new ModelProxy({ baseUrl: "http://127.0.0.1:9/v1", model: "stub", budgetTokens: 1 }),
      lease: { heartbeatMs: 500, expiryMs: 5_000, marginMs: 1_000 },
      acquire: async (opts) => localClaim(root, opts),
      claimDir: (dir) => openClaimDir(dir, { fstype: null }),
      log: (event, data = {}) => logs.push({ event, data }),
      // A digest that takes as long as the test says.
      digest: async (entries) => {
        digesting = true;
        await new Promise<void>((resolve) => (finishDigest = resolve));
        return manifestDigest(entries);
      },
    });
  });
  after(async () => {
    finishDigest();
    await pipe.release().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns, and the writer has its manifest, before the digest of work/ for the log is done", async () => {
    const frames: PipeFrame[] = [];
    const socket: PipeSocket = { id: "a", send: (frame) => frames.push(frame), close: () => undefined };
    assert.equal(await pipe.attach(socket, "a", false), "writer");
    assert.ok(frames.some((f) => f.t === "attached"));
    assert.ok(digesting, "the digest started");
    assert.ok(!logs.some((l) => l.event === "pipe.attach"), "the log line waits for the digest, the attach does not");
    finishDigest();
    for (let i = 0; i < 100 && !logs.some((l) => l.event === "pipe.attach"); i++) await new Promise((r) => setTimeout(r, 10));
    const line = logs.find((l) => l.event === "pipe.attach");
    assert.equal(line?.data.workDigest, await manifestDigest([]));
  });
});
