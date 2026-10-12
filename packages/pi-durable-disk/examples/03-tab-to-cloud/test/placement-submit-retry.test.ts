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
  let script: (text: string, attempt: number) => number | "ok" = () => "ok";
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      const choice = query.phase === "start" ? "vm" : "tab";
      const decision: PlacementDecision = { id: `d-${query.phase}`, phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 1 : 0 })), choice, decidedBy: "model" } as PlacementDecision;
      return decision;
    },
  };
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }],
    start: async () => ({ host: "vm-1" }),
    stop: async () => undefined,
    attachViewer: async () => () => undefined,
    submit: async (_ref, text) => {
      attempts.push(text);
      const answer = script(text, attempts.filter((t) => t === text).length);
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

  it("does not retry a refusal that is not a 503", async () => {
    script = () => 400;
    const run = await send("bad-request", "teach it to sit");
    await until(() => ofRun(run.id, "submit.failed").length > 0);
    assert.equal(attempts.filter((t) => t === "teach it to sit").length, 1, "one try");
    assert.equal(ofRun(run.id, "placement.retry").length, 0);
    run.close();
  });
});
