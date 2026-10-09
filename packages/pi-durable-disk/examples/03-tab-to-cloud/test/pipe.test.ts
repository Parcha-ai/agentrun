// The pipe's protocol on a local directory: pi's storage conformance suite through a real WebSocket, write-through with
// its barrier ordering, restore, takeover and the epoch fence, the model proxy and its budget.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, readFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { registerConformance } from "./_conformance.ts";
import { PipeClient, remoteStorage } from "../tab/pipe-client.ts";
import { PipeLostError, toBase64, type Move, type PipeFrame } from "../wire.ts";
import type { CloudHost } from "../pipe/server.ts";
import { localServer, modelStub } from "./_local.ts";

const text = (s: string) => toBase64(new TextEncoder().encode(s));

describe("storage conformance through the pipe", async () => {
  const local = await localServer({ scratchStores: true });
  const { id, secret } = await local.server.createRun("conf");
  let n = 0;
  after(() => local.remove());
  registerConformance("pipe", async (use) => {
    const client = new PipeClient({ url: local.url, run: id, token: secret, tab: `case-${++n}`, mode: "write", takeover: true });
    await client.ready;
    try {
      await use(remoteStorage(client));
    } finally {
      client.close();
    }
  });
});

describe("the pipe", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  let model: Awaited<ReturnType<typeof modelStub>>;
  let barrierCalls = 0;
  before(async () => {
    model = await modelStub(() => "hello from the stub");
    local = await localServer({
      model: { baseUrl: model.url, model: "gpt-stub", budgetTokens: 40 },
      writerGraceMs: 600,
      hooks: { barrier: async () => void barrierCalls++ },
    });
  });
  after(async () => {
    await local.remove();
    await model.close();
  });

  it("refuses a hello with the wrong secret", async () => {
    const { id } = await local.server.createRun("auth");
    const client = new PipeClient({ url: local.url, run: id, token: "wrong", tab: "t", mode: "write" });
    await assert.rejects(client.ready);
  });

  it("writes files under work/, syncs, and only then answers; restores them on the next attach", async () => {
    const { id, secret } = await local.server.createRun("files");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    const attached = await a.ready;
    assert.equal(attached.t, "attached");
    const before = barrierCalls;
    await a.syncFiles([
      { path: "notes/hello.txt", op: "write", data: text("hi\n") },
      { path: "empty", op: "mkdir" },
    ]);
    assert.equal(barrierCalls, before + 1);
    const work = join(local.root, "runs", id, "work");
    assert.equal(readFileSync(join(work, "notes/hello.txt"), "utf8"), "hi\n");
    assert.ok(existsSync(join(work, "empty")));
    for (const bad of ["../store/run.sqlite", "/etc/passwd", "a/./b", "a//b", ""]) {
      await assert.rejects(a.syncFiles([{ path: bad, op: "write", data: text("x") }]), /unsafe|relative/);
    }
    // A symbolic link the cloud's agent left is never followed by a write.
    symlinkSync("../store", join(work, "link"));
    await assert.rejects(a.syncFiles([{ path: "link/run.sqlite", op: "write", data: text("x") }]), /not a directory/);
    await a.syncFiles([{ path: "notes/hello.txt", op: "delete" }]);
    a.close();
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "b", mode: "write" });
    const again = (await b.ready) as Extract<Awaited<typeof b.ready>, { t: "attached" }>;
    const paths = again.files.map((f) => `${f.kind}:${f.path}`).sort();
    assert.deepEqual(paths, ["directory:empty", "directory:notes", "symlink:link"]);
    b.close();
  });

  it("a takeover moves the run: the old tab's next call fails, the new one commits", async () => {
    const { id, secret } = await local.server.createRun("takeover");
    const lostA: string[] = [];
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onLost: (code) => lostA.push(code) });
    await a.ready;
    const sa = remoteStorage(a);
    const conv = await sa.mintId();
    assert.ok(conv);
    // Without takeover, a second device only watches.
    const viewer = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "write" });
    assert.equal((await viewer.ready).t, "viewing");
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "b", mode: "write", takeover: true });
    const attachedB = await b.ready;
    assert.equal(attachedB.t, "attached");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(lostA, ["MOVED"]);
    await assert.rejects(sa.mintId(), (e: unknown) => e instanceof PipeLostError);
    await assert.rejects(a.syncFiles([{ path: "x", op: "write", data: text("x") }]), (e: unknown) => e instanceof PipeLostError);
    assert.ok(await remoteStorage(b).mintId());
    viewer.close();
    b.close();
  });

  it("proxies model calls with its own model name and stops at the budget", async () => {
    const { id, secret } = await local.server.createRun("model");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    const first = await a.fetch("http://ignored/v1/chat/completions", { body: JSON.stringify({ model: "something-else", messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(first.status, 200);
    const body = await first.text();
    assert.match(body, /hello from the stub/);
    assert.equal(model.requests.at(-1)!.model, "gpt-stub");
    assert.equal(model.requests.at(-1)!.stream, true);
    const second = await a.fetch("http://x/v1/chat/completions", { body: JSON.stringify({ messages: [] }) });
    await second.text();
    // 15 + 15 tokens spent of 40; the third call is still allowed, the fourth refused.
    await (await a.fetch("http://x/v1/chat/completions", { body: JSON.stringify({ messages: [] }) })).text();
    const refused = await a.fetch("http://x/v1/chat/completions", { body: JSON.stringify({ messages: [] }) });
    assert.equal(refused.status, 429);
    a.close();
  });

  it("a tab that stops pinging is gone: the pipe releases the run", async () => {
    const { id, secret } = await local.server.createRun("gone");
    const placements: string[] = [];
    local.server.on("placement", (run, p) => run === id && placements.push(p.where));
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", pingMs: 60_000 });
    await a.ready;
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(placements.at(-1), "parked");
    assert.equal(local.server.runs.get(id)!.pipe, undefined);
    const record = JSON.parse(readFileSync(join(local.root, "runs", id, "run.json"), "utf8"));
    assert.equal(record.status, "paused");
    assert.equal(typeof record.sealedSeq, "number");
    a.close();
    mkdirSync(join(local.root, "unused"), { recursive: true });
  });
});

describe("switching environments", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const calls: { op: string; env?: string; move?: Move; how?: string }[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const cloud: CloudHost = {
    environments: [{ id: "far", label: "Far away", phrase: "a far-away host", kind: "cloud" }],
    async start(_ref, run) {
      calls.push({ op: "start", env: run.env, move: run.move });
      return { host: "far-1" };
    },
    async stop(_ref, how) {
      calls.push({ op: "stop", ...(how ? { how } : {}) });
    },
  };
  before(async () => {
    local = await localServer({ cloud, drainMs: 400, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(() => local.remove());

  const until = async (check: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("tab to cloud: the tab drains, the run is released, the cloud starts with a planned move", async () => {
    const { id, secret } = await local.server.createRun("switch-out");
    const frames: PipeFrame[] = [];
    const a: PipeClient = new PipeClient({
      url: local.url, run: id, token: secret, tab: "a", mode: "write",
      onFrame: (f) => {
        frames.push(f);
        if (f.t === "drain") setTimeout(() => a.send({ t: "drained", switchId: f.switchId }), 50);
      },
    });
    const attached = await a.ready;
    assert.equal(attached.t, "attached");
    assert.deepEqual(attached.t === "attached" && attached.environments.map((e) => e.id), ["tab", "far"]);
    a.send({ t: "switch", to: "tab" });
    await until(() => frames.some((f) => f.t === "switch-refused"));
    a.send({ t: "switch", to: "far" });
    const state = local.server.runs.get(id)!;
    await until(() => state.placement.where === "cloud");
    const drain = frames.find((f) => f.t === "drain");
    assert.ok(drain && drain.t === "drain");
    const started = calls.at(-1)!;
    assert.equal(started.op, "start");
    assert.equal(started.env, "far");
    assert.deepEqual({ ...started.move, id: undefined }, { id: undefined, from: "your user's browser tab", planned: true });
    assert.equal(started.move!.id, drain.switchId);
    assert.equal(state.pipe, undefined);
    const drained = events.find((e) => e.event === "switch.drained" && e.data.switchId === drain.switchId);
    assert.equal(drained?.data.drained, true);
    const record = JSON.parse(readFileSync(join(local.root, "runs", id, "run.json"), "utf8"));
    assert.equal(typeof record.sealedSeq, "number");
    assert.ok(frames.some((f) => f.t === "lost" && f.code === "RELEASED"));
    a.close();
  });

  it("cloud to tab: the cloud stops, the asking page is told to run it, its hello carries the move", async () => {
    const { id, secret } = await local.server.createRun("switch-in");
    // Into the cloud first (the writer ignores the drain: the switch goes on after the drain timeout).
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    a.send({ t: "switch", to: "far" });
    const state = local.server.runs.get(id)!;
    await until(() => state.placement.where === "cloud");
    assert.equal(events.find((e) => e.event === "switch.drained" && e.data.run === id)?.data.drained, false);
    a.close();
    const seen: PipeFrame[] = [];
    const v = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "operator", canRun: true, onFrame: (f) => seen.push(f) });
    const viewing = await v.ready;
    assert.equal(viewing.t, "viewing");
    v.send({ t: "switch", to: "tab" });
    await until(() => seen.some((f) => f.t === "run-here"));
    const runHere = seen.find((f) => f.t === "run-here")!;
    assert.ok(runHere.t === "run-here");
    assert.deepEqual(calls.at(-1), { op: "stop", how: "now" });
    // Another tab cannot take the run while the switch waits for the asking one.
    const other = new PipeClient({ url: local.url, run: id, token: secret, tab: "o", mode: "write" });
    assert.equal((await other.ready).t, "viewing");
    other.close();
    const got: PipeFrame[] = [];
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "write", switchId: runHere.switchId, onFrame: (f) => got.push(f) });
    const attached = await b.ready;
    assert.ok(attached.t === "attached");
    assert.equal(attached.move?.id, runHere.switchId);
    assert.deepEqual({ ...attached.move, id: undefined }, { id: undefined, from: "a far-away host", planned: true });
    b.send({ t: "switched", switchId: runHere.switchId });
    await until(() => got.some((f) => f.t === "switched"));
    assert.equal(state.switching, undefined);
    assert.equal(state.placement.where, "tab");
    v.close();
    b.close();
  });
  it("a view-only connection may not switch the run or send it messages; an operator may", async () => {
    const { id, secret } = await local.server.createRun("roles");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write" });
    await a.ready;
    const seen: PipeFrame[] = [];
    const watcher = new PipeClient({ url: local.url, run: id, token: secret, tab: "w", mode: "view", onFrame: (f) => seen.push(f) });
    await watcher.ready;
    watcher.send({ t: "switch", to: "far" });
    watcher.send({ t: "submit", text: "hi", requestId: "r1" });
    await until(() => seen.some((f) => f.t === "switch-refused") && seen.some((f) => f.t === "submit-refused"));
    const refused = seen.find((f) => f.t === "submit-refused");
    assert.ok(refused?.t === "submit-refused" && refused.requestId === "r1");
    const state = local.server.runs.get(id)!;
    assert.equal(state.placement.where, "tab");
    assert.equal(state.switching, undefined);
    // An operator's submit reaches the writer.
    const got: PipeFrame[] = [];
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => got.push(f) });
    await b.ready;
    const op = new PipeClient({ url: local.url, run: id, token: secret, tab: "o", mode: "operator" });
    await op.ready;
    op.send({ t: "submit", text: "hello", requestId: "r2" });
    await until(() => got.some((f) => f.t === "submit" && f.requestId === "r2"));
    for (const c of [a, b, watcher, op]) c.close();
  });

  it("a switch into a tab goes to a page that can run the agent, or is refused before anything moves", async () => {
    const { id, secret } = await local.server.createRun("run-here");
    const a = new PipeClient({ url: local.url, run: id, token: secret, tab: "a", mode: "write", onFrame: (f) => f.t === "drain" && a.send({ t: "drained", switchId: f.switchId }) });
    await a.ready;
    a.send({ t: "switch", to: "far" });
    const state = local.server.runs.get(id)!;
    await until(() => state.placement.where === "cloud");
    a.close();
    // A stage display: it may control the run but cannot run the agent. With no page that can, the switch is refused.
    const stageSeen: PipeFrame[] = [];
    const stage = new PipeClient({ url: local.url, run: id, token: secret, tab: "stage", mode: "operator", onFrame: (f) => stageSeen.push(f) });
    await stage.ready;
    const stops = calls.filter((c) => c.op === "stop").length;
    stage.send({ t: "switch", to: "tab" });
    await until(() => stageSeen.some((f) => f.t === "switch-refused"));
    assert.equal(state.placement.where, "cloud");
    assert.equal(calls.filter((c) => c.op === "stop").length, stops);
    // With a page open that can, the stage's switch tells that page to run it.
    const pageSeen: PipeFrame[] = [];
    const page = new PipeClient({ url: local.url, run: id, token: secret, tab: "p", mode: "operator", canRun: true, onFrame: (f) => pageSeen.push(f) });
    await page.ready;
    stage.send({ t: "switch", to: "tab" });
    await until(() => pageSeen.some((f) => f.t === "run-here"));
    assert.ok(!stageSeen.some((f) => f.t === "run-here"));
    const runHere = pageSeen.find((f) => f.t === "run-here")!;
    assert.ok(runHere.t === "run-here");
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "p", mode: "write", canRun: true, switchId: runHere.switchId });
    assert.equal((await b.ready).t, "attached");
    for (const c of [stage, page, b]) c.close();
  });
});
