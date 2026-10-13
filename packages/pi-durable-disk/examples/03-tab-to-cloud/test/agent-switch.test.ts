// The agent's own request to move (switch_environment): over a tab's pipe it is answered with switch-accepted (the
// handover's id) or switch-refused, both carrying the request id; the cloud host that starts the run gets a move that says
// the agent chose it and why; a host that is not the pipe (a cloud host's link) asks through the API the server hands it.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { CloudHost, ServerApi } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import type { Move, PipeFrame } from "../wire.ts";
import { localServer } from "./_local.ts";

describe("an agent that moves itself", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const started: { run: string; env: string; move: Move }[] = [];
  /** The cloud starts of one run: the cloud host is shared by every run here, and a run of an earlier test can still move late. */
  const startedFor = (run: string) => started.filter((s) => s.run === run);
  let api: ServerApi | undefined;
  const cloud: CloudHost = {
    environments: [{ id: "big-vm", label: "Big VM", phrase: "a big VM", kind: "cloud" }],
    bind: (a) => void (api = a),
    async start(ref, run) {
      started.push({ run: ref.id, env: run.env, move: run.move });
      return { host: "big-vm-1" };
    },
    stop: async () => undefined,
  };
  before(async () => {
    local = await localServer({ cloud, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
  });
  const until = async (check: () => boolean, ms = 20_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 25))) {
      if (Date.now() > end) throw new Error(`timed out; server: ${events.slice(-6).map((e) => `${e.event} ${JSON.stringify(e.data).slice(0, 140)}`).join(" | ")}`);
    }
  };
  const writer = async (run: string, secret: string, tab: string) => {
    const frames: PipeFrame[] = [];
    const client: PipeClient = new PipeClient({
      url: local.url, run, token: secret, tab, mode: "write",
      onFrame: (f) => {
        frames.push(f);
        if (f.t === "drain") client.send({ t: "drained", switchId: f.switchId });
      },
    });
    await client.ready;
    return { client, frames };
  };

  it("is refused with its request id when the environment does not exist, naming the ones that do, or when the run is already there", async () => {
    const { id, secret } = await local.server.createRun("refused");
    const { client, frames } = await writer(id, secret, "a");
    client.send({ t: "switch", to: "nowhere", by: "agent", reason: "why not", ask: "ask-1" });
    client.send({ t: "switch", to: "tab", by: "agent", reason: "back", ask: "ask-2" });
    await until(() => frames.filter((f) => f.t === "switch-refused").length === 2);
    const refused = frames.filter((f): f is Extract<PipeFrame, { t: "switch-refused" }> => f.t === "switch-refused");
    assert.deepEqual(refused.map((f) => f.ask).sort(), ["ask-1", "ask-2"]);
    assert.match(refused.find((f) => f.ask === "ask-1")!.message, /no environment nowhere; the environments are .*big-vm/);
    assert.match(refused.find((f) => f.ask === "ask-2")!.message, /the run is already there/);
    assert.ok(!events.some((e) => e.event === "switch.start" && e.data.run === id), "nothing began");
    client.close();
  });

  it("is accepted with its request id and the handover's id, and the cloud host is told the agent chose the move and why", async () => {
    const { id, secret } = await local.server.createRun("accepted");
    const { client, frames } = await writer(id, secret, "a");
    client.send({ t: "switch", to: "big-vm", by: "agent", reason: "I need a full Linux VM with Docker", ask: "ask-9" });
    await until(() => frames.some((f) => f.t === "switch-accepted"));
    const accepted = frames.find((f): f is Extract<PipeFrame, { t: "switch-accepted" }> => f.t === "switch-accepted")!;
    assert.equal(accepted.ask, "ask-9");
    assert.match(accepted.switchId, /^sw-/);
    await until(() => startedFor(id).length === 1);
    const move = startedFor(id)[0]!.move;
    assert.deepEqual({ ...move, id: undefined }, { id: undefined, from: "your user's browser tab", planned: true, by: "agent", reason: "I need a full Linux VM with Docker" });
    assert.equal(move.id, accepted.switchId, "the handover id the tool returned is the move's");
    assert.ok(events.some((e) => e.event === "switch.start" && e.data.by === "agent"));
    client.close();
  });

  it("a user's click carries no agent marker and no request id: no accepted frame, the move says the user planned it", async () => {
    const { id, secret } = await local.server.createRun("click");
    const { client, frames } = await writer(id, secret, "a");
    const before = startedFor(id).length;
    client.send({ t: "switch", to: "big-vm" });
    await until(() => startedFor(id).length === before + 1);
    assert.equal(startedFor(id).at(-1)!.move.by, undefined);
    assert.ok(!frames.some((f) => f.t === "switch-accepted"));
    client.close();
  });

  it("an agent in the cloud comes home: a page that can run it, watching, is told to take it; with none (or one that only watches) it is refused", async () => {
    const { id, secret } = await local.server.createRun("home");
    const { client } = await writer(id, secret, "a");
    client.send({ t: "switch", to: "big-vm" });
    await until(() => local.server.runs.get(id)!.placement.where === "cloud");
    const ref = local.server.runs.get(id)!.ref;
    await assert.rejects(api!.requestSwitch(ref, "tab", "done"), /no browser tab that can run the agent is open on this run/);
    const seen: PipeFrame[] = [];
    const watcher = new PipeClient({ url: local.url, run: id, token: secret, tab: "w", mode: "view", canRun: true, onFrame: () => undefined });
    await watcher.ready;
    await assert.rejects(api!.requestSwitch(ref, "tab", "done"), /no browser tab that can run the agent/, "a connection that only watches is not told to run it");
    watcher.close();
    const viewer = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
    await viewer.ready;
    const { switchId } = await api!.requestSwitch(ref, "tab", "training is done, the policy is in work/");
    await until(() => seen.some((f) => f.t === "run-here"));
    const runHere = seen.find((f): f is Extract<PipeFrame, { t: "run-here" }> => f.t === "run-here")!;
    assert.equal(runHere.switchId, switchId, "the watching tab is handed the agent's own handover");
    viewer.close();
    client.close();
  });

  it("a cloud host asks through the API the server bound: resolved with the handover's id, or rejected with the reason", async () => {
    assert.ok(api, "the server bound its API to the cloud host");
    const { id, secret } = await local.server.createRun("bound");
    const { client } = await writer(id, secret, "a");
    const ref = local.server.runs.get(id)!.ref;
    await until(() => local.server.runs.get(id)!.placement.where === "tab");
    await assert.rejects(api!.requestSwitch(ref, "nowhere", "x"), /no environment nowhere/);
    await assert.rejects(api!.requestSwitch({ ...ref, id: "unknown-run" }, "big-vm", "x"), /no such run/);
    const before = startedFor(id).length;
    // Another run moves to the cloud meanwhile (as a run of an earlier test can, late, once its tab is gone): its start is not this run's.
    const bystander = await local.server.createRun("bystander");
    const { client: byTab } = await writer(bystander.id, bystander.secret, "a");
    byTab.send({ t: "switch", to: "big-vm" });
    await until(() => local.server.runs.get(bystander.id)!.placement.where === "cloud");
    const { switchId } = await api!.requestSwitch(ref, "big-vm", "more cores");
    assert.match(switchId, /^sw-/);
    await until(() => startedFor(id).length === before + 1);
    assert.equal(startedFor(id).at(-1)!.move.reason, "more cores");
    client.close();
    byTab.close();
  });
});

describe("a cloud host that reports its notice committed", () => {
  it("the move is timed to that report, and the run is busy (no second move) until it", async () => {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    let api: ServerApi | undefined;
    const cloud: CloudHost = {
      environments: [{ id: "vm", label: "VM", phrase: "a VM", kind: "cloud" }],
      notifiesSwitched: true,
      bind: (a) => void (api = a),
      start: async () => ({ host: "vm-1" }),
      stop: async () => undefined,
    };
    const local = await localServer({ cloud, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
    try {
      const { id, secret } = await local.server.createRun("notified");
      const seen: PipeFrame[] = [];
      const a: PipeClient = new PipeClient({
        url: local.url, run: id, token: secret, tab: "a", mode: "write",
        onFrame: (f) => {
          seen.push(f);
          if (f.t === "drain") a.send({ t: "drained", switchId: f.switchId });
        },
      });
      await a.ready;
      a.send({ t: "switch", to: "vm" });
      for (const end = Date.now() + 10_000; local.server.runs.get(id)!.placement.where !== "cloud"; await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error("the run never reached the cloud");
      const state = local.server.runs.get(id)!;
      assert.ok(state.switching, "the move is still open: no notice reported yet");
      assert.ok(!events.some((e) => e.event === "switch.done"));
      api!.switched(state.ref, state.switching!.move.id);
      assert.equal(state.switching, undefined, "the report ends the move");
      assert.ok(events.some((e) => e.event === "switch.done" && e.data.to === "vm" && typeof e.data.ms === "number"));
      a.close();
    } finally {
      await local.remove();
    }
  });
});

describe("the notice of a move the agent chose", () => {
  const facts = { label: "a Modal VM", cpus: 2, memoryGb: 4, gpu: null, tools: ["bash"], network: true };
  it("says the agent moved itself and why, once the reason's own full stop is dropped", async () => {
    const { noticeText } = await import("../environment.ts");
    const text = noticeText(facts, { id: "sw-1", from: "your user's browser tab", planned: true, by: "agent", reason: "I need Docker." });
    assert.match(text, /You moved yourself here from your user's browser tab, because: I need Docker\. Your conversation/);
    assert.ok(!text.includes("Your user moved you"));
    assert.match(noticeText(facts, { id: "sw-2", from: "x", planned: true, by: "agent", reason: "  " }), /You moved yourself here from x\./);
    assert.match(noticeText(facts, { id: "sw-3", from: "x", planned: true }), /Your user moved you here from x\./);
  });
});

describe("the notice of a move the server's placement made", () => {
  const facts = { label: "a Modal VM", cpus: 2, memoryGb: 4, gpu: null, tools: ["bash"], network: true };
  it("says where the run came from and nothing of why: the environment's criterion (the cluster's speaks of teaching) and the answer's probability stay out of the agent's words", async () => {
    const { noticeText } = await import("../environment.ts");
    // On a bare "go to the modal vm", Opus 5.5 read the criterion in the notice as "the system flagged this as likely a teaching request".
    const criterion = "A cloud computer with eight GPU machines, for the time the robot is being taught. Any request that asks for the robot to be taught belongs here.";
    const text = noticeText(facts, { id: "sw-4", from: "your user's browser tab", planned: true, by: "placement", reason: criterion, probability: 0.98, phase: "start" });
    assert.match(text, /Your user's server moved you here from your user's browser tab\./);
    assert.doesNotMatch(text, /taught|teach|GPU machines|probability|98%|typed question/);
  });
});
