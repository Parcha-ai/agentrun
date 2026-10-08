// The acceptance check and the cost and latency report on the package alone, live on the shared scratch
// disk. Each job is an app driven through the `--app` contract (`pi-durable-archil run`) under localHost and the
// supervisor (`ensureRunning` in a process of its own, `_supervisor.ts`), on pi-ai's faux model, with a paid effect on
// the fake paid API (`test/fixtures/paid-api.ts`). Host A and host B are two mount roots with separate FUSE clients on
// this box. Per job: a clean run, then host A lost after a paid effect (with the next model turn in flight) and in the
// middle of a paid effect's dispatch, once by power off (SIGKILL of the instance's unit and its FUSE daemon in one
// kill, the unit never restarted) and once by freeze (SIGSTOP of the same processes, thawed after host B resumed and
// dispatched). The supervisor revokes and resumes on host B; the run must end with the clean run's result shape, every
// paid effect dispatched as often as in the clean run, a cut effect refused as interrupted and never re-sent, and no
// model turn repeated beyond the one in flight.
//
// Run: PDA_LIVE=1 PDA_LIVE_DISK=dsk-... ARCHIL_API_KEY=... npm run test:acceptance
// Subsets: PDA_P6_JOBS=paid,agentic  PDA_P6_MODES=clean,kill-after-effect,...  Results and traces go to $PDA_STATE_DIR.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDisk, type Disk } from "disk";
import { acquire, createRunDir, findDelegations, mintMountToken, removeMountToken } from "../../src/claim.ts";
import { openArchilStore } from "../../src/store.ts";
import { storeHead } from "../../src/run.ts";
import { readRunStatus, type HostHandle } from "../../src/supervise.ts";
import type { RunRecord } from "../../src/status.ts";
import { ctx, entryCommitter, percentile } from "../_support.ts";
import { LIVE, REGION, scratchDisk, scratchDiskId } from "../live/_archil.ts";
import { startPaidApi, type Hold, type PaidApi, type PaidRequest } from "../fixtures/paid-api.ts";
import { lateRows, PAID_TOOL, storeRows, type Job, type JobResult, type StoreRows } from "./_app.ts";
import {
  archilMounts,
  BASE,
  cleanRun,
  hostProcesses,
  instanceLog,
  LANES,
  ledger,
  sh,
  show,
  signalAll,
  sleep,
  stopInstance,
  supervisor,
  TRACES,
  waitFor,
  type SupervisorLine,
} from "./_rig.ts";

const APP = fileURLToPath(new URL("./_app.ts", import.meta.url));
const STAMP = Date.now().toString(36);
const A = `${BASE}/a`;
const B = `${BASE}/b`;
const PROBE = `${BASE}/probe`;
const OUT = join(process.env.TMPDIR ?? "/tmp", `p6-out-${STAMP}`);
/** The latest run's results, and a copy per run. */
const RESULTS = join(LANES, "P6-results.json");
const RESULTS_RUN = join(LANES, `P6-results-${STAMP}.json`);
const TOKEN_PREFIX = "pda-p6-";
/** Host A is lost after this paid effect (the next model turn in flight), or while the next one is being dispatched. */
const CUT = 2;
/** The rig's lease: short, so a frozen host is detected in seconds; production defaults are 20 s, 90 s and a 30 s tick. */
const LEASE = { heartbeatMs: 1_000, instanceExpiryMs: 6_000, instanceMarginMs: 1_500, supervisorExpiryMs: 6_000, tickMs: 3_000 };
const DEFAULT_HEARTBEAT_MS = 20_000;

type JobName = "paid" | "agentic";
type Mode =
  | "clean"
  | "kill-after-effect"
  | "kill-mid-dispatch"
  | "freeze-after-effect"
  | "freeze-mid-dispatch"
  | "freeze-after-effect-revoke-only"
  | "freeze-mid-dispatch-revoke-only";
const JOBS: Record<JobName, Job> = {
  paid: { kind: "paid", charges: 4 },
  agentic: { kind: "agentic", cycles: 16, charges: 4, fileBytes: 36_000 },
};
// The revoke-only freezes put host A's own self-fence out of reach (600 s), so only Archil's revoke can stop the thawed
// instance: its next write through the revoked mount fails (safety never depends on the self-fence).
const MODES: Mode[] = ["clean", "kill-after-effect", "kill-mid-dispatch", "freeze-after-effect", "freeze-mid-dispatch", "freeze-after-effect-revoke-only", "freeze-mid-dispatch-revoke-only"];
const NO_SELF_FENCE = { instanceExpiryMs: 600_000, instanceMarginMs: 0 };
const pick = <T extends string>(env: string | undefined, all: readonly T[]) => (env ? all.filter((x) => env.split(",").includes(x)) : [...all]);
const jobs = pick(process.env.PDA_P6_JOBS, Object.keys(JOBS) as JobName[]);
const modes = pick(process.env.PDA_P6_MODES, MODES);

let disk: Disk;
const results: Record<string, unknown> = { at: new Date().toISOString(), stamp: STAMP, lease: LEASE, cut: CUT, jobs: JOBS, outcomes: {} };
const outcomes = results.outcomes as Record<string, Outcome>;
const allTokens = new Set<string>();
const r1 = (x: number) => Math.round(x * 10) / 10;

type AppEvent = Record<string, unknown> & { event: string; t: number; writer: string; unit: string | null; host: string | null; generation: number };
const appEvents = (id: string): AppEvent[] => {
  const file = join(OUT, `${id}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AppEvent) : [];
};
const hostOfWriter = (writer: string | null) => (writer?.startsWith("pda-p6-a-") ? "A" : writer?.startsWith("pda-p6-b-") ? "B" : "?");
const normalize = (id: string, key: string) => key.replace(`${id}:`, "");

interface Timings {
  detectMs: number;
  decideMs: number;
  revokeMs: number;
  mintMs: number;
  driverStartMs: number;
  bootMs: number;
  mountMs: number;
  openMs: number;
  firstRequestMs: number;
  totalMs: number;
  openSteps: Record<string, number>;
}

interface Outcome {
  job: JobName;
  mode: Mode;
  id: string;
  record: RunRecord | null;
  result: JobResult | null;
  store: { db: number; wal: number; logical: number } | null;
  done: Record<string, unknown> | null;
  charges: Record<string, number>;
  chargeLog: { seq: number; key: string; nth: number; host: string; state: string; receivedAt: number; answeredAt: number | null; cutAt: number | null }[];
  modelLog: { seq: number; key: string; host: string; state: string; receivedAt: number; answeredAt: number | null }[];
  /** B's store read by a third client after the run ended (host A thawed and exited, host B released). */
  storeRead?: StoreRead;
  /** Rows in that store host A wrote from an answer it got after the loss (`lateRows`): must be none. */
  aLateRows: string[];
  model: { requests: number; repeated: { key: string; count: number; hosts: string[] }[] };
  incarnations: { generation: number; host: string; unit: string | null; opened: number; pid: unknown }[];
  starts: { host: string; reason: string; at: number; revoked: unknown; stonith: unknown }[];
  loss?: { kind: "kill" | "freeze"; at: number; pids: { instance: number[]; fuse: number[] }; held: Pick<PaidRequest, "route" | "key" | "receivedAt"> & { body: unknown } };
  heldAfter?: { state: string; cutAt: number | null; answeredAt: number | null };
  thaw?: {
    /** run.json over S3 just before the thaw: host B holds the run and has committed. */
    bAtThaw: { status: string; generation: number; holder: string | null; heartbeatAt: string | null } | null;
    /** The counter seqs that showed host B committed: its first paid dispatch, then a model request after it. */
    bCommitted: { charge: number; model: number };
    releasedAt: number;
    thawedAt: number;
    exitedAt: number;
    exitStatus: string;
    restarts: string;
    fence: string | null;
    requestsFromAAfterThaw: number;
  };
  hostAAfter?: Record<string, string>;
  aRequestsAfterLoss: number;
  timings?: Timings;
  wallMs: number;
  lifetimes: { host: string; ms: number }[];
  t10: Record<string, unknown>;
}

// ---- the commit probe (T10's in-region commit p50) ---------------------------------------------------------------------

async function commitProbe(): Promise<Record<string, unknown>> {
  const id = `p6-${STAMP}-probe`;
  await createRunDir(disk, id, { uid: process.getuid!(), gid: process.getgid!() });
  ledger.subdir(`runs/${id}/`, "commit latency probe");
  const nickname = `${TOKEN_PREFIX}probe-${STAMP}`;
  const t = await mintMountToken(disk, { nickname, ttl: "1h" });
  ledger.token(t.identifier, nickname, "commit latency probe");
  allTokens.add(t.identifier);
  const claim = await acquire({ ref: { disk: scratchDiskId(), region: REGION, id }, token: t.token, mountRoot: PROBE });
  ledger.mount(claim.root, `${scratchDiskId()}:/runs/${id}`);
  const out: Record<string, unknown> = { mountMs: r1(claim.timings.mountMs), verifyMs: r1(claim.timings.verifyMs) };
  try {
    const store = await openArchilStore(join(claim.store, "run.sqlite"));
    try {
      for (const bytes of [256, 8_192]) {
        const writer = entryCommitter(store.storage, bytes);
        if (bytes === 256) await writer.setup();
        for (let n = 0; n < 20; n++) await writer.commit(n);
        const sample: number[] = [];
        for (let n = 0; n < 200; n++) {
          const t0 = performance.now();
          await writer.commit(20 + n);
          sample.push(performance.now() - t0);
        }
        out[`entry${bytes}B`] = { n: sample.length, p50: r1(percentile(sample, 50)), p95: r1(percentile(sample, 95)), max: r1(Math.max(...sample)) };
      }
    } finally {
      await store.storage.close(ctx);
    }
    const b0 = performance.now();
    await claim.barrier();
    out.barrierMs = r1(performance.now() - b0);
  } finally {
    const { via } = await claim.release();
    ledger.unmounted(claim.root, via);
    out.cleanup = await cleanRun(disk, id, [t.identifier]);
    allTokens.delete(t.identifier);
  }
  return out;
}

// ---- the store, read by a third client ---------------------------------------------------------------------------------

interface StoreRead {
  integrity: string | undefined;
  /** The store's last committed sequence. */
  head: number;
  rows: StoreRows;
  mountMs: number;
}

/**
 * Mount the run on a third client after the run ended and read its store: integrity, head, and every row with the
 * instance that wrote it. This is B's store as any later owner would find it, independent of what host B's process saw.
 */
async function readStore(id: string, tokens: Set<string>): Promise<StoreRead> {
  const nickname = `${TOKEN_PREFIX}read-${id}`;
  const t = await mintMountToken(disk, { nickname, ttl: "1h" });
  tokens.add(t.identifier);
  allTokens.add(t.identifier);
  ledger.token(t.identifier, nickname, `independent read of ${id}`);
  const claim = await acquire({ ref: { disk: scratchDiskId(), region: REGION, id }, token: t.token, mountRoot: PROBE });
  ledger.mount(claim.root, `${scratchDiskId()}:/runs/${id} (independent read)`);
  try {
    const store = await openArchilStore(join(claim.store, "run.sqlite"));
    try {
      const integrity = await store.database.get<{ integrity_check: string }>("PRAGMA integrity_check");
      return { integrity: integrity?.integrity_check, head: await storeHead(store), rows: await storeRows(store.storage), mountMs: r1(claim.timings.mountMs + claim.timings.verifyMs) };
    } finally {
      await store.storage.close(ctx);
    }
  } finally {
    const { via } = await claim.release();
    ledger.unmounted(claim.root, via);
  }
}

// ---- one scenario ------------------------------------------------------------------------------------------------------

async function scenario(name: JobName, mode: Mode): Promise<Outcome> {
  const job = JOBS[name];
  const id = `p6-${STAMP}-${name}-${mode}`;
  await createRunDir(disk, id, { uid: process.getuid!(), gid: process.getgid!() });
  ledger.subdir(`runs/${id}/`, `acceptance ${name} ${mode}`);
  const api: PaidApi = await startPaidApi({ log: join(OUT, `${id}.paid.jsonl`) });
  const tokens = new Set<string>();
  const handles: HostHandle[] = [];
  const onLine = (line: SupervisorLine) => {
    const d = line.decision;
    if (d?.action !== "started") return;
    const tk = d.token as { identifier: string; nickname: string };
    tokens.add(tk.identifier);
    allTokens.add(tk.identifier);
    ledger.token(tk.identifier, tk.nickname, `minted by a supervisor process for ${id}`);
    const h = d.handle as HostHandle;
    handles.push(h);
    ledger.unit(`${h.unit}.service`, `instance of ${id} (${h.host})`);
    ledger.mount(String(h.mountpoint), `${scratchDiskId()}:/runs/${id} (made by instance ${h.unit})`);
  };
  const kill = mode.startsWith("kill");
  const freeze = mode.startsWith("freeze");
  const mid = mode.includes("mid-dispatch");
  const revokeOnly = mode.endsWith("revoke-only");
  const heldKey = `${id}:charge-${CUT + 1}`;
  let hold: Hold | null = null;
  if (mode !== "clean") {
    hold = mid
      ? api.hold({ route: "charge", key: heldKey })
      : api.hold({ route: "model", match: (r) => (r.body as { paid?: number }).paid === CUT && (r.body as { last?: { toolName?: string } }).last?.toolName === PAID_TOOL });
  }
  const env = { PDA_ACCEPT_API: api.url, PDA_ACCEPT_OUT: OUT, PDA_ACCEPT_JOB: JSON.stringify(job) };
  const lease = (selfFence: { instanceExpiryMs: number; instanceMarginMs: number }) => [
    `--app=${APP}`,
    `--heartbeat-ms=${LEASE.heartbeatMs}`,
    `--lease-expiry-ms=${selfFence.instanceExpiryMs}`,
    `--lease-margin-ms=${selfFence.instanceMarginMs}`,
  ];
  const config = (host: "a" | "b", extra: Record<string, unknown> = {}) => ({
    disk: scratchDiskId(),
    region: REGION,
    id,
    mountRoot: host === "a" ? A : B,
    hostName: `host-${host}`,
    unitPrefix: `pda-p6-${host}-`,
    leaseExpiryMs: LEASE.supervisorExpiryMs,
    runArgs: lease(host === "a" && revokeOnly ? NO_SELF_FENCE : LEASE),
    env,
    tokenPrefix: TOKEN_PREFIX,
    tokenTtl: "2h",
    stopTimeoutMs: 5_000,
    ...extra,
  });
  const supervisors: { stop(): Promise<void> }[] = [];
  const t0 = Date.now();
  const out: Partial<Outcome> = { job: name, mode, id, starts: [], aRequestsAfterLoss: 0 };
  try {
    // Host A: one supervise pass starts the run. In the power-off modes A's unit never restarts.
    const supA = supervisor(config("a", { restart: !kill }), onLine);
    supervisors.push(supA);
    await supA.exited;
    const startedA = supA.lines.find((l) => l.decision?.action === "started");
    assert.ok(startedA, `host A's supervisor started nothing: ${supA.stderr()} ${JSON.stringify(supA.lines)}`);
    const unitA = String((startedA.decision!.handle as HostHandle).unit);
    out.starts!.push({ host: "A", reason: String(startedA.decision!.reason), at: startedA.at, revoked: startedA.decision!.revoked, stonith: startedA.decision!.stonith ?? null });

    if (mode !== "clean") {
      const held = await Promise.race([
        hold!.first,
        waitFor("the run to finish before the hold caught anything", () => appEvents(id).some((e) => e.event === "done"), 300_000, 200).then(() => {
          throw new Error(`the hold never caught a request: ${JSON.stringify(api.requests().slice(-3))}`);
        }),
      ]);
      // Host B's supervisor watches before the loss, as a deployed one would.
      const supB = supervisor(config("b", { everyMs: LEASE.tickMs, untilTerminal: true }), onLine);
      supervisors.push(supB);
      await waitFor("host B's supervisor to see a healthy run", () => supB.lines.find((l) => l.decision?.action === "healthy"), 60_000);
      const pids = hostProcesses(unitA);
      assert.ok(pids.instance.length >= 1 && pids.fuse.length >= 1, `host A's processes: ${JSON.stringify(pids)}`);
      const lossAt = signalAll(kill ? "KILL" : "STOP", [...pids.instance, ...pids.fuse]);
      out.loss = { kind: kill ? "kill" : "freeze", at: lossAt, pids, held: { route: held.route, key: normalize(id, held.key), receivedAt: held.receivedAt, body: held.body } };
      ledger.event(kill ? "power off host A" : "freeze host A", { id, unit: unitA, pids });

      const takeover = await waitFor("host B's takeover", () => supB.lines.find((l) => l.decision?.action === "started"), 120_000);
      const firstB = await api.waitFor((r) => r.route === "model" && hostOfWriter(r.writer) === "B", 120_000);
      await waitFor("host B's instance open", () => appEvents(id).find((e) => e.event === "opened" && hostOfWriter(e.writer) === "B"), 60_000);
      out.starts!.push({ host: "B", reason: String(takeover.decision!.reason), at: takeover.at, revoked: takeover.decision!.revoked, stonith: takeover.decision!.stonith ?? null });

      if (freeze) {
        // Thaw once host B has taken over and committed: it dispatched a paid effect of its own (pi commits a call's intent
        // before it runs) and then asked the model again (that effect's result is committed). The frozen instance wakes
        // holding an answer that tells it to go on; it must fence, dispatch nothing, and leave no row in B's store.
        const bCharge = await api.waitFor((r) => r.route === "charge" && hostOfWriter(r.writer) === "B", 300_000);
        const bModel = await api.waitFor((r) => r.route === "model" && hostOfWriter(r.writer) === "B" && r.seq > bCharge.seq, 300_000);
        const atThaw = await readRunStatus(disk, id);
        const releasedAt = Date.now();
        hold!.release();
        const thawedAt = signalAll("CONT", [...pids.instance, ...pids.fuse]);
        const exited = await waitFor("host A's frozen instance to exit", () => {
          const s = show(unitA);
          return ["failed", "inactive"].includes(s.ActiveState ?? "") || s.LoadState === "not-found" ? s : null;
        }, 60_000);
        const log = instanceLog(unitA);
        out.thaw = {
          bAtThaw: atThaw && { status: atThaw.status, generation: atThaw.generation, holder: atThaw.holder?.host ?? null, heartbeatAt: atThaw.heartbeatAt },
          bCommitted: { charge: bCharge.seq, model: bModel.seq },
          releasedAt,
          thawedAt,
          exitedAt: Date.now(),
          exitStatus: exited.ExecMainStatus ?? log.exit ?? "?",
          restarts: exited.NRestarts ?? "?",
          fence: log.fence,
          requestsFromAAfterThaw: 0,
        };
      }
      await waitFor("the run to finish on host B", () => appEvents(id).find((e) => e.event === "done" && hostOfWriter(e.writer) === "B"), 600_000, 200);
      await Promise.race([supB.exited, sleep(LEASE.tickMs * 3)]);
      await supB.stop();
      out.hostAAfter = show(unitA);
      out.aRequestsAfterLoss = api.requests().filter((r) => hostOfWriter(r.writer) === "A" && r.receivedAt > lossAt).length;
      if (out.thaw) out.thaw.requestsFromAAfterThaw = api.requests().filter((r) => hostOfWriter(r.writer) === "A" && r.receivedAt >= out.thaw!.thawedAt).length;
      const heldNow = api.requests().find((r) => r.seq === held.seq)!;
      out.heldAfter = { state: heldNow.state, cutAt: heldNow.cutAt, answeredAt: heldNow.answeredAt };

      // The takeover, split: the tick that saw the loss, its reads, the revoke, the token, the unit start, the
      // instance's boot, mount and open (its journal), and the first model request on host B.
      const calls = takeover.calls;
      const revokes = calls.filter((c) => c.call === "revokeDelegation");
      const mint = calls.find((c) => c.call === "addUser");
      const unitB = String((takeover.decision!.handle as HostHandle).unit);
      const running = instanceLog(unitB).events.find((e) => e.event === "running");
      const steps = (running?.steps ?? {}) as Record<string, number>;
      const openTotal = Object.values(steps).reduce((x, y) => x + y, 0);
      const runningAt = running ? Date.parse(String(running.at)) : Number.NaN;
      const tickEnd = takeover.at + takeover.ms;
      out.timings = {
        detectMs: r1(takeover.at - lossAt),
        decideMs: r1((revokes[0]?.at ?? mint?.at ?? tickEnd) - takeover.at),
        revokeMs: r1(revokes.reduce((x, c) => x + c.ms, 0)),
        mintMs: r1(mint?.ms ?? Number.NaN),
        driverStartMs: r1(Number(takeover.decision!.startMs) - (mint?.ms ?? 0)),
        bootMs: r1(runningAt - openTotal - tickEnd),
        mountMs: r1(steps.acquire ?? Number.NaN),
        openMs: r1(openTotal - (steps.acquire ?? 0)),
        firstRequestMs: r1(firstB.receivedAt - runningAt),
        totalMs: r1(firstB.receivedAt - lossAt),
        openSteps: steps,
      };
    } else {
      await waitFor("the clean run to finish", () => appEvents(id).find((e) => e.event === "done"), 600_000, 200);
    }
    out.wallMs = Date.now() - t0;
    // The instance exits right after its release; let its unit settle before the record is read.
    for (const h of handles) await waitFor(`${h.unit} to stop`, () => show(String(h.unit)).ActiveState !== "active", 30_000, 100).catch(() => undefined);
    out.storeRead = await readStore(id, tokens);

    const events = appEvents(id);
    const settled = events.findLast((e) => e.event === "settled");
    const done = events.findLast((e) => e.event === "done");
    out.record = await readRunStatus(disk, id);
    out.result = (settled?.result ?? null) as JobResult | null;
    out.store = (settled?.store ?? null) as Outcome["store"];
    out.done = done ?? null;
    out.charges = Object.fromEntries(Object.entries(api.counts("charge")).map(([k, n]) => [normalize(id, k), n]));
    out.chargeLog = api.requests("charge").map((r) => ({ seq: r.seq, key: normalize(id, r.key), nth: r.nth, host: hostOfWriter(r.writer), state: r.state, receivedAt: r.receivedAt, answeredAt: r.answeredAt, cutAt: r.cutAt }));
    out.aLateRows = out.loss ? lateRows(out.storeRead.rows, api.requests(), out.loss.at, (w) => hostOfWriter(w) === "A") : [];
    out.modelLog = api.requests("model").map((r) => ({ seq: r.seq, key: r.key, host: hostOfWriter(r.writer), state: r.state, receivedAt: r.receivedAt, answeredAt: r.answeredAt }));
    const modelCounts = api.counts("model");
    out.model = {
      requests: api.requests("model").length,
      repeated: Object.entries(modelCounts)
        .filter(([, n]) => n > 1)
        .map(([key, count]) => ({ key, count, hosts: api.requests("model").filter((r) => r.key === key).map((r) => hostOfWriter(r.writer)) })),
    };
    out.incarnations = events.filter((e) => e.event === "opened").map((e) => ({ generation: e.generation, host: hostOfWriter(e.writer), unit: e.unit, opened: e.t, pid: e.pid }));
    out.lifetimes = out.incarnations.map((inc) => {
      const end = inc.host === "A" && out.loss ? out.loss.at : Number(events.findLast((e) => e.event === "done" && e.unit === inc.unit)?.t ?? Number.NaN);
      return { host: inc.host, ms: end - inc.opened };
    });
    out.t10 = t10(out as Outcome);
    return out as Outcome;
  } finally {
    for (const s of supervisors) await s.stop().catch(() => undefined);
    for (const h of handles) await stopInstance(h, "stopped after the scenario");
    await api.close();
    const cleanup = await cleanRun(disk, id, tokens);
    for (const tk of tokens) allTokens.delete(tk);
    out.t10 = { ...(out.t10 ?? {}), cleanup };
  }
}

/** The cost report for one run: commits times the in-region commit p50, the barrier, lease writes, and Archil's bill. */
function t10(o: Outcome): Record<string, unknown> {
  const probe = results.probe as { entry256B?: { p50: number } } | undefined;
  const p50 = probe?.entry256B?.p50 ?? Number.NaN;
  const commits = Number(o.done?.sealedSeq ?? o.record?.sealedSeq ?? Number.NaN);
  // Each incarnation writes run.json at open and after Harness.open, then once per heartbeat; the one that finishes adds
  // the done status and the seal.
  const writes = (heartbeatMs: number) =>
    o.lifetimes.reduce((sum, l, i) => sum + 2 + Math.floor(l.ms / heartbeatMs) + (i === o.lifetimes.length - 1 ? 2 : 0), 0);
  const storeBytes = (o.store?.logical ?? 0) || (o.store?.db ?? 0) + (o.store?.wal ?? 0);
  const leaseWritesDefault = writes(DEFAULT_HEARTBEAT_MS);
  // Data written counts as active storage for an hour after its flush, a metadata operation as 32 KiB, at
  // $0.20 per GB-month (beyond the Team plan's 1 TB); a run on a VM uses no Archil compute (no Disk.exec, no sandbox).
  const metadataOps = 3 * leaseWritesDefault;
  const gbHours = ((storeBytes + metadataOps * 32 * 1024) / 1e9) * 1;
  return {
    commits,
    commitP50Ms: p50,
    commitTimeMs: r1(commits * p50),
    barrierMs: o.done?.barrierMs ?? null,
    doneStatusMs: o.done?.doneMs ?? null,
    releaseMs: o.done?.releaseMs ?? null,
    leaseWritesRig: writes(LEASE.heartbeatMs),
    leaseWritesAtDefaultHeartbeat: leaseWritesDefault,
    storeBytes,
    archil: {
      computeUsd: 0,
      metadataOps,
      activeGbHours: Number(gbHours.toPrecision(3)),
      storageUsdBeyondIncluded: Number(((gbHours / 730) * 0.2).toPrecision(3)),
    },
    takeoverToFirstModelRequestMs: o.timings?.totalMs ?? null,
  };
}

// ---- the trace -----------------------------------------------------------------------------------------------------------

function writeTrace(o: Outcome, clean: Outcome | undefined): string {
  mkdirSync(TRACES, { recursive: true });
  const base = join(TRACES, `${STAMP}-${o.job}-${o.mode}`);
  writeFileSync(`${base}.json`, `${JSON.stringify({ ...o, cleanCharges: clean?.charges ?? null, cleanModelRequests: clean?.model.requests ?? null }, null, 2)}\n`);
  const at = (t: number) => (o.loss ? `${t - o.loss.at >= 0 ? "+" : ""}${Math.round(t - o.loss.at)} ms` : new Date(t).toISOString());
  const lines = [`# ${o.job} / ${o.mode} (run ${o.id})`, ""];
  if (o.loss) {
    lines.push(`- loss: ${o.loss.kind === "kill" ? "power off (SIGKILL of the unit's processes and its FUSE daemon, one kill)" : "freeze (SIGSTOP of the same processes)"} at ${new Date(o.loss.at).toISOString()}, pids ${JSON.stringify(o.loss.pids)}`);
    lines.push(`- in flight at the loss: ${o.loss.held.route} ${o.loss.held.key} (received ${at(o.loss.held.receivedAt)}); afterwards ${o.heldAfter?.state}${o.heldAfter?.cutAt ? ` at ${at(o.heldAfter.cutAt)}` : ""}${o.heldAfter?.answeredAt ? `, answered ${at(o.heldAfter.answeredAt)}` : ""}`);
    for (const s of o.starts) lines.push(`- start on host ${s.host}: ${s.reason} at ${at(s.at)}, revoked ${JSON.stringify(s.revoked)}${s.stonith ? `, stonith ${JSON.stringify(s.stonith)}` : ""}`);
    if (o.timings) lines.push(`- loss to host B's first model request ${o.timings.totalMs} ms: detect ${o.timings.detectMs}, decide ${o.timings.decideMs}, revoke ${o.timings.revokeMs}, mint ${o.timings.mintMs}, unit start ${o.timings.driverStartMs}, boot ${o.timings.bootMs}, mount ${o.timings.mountMs}, open ${o.timings.openMs}, to first request ${o.timings.firstRequestMs}`);
    if (o.thaw) lines.push(`- thaw: hold released ${at(o.thaw.releasedAt)}, SIGCONT ${at(o.thaw.thawedAt)}, host A exited ${o.thaw.exitStatus} at ${at(o.thaw.exitedAt)} (restarts ${o.thaw.restarts}); ${o.thaw.fence ?? "no fence line"}`);
    if (o.thaw) lines.push(`- host B at the thaw: run.json ${JSON.stringify(o.thaw.bAtThaw)}, committed through its paid dispatch (counter seq ${o.thaw.bCommitted.charge}) and a later model request (seq ${o.thaw.bCommitted.model}); requests from host A after the thaw: ${o.thaw.requestsFromAAfterThaw}`);
    lines.push(`- requests from host A after the loss: ${o.aRequestsAfterLoss}`);
  }
  lines.push(`- incarnations: ${o.incarnations.map((i) => `g${i.generation} on ${i.host} opened ${at(i.opened)}`).join("; ")}`);
  lines.push(`- run.json: ${o.record?.status} generation ${o.record?.generation} holder ${o.record?.holder?.host} sealedSeq ${o.record?.sealedSeq}`);
  if (o.storeRead) {
    const by = (host: string) => `${o.storeRead!.rows.assistants.filter((a) => hostOfWriter(a.writer) === host).length} model rows, ${o.storeRead!.rows.results.filter((r) => r.name === PAID_TOOL && hostOfWriter(r.writer) === host).length} paid results`;
    lines.push(`- the store, read by a third client after the run: integrity ${o.storeRead.integrity}, head ${o.storeRead.head}; host A ${by("A")}, host B ${by("B")}; host A's rows from after the loss: ${o.aLateRows.length ? o.aLateRows.join("; ") : "none"}`);
  }
  lines.push("", "| paid effect | this run | clean run | dispatched by | state |", "|---|---|---|---|---|");
  const keys = [...new Set([...Object.keys(o.charges), ...Object.keys(clean?.charges ?? {})])].sort();
  for (const k of keys) {
    const rows = o.chargeLog.filter((c) => c.key === k);
    lines.push(`| ${k} | ${o.charges[k] ?? 0} | ${clean?.charges[k] ?? "-"} | ${rows.map((r) => r.host).join(", ")} | ${rows.map((r) => r.state).join(", ")} |`);
  }
  const cut = o.result?.results.filter((r) => r.interrupted) ?? [];
  lines.push("", `- refused cut effects: ${cut.length ? cut.map((r) => `${r.id} (${r.name}): "${r.text}"`).join("; ") : "none"}`);
  lines.push(`- model requests: ${o.model.requests} (clean ${clean?.model.requests ?? "-"}); repeated turns: ${o.model.repeated.length ? o.model.repeated.map((r) => `${r.key} x${r.count} by ${r.hosts.join("+")}`).join("; ") : "none"}`);
  lines.push(`- result: ${o.result?.status}, "${o.result?.final}", ${o.result?.calls.length} calls, ${o.result?.results.length} results`);
  lines.push(`- T10: ${JSON.stringify(o.t10)}`);
  writeFileSync(`${base}.md`, `${lines.join("\n")}\n`);
  return base;
}

// ---- the acceptance assertions -------------------------------------------------------------------------------------------

/** The run's store as a third client finds it: intact, nothing after the seal, the rows the run itself reported. */
function assertStore(o: Outcome): StoreRead {
  const s = o.storeRead!;
  assert.equal(s.integrity, "ok");
  assert.equal(s.head, o.record!.sealedSeq, "nothing was committed after the last holder's seal");
  assert.deepEqual(s.rows.kinds, o.result!.kinds);
  assert.deepEqual(s.rows.assistants.flatMap((a) => a.calls), o.result!.calls.map((c) => c.id));
  assert.deepEqual(s.rows.results.map((r) => [r.id, r.interrupted]), o.result!.results.map((r) => [r.id, r.interrupted]));
  return s;
}

function assertClean(o: Outcome, job: Job): void {
  const s = assertStore(o);
  assert.ok(s.rows.assistants.every((a) => hostOfWriter(a.writer) === "A"), "every model row names host A's instance");
  assert.equal(o.record?.status, "done");
  assert.equal(o.record?.generation, 1);
  assert.equal(o.result?.status, "done");
  assert.ok(o.result!.calls.length > 0);
  assert.equal(o.result!.results.length, o.result!.calls.length);
  assert.ok(o.result!.results.every((r) => !r.isError), JSON.stringify(o.result!.results.filter((r) => r.isError)));
  assert.equal(Object.keys(o.charges).length, job.charges);
  assert.ok(Object.values(o.charges).every((n) => n === 1), JSON.stringify(o.charges));
  assert.deepEqual(o.model.repeated, []);
}

function assertAcceptance(o: Outcome, clean: Outcome): void {
  const heldKey = `charge-${CUT + 1}`;
  const mid = o.mode.includes("mid-dispatch");
  // Resumed on host B: one takeover, no churn.
  assert.deepEqual(o.starts.map((s) => s.host), ["A", "B"]);
  assert.equal(o.starts[1]!.reason, o.mode.startsWith("kill") ? "orphaned" : "lease-expired");
  assert.equal((o.starts[1]!.revoked as unknown[]).length, 1, "the takeover revoked host A's delegation");
  assert.equal(o.record?.status, "done");
  assert.equal(o.record?.generation, 2);
  assert.equal(o.record?.holder?.host, "host-b");
  // The same result shape: the same calls in the same order, one result each, the same answer.
  assert.equal(o.result?.status, clean.result!.status);
  assert.deepEqual(o.result!.calls, clean.result!.calls);
  assert.equal(o.result!.results.length, o.result!.calls.length);
  assert.deepEqual(o.result!.results.map((r) => r.id), clean.result!.results.map((r) => r.id));
  assert.equal(o.result!.final, clean.result!.final);
  // Every paid effect dispatched as often as in the clean run.
  assert.deepEqual(o.charges, clean.charges);
  // The workspace's effects too: every other tool's result is the clean run's (sums.log gains one line per cycle, so a
  // bash call run twice would show in a later count).
  const others = (r: JobResult) => r.results.filter((x) => x.name !== PAID_TOOL).map((x) => [x.id, x.text]);
  assert.deepEqual(others(o.result!), others(clean.result!));
  // A cut effect is refused as interrupted (unknown outcome) and never sent again; nothing else is interrupted.
  const interrupted = o.result!.results.filter((r) => r.interrupted).map((r) => r.id);
  assert.deepEqual(interrupted, mid ? [heldKey] : [], JSON.stringify(o.result!.results.filter((r) => r.isError)));
  if (mid) {
    assert.equal(o.chargeLog.filter((c) => c.key === heldKey).length, 1, "the cut effect was dispatched once");
    assert.equal(o.heldAfter?.state, o.mode.startsWith("kill") ? "cut" : "answered");
  }
  // No model turn repeated beyond the one in flight at the loss.
  if (mid) assert.deepEqual(o.model.repeated, [], "nothing was in flight at the model");
  else {
    assert.equal(o.model.repeated.length, 1, JSON.stringify(o.model.repeated));
    assert.deepEqual(o.model.repeated[0]!.hosts, ["A", "B"], "the turn in flight on host A, asked again on host B");
    assert.equal(o.model.repeated[0]!.count, 2);
  }
  assert.equal(o.model.requests, clean.model.requests + (mid ? 0 : 1));
  // Host A did nothing after the loss; a frozen host A exits 75 when thawed and is not restarted.
  assert.equal(o.aRequestsAfterLoss, 0);
  // B's store, read by a third client after the run ended: intact, nothing after B's seal, the clean run's rows, both
  // hosts' rows (A's from before the loss, B's after), and none of host A's later rows.
  const s = assertStore(o);
  assert.deepEqual(s.rows.kinds, clean.storeRead!.rows.kinds);
  assert.equal(s.rows.conversations, clean.storeRead!.rows.conversations);
  assert.ok(s.rows.assistants.some((a) => hostOfWriter(a.writer) === "A") && s.rows.assistants.some((a) => hostOfWriter(a.writer) === "B"), "rows from both hosts");
  assert.deepEqual(o.aLateRows, []);
  if (mid) {
    const cut = s.rows.results.filter((r) => r.id === heldKey);
    assert.deepEqual(cut.map((r) => [r.interrupted, r.receipt]), [[true, null]], "the store holds the interrupted result for the cut call, not host A's receipt");
  }
  if (o.thaw) {
    // The hung-host half: host B held the run and had committed when host A woke; A fenced, sent nothing, wrote nothing.
    assert.deepEqual([o.thaw.bAtThaw?.status, o.thaw.bAtThaw?.generation, o.thaw.bAtThaw?.holder], ["running", 2, "host-b"]);
    assert.equal(o.thaw.requestsFromAAfterThaw, 0);
    assert.equal(o.thaw.exitStatus, "75", JSON.stringify(o.thaw));
    assert.equal(o.thaw.restarts, "0");
    // Without a self-fence in reach, what stopped the thawed instance is a write the revoked mount refused.
    if (o.mode.endsWith("revoke-only")) assert.match(o.thaw.fence ?? "", /fenced \((STORE_FENCED|FENCED)\)/);
  }
}

// ---- the suite -----------------------------------------------------------------------------------------------------------

before(async () => {
  if (!LIVE) return;
  disk = await scratchDisk();
  ledger.disk(disk.id);
  ledger.event("acceptance run started", { stamp: STAMP, jobs, modes });
  assert.deepEqual(archilMounts(), [], "no P6 mounts left from an earlier run");
  assert.equal(sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "pda-p6-*"]).stdout.trim(), "", "no pda-p6 units left");
  sh("sudo", ["-n", "mkdir", "-p", A, B, PROBE]);
  sh("sudo", ["-n", "chown", `${process.getuid!()}:${process.getgid!()}`, BASE, A, B, PROBE]);
  mkdirSync(OUT, { recursive: true, mode: 0o755 });
  results.host = sh("hostname", []).stdout.trim();
  results.client = sh("/usr/bin/archil", ["--version"]).stdout.split("\n")[0];
  results.probe = await commitProbe();
});

after(async () => {
  if (!LIVE) return;
  const sweep: Record<string, unknown> = {};
  for (const tk of allTokens) {
    const r = await removeMountToken(disk, tk).then(() => "removed", (e: unknown) => `failed: ${(e as Error).message}`);
    if (r === "removed") ledger.tokenRemoved(tk, "removed in after");
  }
  const fresh = await getDisk(disk.id);
  const strays = (fresh.authorizedUsers ?? []).filter((u) => u.identifier && (u.nickname?.startsWith(`${TOKEN_PREFIX}p6-${STAMP}`) || u.nickname?.startsWith(`${TOKEN_PREFIX}read-p6-${STAMP}`) || u.nickname === `${TOKEN_PREFIX}probe-${STAMP}`));
  for (const u of strays) {
    await disk.removeUser("token", u.identifier!).catch(() => {});
    ledger.tokenRemoved(u.identifier!, "sweep by nickname in after");
  }
  sweep.strayTokens = strays.length;
  sweep.mountsAfter = archilMounts();
  sweep.unitsAfter = sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "pda-p6-*"]).stdout.trim();
  sweep.delegationsAfter = (await disk.listDelegations()).filter((d) => d.path?.includes(`p6-${STAMP}`)).length;
  sh("bash", ["-c", `sudo -n find ${BASE} -mindepth 1 -depth -type d -empty -delete`]);
  sh("sudo", ["-n", "find", "/run/pi-durable-archil", "-name", "pda-p6-*", "-delete"]);
  results.sweep = sweep;
  ledger.event("acceptance run finished", { stamp: STAMP, ...sweep });
  for (const file of [RESULTS, RESULTS_RUN]) writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
});

for (const name of jobs) {
  describe(`T9 acceptance, job ${name}`, { skip: !LIVE }, () => {
    let clean: Outcome | undefined;
    for (const mode of modes) {
      it(mode === "clean" ? "clean run: the baseline counters and result" : `host A ${mode.replace(/-/g, " ")}, resumed on host B`, { timeout: 900_000 }, async (t) => {
        const o = await scenario(name, mode);
        outcomes[`${name}/${mode}`] = o;
        if (mode === "clean") clean = o;
        const trace = writeTrace(o, clean);
        t.diagnostic(`trace ${trace}.md`);
        writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
        if (mode === "clean") return assertClean(o, JOBS[name]);
        assert.ok(clean, "the clean run of this job ran first");
        assertAcceptance(o, clean);
      });
    }
  });
}

// A refused cut effect needs a delegation-free disk afterwards: nothing this suite made may still hold a run.
it("leaves no delegation, mount or unit of its own", { skip: !LIVE }, async () => {
  const held = (await Promise.all(Object.values(outcomes).map((o) => findDelegations(disk, o.id)))).flat();
  assert.deepEqual(held, []);
  assert.deepEqual(archilMounts(), []);
});
