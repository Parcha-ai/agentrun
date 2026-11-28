// A run in a process of its own (run-child.ts) asks its runner for its computer (Held.computer), and the runner's
// computerForClaim meters that computer's time (compute-cost.ts). The run's ledger lives in the run's process, so its ask
// hands the ledger across the channel: the runner's meter books each stretch on it, priced by the runner's settings, and
// holds back while the process's cap can't judge yet (its spec still built). Without it the runner's meter is never
// made: the computer's time is never held or booked, its usage lines `unpriced`, and the run's cap never sees it. The
// run's stop goes across too, so a lost sandbox ends the run from outside a tool call. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const host = await import("../dist/runner/run-child-host.js");
const { childDeps } = await import("../dist/runner/run-child-deps.js");
const { Channel } = await import("../dist/runner/run-channel.js");
const { withinCarried } = await import("../dist/paid-calls.js");
const { heldRedactor } = await import("../dist/runner/redact.js");
const { computeMeter } = await import("../dist/compute-cost.js");

const KEY = randomBytes(32);
/** The runner's settings price Daytona's vCPU and memory; the run's process's environment prices nothing. */
const PRICES = { AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_DAYTONA: "0.00001", AGENTRUN_COMPUTE_USD_PER_GIB_SECOND_DAYTONA: "0.000005" };
const FIGURES = { cpus: 2, memoryMb: 4096, gpuType: null, gpuCount: null, diskGb: null };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A runner and a run's process on one channel: the runner's held side (heldFor) over a computerForClaim that keeps what
 *  it was handed, and the process's deps (childDeps) asking it. */
async function pairOn(t) {
  const { store } = await storeOn(t);
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "child-compute-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const handed = [];
  const deps = { store, sealKey: KEY, env: { ...PRICES }, data, computerForClaim: async (_launch, _store, given) => (handed.push(given), { release: async () => {} }) };
  const reads = { claim: { runId: "run-own", epoch: 1 }, run: { agentId: "agent-own", revisionId: "rev-own", signInHanded: null }, launch: { input: { content: "Hello." } }, revision: { kind: "agentic", body: {} }, claimed: {} };
  const side = host.heldFor(deps, reads, heldRedactor((text) => text), () => {});
  const [a, b] = duplexPair();
  const runner = new Channel(a, { within: withinCarried });
  const child = new Channel(b);
  t.after(() => (runner.close(), child.close()));
  runner.expose("held", (method, args) => side.held[method](...args));
  const runProcess = childDeps({ claim: reads.claim, data, signal: new AbortController().signal }, {}, {}, child.remote("held"), child);
  return { handed, runProcess };
}

/** The run's ledger as the run's process holds it (RunLedger's paid, pause, judges and judged), each call kept. Its admit
 *  waits for the spec, as the run's paid calls do (adapter-loop.ts: they open on the spec's cap), and fails as it fails. */
function ledgerOf() {
  const admitted = [];
  const settled = [];
  const paused = [];
  let judges = false;
  let judged;
  let failed;
  const built = new Promise((resolve, reject) => ((judged = resolve), (failed = reject)));
  built.catch(() => undefined);
  const ledger = {
    paid: { admit: async (request) => void (await built, admitted.push(request)), settle: async (id, usd, options) => void settled.push({ id, usd, ...(options ?? {}) }), spentUsd: () => 0, heldUsd: () => 0 },
    pause: async (refusal) => void paused.push(refusal),
    judges: () => judges,
    judged: () => built,
  };
  return { ledger, admitted, settled, paused, build: () => ((judges = true), judged()), fail: (error) => failed(error) };
}

test("a run's own process hands its ledger to its runner, whose meter books the computer's time on it at the runner's prices, once the run's cap can judge", async (t) => {
  const { handed, runProcess } = await pairOn(t);
  const run = ledgerOf();
  const stops = [];
  await runProcess.computerForClaim({}, {}, { hadComputer: async () => false, compute: { ledger: run.ledger, env: {} }, stopRun: async (words) => void stops.push(words) });
  assert.equal(handed.length, 1, "the runner made the claim's computer");
  const given = handed[0];
  assert.ok(given.compute, "the runner's computerForClaim was handed the run's ledger: without it the computer's time is booked nowhere");
  assert.equal(given.compute.env.AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_DAYTONA, PRICES.AGENTRUN_COMPUTE_USD_PER_VCPU_SECOND_DAYTONA, "the meter prices by the runner's settings");
  assert.equal(given.compute.ledger.judges(), false, "while the run's spec is built, the runner's meter does not ask the cap");

  // The runner's meter over what it was handed, as computerForClaim makes it.
  let clock = 1_000_000;
  const meter = computeMeter({ env: given.compute.env, ledger: given.compute.ledger, now: () => clock, every: () => () => {}, log: () => {} });

  // The spec is built: the process's cap judges, and the runner reads it so.
  run.build();
  await settle();
  assert.equal(given.compute.ledger.judges(), true, "once the run's cap can judge, the runner's meter reads it so");

  meter.start("daytona", "sb-1", FIGURES);
  await settle();
  clock += 60_000;
  await meter.stop("daytona", "sb-1");

  const booked = run.admitted.filter((one) => one.tool === "compute" && !one.hold);
  assert.deepEqual(booked.map((one) => one.tag).sort(), ["memory", "vcpu"], "each priced resource's minute is booked on the run's ledger, in the run's process");
  assert.ok(booked.every((one) => one.owed === true && one.ref.startsWith("compute:daytona:sb-1:")), "booked owed, named by the computer");
  const vcpu = run.settled.find((one) => one.id === booked.find((b) => b.tag === "vcpu").id);
  assert.ok(Math.abs(vcpu.usd - 2 * 60 * 0.00001) < 1e-12, `two vCPUs for 60 s at the runner's price: ${vcpu?.usd}`);
  assert.ok(run.admitted.some((one) => one.tool === "compute" && one.hold === true && one.owed === true), "its first stretch was held, owed");

  // A lost sandbox past its bound ends the run in its process, from outside any tool call.
  await given.stopRun("the computer was lost");
  assert.deepEqual(stops, ["the computer was lost"], "the run's own stop was called");
});

test("a run's process whose spec failed: the runner's meter never reads its cap as judging, and books nothing", async (t) => {
  const { handed, runProcess } = await pairOn(t);
  const run = ledgerOf();
  await runProcess.computerForClaim({}, {}, { hadComputer: async () => false, compute: { ledger: run.ledger, env: {} } });
  const given = handed[0];
  run.fail(new Error("the image build failed"));
  await settle();
  assert.equal(given.compute.ledger.judges(), false, "a spec that failed never judges");
  const meter = computeMeter({ env: given.compute.env, ledger: given.compute.ledger, now: () => 0, every: () => () => {}, log: () => {} });
  meter.start("daytona", "sb-2", FIGURES);
  await meter.stop("daytona", "sb-2");
  assert.deepEqual(run.admitted.filter((one) => !one.hold), [], "nothing is booked while the cap can't judge");
});

/** Whether `made` settles within a bound: a stop the build would hold up never does until the build is done. */
const within = (made, ms = 1_000) => Promise.race([made.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

/** The runner's meter over the ledger a run's process handed it, on the test's clock, its stretches and log kept. */
async function meteredBeforeBuild(t) {
  const { handed, runProcess } = await pairOn(t);
  const run = ledgerOf();
  await runProcess.computerForClaim({}, {}, { hadComputer: async () => false, compute: { ledger: run.ledger, env: {} } });
  const given = handed[0];
  const clock = { at: 1_000_000 };
  const ticks = [];
  const lines = [];
  const meter = computeMeter({ env: given.compute.env, ledger: given.compute.ledger, now: () => clock.at, every: (tick) => (ticks.push(tick), () => {}), log: (line) => void lines.push(line) });
  const stretch = async (ms) => {
    clock.at += ms;
    for (const tick of ticks) tick();
    await settle();
  };
  return { run, given, clock, meter, lines, stretch, booked: (id) => run.admitted.filter((one) => one.tool === "compute" && !one.hold && one.ref.startsWith(`compute:daytona:${id}:`)) };
}

test("computers metered while the run's spec is still built: a stretch waits for the cap, a computer let go then is never held up by the build, and both are booked once the cap judges", async (t) => {
  const { run, given, clock, meter, lines, stretch, booked } = await meteredBeforeBuild(t);
  meter.start("daytona", "sb-3", FIGURES);
  meter.start("daytona", "sb-4", FIGURES);
  const madeAt = clock.at;
  await stretch(300_000);
  assert.deepEqual(run.admitted, [], "while the spec is built, nothing reaches the run's ledger: each step waits for its cap");
  clock.at += 60_000;
  assert.equal(await within(meter.stop("daytona", "sb-4")), true, "a computer let go while the spec is built is let go at once, its booking never waited for there");
  assert.equal(given.compute.ledger.judges(), false, "the runner reads the cap as not judging until the process says it can");

  run.build();
  await settle();
  assert.equal(given.compute.ledger.judges(), true, "once the spec is built, the runner's meter reads its cap as judging");
  assert.deepEqual(booked("sb-4").map((one) => [one.tag, one.basis.split(" ")[0]]).sort(), [["memory", "360"], ["vcpu", "360"]], "the computer let go before the build has its 360 s booked once the cap judges");

  await stretch(300_000);
  const running = booked("sb-3");
  assert.deepEqual(running.map((one) => one.tag).sort(), ["memory", "vcpu"], "the running computer's next stretch is booked once the cap judges, each resource");
  const vcpu = run.settled.find((one) => one.id === running.find((b) => b.tag === "vcpu").id);
  assert.ok(Math.abs(vcpu.usd - 2 * ((clock.at - madeAt) / 1000) * 0.00001) < 1e-12, `two vCPUs for all it ran since it was made: ${vcpu?.usd}`);
  assert.deepEqual(lines.filter((line) => line.includes("compute_spend_unbooked")), [], "nothing said unbooked");
});

test("a computer let go while the run's spec is built, the build then failing: nothing is booked, each priced resource's time is said unbooked, and its stop never waited on the build", async (t) => {
  const { run, given, clock, meter, lines, booked } = await meteredBeforeBuild(t);
  meter.start("daytona", "sb-5", FIGURES);
  clock.at += 60_000;
  assert.equal(await within(meter.stop("daytona", "sb-5")), true, "its stop never waits on the build");
  run.fail(new Error("the image build failed"));
  await settle();
  assert.equal(given.compute.ledger.judges(), false, "a spec that failed never judges");
  assert.deepEqual(booked("sb-5"), [], "nothing is booked");
  assert.deepEqual(run.admitted, [], "nothing reached the run's ledger");
  const unbooked = lines.filter((line) => line.includes("event=compute_spend_unbooked"));
  assert.equal(unbooked.length, 2, `one line per priced resource: ${JSON.stringify(lines)}`);
  for (const tag of ["vcpu", "memory"]) assert.ok(unbooked.some((line) => line.includes(`60 s of daytona sb-5's ${tag} time was not booked`) && line.includes("the image build failed")), `${tag}'s unbooked time said, with the spec's failure: ${JSON.stringify(unbooked)}`);
});

test("the runner's side of the ledger takes only what reads as one: a process that hands none, or a malformed one, gets no meter", () => {
  assert.equal(host.heldComputeLedger(undefined), undefined);
  assert.equal(host.heldComputeLedger({ paid: { admit: () => {} } }), undefined, "no settle");
  assert.equal(host.heldComputeLedger({ paid: { admit: () => {}, settle: () => {} } }), undefined, "no judged");
  assert.equal(typeof host.heldComputeLedger({ paid: { admit: async () => {}, settle: async () => {} }, judged: async () => {} })?.judges, "function");
});
