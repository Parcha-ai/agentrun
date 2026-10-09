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
  const started: { env: string; move: Move }[] = [];
  let api: ServerApi | undefined;
  const cloud: CloudHost = {
    environments: [{ id: "big-vm", label: "Big VM", phrase: "a big VM", kind: "cloud" }],
    bind: (a) => void (api = a),
    async start(_ref, run) {
      started.push({ env: run.env, move: run.move });
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

  it("is refused with its request id when the environment does not exist, naming the ones that do; or is the browser tab", async () => {
    const { id, secret } = await local.server.createRun("refused");
    const { client, frames } = await writer(id, secret, "a");
    client.send({ t: "switch", to: "nowhere", by: "agent", reason: "why not", ask: "ask-1" });
    client.send({ t: "switch", to: "tab", by: "agent", reason: "back", ask: "ask-2" });
    await until(() => frames.filter((f) => f.t === "switch-refused").length === 2);
    const refused = frames.filter((f): f is Extract<PipeFrame, { t: "switch-refused" }> => f.t === "switch-refused");
    assert.deepEqual(refused.map((f) => f.ask).sort(), ["ask-1", "ask-2"]);
    assert.match(refused.find((f) => f.ask === "ask-1")!.message, /no environment nowhere; the environments are .*big-vm/);
    assert.match(refused.find((f) => f.ask === "ask-2")!.message, /cannot move itself into a browser tab/);
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
    await until(() => started.length === 1);
    assert.deepEqual({ ...started[0]!.move, id: undefined }, { id: undefined, from: "your user's browser tab", planned: true, by: "agent", reason: "I need a full Linux VM with Docker" });
    assert.equal(started[0]!.move.id, accepted.switchId, "the handover id the tool returned is the move's");
    assert.ok(events.some((e) => e.event === "switch.start" && e.data.by === "agent"));
    client.close();
  });

  it("a user's click carries no agent marker and no request id: no accepted frame, the move says the user planned it", async () => {
    const { id, secret } = await local.server.createRun("click");
    const { client, frames } = await writer(id, secret, "a");
    const before = started.length;
    client.send({ t: "switch", to: "big-vm" });
    await until(() => started.length === before + 1);
    assert.equal(started.at(-1)!.move.by, undefined);
    assert.ok(!frames.some((f) => f.t === "switch-accepted"));
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
    const before = started.length;
    const { switchId } = await api!.requestSwitch(ref, "big-vm", "more cores");
    assert.match(switchId, /^sw-/);
    await until(() => started.length === before + 1);
    assert.equal(started.at(-1)!.move.reason, "more cores");
    client.close();
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
