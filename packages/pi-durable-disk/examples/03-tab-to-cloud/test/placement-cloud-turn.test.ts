// A run placed on a mounted cloud host (a VM that mounts the disk) comes home when the agent's turn ends there: the host's events reach
// the server through the viewer relay, not through a tab's `view` frames, so the end of the turn is read from that path too.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PLACEMENT_QUESTIONS, type Placer, type PlacementDecision } from "../placement.ts";
import type { CloudHost } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import { tag, type PipeFrame } from "../wire.ts";
import { localServer } from "./_local.ts";

describe("a task placed on a mounted cloud host", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const asked: string[] = [];
  const sinks: ((frame: PipeFrame) => void)[] = [];
  const submitted: string[] = [];
  let decideMs = 0;
  let endTurns = true;
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      asked.push(query.phase);
      await new Promise((r) => setTimeout(r, decideMs)); // a typed question takes a moment: a second message can arrive while it is out
      const choice = query.phase === "start" ? "vm" : "tab";
      const decision: PlacementDecision = { id: `d-${asked.length}`, phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 0.9 : 0.1 })), choice, latency_ms: 1, model: "scripted" };
      return decision;
    },
  };
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }],
    start: async () => ({ host: "vm-1" }),
    stop: async () => undefined,
    attachViewer: async (_ref, send) => {
      sinks.push(send);
      return () => undefined;
    },
    submit: async (_ref, text) => {
      submitted.push(text);
      // The agent's turn on the VM ends: the instance's events come back to the server through the relay.
      if (!endTurns) return;
      setTimeout(() => sinks.forEach((send) => send({ t: "event", event: tag({ kind: "events", events: [{ type: "run_end" }] }) })), 100);
    },
  };
  before(async () => {
    local = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 60_000 });
  });
  after(async () => {
    await local.remove();
  });
  const until = async (check: () => boolean, ms = 15_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 50))) {
      if (Date.now() > end) throw new Error(`timed out; asked: ${asked.join(",")}`);
    }
  };

  it("asks the done question and brings the run home when the turn ends on the host", async () => {
    const { id, secret } = await local.server.createRun("mounted");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
    await tab.ready;
    const seen: PipeFrame[] = [];
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
    await page.ready;
    page.send({ t: "submit", text: "open a browser and look something up", requestId: "r1" });
    await until(() => submitted.length === 1);
    await until(() => asked.includes("done"));
    await until(() => seen.some((f) => f.t === "run-here"));
    assert.deepEqual(asked, ["start", "done"]);
    tab.close();
    page.close();
  });

  it("serializes two quick messages: the second never overwrites the first, and both reach the host in order", async () => {
    decideMs = 300;
    endTurns = false;
    const before = submitted.length;
    const askedBefore = asked.length;
    try {
      const { id, secret } = await local.server.createRun("quick");
      const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
      await tab.ready;
      const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: () => undefined });
      await page.ready;
      page.send({ t: "submit", text: "quick message one", requestId: "q1" });
      page.send({ t: "submit", text: "quick message two", requestId: "q2" });
      await until(() => submitted.length - before >= 2);
      assert.deepEqual(submitted.slice(before), ["quick message one", "quick message two"], "both delivered, in the order they were sent");
      assert.equal(asked.length - askedBefore, 2, "one typed question each, asked one after the other");
      tab.close();
      page.close();
    } finally {
      decideMs = 0;
      endTurns = true;
    }
  });
});
