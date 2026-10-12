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
  /** A tab attached as the writer. `ready`: it says so once its runtime is up (the page sends writer-ready after it is the writer); a tab that never says it is not given the run's lines. */
  const attachTab = async (id: string, secret: string, frames: PipeFrame[], ready = true) => {
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", pingMs: 100, onFrame: (f) => (frames.push(f), f.t === "drain" && tab.send({ t: "drained", switchId: f.switchId })) });
    await tab.ready;
    if (ready) tab.send({ t: "writer-ready" });
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

  it("does not give the queued line to a returned tab before that tab says it is the writer", async () => {
    const { id, secret } = await local.server.createRun("booting-tab");
    const first = await attachTab(id, secret, []);
    const page = await attachPage(id, secret);
    first.close();
    await until(() => ofRun(id, "pipe.writer-gone").length === 1);
    page.send({ t: "submit", text: "wave hello", requestId: "ui-booting" });
    const seen: PipeFrame[] = [];
    const back = await attachTab(id, secret, seen, false); // files restored, runtime still starting
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(seen.some((f) => f.t === "submit"), false, "nothing is sent to a page that cannot run it yet");
    back.send({ t: "writer-ready" });
    await until(() => seen.some((f) => f.t === "submit" && f.requestId === "ui-booting"));
    assert.equal(ofRun(id, "placement.writer-grace")[0]!.data.outcome, "returned");
    back.close();
    page.close();
  });

  it("an operator's move to the cloud during the grace takes the queued line along", async () => {
    const { id, secret } = await local.server.createRun("operator-moves");
    const first = await attachTab(id, secret, []);
    const page = await attachPage(id, secret);
    first.close();
    await until(() => ofRun(id, "pipe.writer-gone").length === 1);
    page.send({ t: "submit", text: "teach it to sit", requestId: "ui-queued-for-move" });
    await until(() => ofRun(id, "placement.queued").length === 1);
    page.send({ t: "switch", to: "vm" });
    await until(() => cloudSubmits.includes("teach it to sit"));
    assert.equal(ofRun(id, "placement.writer-grace")[0]!.data.outcome, "superseded");
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

describe("the grace where there is nothing to move to, and at shutdown", () => {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const ofRun = (id: string, event: string) => events.filter((e) => e.event === event && e.data.run === id);
  const until = async (check: () => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 25))) {
      if (Date.now() > end) throw new Error(`timed out; server: ${events.slice(-8).map((e) => `${e.event} ${JSON.stringify(e.data).slice(0, 140)}`).join(" | ")}`);
    }
  };
  const placer: Placer = {
    describe: (env) => `criterion of ${env}`,
    async decide(query) {
      return { id: `d-${query.phase}`, phase: query.phase, question: PLACEMENT_QUESTIONS[query.phase], options: query.environments.map((id) => ({ id, label: id, probability: id === query.current ? 1 : 0 })), choice: query.current, decidedBy: "model" } as PlacementDecision;
    },
  };
  const clients = async (server: Awaited<ReturnType<typeof localServer>>, name: string, pageFrames: PipeFrame[]) => {
    const { id, secret } = await server.server.createRun(name);
    const tab: PipeClient = new PipeClient({ url: server.url, run: id, token: secret, tab: "a", mode: "write" });
    await tab.ready;
    const page: PipeClient = new PipeClient({ url: server.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => pageFrames.push(f) });
    await page.ready;
    return { id, tab, page };
  };

  it("answers a queued line with a refusal when the run is parked because there is no cloud to move to", async () => {
    const server = await localServer({ placer, drainMs: 5_000, superviseMs: 60_000, writerGraceMs: 300, writerReturnMs: 600, log: (event, data = {}) => events.push({ event, data }) });
    try {
      const frames: PipeFrame[] = [];
      const { id, tab, page } = await clients(server, "no-cloud", frames);
      tab.close();
      await until(() => ofRun(id, "pipe.writer-gone").length === 1);
      page.send({ t: "submit", text: "make it spin", requestId: "ui-parked" });
      await until(() => frames.some((f) => f.t === "submit-refused" && f.requestId === "ui-parked"));
      assert.equal(ofRun(id, "placement.writer-grace")[0]!.data.outcome, "expired");
      page.close();
    } finally {
      await server.remove();
    }
  });

  it("starts no cloud host when the server closes during the grace, even in the last tick of it", async () => {
    const cloudStarts: string[] = [];
    const cloud: CloudHost = {
      environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }],
      start: async (ref) => (cloudStarts.push(ref.id), { host: "vm-1" }),
      stop: async () => undefined,
      attachViewer: async () => () => undefined,
      submit: async () => undefined,
    };
    // One tick is the whole grace: the deadline passes in the sleep the close lands in.
    const server = await localServer({ cloud, placer, drainMs: 5_000, superviseMs: 60_000, writerGraceMs: 300, writerReturnMs: 300, writerReturnPollMs: 300, log: (event, data = {}) => events.push({ event, data }) });
    const { id, tab } = await clients(server, "closing", []);
    tab.close();
    await until(() => ofRun(id, "pipe.writer-gone").length === 1);
    await new Promise((r) => setTimeout(r, 120)); // inside the tick's sleep
    const closing = server.remove();
    await until(() => ofRun(id, "placement.writer-grace").length === 1);
    assert.equal(ofRun(id, "placement.writer-grace")[0]!.data.outcome, "closed");
    await closing;
    assert.deepEqual(cloudStarts, [], "the cloud was not started by a server that is shutting down");
  });
});

describe("a page that comes back booting", () => {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const ofRun = (id: string, event: string) => events.filter((e) => e.event === event && e.data.run === id);
  const until = async (check: () => boolean, ms = 10_000) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 25))) {
      if (Date.now() > end) throw new Error(`timed out; server: ${events.slice(-8).map((e) => `${e.event} ${JSON.stringify(e.data).slice(0, 140)}`).join(" | ")}`);
    }
  };
  const cloudStarts: string[] = [];
  const cloud: CloudHost = {
    environments: [{ id: "vm", label: "A VM", phrase: "a VM", kind: "cloud" }],
    start: async (ref) => (cloudStarts.push(ref.id), { host: "vm-1" }),
    stop: async () => undefined,
    attachViewer: async () => () => undefined,
    submit: async () => undefined,
  };
  let local: Awaited<ReturnType<typeof localServer>>;
  before(async () => {
    // 0.4 s of plain grace; a page that asked gets up to 3 s of boot, never past 5 s
    local = await localServer({ cloud, drainMs: 5_000, superviseMs: 60_000, writerGraceMs: 300, writerReturnMs: 400, writerBootMs: 3_000, writerReturnMaxMs: 5_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    await local.remove();
  });
  const dropWriter = async (name: string) => {
    const { id, secret } = await local.server.createRun(name);
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await tab.ready;
    tab.close();
    await until(() => ofRun(id, "pipe.writer-gone").length === 1);
    return { id, secret };
  };

  it("tells a page that can run the run to attach, and waits for it to boot past the plain grace", async () => {
    const { id, secret } = await dropWriter("booting-page");
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "operator", canRun: true, onFrame: () => undefined });
    const first = (await page.ready) as { t: string; placement: { where: string } };
    assert.equal(first.t, "viewing");
    assert.equal(first.placement.where, "parked", "told the run waits for it, so the page attaches as the writer by itself");
    await new Promise((r) => setTimeout(r, 1_500)); // booting its computer: well past the plain 0.4 s
    assert.equal(ofRun(id, "cloud.started").length, 0, "the run is still waiting for it");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", pingMs: 100 });
    await tab.ready;
    tab.send({ t: "writer-ready" });
    await until(() => ofRun(id, "placement.writer-grace").length === 1);
    assert.equal(ofRun(id, "placement.writer-grace")[0]!.data.outcome, "returned");
    assert.equal(ofRun(id, "cloud.started").length, 0);
    tab.close();
    page.close();
  });

  it("tells a page that asks in the instant between the socket closing and the writer being declared gone, and the grace then waits for it", async () => {
    const { id, secret } = await local.server.createRun("fast-reload");
    const tab: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", pingMs: 100 });
    await tab.ready;
    tab.close();
    await new Promise((r) => setTimeout(r, 30)); // the reloaded page is quick: its hello lands before the pipe declares the writer gone (about 250 ms after the close)
    assert.equal(ofRun(id, "pipe.writer-gone").length, 0, "the writer is not declared gone yet");
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "operator", canRun: true, onFrame: () => undefined });
    const first = (await page.ready) as { t: string; placement: { where: string } };
    assert.equal(first.placement.where, "parked", "told the run waits for it");
    await new Promise((r) => setTimeout(r, 1_200)); // booting: past the plain 0.4 s of grace
    assert.equal(ofRun(id, "cloud.started").length, 0);
    const back: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", pingMs: 100 });
    await back.ready;
    back.send({ t: "writer-ready" });
    await until(() => ofRun(id, "placement.writer-grace").length === 1 || ofRun(id, "cloud.started").length === 1, 8_000);
    assert.equal(ofRun(id, "cloud.started").length, 0, "the run never went to the cloud");
    back.close();
    page.close();
  });

  it("does not wait longer for a plain viewer, which is not offered the run either", async () => {
    const { id, secret } = await dropWriter("plain-viewer");
    const viewer: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "view", onFrame: () => undefined });
    const first = (await viewer.ready) as { t: string; placement: { where: string } };
    assert.notEqual(first.placement.where, "parked", "a viewer that cannot run the run is not offered it");
    await until(() => ofRun(id, "placement.writer-grace").length === 1);
    assert.equal(ofRun(id, "placement.writer-grace")[0]!.data.outcome, "expired");
    assert.ok((ofRun(id, "placement.writer-grace")[0]!.data.ms as number) < 1_500, "the plain grace, not an extended one");
    viewer.close();
  });

  it("still gives up on a page that asked and never attaches, at the boot allowance", async () => {
    const { id, secret } = await dropWriter("never-attaches");
    const page: PipeClient = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "operator", canRun: true, onFrame: () => undefined });
    await page.ready;
    await until(() => ofRun(id, "placement.writer-grace").length === 1, 8_000);
    const grace = ofRun(id, "placement.writer-grace")[0]!.data;
    assert.equal(grace.outcome, "expired");
    assert.ok((grace.ms as number) >= 2_500 && (grace.ms as number) <= 4_500, `waited out the boot allowance (${grace.ms} ms)`);
    await until(() => ofRun(id, "cloud.started").length === 1);
    page.close();
  });
});
