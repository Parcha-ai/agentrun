// A run on a priced computer, through the runner, the pi spec and the adapter loop as they really run (#3338 review): its
// computer is made while the run's spec is built, before the run's cap can judge anything, so the claim must not need the
// cap then; and its last stretch of computer time is booked before the run's end is written, so the end's cost.usd, and
// the usage read's total, hold all of it.
//
// The desktop is --faux's machine (faux-computers.ts) behind a loopback vendor: nothing is rented. Its price is the
// operator's per-resource setting, high enough that the run's few seconds book a figure well above float noise.
//
// And a stretch of computer time on the loop every runner the CLI starts runs a run on, a process of its own
// (run-child-host.ts childLoops), beside the runner's own loop: its computer is the runner's and its cap the run's
// process's, and a stretch it ran is booked on that cap and the next one held there, a cap with no room for it parking
// the run in its words. The meter's clock and its stretches are the test's (computerForClaim's now, compute.every): the
// stretch passes while the run's first model request waits at a loopback gateway, never in a sleep.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readBackOf } from "@parcha/agentrun-computer";
import { Agent37Provider } from "@parcha/agentrun-computer/agent37";
import { API_URL, fakeRest, KEY, keyPair, PROXY } from "../../computer/test/fake-agent37.mjs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";

// No host model setting or model key from this process reaches the runs below: their model is the loopback gateway's.
for (const name of Object.keys(process.env)) if (/^(AGENT_MODEL|ANTHROPIC_|OPENAI_|OPENROUTER_|AWS_)/.test(name)) delete process.env[name];

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { computerForClaim } = await import("../dist/workspace/index.js");
const { fauxComputers } = await import("../dist/faux-computers.js");
const { runUsageOverStore } = await import("../dist/run-usage.js");
const { childLoops } = await import("../dist/runner/run-child-host.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { putSealedKey } = await import("../dist/server-keys.js");

const RUN = "run-1";
const SEAL_KEY = Buffer.alloc(32, 7);
const FAUX = fauxComputers();
after(closeOpenSessions);

/** $0.01 a vCPU-second and $0.001 a GiB-second on faux-desktop: 2 vCPUs and 4 GiB cost $0.024 a second. */
const PRICES = { AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_FAUX_DESKTOP: "0.01", AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_FAUX_DESKTOP: "0.001" };

const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** A vendor of --faux's desktops: create starts one, connect finds it, delete ends it. */
function fauxVendor() {
  const entry = FAUX.kinds.PROVIDERS.find((one) => one.id === "faux-desktop");
  const computers = new Map();
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
      const id = `d${++made}`;
      computers.set(id, { id, labels: { ...spec.labels }, desk: await FAUX.launch(entry, { kind: "desktop", keys: {} }) });
      return { ok: true, value: { id, name: id } };
    },
    async attach({ id }) {
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
      if (how === "delete") {
        await computers.get(ref.id)?.desk.release().catch(() => {});
        computers.delete(ref.id);
      }
      return { ok: true, value: undefined };
    },
  };
  return { provider, computers };
}

/** run-1 on a priced faux desktop, run by a runner on the pi spec with a scripted model that answers at once, until it
 *  rests (within `ms`); `patch` changes the vendor first, and `spec` is the sizes its create asks. Its row and vendor. */
async function pricedRun(t, { patch = () => {}, ms = 60_000, env = PRICES, spec = { cpus: 2, memoryMb: 4096 } } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-compute-priced-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: { kind: "desktop", provider: "faux-desktop" }, tools: ["read"] } });
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5.5" } } });
  await server.flush?.();
  const route = { model: "faux-1", provider: { api: "anthropic-messages", origin: "https://route.invalid", credential: () => "not-a-secret" }, fetch: scriptedOrigin([{ say: "done" }], []), price: () => 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 100 };
  const vendor = fauxVendor();
  patch(vendor);
  const computerDeps = { kinds: FAUX.kinds, keyTable: FAUX.keyTable, providers: { "faux-desktop": () => vendor.provider }, spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open", ...spec }), check: { readBackOf } };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf: async () => route, computerForClaim, computerDeps };
  runner = startRunner({
    store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 30_000, stopMarginMs: 5_000,
    createLoop: createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) }),
  });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped", "parked"].includes(now.state) && now.runner === null && now;
  }, "the run rests", ms);
  return { server, vendor, row };
}

test("a priced computer whose connect fails after its create is deleted, and the run fails in its words: its setup never waits on a cap that will not come (#3338 review)", { timeout: 120_000 }, async (t) => {
  const { server, vendor, row } = await pricedRun(t, {
    ms: 30_000,
    patch: (one) => {
      one.provider.connect = async () => ({ ok: false, error: { code: "unavailable", message: "the desktop did not answer" } });
    },
  });
  assert.equal(row.state, "failed", JSON.stringify(row));
  assert.match(row.summary, /the desktop did not answer/);
  assert.equal(vendor.computers.size, 0, "the computer it made is deleted");
  // Its time was never booked (the run's cap never judged): it is the run's unheld time, on its interval.
  const [interval] = await server.computerIntervals.forRun(RUN);
  assert.equal(interval.bookedMs, 0);
  assert.notEqual(interval.endedAt, null, "its delete answered ok: ended");
});

test("a run on a priced computer runs (its computer is made before the cap can judge), and its end's cost holds every stretch it booked, the last one included", { timeout: 120_000 }, async (t) => {
  const { server, row } = await pricedRun(t);
  assert.equal(row.state, "ended", `the run ran on its priced computer: ${JSON.stringify(row)}`);

  // Every computer-time booking of the run, as its journal keeps them: owed steps tagged by resource, each settled.
  const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const requests = records.entries.filter((entry) => entry.kind === "runner.request" && entry.data?.tool === "compute");
  const holds = requests.filter((entry) => entry.data.hold === true);
  const booked = requests.filter((entry) => entry.data.hold !== true);
  assert.ok(holds.length >= 1, "its first stretch was held once the run's cap could judge it");
  assert.deepEqual([...new Set(booked.map((entry) => entry.data.tag))].sort(), ["memory", "vcpu"], "its time booked by resource");
  const turnUsd = new Map(records.entries.filter((entry) => entry.kind === "runner.turn").map((entry) => [`${entry.conversationId}:${entry.data.turn}`, entry.data.usd]));
  const bookedUsd = booked.reduce((sum, entry) => sum + (turnUsd.get(`${entry.conversationId}:${entry.data.turn}`) ?? 0), 0);
  assert.ok(bookedUsd > 0, `its time was booked before the end: $${bookedUsd}`);

  // The end's cost holds it all (the model's requests cost $0 here), and so does the usage read's total.
  assert.ok(Math.abs(row.costUsd - bookedUsd) < 1e-9, `cost.usd ${row.costUsd} is the booked computer time ${bookedUsd}`);
  const usage = await runUsageOverStore(server, RUN);
  assert.ok(Math.abs(usage.total.usd - row.costUsd) < 1e-9, "the usage total is cost.usd");
  const lines = usage.lines.filter((line) => line.meter === "compute_time");
  assert.deepEqual(lines.map((line) => [line.provider, line.resource, line.unit, line.basis]), [["faux-desktop", "vcpu", "vcpu_second", "estimate"], ["faux-desktop", "memory", "gib_second", "estimate"]]);
  assert.ok(Math.abs(lines.reduce((sum, line) => sum + line.usd, 0) - row.costUsd) < 1e-9, "the compute lines sum to it");
  // Its booked time: 2 vCPUs at $0.01 for every second booked is the vCPU line's figure.
  const [interval] = await server.computerIntervals.forRun(RUN);
  assert.ok(interval.bookedMs > 0, "its interval says how much was booked");
  assert.ok(Math.abs(lines[0].usd - 2 * 0.01 * (interval.bookedMs / 1000)) < 1e-9, "the vCPU line is 2 vCPUs at $0.01 for the booked seconds");
});

test("a run on a computer whose resources the operator priced at $0 reads $0 on its compute lines, never unpriced (#3338 review)", { timeout: 120_000 }, async (t) => {
  const { server, row } = await pricedRun(t, { env: { AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_FAUX_DESKTOP: "0", AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_FAUX_DESKTOP: "0" } });
  assert.equal(row.state, "ended", `the run ran: ${JSON.stringify(row)}`);
  const usage = await runUsageOverStore(server, RUN);
  const lines = usage.lines.filter((line) => line.meter === "compute_time");
  assert.deepEqual(lines.map((line) => [line.resource, line.basis, line.usd]), [["vcpu", "estimate", 0], ["memory", "estimate", 0]]);
  assert.equal(usage.total.usd, 0, "the usage total is $0");
});

test("a run on an Agent37 computer whose create asks no size is priced at the size Agent37's answer gives: its compute lines are booked, never unpriced", { timeout: 120_000 }, async (t) => {
  // The figures an Agent37 machine is read back with: the provider's own reading of an instance Agent37 answered
  // (resources { cpu: 4, memory: 8, disk: 4 }, in vCPUs and GB), handed back by the vendor's create as the hosted adapter does.
  const rest = fakeRest();
  const agent37 = new Agent37Provider({ apiKey: KEY, sshKey: keyPair().private, ssh2: { Client: class {} }, fetch: rest.fetch, apiUrl: API_URL, proxyDomain: PROXY });
  const made = await agent37.host.create({ name: "computer-0123456789ab", image: "agent37-base", labels: { "agentrun.computer": "1" }, lifetimeMs: 600_000, egress: false, cpus: 4, memoryMb: 8192 }, { timeoutMs: 10_000 });
  const { resources } = await agent37.host.get(made.id, { timeoutMs: 10_000 });
  assert.deepEqual(resources, { cpus: 4, memoryMb: 8192, diskGb: 4 }, "Agent37's own figures");

  const env = { ...PRICES, AGENTRUN_COMPUTE_USD_PER_DISK_GB_MONTH_FAUX_DESKTOP: "100" };
  const { server, row } = await pricedRun(t, {
    env,
    spec: {},
    patch: (one) => {
      const create = one.provider.create;
      one.provider.create = async (spec) => {
        const answer = await create(spec);
        return answer.ok ? { ok: true, value: { ...answer.value, resources } } : answer;
      };
    },
  });
  assert.equal(row.state, "ended", `the run ran: ${JSON.stringify(row)}`);
  const [interval] = await server.computerIntervals.forRun(RUN);
  assert.deepEqual([interval.cpus, interval.memoryMb, interval.diskGb], [4, 8192, 4], "its interval holds Agent37's figures, the create having asked none");
  const usage = await runUsageOverStore(server, RUN);
  const lines = usage.lines.filter((line) => line.meter === "compute_time");
  assert.deepEqual(lines.map((line) => [line.resource, line.basis]), [["vcpu", "estimate"], ["memory", "estimate"], ["disk", "estimate"]], "every resource priced, none unpriced");
  assert.ok(lines.every((line) => line.usd > 0), `every line booked money: ${JSON.stringify(lines)}`);
  // A run of a second or so is a few vCPU- and GiB-seconds, and well under a millionth of a GB-month of disk (its quantity's grain).
  assert.ok(lines.every((line) => line.quantity !== null) && lines[0].quantity > 0 && lines[1].quantity > 0, `every quantity known: ${JSON.stringify(lines)}`);
  assert.ok(Math.abs(lines[0].usd - 4 * 0.01 * (interval.bookedMs / 1000)) < 1e-9, "the vCPU line is Agent37's 4 vCPUs at $0.01 for the booked seconds");
});

/** A stretch of the meter's clock (compute-cost.ts COMPUTE_STRETCH_S, in ms). */
const STRETCH_MS = 300_000;

/** The meter's clock and its stretches, the test's: `pass(ms)` moves the clock on and runs each stretch's tick. */
function testClock() {
  let at = Date.now();
  const ticks = new Set();
  return {
    now: () => at,
    every: (tick) => {
      const one = { tick };
      ticks.add(one);
      return () => ticks.delete(one);
    },
    pass(ms) {
      at += ms;
      for (const one of [...ticks]) one.tick();
    },
  };
}

/** Whether `done` holds within `ms`: a bounded wait that never throws, so the assertions after it say what was missed. */
const within = (done, ms) => until(done, "", ms).then(() => true, () => false);

/** run-1 on a priced faux desktop, its model a loopback gateway that answers a `read` call first and then "done", run by a
 *  runner on its own loop (`where`: "runner") or in a process of its own ("process"), under `capUsd` when given. While
 *  the first model request waits, a stretch passes on the meter's clock, and the request is answered once that stretch
 *  is booked, or once the cap paused the run for the next one. Its row, the store, the pauses and its interval. */
async function stretchRun(t, { where, capUsd }) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-compute-stretch-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const clock = testClock();
  const paused = [];
  const interval = async () => (await server.computerIntervals.forRun(RUN))[0];
  let asked = 0;
  const gw = await startFauxGateway({
    call: () => (asked === 1 ? { name: "read", input: { path: "notes.txt" } } : undefined),
    text: "done",
    wait: async (request) => {
      if (!request.path.endsWith("/v1/messages") || (asked += 1) !== 1) return;
      clock.pass(STRETCH_MS);
      await within(async () => (capUsd === undefined ? (await interval())?.bookedMs >= STRETCH_MS : paused.length > 0), 15_000);
    },
  });
  let runner;
  t.after(async () => {
    await runner?.close().catch(() => {});
    await gw.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Desk" }, { id: "rev-1", kind: "agentic", body: { instructions: "Look.", computer: { kind: "desktop", provider: "faux-desktop" }, tools: ["read"] } });
  await putSealedKey(server, SEAL_KEY, "ANTHROPIC_API_KEY", `not-a-secret-${"compute-stretch"}`);
  await server.runs.create({ id: RUN, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Look." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, ...(capUsd === undefined ? {} : { max_cost_usd: capUsd }) } });
  await server.flush?.();
  const env = { PATH: process.env.PATH, TMPDIR: dir, ANTHROPIC_BASE_URL: gw.url, NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1", ...PRICES };
  const vendor = fauxVendor();
  const computerDeps = { kinds: FAUX.kinds, keyTable: FAUX.keyTable, providers: { "faux-desktop": () => vendor.provider }, spec: () => ({ image: "faux", lifetimeMs: 600_000, network: "open", cpus: 2, memoryMb: 4096 }), check: { readBackOf } };
  // The runner's computerForClaim on the test's clock and stretches, each pause of the run's cap seen on its way.
  const metered = (launch, on, given) => {
    const compute = given.compute && { ...given.compute, every: clock.every, ledger: { ...given.compute.ledger, pause: async (refusal) => { await given.compute.ledger.pause(refusal); paused.push(refusal); } } };
    return computerForClaim(launch, on, { ...given, now: clock.now, ...(compute ? { compute } : {}) });
  };
  const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf, computerForClaim: metered, computerDeps, log: () => {} };
  const createLoop = where === "process"
    ? childLoops({ deps, isolation: { kind: "process", why: "a test's runner" }, log: deps.log })
    : createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) });
  runner = startRunner({ store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000, createLoop });
  const row = await until(async () => {
    const now = await server.runs.get(RUN);
    return ["ended", "failed", "stopped", "parked"].includes(now.state) && now.runner === null && now;
  }, "the run rests", 60_000);
  return { server, row, paused, interval: await interval() };
}

for (const where of ["runner", "process"]) {
  const on = where === "runner" ? "on the runner's own loop" : "in a process of its own";
  test(`${on}: a stretch of a priced computer's time is booked on the run's ledger, its usage lines priced at the prices the server reads, never unpriced`, { timeout: 120_000 }, async (t) => {
    const { server, row, interval } = await stretchRun(t, { where });
    assert.equal(row.state, "ended", `the run ran: ${JSON.stringify(row)}`);
    assert.ok(interval.bookedMs >= STRETCH_MS, `a whole stretch and the rest of its time booked: ${interval.bookedMs} ms`);
    const usage = await runUsageOverStore(server, RUN);
    const lines = usage.lines.filter((line) => line.meter === "compute_time");
    assert.deepEqual(lines.map((line) => [line.provider, line.resource, line.basis]), [["faux-desktop", "vcpu", "estimate"], ["faux-desktop", "memory", "estimate"]], JSON.stringify(lines));
    assert.ok(Math.abs(lines[0].usd - 2 * 0.01 * (interval.bookedMs / 1000)) < 1e-6, `the vCPU line is 2 vCPUs at $0.01 for the booked seconds: ${JSON.stringify(lines[0])}`);
    assert.ok(Math.abs(row.costUsd - usage.total.usd) < 1e-9 && row.costUsd >= 2 * 0.01 * 300 + 4 * 0.001 * 300, `the run's cost holds the stretch: ${row.costUsd}`);
  });

  test(`${on}: a run whose cap has no room for its computer's next stretch is paused in the cap's words, the stretch it ran booked`, { timeout: 120_000 }, async (t) => {
    // A stretch is $7.20 (300 s of 2 vCPUs at $0.01 and 4 GiB at $0.001): the first is held and booked under $10, the
    // second has no room.
    const { server, row, paused, interval } = await stretchRun(t, { where, capUsd: 10 });
    assert.equal(paused.length, 1, `the cap paused the run once: ${JSON.stringify(paused)}`);
    assert.equal(paused[0].code, "spend_cap_reached");
    assert.equal(paused[0].forGood, false, "a raise lets it go on");
    assert.equal(row.state, "parked", `the run parked at its cap: ${JSON.stringify(row)}`);
    assert.ok(interval?.bookedMs >= STRETCH_MS, `the stretch it ran is booked: ${interval?.bookedMs} ms`);
    // Parked, the run's usage read waits for its end: its journal holds the stretch's bookings, by resource.
    const records = await journalRecords(server.journal({ runId: RUN, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
    const booked = records.entries.filter((entry) => entry.kind === "runner.request" && entry.data?.tool === "compute" && entry.data.hold !== true);
    assert.deepEqual([...new Set(booked.map((entry) => entry.data.tag))].sort(), ["memory", "vcpu"], "its time booked by resource");
  });
}

test("the same run books the same seconds and the same money on the runner's own loop and in a process of its own", { timeout: 240_000 }, async (t) => {
  const read = async (where) => {
    const { server, row, interval } = await stretchRun(t, { where });
    assert.equal(row.state, "ended", `${where}: the run ran: ${JSON.stringify(row)}`);
    const usage = await runUsageOverStore(server, RUN);
    const lines = usage.lines.filter((line) => line.meter === "compute_time").map((line) => [line.resource, line.basis, line.quantity, line.usd]);
    return { bookedMs: interval?.bookedMs, lines };
  };
  const own = await read("runner");
  const apart = await read("process");
  assert.ok(own.bookedMs >= STRETCH_MS, `the runner's own loop booked its stretch: ${own.bookedMs} ms`);
  assert.deepEqual(apart, own, "a run in a process of its own books what the runner's own loop books");
});
