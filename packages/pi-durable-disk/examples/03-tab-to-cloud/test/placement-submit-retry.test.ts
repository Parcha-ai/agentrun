// A line placed on a cloud host that has only just started: the host's app may refuse it (503) for a few seconds. The server retries that
// refusal for a bounded time and says so (placement.retry), so the line the user typed is not lost; any other failure, and a host that
// is still refusing at the bound, fails visibly.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PLACEMENT_QUESTIONS, type Placer, type PlacementDecision } from "../placement.ts";
import type { CloudHost } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import { localServer } from "./_local.ts";

/** What a cloud host throws for a refused submit: the message and the HTTP status the host answered. */
const refused = (status: number): Error => Object.assign(new Error(`submit: ${status}`), { status });

describe("a line placed on a cloud host that is not accepting yet", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const attempts: string[] = [];
  const accepted: string[] = [];
  // The host's answer to the next submit of a text: a number is a refusal with that status, "ok" accepts.
  let script: (text: string, attempt: number) => number | "ok" | "hang" = () => "ok";
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      const choice = query.phase === "start" ? "vm" : "tab";
      const decision: PlacementDecision = { id: `d-${query.phase}`, phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 1 : 0 })), choice, latency_ms: 0, model: "scripted" };
      return decision;
    },
  };
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }],
    start: async () => ({ host: "vm-1" }),
    stop: async () => undefined,
    attachViewer: async () => () => undefined,
    submit: async (_ref, text, _requestId, signal) => {
      attempts.push(text);
      const answer = script(text, attempts.filter((t) => t === text).length);
      // "hang": a host that answers in 5 s unless the attempt is cut off (what a slow HTTP response is to the adapter)
      if (answer === "hang") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)));
        });
        return;
      }
      if (answer !== "ok") throw refused(answer);
      accepted.push(text);
    },
  };
  before(async () => {
    local = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 60_000, submitRetryMs: 600, submitRetryDelayMs: 40, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
  });
  const until = async (check: () => boolean, ms = 15_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 25))) {
      if (Date.now() > end) throw new Error(`timed out; server: ${events.slice(-8).map((e) => `${e.event} ${JSON.stringify(e.data).slice(0, 140)}`).join(" | ")}`);
    }
  };
  const send = async (name: string, text: string) => {
    const { id, secret } = await local.server.createRun(name);
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
    await tab.ready;
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: () => undefined });
    await page.ready;
    page.send({ t: "submit", text, requestId: `req-${name}` });
    return { id, close: () => (tab.close(), page.close()) };
  };
  const ofRun = (id: string, event: string) => events.filter((e) => e.event === event && e.data.run === id);

  it("retries a 503 and delivers the line once the host accepts, saying so", async () => {
    script = (_text, attempt) => (attempt <= 2 ? 503 : "ok");
    const run = await send("not-yet", "teach it to spin");
    await until(() => accepted.includes("teach it to spin"));
    assert.equal(attempts.filter((t) => t === "teach it to spin").length, 3, "refused twice, accepted on the third try");
    assert.equal(accepted.filter((t) => t === "teach it to spin").length, 1, "delivered once");
    assert.equal(ofRun(run.id, "placement.retry").length, 2, "each retry is logged");
    assert.equal(ofRun(run.id, "placement.retry")[0]!.data.error, "submit: 503");
    await until(() => ofRun(run.id, "submit.delivered").some((e) => e.data.to === "cloud"));
    assert.equal(ofRun(run.id, "submit.failed").length, 0, "and the delivery did not fail");
    run.close();
  });

  it("gives up visibly when the host is still refusing at the bound", async () => {
    script = () => 503;
    const run = await send("never-ready", "teach it to wave");
    await until(() => ofRun(run.id, "submit.failed").length > 0);
    assert.match(String(ofRun(run.id, "submit.failed")[0]!.data.error), /submit: 503/);
    const tries = attempts.filter((t) => t === "teach it to wave").length;
    assert.ok(tries >= 3 && tries <= 20, `retried while it could (${tries} tries), then stopped`);
    assert.equal(accepted.includes("teach it to wave"), false);
    run.close();
  });

  it("bounds the whole delivery by the retry budget: an attempt that hangs is cut off at the bound, not left to run its own timeout", async () => {
    script = (_text, attempt) => (attempt === 1 ? 503 : "hang");
    const t0 = Date.now();
    const run = await send("slow-host", "teach it to roll");
    await until(() => ofRun(run.id, "submit.failed").length > 0, 4_000);
    assert.ok(Date.now() - t0 < 2_500, `the delivery ended at the bound (${Date.now() - t0} ms), not after the host's own 5 s`);
    run.close();
  });

  it("does not retry a refusal that is not a 503", async () => {
    script = () => 400;
    const run = await send("bad-request", "teach it to sit");
    await until(() => ofRun(run.id, "submit.failed").length > 0);
    assert.equal(attempts.filter((t) => t === "teach it to sit").length, 1, "one try");
    assert.equal(ofRun(run.id, "placement.retry").length, 0);
    run.close();
  });
});

describe("a line sent to a cloud host without a placer", () => {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const attempts: string[] = [];
  const accepted: string[] = [];
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }],
    start: async () => ({ host: "vm-1" }),
    stop: async () => undefined,
    attachViewer: async () => () => undefined,
    submit: async (_ref, text) => {
      attempts.push(text);
      if (attempts.length <= 2) throw refused(503);
      accepted.push(text);
    },
  };
  it("is retried on a 503 like a placed one (the documented --cloud daytona has no placer)", async () => {
    const local = await localServer({ cloud, drainMs: 5_000, superviseMs: 60_000, submitRetryMs: 600, submitRetryDelayMs: 40, log: (event, data = {}) => events.push({ event, data }) });
    try {
      const { id, secret } = await local.server.createRun("no-placer");
      const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId }) });
      await tab.ready;
      const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: () => undefined });
      await page.ready;
      page.send({ t: "switch", to: "vm" });
      for (const end = Date.now() + 8_000; !events.some((e) => e.event === "cloud.started" && e.data.run === id); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error("the move to the cloud did not finish");
      page.send({ t: "submit", text: "teach it to hop", requestId: "ui-direct" });
      for (const end = Date.now() + 8_000; !accepted.includes("teach it to hop"); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error(`never delivered; attempts ${attempts.length}`);
      assert.equal(attempts.length, 3, "refused twice, accepted on the third try");
      assert.equal(events.filter((e) => e.event === "placement.retry" && e.data.run === id).length, 2);
      tab.close();
      page.close();
    } finally {
      await local.remove();
    }
  });
});
