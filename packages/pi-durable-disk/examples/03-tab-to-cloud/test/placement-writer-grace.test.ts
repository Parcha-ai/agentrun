// A page refresh closes the tab's socket for a few seconds, and the server used to take that as "the tab is gone" and move the run to the cloud.
// The server now waits `writerReturnMs` for a writer of the run to come back (the same link after a refresh): if one does, the run stays in the
// browser and the lines typed meanwhile go to it; if none does, the run moves to the cloud as before, and those lines go there.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PLACEMENT_QUESTIONS, type Placer, type PlacementDecision } from "../placement.ts";
import type { CloudHost } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import type { PipeFrame } from "../wire.ts";
import { localServer } from "./_local.ts";

describe("a tab that drops and a tab that comes back", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const cloudSubmits: string[] = [];
  // Every typed question answers "stay where you are", wherever that is.
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      const choice = query.current;
      return { id: `d-${query.phase}`, phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 1 : 0 })), choice, decidedBy: "model" } as PlacementDecision;
    },
  };
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }],
    start: async () => ({ host: "vm-1" }),
    stop: async () => undefined,
    attachViewer: async () => () => undefined,
    submit: async (_ref, text) => {
      cloudSubmits.push(text);
    },
  };
  before(async () => {
    local = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 60_000, writerGraceMs: 300, writerReturnMs: 1_500, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
  });
  const until = async (check: () => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 25))) {
      if (Date.now() > end) throw new Error(`timed out; server: ${events.slice(-8).map((e) => `${e.event} ${JSON.stringify(e.data).slice(0, 140)}`).join(" | ")}`);
    }
  };
  const ofRun = (id: string, event: string) => events.filter((e) => e.event === event && e.data.run === id);
  const attachTab = async (id: string, secret: string, frames: PipeFrame[]) => {
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => (frames.push(f), f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId })) });
    await tab.ready;
    return tab;
  };
  const attachPage = async (id: string, secret: string) => {
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: () => undefined });
    await page.ready;
    return page;
  };

  it("keeps the run in the browser when the tab comes back inside the grace, and its queued line goes to the returned tab", async () => {
    const { id, secret } = await local.server.createRun("refresh");
    const first = await attachTab(id, secret, []);
    const page = await attachPage(id, secret);
    first.close(); // the refresh: the socket closes
    await until(() => ofRun(id, "pipe.writer-gone").length === 1);
    page.send({ t: "submit", text: "make it spin", requestId: "ui-after-refresh" }); // typed while the page reloads
    await new Promise((r) => setTimeout(r, 400));
    const seen: PipeFrame[] = [];
    const back = await attachTab(id, secret, seen);
    await until(() => seen.some((f) => f.t === "submit" && f.requestId === "ui-after-refresh"));
    const grace = ofRun(id, "placement.writer-grace");
    assert.equal(grace.length, 1);
    assert.equal(grace[0]!.data.outcome, "returned");
    assert.equal(ofRun(id, "cloud.started").length, 0, "the run never went to the cloud");
    assert.equal(events.some((e) => e.event === "placement" && e.data.run === id && e.data.env === "vm"), false, "and was never placed there");
    assert.deepEqual(cloudSubmits.filter((t) => t === "make it spin"), [], "the line did not go to the cloud");
    back.close();
    page.close();
  });

  it("moves the run to the cloud after the grace when no writer comes back, and the queued line goes there", async () => {
    const { id, secret } = await local.server.createRun("closed-tab");
    const first = await attachTab(id, secret, []);
    const page = await attachPage(id, secret);
    first.close();
    await until(() => ofRun(id, "pipe.writer-gone").length === 1);
    page.send({ t: "submit", text: "teach it to wave", requestId: "ui-lost-tab" });
    const gone = Date.now();
    await until(() => ofRun(id, "cloud.started").length === 1);
    assert.ok(Date.now() - gone >= 1_000, "it waited for the tab out the grace first");
    assert.equal(ofRun(id, "placement.writer-grace")[0]!.data.outcome, "expired");
    await until(() => cloudSubmits.includes("teach it to wave"));
    page.close();
  });
});
