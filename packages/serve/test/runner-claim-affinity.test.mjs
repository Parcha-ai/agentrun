// A parked run's kept computer survives a resume while the runner that kept it is alive: that runner alone claims the
// run, and the same machine comes back. Once that runner is stale (no word of it for PRESENCE_STALE_MS) any runner
// claims it, starts a new machine, and the run says in words that the kept one was lost with its runner. Once that runner
// refuses claims but is still there, any runner claims it too, and puts the kept row back as it read it when it can't
// reach the machine, so the runner that kept it still ends it at its time; that claim's own park later never writes over
// that row (it keeps nothing, and its own machine goes as at a run's end), and that runner never takes its machine back as
// the run's. A runner that
// may not claim the run claims nothing and moves nothing (no claim-and-give-back), at its usual poll. A single runner
// is unchanged. The store's own rule, on both dialects, is store-claim-affinity.test.mjs; the janitor's,
// workspace-computer-kept.test.mjs.
//
// The runner, the pi spec and the adapter loop as they really run (runner-park-keeps-computer.test.mjs), with the
// server's store and each runner's store on one clock the test can move (adapter-pi-cap-raise-crash.test.mjs): kill()
// leaves a runner's word to go stale, as a crash does. Each host has a vendor of its own (`hosts.a`, `hosts.b`): a
// machine A made is one B's provider cannot find, as a Docker container on A's engine or a dial machine whose socket is
// in A's hub. --faux's desktop is declared a dial provider here (PINNED_KINDS), so the keep pins it to its runner
// (computer-kept.ts pinnedOf); the vendor is the test's own, so nothing dials.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { endKept, KEEP_MS, keptKeyOf, readKept, sweepKept } = await import("../dist/workspace/computer-kept.js");
const { PRESENCE_STALE_MS } = await import("../dist/runner/presence.js");
const { runTimeline } = await import("../dist/store-reads/journal.js");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const DESKTOP = { kind: "desktop", provider: "faux-desktop" };
const FAUX = fauxComputers();
/** --faux's registry with its desktop declared a dial provider: a machine only the runner that made it can reach. */
const PINNED_KINDS = { ...FAUX.kinds, PROVIDERS: FAUX.kinds.PROVIDERS.map((one) => (one.id === "faux-desktop" ? { ...one, connect: "dial" } : one)) };
/** Each runner's poll: short, so a busy loop would show as many more polls than the window allows. */
const POLL_MS = 20;
const TIMING = { ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000, pollMs: POLL_MS };
after(closeOpenSessions);

const SAME = "It's the same desktop, as the wait left it.";
const NEW = "It's a new desktop";
/** Why the resume's desktop is a new one, once the runner that kept it is gone: it names no runner. */
const LOST = "The desktop wasn't kept: the runner that kept it is gone.";

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** One host's vendor of --faux's desktops, its ids prefixed by the host: create starts one under the spec's labels,
 *  attach and connect find only this host's, delete ends it. */
function hostVendor(host) {
  const entry = FAUX.kinds.PROVIDERS.find((one) => one.id === "faux-desktop");
  const computers = new Map();
  const calls = [];
  let made = 0;
  const provider = {
    id: "faux-desktop",
    version: "0",
    capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }),
    check: () => [],
    async list(labels) {
      const held = [...computers.values()].filter((one) => Object.entries(labels).every(([name, value]) => one.labels[name] === value));
      return { ok: true, value: held.map((one) => ({ ref: { id: one.id, name: one.id }, labels: { ...one.labels }, deadline: new Date(Date.now() + 3_600_000), state: "running", network: "open" })) };
    },
    async create(spec) {
      const id = `${host}-d${++made}`;
      calls.push(["create", id]);
      computers.set(id, { id, labels: { ...spec.labels }, desk: await FAUX.launch(entry, { kind: "desktop", keys: {} }) });
      return { ok: true, value: { id, name: id } };
    },
    async attach({ id }) {
      calls.push(["attach", id]);
      if (!computers.has(id)) return { ok: false, error: { code: "not_found", message: `no computer ${id}` } };
      return { ok: true, value: { id, name: id, spec: { image: "faux", user: "1000:1000", network: "open" } } };
    },
    async connect({ id }) {
      const one = computers.get(id);
      if (!one) return { ok: false, error: { code: "gone", message: `no computer ${id}` } };
      return { ok: true, value: { client: one.desk.client, hello: one.desk.hello, close: async () => {} } };
    },
    async watch() {
      return { ok: true, value: { input: async () => ({ ok: true, value: { done: 0 } }), close: async () => {} } };
    },
    async release(ref, how) {
      calls.push(["release", ref.id, how]);
      if (!computers.has(ref.id)) return { ok: false, error: { code: "not_found", message: `no computer ${ref.id}` } };
      if (how === "delete") {
        await computers.get(ref.id)?.desk.release().catch(() => {});
        computers.delete(ref.id);
      }
      return { ok: true, value: undefined };
    },
  };
  return { provider, computers, calls };
}

const creates = (vendor) => vendor.calls.filter(([verb]) => verb === "create").map(([, id]) => id);

/** `store` with its runs' claimMany counted (`calls.n`, each claim by the number of the call that made it in
 *  `calls.claimed`) and, while `gate.shut`, held until the gate opens: how the test makes A's poll wait while B's polls
 *  run, so a B that may claim the run claims it first whatever the timing. With `keptReads` ({ fail, failed }), the next
 *  `fail` reads of run-1's kept row throw as a store that did not answer, each counted in `failed`. */
function watchedStore(store, gate = { shut: false }, calls = { n: 0, claimed: [] }, keptReads = undefined) {
  const settings = keptReads && new Proxy(store.settings, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "get") return typeof value === "function" ? value.bind(target) : value;
      return async (name, ...rest) => {
        if (name === keptKeyOf(RUN) && keptReads.fail > 0) {
          keptReads.fail -= 1;
          keptReads.failed += 1;
          throw new Error("the store did not answer");
        }
        return value.apply(target, [name, ...rest]);
      };
    },
  });
  const runs = new Proxy(store.runs, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "claimMany") return typeof value === "function" ? value.bind(target) : value;
      return async (...args) => {
        calls.n += 1;
        const n = calls.n;
        if (gate.shut) await gate.opened;
        const claims = await value.apply(target, args);
        if (claims.length > 0) calls.claimed.push({ n, runIds: claims.map((claim) => claim.runId) });
        return claims;
      };
    },
  });
  return new Proxy(store, {
    get(target, key) {
      if (key === "runs") return runs;
      if (key === "settings" && settings) return settings;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A gate that starts open: close() holds every claimMany behind it until open(). */
function claimGate() {
  const gate = { shut: false, opened: Promise.resolve() };
  gate.close = () => {
    let open;
    gate.opened = new Promise((resolve) => (open = resolve));
    gate.open = () => {
      gate.shut = false;
      open();
    };
    gate.shut = true;
  };
  return gate;
}

/**
 * run-1 on a pinned desktop whose tools ask, parked on its screenshot's ask by runner-a (host a). The server's store and
 * the runners' stores share one clock the test moves (`clock.skewMs`, from `skewMs`); the runners' own clocks (their
 * computers') stay the real one. `start(name, host, options)` starts another runner on host `host`'s vendor; `gate` holds
 * runner-a's polls; while `refusal.words` is set, runner-a's claim gate refuses in those words (as runner/main.ts
 * diskFreeGate does), so it stays there and claims nothing. `script`: the model's turns (default: one screenshot, which
 * asks and parks, then done).
 */
async function parkedOnA(t, { skewMs = 0, script = [{ call: "computer_screenshot", args: {} }, { say: "done" }] } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-claim-affinity-"));
  const clock = { skewMs };
  const now = () => Date.now() + clock.skewMs;
  const server = await openSqliteStore({ dataDir: dir, role: "server", now });
  const stores = [];
  const runners = [];
  t.after(async () => {
    for (const runner of runners) await runner.close().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: DESKTOP, tools: ["read"], toolSettings: { desktop: { permission: "ask" } } } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } } });
  await server.settings.put("approvers", { approvers: true });
  await server.flush?.();
  const requests = [];
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin(script, requests), price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 100 };
  const hosts = { a: hostVendor("a"), b: hostVendor("b") };
  const claimManyCalls = {};
  const start = async (name, host, { gate, keptReads, refusal } = {}) => {
    const raw = await openSqliteStore({ dataDir: dir, role: "runner", now });
    stores.push(raw);
    claimManyCalls[name] = { n: 0, claimed: [] };
    const store = watchedStore(raw, gate, claimManyCalls[name], keptReads);
    const computerDeps = { kinds: PINNED_KINDS, keyTable: FAUX.keyTable, providers: { "faux-desktop": () => hosts[host].provider }, spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open" }), check: { readBackOf } };
    const deps = { env: {}, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps };
    const runner = startRunner({
      store, name, ...TIMING,
      ...(refusal ? { claimGate: async () => refusal.words } : {}),
      createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (harness, given) => (harness === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
    });
    runners.push(runner);
    return runner;
  };
  const gate = claimGate();
  const refusal = { words: undefined };
  const a = await start("runner-a", "a", { gate, refusal });
  const parked = await until(async () => {
    const row = await server.runs.get(RUN);
    return ["ended", "failed", "stopped", "parked"].includes(row.state) && row.runner === null && row;
  }, "the run rests");
  assert.equal(parked.state, "parked", JSON.stringify(parked));
  const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: parked.epoch, until: 0, from: parked.state }), ctx);
  const [ask] = records.entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data);
  assert.ok(ask, "parked on the screenshot's ask");
  assert.deepEqual(creates(hosts.a), ["a-d1"], "runner-a made the desktop on its host");
  return { server, clock, hosts, ask, a, gate, refusal, start, claimManyCalls, parkedEpoch: parked.epoch };
}

/** Two screenshots, each asking and parking, then done: a run that parks again after its first resume. */
const TWO_ASKS = [{ call: "computer_screenshot", args: {} }, { call: "computer_screenshot", args: {} }, { say: "done" }];

/** Until the run rests parked again at an epoch past `epoch`; its row and its newest ask. */
async function parksAgain(server, epoch) {
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return now.state === "parked" && now.runner === null && now.epoch > epoch && now;
  }, "the run parks again");
  const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const ask = records.entries.filter((entry) => entry.kind === "agentrun.ask").map((entry) => entry.data).at(-1);
  return { row, ask };
}

/** run-1 parked on A, A refusing claims (its disk full) but there; B started on host b and the run answered: B gives the
 *  kept row back, goes on on a new desktop of its own host and parks on the second ask. */
async function reparkedOnB(t) {
  const one = await parkedOnA(t, { script: TWO_ASKS });
  const atPark = await readKept(one.server.settings, RUN);
  assert.equal(atPark?.id, "a-d1");
  one.refusal.words = "this runner's disk is full";
  await until(async () => (await one.server.runners.list()).find((row) => row.runner === "runner-a")?.refused, "runner-a's word says it refuses", 10_000);
  const b = await one.start("runner-b", "b");
  await one.server.command(RUN, { kind: "approve", body: { approval: one.ask.callId } });
  const again = await parksAgain(one.server, one.parkedEpoch);
  assert.ok(again.ask && again.ask.callId !== one.ask.callId, `parked on the second ask: ${JSON.stringify(again.ask)}`);
  assert.deepEqual(creates(one.hosts.b), ["b-d1"], "B went on on a new desktop of its own host");
  assert.ok(one.hosts.a.computers.has("a-d1"), "A's desktop still runs on A's host");
  return { ...one, atPark, b, again };
}

/** Until the run ends; its row and its timeline's summaries. */
async function ends(server, state = "ended") {
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
  }, "the run ends");
  assert.equal(row.state, state, JSON.stringify(row));
  return (await runTimeline(server, RUN, ctx)).map((entry) => entry.summary ?? "");
}

/** B started on host b, A's polls held, the run answered; B polls 25 times (or claims the run). What B's polls did. */
async function answeredWhileBPolls(one) {
  await one.start("runner-b", "b");
  one.gate.close();
  await one.server.command(RUN, { kind: "approve", body: { approval: one.ask.callId } });
  const from = Date.now();
  const polledFrom = one.claimManyCalls["runner-b"].n;
  await until(async () => one.claimManyCalls["runner-b"].n - polledFrom >= 25 || (await one.server.runs.get(RUN)).epoch !== one.parkedEpoch, "B polls 25 times", 10_000);
  return { elapsed: Date.now() - from, polls: one.claimManyCalls["runner-b"].n - polledFrom };
}

test("park on A, answered while A is alive and B polls: B claims nothing and moves nothing at its usual poll, A claims it, and the same desktop comes back", { timeout: 120_000 }, async (t) => {
  const one = await parkedOnA(t);
  const [rowA] = (await one.server.runners.list()).filter((row) => row.runner === "runner-a");
  const kept = await one.server.settings.get(keptKeyOf(RUN));
  const { elapsed, polls } = await answeredWhileBPolls(one);
  assert.equal((await one.server.runs.get(RUN)).epoch, one.parkedEpoch, "B claimed nothing and gave nothing back: the epoch did not move");
  assert.ok(polls <= Math.ceil(elapsed / POLL_MS) + 3, `B polled at its pace, no busy loop: ${polls} polls in ${elapsed} ms`);
  assert.deepEqual(creates(one.hosts.b), [], "B made no desktop");
  // The keep named the runner that holds the desktop and its incarnation, as a dial token's row does.
  assert.equal(kept?.runner, "runner-a", `the keep names its runner: ${JSON.stringify(kept)}`);
  assert.equal(kept?.incarnation, rowA.incarnation, "and that runner's incarnation");

  one.gate.open();
  const said = await ends(one.server);
  assert.deepEqual(creates(one.hosts.a), ["a-d1"], "the same desktop: no create at the resume");
  assert.deepEqual(creates(one.hosts.b), [], "nothing on B's host");
  assert.equal(said.filter((summary) => summary.endsWith(SAME)).length, 1, `the resume said it is the same one: ${JSON.stringify(said)}`);
  assert.deepEqual(said.filter((summary) => summary.includes(NEW)), [], "never called a new one");
});

test("park on A with the runners' clocks a keep and more behind the store's: the keep's end is stamped on the store's clock, so B claims nothing while A is live, and A gets the same desktop back", { timeout: 120_000 }, async (t) => {
  // The store's clock (the deadlines', the one the claim rule judges the keep by) runs KEEP_MS and a minute ahead of the
  // runners' own from the start.
  const one = await parkedOnA(t, { skewMs: KEEP_MS + 60_000 });
  const kept = await readKept(one.server.settings, RUN);
  assert.ok(kept, "kept at the park");
  const storeNow = Date.now() + one.clock.skewMs;
  assert.ok(kept.until > storeNow && kept.until <= storeNow + KEEP_MS, `the keep's end is stamped on the store's clock, KEEP_MS from the park: ${kept.until - storeNow} ms ahead of the store's now`);
  const { elapsed, polls } = await answeredWhileBPolls(one);
  assert.equal((await one.server.runs.get(RUN)).epoch, one.parkedEpoch, "B claimed nothing: the pin holds on the store's clock");
  assert.ok(polls <= Math.ceil(elapsed / POLL_MS) + 3, `B polled at its pace: ${polls} polls in ${elapsed} ms`);
  assert.deepEqual(creates(one.hosts.b), [], "B made no desktop");
  one.gate.open();
  const said = await ends(one.server);
  assert.deepEqual(creates(one.hosts.a), ["a-d1"], "the same desktop: A's resume judged the keep on the store's clock too");
  assert.equal(said.filter((summary) => summary.endsWith(SAME)).length, 1, `said the same one: ${JSON.stringify(said)}`);
});

test("leak (a): another runner's resume never orphans A's kept container: once the run ends, A's timer's end finds every machine on A's host gone or still named by its row", { timeout: 120_000 }, async (t) => {
  const one = await parkedOnA(t);
  // The row A's park wrote, as A's own timer holds it to end at its time (computer-for-claim.ts park, endKept).
  const atPark = await readKept(one.server.settings, RUN);
  assert.equal(atPark?.id, "a-d1");
  await answeredWhileBPolls(one);
  one.gate.open();
  await ends(one.server);
  // A's timer at the keep's time: its end deletes the machine only while the row still reads as it wrote it.
  const timerDeleted = [];
  await endKept(one.server.settings, RUN, atPark, async () => {
    timerDeleted.push(atPark.id);
    await one.hosts.a.provider.release({ id: atPark.id, name: atPark.name }, "delete");
  });
  const named = (await readKept(one.server.settings, RUN))?.id;
  const leftOnA = () => [...one.hosts.a.computers.keys()].filter((id) => id !== named);
  // The run's end lets its desktop go a moment after its row reads ended.
  const settle = Date.now() + 5_000;
  while (leftOnA().length > 0 && Date.now() < settle) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(leftOnA(), [],`no container left on A's host that no kept row names: the resume's taking of the row left A's timer nothing to end (it deleted ${JSON.stringify(timerDeleted)})`);
});

test("park on A, A goes stale: B claims it, starts a new desktop, and the run says the kept one was lost with its runner", { timeout: 120_000 }, async (t) => {
  const one = await parkedOnA(t);
  // A crash: its word stops and goes stale on the stores' clock. The keep's own 10 minutes are far off.
  one.a.kill();
  one.clock.skewMs += PRESENCE_STALE_MS + 1_000;
  await one.start("runner-b", "b");
  await one.server.command(RUN, { kind: "approve", body: { approval: one.ask.callId } });
  const said = await ends(one.server);
  assert.deepEqual(creates(one.hosts.b), ["b-d1"], "a new desktop on B's host");
  assert.deepEqual(creates(one.hosts.a), ["a-d1"], "nothing more on A's");
  assert.equal(said.filter((summary) => summary.includes(`${LOST} ${NEW}`)).length, 1, `said once, with why: ${JSON.stringify(said)}`);
  assert.deepEqual(said.filter((summary) => summary.endsWith(SAME)), [], "never called the same one");
  assert.deepEqual(said.filter((summary) => summary.includes("10 minutes passed")), [], "not the lapsed words: its time had not passed");
  assert.equal(await readKept(one.server.settings, RUN), undefined, "the keep was taken");
});

test("park on A, A still there but refusing claims: B claims on the answer, can't reach A's desktop, and puts the kept row back as A's park wrote it, so A's own end at its time deletes the desktop", { timeout: 120_000 }, async (t) => {
  const one = await parkedOnA(t);
  const key = keptKeyOf(RUN);
  // The row as A's park wrote it: A's timer ends the desktop only while the row still reads this (endKept's compare).
  const written = await one.server.settings.get(key);
  const atPark = await readKept(one.server.settings, RUN);
  assert.equal(atPark?.id, "a-d1");
  // A's claim gate refuses (a disk that filled up): A stays there, renewing its word, and claims nothing. The pin needs a
  // runner that claims, so the run is any runner's.
  one.refusal.words = "this runner's disk is full";
  await until(async () => (await one.server.runners.list()).find((row) => row.runner === "runner-a")?.refused, "runner-a's word says it refuses", 10_000);
  await one.start("runner-b", "b");
  await one.server.command(RUN, { kind: "approve", body: { approval: one.ask.callId } });
  await ends(one.server);
  assert.deepEqual(creates(one.hosts.b), ["b-d1"], "B went on on a new desktop of its own host");
  assert.ok(one.hosts.a.computers.has("a-d1"), "A's desktop still runs on A's host");
  assert.ok((await one.server.runners.live(PRESENCE_STALE_MS)).some((row) => row.runner === "runner-a"), "runner-a is still there");
  // B took the row and could not reach the machine: the row is back, the same text, for A's end to compare against.
  assert.deepEqual(await one.server.settings.get(key), written, `the kept row is back as runner-a's park wrote it: ${JSON.stringify(await one.server.settings.get(key))}`);
  assert.equal(JSON.stringify(await one.server.settings.get(key)), JSON.stringify(written), "byte for byte");
  // A's timer at the keep's time (computer-for-claim.ts park): its end finds the row it wrote and deletes the desktop.
  const ended = await endKept(one.server.settings, RUN, atPark, async () => {
    await one.hosts.a.provider.release({ id: atPark.id, name: atPark.name }, "delete");
  });
  assert.equal(ended, true, "A's end found its row");
  assert.equal(one.hosts.a.computers.has("a-d1"), false, "and deleted A's desktop: nothing left running with nothing to end it");
});

test("park on A, A there but refusing: B gives the row back, goes on on a new desktop and parks again; B's park never writes over A's row, so A's own end at its time still deletes A's desktop, and B's desktop is ended at that park, not left running with no row", { timeout: 120_000 }, async (t) => {
  const one = await reparkedOnB(t);
  const row = await readKept(one.server.settings, RUN);
  assert.deepEqual([row?.id, row?.runner], ["a-d1", "runner-a"], `the kept row is still runner-a's: ${JSON.stringify(row)}`);
  // B's park kept nothing: its desktop goes as at a run's end, so no machine is left with no row and no runner to end it.
  await until(async () => !one.hosts.b.computers.has("b-d1"), "B's desktop is ended at its park", 5_000);
  // A's timer at the keep's time (computer-for-claim.ts park): its end still finds its row and deletes the desktop.
  const ended = await endKept(one.server.settings, RUN, one.atPark, async () => {
    await one.hosts.a.provider.release({ id: one.atPark.id, name: one.atPark.name }, "delete");
  });
  assert.equal(ended, true, "A's end found its row");
  assert.equal(one.hosts.a.computers.has("a-d1"), false, "and deleted A's desktop");
  assert.equal((await readKept(one.server.settings, RUN))?.ended, true, "its row reads ended");
});

test("park on A, A there but refusing, B gives the row back, goes on on a new desktop and parks again; then A claims again: a new desktop, never A's earlier one called the same, nor said to have lapsed", { timeout: 120_000 }, async (t) => {
  const one = await reparkedOnB(t);
  // Only runner-a from here, claiming again (its disk freed).
  await one.b.close();
  one.refusal.words = undefined;
  await one.server.command(RUN, { kind: "approve", body: { approval: one.again.ask.callId } });
  const said = await ends(one.server);
  assert.deepEqual(creates(one.hosts.a), ["a-d1", "a-d2"], "a new desktop on A's host: the one A kept stopped being the run's when B went on without it");
  assert.deepEqual(said.filter((summary) => summary.endsWith(SAME)), [], `never called the same one: ${JSON.stringify(said)}`);
  assert.deepEqual(said.filter((summary) => summary.includes("10 minutes passed")), [], "nor said to have lapsed: its time had not passed");
  assert.equal(said.filter((summary) => summary.includes(NEW)).length, 2, "each resume said its desktop is a new one");
});

test("a stop of a parked run pinned to a live runner whose loops are full ends within one poll on another runner, and that runner never takes the kept machine", { timeout: 120_000 }, async (t) => {
  const one = await parkedOnA(t);
  const [rowA] = (await one.server.runners.list()).filter((row) => row.runner === "runner-a");
  await one.start("runner-b", "b");
  // A's loops full: its polls claim nothing while the gate is shut (as a runner with no free loop claims nothing).
  one.gate.close();
  await one.server.command(RUN, { kind: "stop" });
  const polledFrom = one.claimManyCalls["runner-b"].n;
  // A person's stop never waits on the pin: the poll B had in flight when it landed, or B's next, claims the run.
  const ended = await until(async () => {
    const row = await one.server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(row.state) && row.runner === null && row;
  }, "B ends the run on the stop, runner-a live with its loops full", 10_000);
  assert.equal(ended.state, "stopped", JSON.stringify(ended));
  const claimedAt = one.claimManyCalls["runner-b"].claimed.find(({ runIds }) => runIds.includes(RUN))?.n;
  assert.ok(claimedAt !== undefined && claimedAt - polledFrom <= 1, `B claimed it within one poll of the stop: at poll ${claimedAt}, the stop landed at ${polledFrom}`);
  // B ends the run with no loop: it never takes the kept row, and asks no provider of its own anything (no attach of
  // A's machine, no new desktop, no delete).
  assert.deepEqual(one.hosts.b.calls, [], "B asked its provider nothing");
  const kept = await readKept(one.server.settings, RUN);
  assert.equal(kept?.id, "a-d1", `the kept row is still there: ${JSON.stringify(kept)}`);
  assert.deepEqual([kept?.runner, kept?.incarnation], ["runner-a", rowA.incarnation], "and still names runner-a: B did not take it");
  assert.ok(!kept.ending && !kept.ended, "nor ended it");
  assert.ok(one.hosts.a.computers.has("a-d1"), "A's desktop still runs on A's host");
  one.gate.open();

  // B's janitor leaves it though the run is final: runner-a is still there (leak (b)).
  const janitor = (self) => sweepKept({ settings: one.server.settings, runs: one.server.runs, now: Date.now() + one.clock.skewMs, providerOf: async () => (self.runner === "runner-a" ? one.hosts.a.provider : one.hosts.b.provider), runners: one.server.runners, self });
  const byB = await janitor({ runner: "runner-b", incarnation: "b-any" });
  assert.deepEqual(byB.ended, [], "B's janitor ends nothing of runner-a's");
  assert.equal((await readKept(one.server.settings, RUN))?.runner, "runner-a", "the row stays runner-a's");
  // A sees the run ended at its janitor's pass (the run final, the row its own) and ends its desktop on its own host;
  // else its park's timer does at the keep's time.
  const byA = await janitor({ runner: "runner-a", incarnation: rowA.incarnation });
  assert.deepEqual(byA.ended, ["a-d1"], `A's janitor ends its own kept desktop: ${JSON.stringify(byA)}`);
  assert.equal(one.hosts.a.computers.has("a-d1"), false, "gone from A's host");
  assert.equal(await readKept(one.server.settings, RUN), undefined, "and its row with it, the run being over");
  assert.deepEqual(one.hosts.b.calls, [], "B's host was never asked, start to end");
});

test("a stop of a parked run pinned to a live runner, claimed by another runner whose read of the kept row fails, ends ends-only: no loop starts, and the kept row and machine stay runner-a's", { timeout: 120_000 }, async (t) => {
  const one = await parkedOnA(t);
  const [rowA] = (await one.server.runners.list()).filter((row) => row.runner === "runner-a");
  // B's first read of the kept row fails, as a store that did not answer once; every later read succeeds. A loop
  // started on that failure would read the row again in its claim's computer, take it and try A's machine on B's host.
  const keptReads = { fail: 1, failed: 0 };
  await one.start("runner-b", "b", { keptReads });
  one.gate.close();
  await one.server.command(RUN, { kind: "stop" });
  const ended = await until(async () => {
    const row = await one.server.runs.get(RUN);
    return ["ended", "failed", "stopped"].includes(row.state) && row.runner === null && row;
  }, "B ends the run on the stop, its read of the kept row failed", 10_000);
  assert.equal(ended.state, "stopped", JSON.stringify(ended));
  assert.equal(keptReads.failed, 1, "B's read of who holds the kept machine failed");
  // An unreadable holder counts as held elsewhere: B ends the run with no loop, so its provider is asked nothing.
  assert.deepEqual(one.hosts.b.calls, [], "B asked its provider nothing: no loop started on the failed read");
  const kept = await readKept(one.server.settings, RUN);
  assert.equal(kept?.id, "a-d1", `the kept row is still there: ${JSON.stringify(kept)}`);
  assert.deepEqual([kept?.runner, kept?.incarnation], ["runner-a", rowA.incarnation], "and still names runner-a");
  assert.ok(!kept.ending && !kept.ended, "nor ended");
  assert.ok(one.hosts.a.computers.has("a-d1"), "A's desktop still runs on A's host, for A's own timer or janitor to end");
  one.gate.open();
});

test("a single runner, unchanged: its resume gets the same desktop at once; after its clean restart, the next runner on the same host gets it too", { timeout: 120_000 }, async (t) => {
  const one = await parkedOnA(t);
  await one.server.command(RUN, { kind: "approve", body: { approval: one.ask.callId } });
  const said = await ends(one.server);
  assert.deepEqual(creates(one.hosts.a), ["a-d1"], "the same desktop");
  assert.equal(said.filter((summary) => summary.endsWith(SAME)).length, 1);

  const two = await parkedOnA(t);
  // A clean stop removes runner-a's word at once (presence.ts close): nothing pins the run, with no wait.
  await two.a.close();
  await two.start("runner-a2", "a");
  await two.server.command(RUN, { kind: "approve", body: { approval: two.ask.callId } });
  const again = await ends(two.server);
  assert.deepEqual(creates(two.hosts.a), ["a-d1"], "the same container, from the same host's engine");
  assert.equal(again.filter((summary) => summary.endsWith(SAME)).length, 1, `the same one: ${JSON.stringify(again)}`);
});
