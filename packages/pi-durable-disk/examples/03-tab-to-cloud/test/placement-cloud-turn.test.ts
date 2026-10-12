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

describe("a message that arrives while the agent is on its way home", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const sinks: ((frame: PipeFrame) => void)[] = [];
  const submitted: string[] = [];
  const decided: { phase: string; message: string; choice: string }[] = [];
  // A training request belongs on the GPU; the end of a turn sends the agent home.
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      const choice = query.phase === "done" ? "tab" : /train/.test(query.message) ? "gpu" : "tab";
      decided.push({ phase: query.phase, message: query.message, choice });
      const decision: PlacementDecision = { id: `d-${decided.length}`, phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 0.9 : 0.1 })), choice, latency_ms: 1, model: "scripted" };
      return decision;
    },
  };
  const cloud: CloudHost = {
    environments: [{ id: "gpu", label: "A GPU", phrase: "a GPU", kind: "cloud" }],
    start: async () => ({ host: "gpu-1" }),
    stop: async () => undefined,
    attachViewer: async (_ref, send) => {
      sinks.push(send);
      return () => undefined;
    },
    submit: async (_ref, text) => {
      submitted.push(text);
      // The first task's turn ends on the GPU; the second one's is never finished (the test ends first).
      if (submitted.length === 1) setTimeout(() => sinks.forEach((send) => send({ t: "event", event: tag({ kind: "events", events: [{ type: "run_end" }] }) })), 100);
    },
  };
  before(async () => {
    local = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 60_000 });
  });
  after(async () => {
    await local.remove();
  });
  const until = async (check: () => boolean, ms = 20_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 50))) {
      if (Date.now() > end) throw new Error(`timed out; decided: ${JSON.stringify(decided)}; submitted: ${submitted.join(" | ")}`);
    }
  };

  it("is placed as a message of its own once the move ends: a second training task goes to the GPU, not into the browser", async () => {
    const { id, secret } = await local.server.createRun("homeward");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
    await tab.ready;
    const seen: PipeFrame[] = [];
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
    await page.ready;
    page.send({ t: "submit", text: "train the first one", requestId: "t1" });
    await until(() => seen.some((f) => f.t === "run-here")); // the turn ended on the GPU and the agent is asked home
    const runHere = seen.find((f): f is Extract<PipeFrame, { t: "run-here" }> => f.t === "run-here")!;
    const homeFrames: PipeFrame[] = [];
    const home: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "write", switchId: runHere.switchId, onFrame: (f) => {
      homeFrames.push(f);
      if (f.t === "drain") home.send({ t: "drained", switchId: f.switchId });
    } });
    await home.ready;
    // The move home is still going (the page has not reported its notice): the second training task arrives now.
    page.send({ t: "submit", text: "train the second one", requestId: "t2" });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!submitted.includes("train the second one"), "queued, not delivered while the move runs");
    home.send({ t: "switched", switchId: runHere.switchId });
    await until(() => submitted.includes("train the second one"));
    assert.ok(!homeFrames.some((f) => f.t === "submit" && f.text === "train the second one"), "it did not land in the browser, which has no way to move");
    assert.deepEqual(decided.filter((d) => d.phase === "start").map((d) => d.message), ["train the first one", "train the second one"], "it was asked about, as a message of its own");
    tab.close();
    page.close();
    home.close();
  });
});

describe("a mounted cloud host that reports its notice (notifiesSwitched)", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const submitted: string[] = [];
  let api: { switched(ref: unknown, switchId: string): void } | undefined;
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      const choice = query.phase === "done" ? "tab" : /teach/.test(query.message) ? "vm" : "tab";
      const decision: PlacementDecision = { id: `n-${query.phase}`, phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 0.9 : 0.1 })), choice, latency_ms: 1, model: "scripted" };
      return decision;
    },
  };
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }],
    notifiesSwitched: true,
    bind: (server) => void (api = server as never),
    start: async (ref, run) => {
      // The host's agent commits its notice shortly after it started, and says so.
      setTimeout(() => api?.switched(ref, (run as { move: { id: string } }).move.id), 300);
      return { host: "vm-1" };
    },
    stop: async () => undefined,
    attachViewer: async () => () => undefined,
    submit: async (_ref, text) => void submitted.push(text),
  };
  before(async () => {
    local = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 60_000 });
  });
  after(async () => {
    await local.remove();
  });

  it("delivers the message the move was for to the host once the host reports its notice", async () => {
    const { id, secret } = await local.server.createRun("notified");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
    await tab.ready;
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: () => undefined });
    await page.ready;
    page.send({ t: "submit", text: "teach it to move", requestId: "n1" });
    for (const end = Date.now() + 10_000; submitted.length === 0; await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error("the message never reached the host");
    assert.deepEqual(submitted, ["teach it to move"]);
    tab.close();
    page.close();
  });
});
