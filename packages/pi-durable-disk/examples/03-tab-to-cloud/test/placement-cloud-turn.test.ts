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
  /** The model each question was told the root conversation has. */
  const models: (string | undefined)[] = [];
  const sinks: ((frame: PipeFrame) => void)[] = [];
  const submitted: string[] = [];
  let decideMs = 0;
  let endTurns = true;
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      asked.push(query.phase);
      models.push(query.model ? `${query.model.provider}/${query.model.modelId}` : undefined);
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

  it("tells the placer the model the conversation has, from the writer's snapshot and then from the relayed agent_changed of the host the run is on", async () => {
    endTurns = false;
    const askedBefore = asked.length;
    try {
      const { id, secret } = await local.server.createRun("model-fact");
      const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
      await tab.ready;
      const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: () => undefined });
      await page.ready;
      tab.send({ t: "view", event: tag({ kind: "snapshot", event: { type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], usage: {}, agent: { model: { provider: "modal", modelId: "big" } } } }) } as never);
      page.send({ t: "submit", text: "first message", requestId: "m1" });
      await until(() => asked.length - askedBefore >= 1);
      assert.equal(models[askedBefore], "modal/big", "the snapshot's agent is the first fact");
      await until(() => sinks.length > 0 && submitted.includes("first message"));
      // The run is on the host now; its events come back through the relay, the model switched in a batch with other events.
      sinks.forEach((send) => send({ t: "event", event: tag({ kind: "events", events: [{ type: "turn_start" }, { type: "agent_changed", agent: { model: { provider: "steered", modelId: "qwen3.5-27b" } } }] }) }));
      page.send({ t: "submit", text: "second message", requestId: "m2" });
      await until(() => submitted.includes("second message"));
      assert.equal(models[models.length - 1], "steered/qwen3.5-27b", "the relayed agent_changed is the latest fact");
      tab.close();
      page.close();
    } finally {
      endTurns = true;
    }
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

describe("two messages in quick succession while the agent's turn is running", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const submitted: string[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      const choice = query.phase === "done" ? "tab" : /teach/.test(query.message) ? "vm" : "tab";
      const decision: PlacementDecision = { id: `q-${query.message.length}`, phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 0.9 : 0.1 })), choice, latency_ms: 1, model: "scripted" };
      return decision;
    },
  };
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }],
    start: async () => ({ host: "vm-1" }),
    stop: async () => undefined,
    attachViewer: async () => () => undefined,
    submit: async (_ref, text) => void submitted.push(text),
  };
  before(async () => {
    local = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
  });

  it("a message that needs a move waits for the turn that is running in the tab: the tab is never asked to hand over mid-turn", async () => {
    const { id, secret } = await local.server.createRun("rapid");
    const tabFrames: PipeFrame[] = [];
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => { tabFrames.push(f); if (f.t === "drain") tab.send({ t: "drained", switchId: f.switchId }); } });
    await tab.ready;
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: () => undefined });
    await page.ready;
    page.send({ t: "submit", text: "change its colour", requestId: "a" }); // stays in the tab: its turn starts
    page.send({ t: "submit", text: "teach it to move", requestId: "b" }); // needs the VM: arrives while that turn runs
    await new Promise((r) => setTimeout(r, 700));
    assert.ok(tabFrames.some((f) => f.t === "submit" && f.text === "change its colour"), "the first message went to the tab");
    assert.ok(!tabFrames.some((f) => f.t === "drain"), "the tab was not asked to hand the run over while its turn runs");
    assert.ok(!events.some((e) => e.event === "switch.start" && e.data.run === id), "no move started");
    assert.ok(!submitted.includes("teach it to move"));
    // The tab's turn ends: now the message is placed, the tab hands over, and the VM gets it.
    tab.send({ t: "view", event: tag({ kind: "events", events: [{ type: "run_end" }] }) } as never);
    for (const end = Date.now() + 10_000; !submitted.includes("teach it to move"); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error("the message never reached the VM");
    assert.ok(tabFrames.some((f) => f.t === "drain"), "the tab handed over after its turn");
    const at = (name: string) => events.findIndex((e) => e.event === name && e.data.run === id);
    assert.ok(at("switch.start") >= 0);
    tab.close();
    page.close();
  });

  it("a message that stays where it is is not held back by a running turn", async () => {
    const { id, secret } = await local.server.createRun("rapid-stay");
    const tabFrames: PipeFrame[] = [];
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => tabFrames.push(f) });
    await tab.ready;
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: () => undefined });
    await page.ready;
    page.send({ t: "submit", text: "one", requestId: "a" });
    for (const end = Date.now() + 5_000; !tabFrames.some((f) => f.t === "submit" && f.text === "one"); await new Promise((r) => setTimeout(r, 30))) if (Date.now() > end) throw new Error("no first");
    page.send({ t: "submit", text: "two", requestId: "b" });
    // It stays where it is: it reaches the tab while the first turn is still running, without waiting for that turn to end.
    for (const end = Date.now() + 5_000; !tabFrames.some((f) => f.t === "submit" && f.text === "two"); await new Promise((r) => setTimeout(r, 30))) if (Date.now() > end) throw new Error("the second message was held back by the running turn");
    tab.send({ t: "view", event: tag({ kind: "events", events: [{ type: "run_end" }] }) } as never);
    tab.close();
    page.close();
  });
});

describe("a mounted cloud host's turn ends, with messages in flight and with every viewer relaying the same end", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const submitted: string[] = [];
  const sinks: ((frame: PipeFrame) => void)[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const asked: string[] = [];
  let slowFor = "";
  let doneGoesHome = false;
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      asked.push(`${query.phase}:${query.message}`);
      if (slowFor && query.message.includes(slowFor)) await new Promise((r) => setTimeout(r, 400)); // the typed question takes a while
      // Training stays on the VM; a request to go home goes to the tab; the done question keeps the agent where it is.
      const choice = query.phase === "done" ? (doneGoesHome ? "tab" : "vm") : /home/.test(query.message) ? "tab" : "vm";
      const decision: PlacementDecision = { id: `c-${asked.length}`, phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 0.9 : 0.1 })), choice, latency_ms: 1, model: "scripted" };
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
    submit: async (_ref, text) => void submitted.push(text),
  };
  before(async () => {
    local = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
  });
  // A run_end names the submissions it covers: every viewer is sent its own copy of the same one.
  const end = (i: number, inputs: number[] = []) => sinks[i]!({ t: "event", event: tag({ kind: "events", events: [{ type: "run_end", ...(inputs.length > 0 ? { inputs } : {}) }] }) });
  const until = async (check: () => boolean, what: string) => {
    for (const stop = Date.now() + 10_000; !check(); await new Promise((r) => setTimeout(r, 30))) if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
  };
  const open = async (name: string) => {
    sinks.length = 0;
    submitted.length = 0;
    const { id, secret } = await local.server.createRun(name);
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
    await tab.ready;
    const p1: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v1", mode: "operator", canRun: true, onFrame: () => undefined });
    await p1.ready;
    const p2: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v2", mode: "operator", canRun: true, onFrame: () => undefined });
    await p2.ready;
    return { id, tab, p1, p2, close: () => (tab.close(), p1.close(), p2.close()) };
  };

  it("a message whose placement is still being decided is not lost when the finished turn's end arrives: the agent is not sent away from it", async () => {
    const r = await open("in-flight");
    slowFor = "teach B";
    doneGoesHome = true; // the finished task would send the agent home, if it did not know a message is on its way
    try {
      r.p1.send({ t: "submit", text: "teach A", requestId: "a" });
      await until(() => submitted.includes("teach A") && sinks.length >= 1, "the first task on the host");
      r.p1.send({ t: "submit", text: "teach B", requestId: "b" }); // its placement question takes 400 ms
      await new Promise((r2) => setTimeout(r2, 100));
      end(0); // the first turn ends while B is still being placed
      await until(() => submitted.includes("teach B"), "B delivered to the host");
      assert.ok(!events.some((e) => e.event === "submit.undeliverable" && e.data.run === r.id), "no message was lost");
      assert.ok(!events.some((e) => e.event === "switch.start" && e.data.run === r.id && e.data.to === "tab"), "the agent was not sent home under the message");
    } finally {
      slowFor = "";
      doneGoesHome = false;
      r.close();
    }
  });

  it("a second viewer's copy of an earlier turn's end does not end the turn that began after it", async () => {
    const r = await open("stale-end");
    try {
      r.p1.send({ t: "submit", text: "teach A", requestId: "a" });
      await until(() => submitted.includes("teach A") && sinks.length >= 2, "the first task on the host and both viewers attached");
      end(0, [1]); // A's turn ends (the first viewer's copy)
      await new Promise((r2) => setTimeout(r2, 100));
      r.p1.send({ t: "submit", text: "teach B", requestId: "b" }); // stays on the host: B's turn begins
      await until(() => submitted.includes("teach B"), "B on the host");
      end(1, [1]); // the second viewer's copy of A's end arrives late
      await new Promise((r2) => setTimeout(r2, 100));
      r.p1.send({ t: "submit", text: "bring it home", requestId: "c" }); // needs a move
      await new Promise((r2) => setTimeout(r2, 500));
      assert.ok(!events.some((e) => e.event === "switch.start" && e.data.run === r.id && e.data.to === "tab"), "the move home waits for B's own end");
      end(0, [2]); // B's turn really ends
      await until(() => events.some((e) => e.event === "switch.start" && e.data.run === r.id && e.data.to === "tab"), "the move home after B's end");
    } finally {
      r.close();
    }
  });

  it("the end of a turn is seen when the first viewer's stream dropped: any viewer's first copy of it counts", async () => {
    const r = await open("dropped-viewer");
    try {
      r.p1.send({ t: "submit", text: "teach A", requestId: "a" });
      await until(() => submitted.includes("teach A") && sinks.length >= 2, "the first task on the host and both viewers attached");
      r.p1.send({ t: "submit", text: "bring it home", requestId: "c" }); // needs a move: waits for A's turn
      await new Promise((r2) => setTimeout(r2, 400));
      assert.ok(!events.some((e) => e.event === "switch.start" && e.data.run === r.id && e.data.to === "tab"), "it waits for the turn");
      // The first viewer's stream dropped and never delivers the end; the second viewer's does.
      end(1, [1]);
      await until(() => events.some((e) => e.event === "switch.start" && e.data.run === r.id && e.data.to === "tab"), "the move home after the end seen by the second viewer");
    } finally {
      r.close();
    }
  });
});
