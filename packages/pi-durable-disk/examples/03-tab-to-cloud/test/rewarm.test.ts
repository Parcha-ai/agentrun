// A host that keeps a spare box for the run's next move (`rewarm`): the spare is used by the move to a remote host, so when a tab takes the run
// back from that host the server asks for the next spare, once, and never while the remote host runs the run. Without `rewarm` the server asks once.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { remoteLocalHost, REMOTE_LOCAL } from "../pipe/remote-local.ts";
import type { CloudHost } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import type { PipeFrame } from "../wire.ts";
import { localServer } from "./_local.ts";

async function roundTrip(rewarm: boolean): Promise<{ prewarms: number; during: number }> {
  const inner = remoteLocalHost();
  let prewarms = 0;
  const cloud: CloudHost = { ...inner, ...(rewarm ? { rewarm: true } : {}), prewarm: () => void prewarms++ };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const local = await localServer({ cloud, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  try {
    const until = async (check: () => boolean) => {
      for (const end = Date.now() + 30_000; !check(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error("timed out");
    };
    const { id, secret } = await local.server.createRun("remote");
    const a: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && a.send({ t: "drained", switchId: f.switchId }) });
    await a.ready;
    a.send({ t: "switch", to: REMOTE_LOCAL.id });
    await until(() => events.some((e) => e.event === "switch.done" && e.data.run === id));
    const during = prewarms; // the remote host's own attach: no new spare while it runs the run
    a.close();
    const seen: PipeFrame[] = [];
    const v = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
    await v.ready;
    v.send({ t: "switch", to: "tab" });
    await until(() => seen.some((f) => f.t === "run-here"));
    const runHere = seen.find((f) => f.t === "run-here")!;
    assert.ok(runHere.t === "run-here");
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "write", switchId: runHere.switchId });
    await b.ready;
    // The spare is asked for just after the attach is acknowledged: give it a moment in both cases, so "not again" is a measurement.
    for (const end = Date.now() + 2_000; prewarms < 2 && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) continue;
    v.close();
    b.close();
    return { prewarms, during };
  } finally {
    await local.remove();
    await inner.close?.();
  }
}

describe("the next spare box after a task", () => {
  it("is asked for once more when the tab takes the run back, if the host rewarms", async () => {
    const r = await roundTrip(true);
    assert.equal(r.during, 1, "one spare for the first move, none while the remote host runs the run");
    assert.equal(r.prewarms, 2, "one more when the tab has the run again");
  });
  it("is not asked for again without rewarm", async () => {
    const r = await roundTrip(false);
    assert.equal(r.prewarms, 1);
  });
});
