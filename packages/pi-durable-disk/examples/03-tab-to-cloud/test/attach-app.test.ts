// The attach carries what the host told the page about its agent (`attached.app`), only when there is something: a page with no policy gets the frame it always got.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openClaimDir } from "@parcha/pi-durable-disk";
import { ModelProxy } from "../pipe/model-proxy.ts";
import { RunPipe, type PipeSocket } from "../pipe/run-pipe.ts";
import type { PipeFrame } from "../wire.ts";
import type { AppPolicy } from "../agent.ts";
import { localClaim } from "./_local.ts";

async function attachedFrame(app: AppPolicy | undefined): Promise<Extract<PipeFrame, { t: "attached" }>> {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-attach-app-"));
  const pipe = await RunPipe.open({
    ref: { disk: "dsk-local", region: "local", id: "attach-app" },
    mountToken: "local",
    mountRoot: root,
    model: new ModelProxy({ baseUrl: "http://127.0.0.1:9/v1", model: "stub", budgetTokens: 1 }),
    lease: { heartbeatMs: 500, expiryMs: 5_000, marginMs: 1_000 },
    acquire: async (opts) => localClaim(root, opts),
    claimDir: (dir) => openClaimDir(dir, { fstype: null }),
    log: () => undefined,
    ...(app ? { app } : {}),
  });
  try {
    const frames: PipeFrame[] = [];
    const socket: PipeSocket = { id: "a", send: (frame) => frames.push(frame), close: () => undefined };
    assert.equal(await pipe.attach(socket, "a", false), "writer");
    return frames.find((f): f is Extract<PipeFrame, { t: "attached" }> => f.t === "attached")!;
  } finally {
    await pipe.release().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the attach frame", () => {
  it("carries the app policy the server was given", async () => {
    const app: AppPolicy = { instructions: { mode: "replace", text: "You are a poet." }, withoutExtensions: ["robot-tools"] };
    assert.deepEqual((await attachedFrame(app)).app, app);
  });
  it("has no `app` when the server was given none", async () => {
    assert.equal("app" in (await attachedFrame(undefined)), false);
  });
});
