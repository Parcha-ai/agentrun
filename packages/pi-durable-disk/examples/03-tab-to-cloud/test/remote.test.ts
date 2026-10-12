// A remote host (remote-host.ts as a child process, pipe/remote-local.ts) runs the run through the pipe: the server dials
// it and invites it, it attaches as the writer with the move's notice, drains on the next switch, and the page that
// asked gets the run back with a notice naming the remote host.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { remoteLocalHost, REMOTE_LOCAL } from "../pipe/remote-local.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import type { PipeFrame } from "../wire.ts";
import { localServer } from "./_local.ts";

describe("a remote host through the pipe", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const cloud = remoteLocalHost();
  before(async () => {
    local = await localServer({ cloud, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
    await cloud.close?.();
  });

  const until = async (check: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out; server: ${events.slice(-8).map((e) => `${e.event} ${JSON.stringify(e.data).slice(0, 160)}`).join(" | ")}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("runs the run with the move's notice, drains on the next switch, and hands it back to the page", async () => {
    const { id, secret } = await local.server.createRun("remote");
    const a: PipeClient = new PipeClient({
      url: local.url, run: id, token: secret, tab: "a", mode: "write",
      onFrame: (f) => {
        if (f.t === "drain") a.send({ t: "drained", switchId: f.switchId });
      },
    });
    await a.ready;
    a.send({ t: "switch", to: REMOTE_LOCAL.id });
    const state = local.server.runs.get(id)!;
    // switch.done: the remote host committed the notice and resumed the run.
    await until(() => events.some((e) => e.event === "switch.done" && e.data.run === id));
    assert.equal(state.placement.where, "tab");
    assert.equal(state.placement.where === "tab" && state.placement.env, REMOTE_LOCAL.id);
    a.close();

    // The page, watching, switches it back into itself: the remote host drains, the page gets the run.
    const seen: PipeFrame[] = [];
    const v = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
    await v.ready;
    v.send({ t: "switch", to: "tab" });
    await until(() => seen.some((f) => f.t === "run-here"));
    const runHere = seen.find((f) => f.t === "run-here")!;
    assert.ok(runHere.t === "run-here");
    assert.ok(events.some((e) => e.event === "switch.drained" && e.data.switchId === runHere.switchId && e.data.drained === true));
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "write", switchId: runHere.switchId });
    const attached = await b.ready;
    assert.ok(attached.t === "attached");
    assert.deepEqual({ ...attached.move, id: undefined }, { id: undefined, from: REMOTE_LOCAL.phrase, planned: true });
    assert.equal(state.remote, undefined);
    v.close();
    b.close();
  });
});
