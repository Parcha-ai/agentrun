// The server places a run by a typed question instead of the agent's own move: on a user's message it asks where the run should
// be, announces the decision (before the move), moves the run, and gives the message to the host the run now has; when the
// agent's turn ends there it asks again and moves the run to where the answer says. The remote host here is a real child process.
import assert from "node:assert/strict";
import { after, before, describe, it, test } from "node:test";
import { PLACEMENT_QUESTIONS, SERVER_TURN, type Placer, type PlacementDecision } from "../placement.ts";
import { remoteLocalHost, REMOTE_LOCAL } from "../pipe/remote-local.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import { tag, type PipeFrame } from "../wire.ts";
import { localServer, modelStub } from "./_local.ts";

describe("placement by a typed question", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  let model: Awaited<ReturnType<typeof modelStub>>;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const asked: { phase: string; message: string; current: string; environments: readonly string[] }[] = [];
  let answer: (phase: "start" | "done") => string = (phase) => (phase === "start" ? REMOTE_LOCAL.id : "tab");
  const placer: Placer = {
    homePrompt: "Say one short sentence: you are home.",
    // A check in code of what the work was for: here the run has no home/policy.json (the combine failed), so the result is not in place.
    async homeCheck(read) {
      if (homeGate) await homeGate;
      checked.push(await read("home/policy.json").then((b) => (b ? "present" : "missing")));
      return (await read("home/policy.json")) ? { ok: true, reason: "the brain is in place." } : { ok: false, reason: "the trained brain was not written." };
    },
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      asked.push({ phase: query.phase, message: query.message, current: query.current, environments: query.environments });
      const choice = answer(query.phase);
      const decision: PlacementDecision = {
        id: `d-${asked.length}`,
        phase: query.phase,
        question: PLACEMENT_QUESTIONS[query.phase],
        options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 0.9 : 0.1 / (query.environments.length - 1) })),
        choice,
        latency_ms: 7,
        model: "scripted",
      };
      return decision;
    },
  };
  const checked: string[] = [];
  /** A test can hold the home check open (it can wait up to two minutes for the browser's receipt) to see what the server does meanwhile. */
  let homeGate: Promise<void> | undefined;
  const cloud = remoteLocalHost();
  before(async () => {
    model = await modelStub(() => "It is trained.");
    local = await localServer({ cloud, placer, model: { baseUrl: model.url, model: "stub", budgetTokens: 1_000_000 }, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
    await cloud.close?.();
    await model.close();
  });
  const until = async (check: () => boolean, ms = 40_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 50))) {
      if (Date.now() > end) throw new Error(`timed out; server: ${events.slice(-8).map((e) => `${e.event} ${JSON.stringify(e.data).slice(0, 160)}`).join(" | ")}`);
    }
  };

  it("places the run before the agent sees the message, delivers it there, and brings the run back when the turn ends", async () => {
    const { id, secret } = await local.server.createRun("placed");
    const tabFrames: PipeFrame[] = [];
    const tab: PipeClient = new PipeClient({
      url: local.url, run: id, token: secret, tab: "a", mode: "write",
      onFrame: (f) => {
        tabFrames.push(f);
        if (f.t === "drain") tab.send({ t: "drained", switchId: f.switchId });
      },
    });
    await tab.ready;
    const seen: PipeFrame[] = [];
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
    await page.ready;

    page.send({ t: "submit", text: "teach it to walk", requestId: "req-1" });
    await until(() => seen.some((f) => f.t === "decision"));
    const first = seen.find((f): f is Extract<PipeFrame, { t: "decision" }> => f.t === "decision")!;
    assert.equal(first.decision.phase, "start");
    assert.equal(first.decision.choice, REMOTE_LOCAL.id);
    assert.equal(first.decision.latency_ms, 7);
    assert.deepEqual(asked[0], { phase: "start", message: "teach it to walk", current: "tab", environments: ["tab", REMOTE_LOCAL.id] });
    // The decision card comes before the move.
    const order = seen.map((f) => (f.t === "placement" && f.placement.where === "moving" ? "moving" : f.t));
    assert.ok(order.indexOf("decision") < order.indexOf("moving"), `decision before the first move: ${order.join(",")}`);
    // The message did not go to the tab that was running the run.
    assert.ok(!tabFrames.some((f) => f.t === "submit"), "the tab never got the message");

    // The agent answered on the remote host (its model call went through the pipe), its turn ended, and the server asked again.
    await until(() => seen.some((f) => f.t === "decision" && f.decision.phase === "done"));
    assert.equal(asked[1]!.phase, "done");
    assert.equal(asked[1]!.current, REMOTE_LOCAL.id);
    assert.equal(asked[1]!.message, "teach it to walk");
    assert.ok(model.requests.length >= 1, "the agent made its model call on the remote host");
    await until(() => seen.some((f) => f.t === "run-here"));
    const runHere = seen.find((f): f is Extract<PipeFrame, { t: "run-here" }> => f.t === "run-here")!;
    const homeFrames: PipeFrame[] = [];
    const home = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "write", switchId: runHere.switchId, onFrame: (f) => homeFrames.push(f) });
    const attached = await home.ready;
    assert.ok(attached.t === "attached");
    // The move home says it was placed, why, and with what probability.
    assert.equal(attached.move?.by, "placement");
    assert.equal(attached.move?.reason, "criterion of tab");
    assert.equal(attached.move?.probability, 0.9);
    // Once the page has the run again and reports its notice, the server gives the agent its one turn at home (marked as the server's).
    home.send({ t: "switched", switchId: runHere.switchId });
    await until(() => homeFrames.some((f) => f.t === "submit"));
    const wake = homeFrames.find((f): f is Extract<PipeFrame, { t: "submit" }> => f.t === "submit")!;
    // The home turn carries the server's own check, and with no brain on the disk it says NO: the agent has no success to word.
    assert.equal(wake.text, `${SERVER_TURN}Say one short sentence: you are home.\n\nChecked by the server just now: NO. the trained brain was not written.`);
    assert.doesNotMatch(wake.text, /Checked by the server just now: yes/);
    assert.deepEqual(checked.slice(0, 1), ["missing"]);
    assert.match(wake.requestId, /^server-sw-/);
    const there = events.find((e) => e.event === "switch.start" && e.data.run === id && e.data.by === "placement");
    assert.ok(there, "the first move was a placement move");
    tab.close();
    page.close();
    home.close();
  });

  it("a training request sent while the agent is on its way home waits for the home check and its closing turn, and is then placed on the GPU", async () => {
    answer = (phase) => (phase === "start" ? REMOTE_LOCAL.id : "tab");
    let release!: () => void;
    homeGate = new Promise<void>((r) => (release = r));
    const { id, secret } = await local.server.createRun("queued-home");
    const tabFrames: PipeFrame[] = [];
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => { tabFrames.push(f); if (f.t === "drain") tab.send({ t: "drained", switchId: f.switchId }); } });
    await tab.ready;
    const seen: PipeFrame[] = [];
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
    await page.ready;
    page.send({ t: "submit", text: "teach it to walk", requestId: "req-a" });
    await until(() => seen.some((f) => f.t === "run-here"));
    const runHere = seen.find((f): f is Extract<PipeFrame, { t: "run-here" }> => f.t === "run-here")!;
    // The browser takes the run back; the move home is in progress until it reports its notice. A second training request arrives now.
    const homeFrames: PipeFrame[] = [];
    const home: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "write", switchId: runHere.switchId, onFrame: (f) => { homeFrames.push(f); if (f.t === "drain") home.send({ t: "drained", switchId: f.switchId }); } });
    await home.ready;
    const decisionsBefore = seen.filter((f) => f.t === "decision").length;
    const movesBefore = events.filter((e) => e.event === "switch.start" && e.data.run === id).length;
    page.send({ t: "submit", text: "teach it to run", requestId: "req-b" });
    await new Promise((r) => setTimeout(r, 300));
    home.send({ t: "switched", switchId: runHere.switchId });
    // The home check is still running (held open). The queued request must not start its own move yet: that would release the browser's pipe under the check and send the closing line nowhere.
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(homeFrames.some((f) => f.t === "submit"), false, "the closing turn is not sent before the check is done");
    assert.equal(seen.filter((f) => f.t === "decision").length, decisionsBefore, "the queued request is not placed while the home check is running");
    assert.equal(events.filter((e) => e.event === "switch.start" && e.data.run === id).length, movesBefore, "and no move starts");
    release();
    homeGate = undefined;
    // The check ends, the closing line goes to the browser (with the true verdict), and the agent's turn there ends.
    await until(() => homeFrames.some((f) => f.t === "submit"));
    const wake = homeFrames.find((f): f is Extract<PipeFrame, { t: "submit" }> => f.t === "submit")!;
    assert.match(wake.text, /Checked by the server just now: NO\. the trained brain was not written\./);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(seen.filter((f) => f.t === "decision").length, decisionsBefore, "still waiting for the closing turn to end");
    home.send({ t: "view", event: tag({ kind: "events", events: [{ type: "run_end" }] }) } as never);
    // Only now is the queued request placed: asked where it belongs, and moved to the GPU.
    await until(() => seen.filter((f) => f.t === "decision").length > decisionsBefore);
    const second = [...seen].reverse().find((f): f is Extract<PipeFrame, { t: "decision" }> => f.t === "decision")!;
    assert.equal(second.decision.phase, "start");
    assert.equal(second.decision.choice, REMOTE_LOCAL.id);
    assert.equal(asked.at(-1)!.message, "teach it to run");
    await until(() => homeFrames.some((f) => f.t === "drain"));
    assert.ok(homeFrames.findIndex((f) => f.t === "submit") < homeFrames.findIndex((f) => f.t === "drain"), "the closing line came before the browser was asked to hand the run over");
    const checkAt = events.findIndex((e) => e.event === "placement.home-check" && e.data.run === id);
    const moveAt = events.findIndex((e, i) => i > checkAt && e.event === "switch.start" && e.data.run === id);
    assert.ok(checkAt >= 0 && moveAt > checkAt, "the second move started after the home check");
    tab.close();
    page.close();
    home.close();
  });

  it("a browser that never ends its closing turn does not hold the queued request forever: it is replayed after the bound", async () => {
    answer = (phase) => (phase === "start" ? REMOTE_LOCAL.id : "tab");
    homeGate = undefined;
    const bounded = await localServer({ cloud, placer, model: { baseUrl: model.url, model: "stub", budgetTokens: 1_000_000 }, drainMs: 5_000, homeTurnMs: 1_200, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
    try {
      const { id, secret } = await bounded.server.createRun("bounded-home");
      const tab: PipeClient = new PipeClient({ url: bounded.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => { if (f.t === "drain") tab.send({ t: "drained", switchId: f.switchId }); } });
      await tab.ready;
      const seen: PipeFrame[] = [];
      const page: PipeClient = new PipeClient({ url: bounded.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
      await page.ready;
      page.send({ t: "submit", text: "teach it to walk", requestId: "req-a" });
      await until(() => seen.some((f) => f.t === "run-here"));
      const runHere = seen.find((f): f is Extract<PipeFrame, { t: "run-here" }> => f.t === "run-here")!;
      const homeFrames: PipeFrame[] = [];
      const home: PipeClient = new PipeClient({ url: bounded.url, run: id, token: secret, tab: "v", mode: "write", switchId: runHere.switchId, onFrame: (f) => { homeFrames.push(f); if (f.t === "drain") home.send({ t: "drained", switchId: f.switchId }); } });
      await home.ready;
      const decisionsBefore = seen.filter((f) => f.t === "decision").length;
      page.send({ t: "submit", text: "teach it to run", requestId: "req-b" });
      await new Promise((r) => setTimeout(r, 300));
      home.send({ t: "switched", switchId: runHere.switchId });
      await until(() => homeFrames.some((f) => f.t === "submit"));
      assert.equal(seen.filter((f) => f.t === "decision").length, decisionsBefore, "waiting for the closing turn");
      // The turn never ends. After the bound the queued request is placed anyway.
      await until(() => seen.filter((f) => f.t === "decision").length > decisionsBefore, 15_000);
      assert.ok(events.some((e) => e.event === "placement.home-turn-timeout" && e.data.run === id));
      tab.close();
      page.close();
      home.close();
    } finally {
      await bounded.remove();
    }
  });

  it("leaves the run where it is, and delivers the message there, when the answer is where it already is", async () => {
    answer = () => "tab";
    const { id, secret } = await local.server.createRun("stays");
    const tabFrames: PipeFrame[] = [];
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => tabFrames.push(f) });
    const first = await tab.ready;
    assert.ok(first.t === "attached" && first.placed === true, "a server that places runs says so in the attach frame");
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", onFrame: () => undefined });
    await page.ready;
    page.send({ t: "submit", text: "fix a typo", requestId: "req-2" });
    await until(() => tabFrames.some((f) => f.t === "submit"));
    const sub = tabFrames.find((f): f is Extract<PipeFrame, { t: "submit" }> => f.t === "submit")!;
    assert.equal(sub.text, "fix a typo");
    assert.ok(!events.some((e) => e.event === "switch.start" && e.data.run === id), "no move");
    tab.close();
    page.close();
  });

  it("delivers the message where the run is when the question fails", async () => {
    const failing: Placer = { describe: (e) => e, decide: async () => Promise.reject(new Error("timeout")) };
    const second = await localServer({ placer: failing, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
    try {
      const { id, secret } = await second.server.createRun("fails");
      const tabFrames: PipeFrame[] = [];
      const tab: PipeClient = new PipeClient({ url: second.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => tabFrames.push(f) });
      const first = await tab.ready;
      assert.ok(first.t === "attached" && first.placed === true);
      const page: PipeClient = new PipeClient({ url: second.url, run: id, token: secret, tab: "v", mode: "operator", onFrame: () => undefined });
      await page.ready;
      page.send({ t: "submit", text: "hello", requestId: "req-3" });
      await until(() => tabFrames.some((f) => f.t === "submit"));
      assert.ok(events.some((e) => e.event === "placement.failed" && /timeout/.test(String(e.data.error))));
      tab.close();
      page.close();
    } finally {
      await second.remove();
    }
  });
});

test("a server without a placer does not mark runs as placed (the agent keeps its move tool)", async () => {
  const plain = await localServer({ superviseMs: 60_000 });
  try {
    const { id, secret } = await plain.server.createRun("plain");
    const tab: PipeClient = new PipeClient({ url: plain.url, run: id, token: secret, tab: "a", mode: "write" });
    const attached = await tab.ready;
    assert.ok(attached.t === "attached");
    assert.equal(attached.placed, undefined);
    tab.close();
  } finally {
    await plain.remove();
  }
});
