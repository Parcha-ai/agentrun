// The universes driver: forks a sealed run into N universes on Daytona boxes, serves the stage's feed (show/README.md)
// on loopback, and takes the stage's commands (kill) plus its own (fanout, collapse). With --auto it plays the whole
// sequence by itself and prints the measurements: fan-out, kills and takeovers, collapse, cleanup.
//
//   with-archil with-daytona node serve.ts [--universes 4] [--spares 1] [--port 8761] [--source RUN] [--auto] [--prewarm]
//     [--kills 1] [--kill-every 20] [--steps 60] [--step-ms 1000] [--checkpoint-every 5] [--snapshot NAME]
//     [--ledger FILE] [--mount-root DIR] [--keep]
//
// Environment: ARCHIL_API_KEY, PDA_LIVE_DISK, PDA_LIVE_REGION (with-archil); DAYTONA_API_KEY, DAYTONA_API_URL,
// DAYTONA_TARGET (with-daytona). Every resource goes into --ledger before it is created and is closed when deleted; at
// exit (and on SIGINT) everything this run made is deleted unless --keep.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { daytonaRest, deleteRunTree, removeMountToken, type RunRef } from "@parcha/pi-durable-disk";
import { archilControl, jsonLog, Ledger } from "../../03-tab-to-cloud/pipe/control.ts";
import { daytonaFleet } from "./daytona-fleet.ts";
import { Feed, serveFeed, type CommandResult, type FeedCommand } from "./feed.ts";
import { Multiverse, MultiverseError, type FanOutReport, type TakeoverReport, type UniverseSpec } from "./multiverse.ts";
import { makeSourceRun } from "./source.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Eureka-style reward variants, one per universe. */
export const REWARDS = [
  "forward speed",
  "forward speed + upright bonus",
  "speed per unit of energy",
  "speed - joint torque penalty",
  "distance on rough terrain",
  "smooth gait (low jerk)",
  "low foot slip",
  "recover from pushes",
];

const { values } = parseArgs({
  options: {
    universes: { type: "string", default: "4" },
    spares: { type: "string", default: "1" },
    port: { type: "string", default: "8761" },
    source: { type: "string" },
    snapshot: { type: "string", default: process.env.DAYTONA_SNAPSHOT },
    auto: { type: "boolean", default: false },
    prewarm: { type: "boolean", default: false },
    kills: { type: "string", default: "1" },
    "kill-every": { type: "string", default: "20" },
    steps: { type: "string", default: "60" },
    "step-ms": { type: "string", default: "1000" },
    "checkpoint-every": { type: "string", default: "5" },
    ledger: { type: "string", default: "universes-ledger.json" },
    "mount-root": { type: "string", default: "/mnt/archil" },
    keep: { type: "boolean", default: false },
  },
});

const disk = process.env.PDA_LIVE_DISK ?? process.env.ARCHIL_DISK;
const region = process.env.PDA_LIVE_REGION ?? process.env.ARCHIL_REGION ?? "aws-us-east-1";
if (!disk || !process.env.ARCHIL_API_KEY) throw new Error("ARCHIL_API_KEY and PDA_LIVE_DISK (with-archil) name the disk");
if (!process.env.DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY (with-daytona) is needed");
if (!values.snapshot) throw new Error("--snapshot (or DAYTONA_SNAPSHOT) names the demo's runtime snapshot (03-tab-to-cloud/scripts/daytona-snapshot.ts)");

const n = Number(values.universes);
const stamp = Date.now().toString(36);
const log = jsonLog();
const ledger = new Ledger(values.ledger!);
const onResource = (kind: string, id: string, note?: string) => {
  if (kind === "token") ledger.open("token", id, note);
  else if (kind === "token-removed") ledger.close("token", id);
  else if (kind === "mount") ledger.open("mount", id, note);
  else if (kind === "unmount") ledger.close("mount", id, note);
  else if (kind === "run") ledger.open("run", id, note);
  else if (kind === "subdir") ledger.open("subdir", id);
  else if (kind === "subdir-deleted") ledger.close("subdir", id);
};

const control = await archilControl({ disk, region, apiKey: process.env.ARCHIL_API_KEY });
const bundle = readFileSync(join(here, "dist/universe-app.mjs"));
const fleet = daytonaFleet({
  client: daytonaRest({ apiKey: process.env.DAYTONA_API_KEY, ...(process.env.DAYTONA_API_URL ? { apiUrl: process.env.DAYTONA_API_URL } : {}) }),
  snapshot: values.snapshot!,
  target: process.env.DAYTONA_TARGET || "us",
  fleet: "demo-d1",
  namePrefix: "pda-demo-d1-",
  app: bundle,
  runArgs: ["--heartbeat-ms", "2000", "--lease-expiry-ms", "10000", "--lease-margin-ms", "3000", "--on-sigterm", "pause"],
  ledger,
  log,
});

mkdirSync(values["mount-root"]!, { recursive: true });
const origin = Date.now();
const feed = new Feed();
const sourceLabel = "your browser tab";
let source: RunRef = { disk, region, id: values.source ?? `d1-src-${stamp}` };
const createdRuns: string[] = [];
if (!values.source) {
  await makeSourceRun({ control, ref: source, mountRoot: values["mount-root"]!, story: "Design a creature that walks, then train it in eight universes and bring the best one home.", onResource, log });
  createdRuns.push(source.id);
}
feed.emit({ t: "run", at: 0, run: source.id, origin, environments: [{ id: "tab", label: "Tab", kind: "tab" }, { id: "universes", label: "Universes", kind: "sandbox" }] });
feed.emit({ t: "place", at: 0, place: { where: "tab", host: sourceLabel }, env: "tab" });
feed.emit({ t: "stay.begin", at: 0, stay: { id: "run:source", lane: "run", host: sourceLabel, hostKind: "tab", from: 0 } });

const universes: UniverseSpec[] = Array.from({ length: n }, (_, i) => ({
  id: `u${i + 1}`,
  reward: REWARDS[i % REWARDS.length]!,
  env: { UNIVERSE_SEED: String(i + 1), UNIVERSE_TOTAL_STEPS: values.steps!, UNIVERSE_STEP_MS: values["step-ms"]!, UNIVERSE_CHECKPOINT_EVERY: values["checkpoint-every"]! },
}));
const runPrefix = `d1-${stamp}-`;
const mv = new Multiverse({
  control,
  fleet,
  source,
  sourceLabel,
  universes,
  spares: Number(values.spares),
  mountRoot: values["mount-root"]!,
  runPrefix,
  machinePrefix: "",
  emit: (e) => feed.emit(e),
  origin,
  ensure: { leaseExpiryMs: 10_000, startGraceMs: 60_000, tokenPrefix: "pda-d1-" },
  log,
  onResource: (kind, id, note) => {
    onResource(kind, id, note);
    if (kind === "run") createdRuns.push(id);
  },
});

const takeovers: TakeoverReport[] = [];
let fanout: FanOutReport | undefined;

/** Run `op`; a refusal that comes back at once is the command's answer, anything later lands in the log. */
async function answer(op: Promise<unknown>, what: string): Promise<CommandResult> {
  const early = await Promise.race([op.then(() => null, (e: unknown) => e), new Promise((r) => setTimeout(() => r(undefined), 50))]);
  op.catch((error: unknown) => log(`${what}.failed`, { error: (error as Error).message }));
  if (early instanceof MultiverseError) return { ok: false, error: early.message };
  return { ok: true };
}

async function command(cmd: FeedCommand): Promise<CommandResult> {
  switch (cmd.t) {
    case "prewarm":
      try {
        mv.prewarm();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    case "fanout":
      return answer(mv.fanOut().then((r) => void (fanout = r)), "fanout");
    case "kill":
      return answer(mv.kill(cmd.universe).then((r) => void takeovers.push(r)), "kill");
    case "collapse":
      return answer(mv.collapse(cmd.winner), "collapse");
    default:
      return { ok: false, error: `${cmd.t} is not this producer's command` };
  }
}

const server = await serveFeed({ feed, port: Number(values.port), command });
log("feed", { url: server.url, source: source.id, universes: n });

let cleaning: Promise<void> | undefined;
async function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    await mv.close({ machines: !values.keep });
    if (values.keep) return;
    const swept = await fleet.sweep();
    for (const row of ledger.openRows().filter((r) => r.kind === "token")) {
      await removeMountToken(control, row.id).then(() => ledger.close("token", row.id, "cleanup"), (e: unknown) => log("token.remove-failed", { id: row.id, error: (e as Error).message }));
    }
    for (const id of createdRuns) {
      await deleteRunTree(control, id).then(
        (r) => {
          ledger.close("run", id, `deleted ${r.objects} objects`);
          ledger.close("subdir", `runs/${id}/`);
        },
        (e: unknown) => log("run.delete-failed", { run: id, error: (e as Error).message }),
      );
    }
    log("cleanup", { swept, runs: createdRuns.length, open: ledger.openRows().filter((r) => r.kind !== "daytona-box" || !swept.includes(r.id)).length });
    server.close();
    feed.close();
  })();
  return cleaning;
}
process.once("SIGINT", () => void cleanup().then(() => process.exit(130)));

if (values.auto) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  try {
    if (values.prewarm) {
      mv.prewarm();
      await mv.whenWarm();
      log("measure.prewarm", { ms: Date.now() - t0 });
    }
    fanout = await mv.fanOut();
    feed.emit({ t: "stay.end", at: Date.now() - origin, id: "run:source", endedBy: "switch" });
    log("measure.fanout", fanout);
    const allTraining = async () => {
      for (let i = 0; i < 240; i++) {
        if (mv.lines().filter((l) => l.slot !== null).every((l) => l.status === "training")) return;
        await sleep(500);
      }
      throw new Error("not every universe reached training in 120 s");
    };
    await allTraining();
    log("measure.training", { ms: Date.now() - t0 });
    for (let k = 0; k < Number(values.kills); k++) {
      await sleep(Number(values["kill-every"]) * 1000);
      const victim = mv.lines().filter((l) => l.slot !== null && l.status === "training")[k % n];
      if (!victim) break;
      const r = await mv.kill(victim.id);
      takeovers.push(r);
      log("measure.takeover", r);
      await allTraining();
    }
    // Let every universe finish its budget, then keep the best.
    for (let i = 0; i < 600; i++) {
      const st = feed.state;
      if (Object.values(st.universes).filter((u) => u.slot !== null).every((u) => u.progress >= 1)) break;
      await sleep(1000);
    }
    const collapse = await mv.collapse();
    log("measure.collapse", collapse);
    log("measure.report", {
      universes: n,
      forkMs: fanout.forks.map((f) => f.ms),
      startMs: fanout.starts.map((s) => s.ms),
      fanoutMs: fanout.ms,
      takeovers: takeovers.map((t) => ({ openMs: t.openMs, trainingMs: t.trainingMs, killMs: t.killMs, startMs: t.startMs, revoked: t.revoked })),
      collapse: { ms: collapse.ms, sealed: collapse.sealed.map((s) => ({ status: s.status, sealedSeq: s.sealedSeq, ms: s.ms })) },
      costUsd: feed.state.cost.usd,
      totalMs: Date.now() - t0,
    });
  } catch (error) {
    log("measure.failed", { error: (error as Error).message, stack: (error as Error).stack?.split("\n").slice(0, 4).join(" | ") });
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}
