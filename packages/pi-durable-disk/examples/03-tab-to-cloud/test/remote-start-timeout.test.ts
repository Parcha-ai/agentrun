// A remote host that never answers fails the move after a bound, loudly, instead of leaving the run "moving" forever.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { CloudHost } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import { localServer } from "./_local.ts";

describe("a move to a remote host that does not answer", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const cloud: CloudHost = {
    environments: [{ id: "silent", label: "A silent host", phrase: "a silent host", kind: "remote" }],
    async start() {
      return { host: "none" };
    },
    async stop() {},
    startRemote: () => new Promise(() => undefined),
  };
  before(async () => {
    local = await localServer({ cloud, remoteStartMs: 300, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
  });

  it("fails with the host's name and parks the run", async () => {
    const { id, secret } = await local.server.createRun("silent");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
    await tab.ready;
    tab.send({ t: "switch", to: "silent" });
    for (const end = Date.now() + 10_000; !events.some((e) => e.event === "switch.failed"); await new Promise((r) => setTimeout(r, 50))) {
      if (Date.now() > end) throw new Error(`no switch.failed: ${events.slice(-5).map((e) => e.event).join(",")}`);
    }
    const failed = events.find((e) => e.event === "switch.failed")!;
    assert.match(String(failed.data.error), /A silent host did not answer in 0 s|did not answer/);
    assert.equal(local.server.runs.get(id)!.placement.where, "parked");
    tab.close();
  });
});

describe("a remote host that answers after the bound", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let signal: AbortSignal | undefined;
  let closed = 0;
  let finish: (() => void) | undefined;
  const cloud: CloudHost = {
    environments: [{ id: "slow", label: "A slow host", phrase: "a slow host", kind: "remote" }],
    async start() {
      return { host: "none" };
    },
    async stop() {},
    startRemote: (_ref, _env, _invite, s) => {
      signal = s;
      return new Promise((resolve) => {
        finish = () => resolve({ socket: { close: () => void closed++ } as never, host: "a slow host" });
      });
    },
  };
  before(async () => {
    local = await localServer({ cloud, remoteStartMs: 300, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
  });

  it("is told to give up at the bound, and a socket it still produces is closed, so no host is left behind a parked run", async () => {
    const { id, secret } = await local.server.createRun("slow");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
    await tab.ready;
    tab.send({ t: "switch", to: "slow" });
    for (const end = Date.now() + 10_000; !events.some((e) => e.event === "switch.failed"); await new Promise((r) => setTimeout(r, 50))) {
      if (Date.now() > end) throw new Error(`no switch.failed: ${events.slice(-5).map((e) => e.event).join(",")}`);
    }
    assert.ok(signal, "the cloud was handed a signal");
    assert.equal(signal!.aborted, true, "aborted when the bound passed");
    assert.equal(local.server.runs.get(id)!.placement.where, "parked");
    assert.equal(closed, 0, "nothing arrived yet");
    finish!();
    for (const end = Date.now() + 5_000; closed === 0; await new Promise((r) => setTimeout(r, 20))) {
      if (Date.now() > end) throw new Error("a socket that arrived after the bound was never closed");
    }
    assert.equal(closed, 1);
    assert.equal(local.server.runs.get(id)!.placement.where, "parked", "the late host did not take the run");
    tab.close();
  });
});
