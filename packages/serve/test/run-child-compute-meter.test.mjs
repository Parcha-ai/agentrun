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

/** The run's ledger as the run's process holds it (RunLedger's paid, pause, judges and judged), each call kept. */
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
    paid: { admit: async (request) => void admitted.push(request), settle: async (id, usd, options) => void settled.push({ id, usd, ...(options ?? {}) }), spentUsd: () => 0, heldUsd: () => 0 },
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

test("the runner's side of the ledger takes only what reads as one: a process that hands none, or a malformed one, gets no meter", () => {
  assert.equal(host.heldComputeLedger(undefined), undefined);
  assert.equal(host.heldComputeLedger({ paid: { admit: () => {} } }), undefined, "no settle");
  assert.equal(host.heldComputeLedger({ paid: { admit: () => {}, settle: () => {} } }), undefined, "no judged");
  assert.equal(typeof host.heldComputeLedger({ paid: { admit: async () => {}, settle: async () => {} }, judged: async () => {} })?.judges, "function");
});
