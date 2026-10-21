// A page that takes a while to re-attach on the move home (a tab behind a tunnel: take 2 took about 32 s, the kiosk 3.4 s) must still close the move: the server waits for it long enough to
// log switch.done and run the home check, instead of parking the run and treating the late attach as a plain re-attach with no switch.
//
// The window is a constant of the server (30 s for a tab target before, 120 s now), so the test runs the server's own timer at 1/100 of its length: setTimeout calls of exactly 30_000 or 120_000 ms
// are shortened to 300 or 1200 ms, and the page attaches 700 ms in (70 s of the window's scale). Nothing else about the timers changes.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PLACEMENT_QUESTIONS, type Placer } from "../placement.ts";
import type { CloudHost } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import { tag, type PipeFrame } from "../wire.ts";
import { localServer } from "./_local.ts";

const realSetTimeout = globalThis.setTimeout;
const SCALE = 100;

describe("the move home waits for a slow page to attach", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const sinks: ((frame: PipeFrame) => void)[] = [];
  const delivered: string[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const doneChoice = "vm";
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      const choice = query.phase === "done" ? doneChoice : /come back/.test(query.message) ? "tab" : "vm";
      return { id: `a-${query.phase}-${Math.random()}`, phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 0.9 : 0.1 })), choice, latency_ms: 1, model: "fixed", source: "test" } as never;
    },
  };
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }],
    start: async () => ({ host: "vm-1" }),
    stop: async () => undefined,
    attachViewer: async (_ref, send) => (sinks.push(send), () => undefined),
    submit: async (_ref, text) => void delivered.push(text),
  };
  before(async () => {
    // Only the server's two attach windows are scaled; every other timer is the real one.
    (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => realSetTimeout(fn, ms === 30_000 || ms === 120_000 ? ms / SCALE : ms, ...rest)) as typeof setTimeout;
    local = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 100, log: (event, data = {}) => logs.push({ event, data }) });
  });
  after(async () => {
    globalThis.setTimeout = realSetTimeout;
    await local.remove();
  });
  const until = async (check: () => boolean, what: string, ms = 20_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => realSetTimeout(r, 50))) if (Date.now() > end) throw new Error(`timed out: ${what}; logs ${logs.slice(-6).map((l) => l.event).join(",")}`);
  };

  it("a page that attaches 70 s into the window (scaled) closes the move: switch.done is logged and the run is not parked", async () => {
    const { id, secret } = await local.server.createRun("slow-attach");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
    await tab.ready;
    const seen: PipeFrame[] = [];
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
    await page.ready;
    const sinksBefore = sinks.length;
    page.send({ t: "submit", text: "go to the vm", requestId: "sa-1" });
    await until(() => delivered.length > 0 && sinks.length > sinksBefore, "the line placed on the VM");
    // The turn on the VM ends and the end-of-turn question keeps the run there; then the user's own line asks to come back.
    sinks.slice(sinksBefore).forEach((send) => send({ t: "event", event: tag({ kind: "events", events: [{ type: "run_end" }] }) }));
    await until(() => logs.some((l) => l.event === "placement.decision" && l.data.phase === "done" && l.data.run === id && l.data.choice === "vm"), "the end-of-turn question answered");
    await new Promise((r) => realSetTimeout(r, 500));
    page.send({ t: "submit", text: "come back to my browser", requestId: "sa-2" });
    await until(() => seen.some((f) => f.t === "run-here"), "the tab told to run the run");
    const runHere = seen.find((f): f is Extract<PipeFrame, { t: "run-here" }> => f.t === "run-here")!;
    // The page is slow: it attaches 700 ms in, 70 s on the window's scale.
    await new Promise((r) => realSetTimeout(r, 700));
    const home: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "write", switchId: runHere.switchId, onFrame: (f) => f.t === "drain" && home.send({ t: "drained", switchId: f.switchId }) });
    await home.ready;
    home.send({ t: "switched", switchId: runHere.switchId });
    try {
      await until(() => logs.some((l) => l.event === "switch.done" && l.data.run === id && l.data.switchId === runHere.switchId), "switch.done for the move home", 5_000);
    } finally {
      tab.close();
      page.close();
      home.close();
    }
    assert.ok(!logs.some((l) => l.event === "placement" && l.data.run === id && l.data.where === "parked"), "the run was never parked");
  });
});
