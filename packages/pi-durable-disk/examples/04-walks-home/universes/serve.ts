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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { daytonaRest, deleteRunTree, readRunStatus, removeMountToken, type ForkOptions, type RunRef } from "@parcha/pi-durable-disk";
import { archilControl, jsonLog, Ledger } from "../../03-tab-to-cloud/pipe/control.ts";
import { daytonaFleet, machineLifetime } from "./daytona-fleet.ts";
import { cleanupOnExit, stagedCleanup } from "./exit-cleanup.ts";
import { modalUniverses } from "./modal.ts";
import { Feed, serveFeed, type CommandResult, type FeedCommand } from "./feed.ts";
import { ModelProxy } from "../../03-tab-to-cloud/pipe/model-proxy.ts";
import { directPlacement, type DirectPlacement } from "./direct.ts";
import { pipePlacement, type PipePlacement } from "./pipe.ts";
import { Multiverse, MultiverseError, type FanOutReport, type TakeoverReport, type UniverseSpec } from "./multiverse.ts";
import { makeSourceRun, runStamp } from "./source.ts";
import { homeAdoption } from "./home-adoption.ts";
import { chooseHomePolicy, homeBody } from "./home-policy.ts";
import { COURSE_SCORE_UNIT, readTrainProgress, TRAIN_SCORE_UNIT } from "./train-progress.ts";

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
    /** How runs reach the boxes: the box mounts the run (direct), or this process holds it and pipes it over (pipe). */
    transport: { type: "string", default: "direct" },
    /** Where the boxes are: Daytona sandboxes from --snapshot, or Modal sandboxes from --modal-image. */
    provider: { type: "string", default: "daytona" },
    "modal-image": { type: "string" },
    "modal-app": { type: "string", default: "pda-demo-d1" },
    /** gvisor (Modal's default, and every GPU sandbox: the pipe) or vm (a durable mount: direct). */
    "modal-runtime": { type: "string", default: "gvisor" },
    /** GPU classes to try in order, comma-separated ("L4,A10,L40S,H100"): the first that places makes the machine. */
    "modal-gpu": { type: "string" },
    "modal-place-ms": { type: "string", default: "20000" },
    "modal-region": { type: "string", default: "us-east" },
    /** What a score means on the stage; with --workload train it is D2's ("m walked in 10 s"), the stand-in's has none. */
    "score-unit": { type: "string" },
    /** What each universe runs: the stand-in trainer, or D2's train.py (in the box's image). */
    workload: { type: "string", default: "stand-in" },
    /** D2's universe files (u1.json .. u8.json: name, hypothesis, reward_scales). */
    "universes-dir": { type: "string", default: join(here, "..", "train", "universes") },
    "train-py": { type: "string", default: "/opt/pda/train/train.py" },
    /** D2's export.py (the home step's combined policy) and the image's getup policy for the default body. */
    "export-py": { type: "string", default: "/opt/pda/train/export.py" },
    getup: { type: "string", default: "/opt/pda/train/default/getup.json" },
    python: { type: "string", default: "/usr/local/bin/python" },
    minutes: { type: "string", default: "6" },
    /** Every machine's hard lifetime in minutes (the provider destroys it at this age): default 30, or the training plus 10. */
    "ttl-minutes": { type: "string" },
    /** A directory whose files go into the source run's work/ before it is sealed (the creature: creature/creature.xml, creature/body.json). */
    "source-files": { type: "string" },
    /** train.py's compile cache: in the run's work/ (default), or an absolute path of each box's own. */
    "compile-cache": { type: "string" },
    /**
     * With --workload train and a box-local --compile-cache: every machine compiles the run's exact training program
     * when it is warmed (train.py --compile-only, with the source's creature and terrain), so a universe started or
     * taken over there starts warm.
     */
    "warm-compile": { type: "boolean", default: false },
    /** train.py's steps per checkpoint, the same for every run and the warm compile (a different value is another program). */
    "checkpoint-steps": { type: "string" },
    /** With --auto: collapse this many seconds after the kills, instead of when every universe reached its budget. */
    "collapse-after": { type: "string" },
    /** The tab's server (03-tab-to-cloud serve.ts) that adopts the winner by id when it is called home, and its admin token file. */
    "home-server": { type: "string" },
    "home-token-file": { type: "string" },
    /** Delete the run that went home at exit too (a rehearsal); by default the tab's server keeps it. */
    "delete-home": { type: "boolean", default: false },
  },
});

const disk = process.env.PDA_LIVE_DISK ?? process.env.ARCHIL_DISK;
const region = process.env.PDA_LIVE_REGION ?? process.env.ARCHIL_REGION ?? "aws-us-east-1";
if (!disk || !process.env.ARCHIL_API_KEY) throw new Error("ARCHIL_API_KEY and PDA_LIVE_DISK (with-archil) name the disk");
const onModal = values.provider === "modal";
if (!onModal && !process.env.DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY (with-daytona) is needed");
if (!onModal && !values.snapshot) throw new Error("--snapshot (or DAYTONA_SNAPSHOT) names the demo's runtime snapshot (03-tab-to-cloud/scripts/daytona-snapshot.ts)");
if (onModal && !values["modal-image"]) throw new Error("--modal-image names the Modal image (D4's layer; D2's GPU image on top)");

const n = Number(values.universes);
const training = values.workload === "train";
const stamp = runStamp();
const log = jsonLog();
const ledger = new Ledger(values.ledger!);
const onResource = (kind: string, id: string, note?: string) => {
  if (kind === "token") ledger.open("token", id, note);
  else if (kind === "token-removed") ledger.close("token", id);
  else if (kind === "mount") ledger.open("mount", id, note);
  else if (kind === "unmount") ledger.close("mount", id, note);
  else if (kind === "run") {
    // Listed for cleanup once made (its directory created under this serve's own id), never before.
    ledger.open("run", id, note);
    if (!createdRuns.includes(id)) createdRuns.push(id);
  }
  else if (kind === "subdir") ledger.open("subdir", id);
  else if (kind === "subdir-deleted") ledger.close("subdir", id);
};

const control = await archilControl({ disk, region, apiKey: process.env.ARCHIL_API_KEY });

/** Every run this serve made, listed when it is created (onResource "run"), so a failure later still deletes it. */
const createdRuns: string[] = [];
/** This serve's mount tokens, then its runs, except `handed` (the tab's server holds it). */
async function removeTokensAndRuns(handed?: string): Promise<void> {
  for (const row of ledger.openRows().filter((r) => r.kind === "token")) {
    await removeMountToken(control, row.id).then(() => ledger.close("token", row.id, "cleanup"), (e: unknown) => log("token.remove-failed", { id: row.id, error: (e as Error).message }));
  }
  for (const id of createdRuns) {
    // The run that went home belongs to the tab's server from its adoption on: it stays, unless asked.
    if (id === handed) {
      ledger.close("run", id, `handed to the tab's server at ${values["home-server"]}`);
      ledger.close("subdir", `runs/${id}/`, "handed to the tab's server");
      continue;
    }
    await deleteRunTree(control, id).then(
      (r) => {
        ledger.close("run", id, `deleted ${r.objects} objects`);
        ledger.close("subdir", `runs/${id}/`);
      },
      (e: unknown) => log("run.delete-failed", { run: id, error: (e as Error).message }),
    );
  }
}
// Until the feed is up a failure has made at most runs and their tokens (no machine exists before a prewarm): that is
// the startup cleanup. Every way out short of SIGKILL runs the cleanup current then (exit-cleanup.ts), once; past
// SIGKILL, each machine's hard lifetime holds.
const { cleanup, ready: cleanupReady, track: creating } = stagedCleanup(async () => {
  if (values.keep) return;
  await removeTokensAndRuns();
  log("cleanup", { stage: "startup", runs: createdRuns.length, open: ledger.openRows().length });
});
cleanupOnExit(cleanup, process, log);
const transport = values.transport === "pipe" ? "pipe" : "direct";
const daytonaApi = (process.env.DAYTONA_API_URL || "https://app.daytona.io/api").replace(/\/+$/, "");
/** A signed preview URL of one port of a box (bound to that port, expiring). */
async function previewUrl(boxId: string, port: number): Promise<string> {
  const res = await fetch(`${daytonaApi}/sandbox/${encodeURIComponent(boxId)}/ports/${port}/signed-preview-url?expiresInSeconds=7200`, {
    headers: { authorization: `Bearer ${process.env.DAYTONA_API_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string };
  if (!res.ok || !body.url) throw new Error(`signed preview URL for ${boxId} port ${port}: ${res.status}`);
  return body.url.replace(/\/+$/, "");
}
// The universes' model access through the pipe: no turn runs unless someone submits one, so the budget is small.
const model = new ModelProxy({ baseUrl: process.env.DEMO_MODEL_URL ?? "http://127.0.0.1:9421/v1", model: process.env.DEMO_MODEL ?? "gpt-6-luna", budgetTokens: 200_000 });
let direct: DirectPlacement | undefined;
let pipes: PipePlacement | undefined;
const bundle = readFileSync(join(here, "dist/universe-app.mjs"));
const probe = readFileSync(join(here, "dist/probe.mjs"));
const modal = onModal
  ? await modalUniverses({
      appName: values["modal-app"]!,
      image: values["modal-image"]!,
      runtime: values["modal-runtime"] === "vm" ? "vm" : "gvisor",
      ...(values["modal-gpu"] ? { gpus: values["modal-gpu"].split(",").map((g) => g.trim()).filter(Boolean) } : {}),
      placeMs: Number(values["modal-place-ms"]),
      regions: [values["modal-region"]!],
      ports: [8080],
      log,
    })
  : undefined;
// The warm compile: the run's creature and terrain, any universe's file (the eight differ only in weights, which are
// data), the same flags as every universe's command, and --compile-only.
const warmup = (() => {
  if (!training || !values["warm-compile"] || !values["source-files"] || !values["compile-cache"]?.startsWith("/")) return undefined;
  const src = values["source-files"];
  const files: Record<string, Uint8Array> = {};
  for (const f of ["creature/creature.xml", "creature/body.json", "terrain/terrain.json", "terrain/course.json"]) if (existsSync(join(src, f))) files[f] = readFileSync(join(src, f));
  files["universe.json"] = readFileSync(join(values["universes-dir"]!, "u1.json"));
  const flag = (name: string, file: string) => (files[file] ? ` --${name} ${file}` : "");
  const command =
    `${values.python} ${values["train-py"]} --mjcf creature/creature.xml --body creature/body.json --universe universe.json --work /tmp/pda-universe-unused` +
    `${flag("world", "terrain/terrain.json")}${flag("course", "terrain/course.json")} --compile-cache ${values["compile-cache"]}` +
    `${values["checkpoint-steps"] ? ` --checkpoint-steps ${values["checkpoint-steps"]}` : ""} --compile-only`;
  return { files, command, timeoutSec: 900 };
})();

// The warm compile runs on the same machine before its training: its budget is part of the machine's life.
const ttlMinutes = machineLifetime(values["ttl-minutes"] === undefined ? undefined : Number(values["ttl-minutes"]), Number(values.minutes), warmup ? warmup.timeoutSec / 60 : 0);
const fleet = daytonaFleet({
  ttlMinutes,
  client: modal?.client ?? daytonaRest({ apiKey: process.env.DAYTONA_API_KEY!, ...(process.env.DAYTONA_API_URL ? { apiUrl: process.env.DAYTONA_API_URL } : {}) }),
  ...(modal ? { kind: modal.kind, ratePerHour: modal.ratePerHour, label: modal.label, ledgerKind: "modal-sandbox" } : {}),
  snapshot: values["modal-image"] ?? values.snapshot!,
  target: process.env.DAYTONA_TARGET || "us",
  fleet: "demo-d1",
  namePrefix: "pda-demo-d1-",
  ...(transport === "direct" ? { app: bundle } : {}),
  ...(warmup ? { warmup } : {}),
  probe,
  runArgs: ["--heartbeat-ms", "2000", "--lease-expiry-ms", "10000", "--lease-margin-ms", "3000", "--on-sigterm", "pause"],
  ledger,
  log,
  ...(transport === "pipe" ? { runner: { bundle: readFileSync(join(here, "dist/universe-remote.mjs")), port: 8080, previewUrl: modal?.previewUrl ?? previewUrl } } : {}),
  placement: (access) =>
    transport === "pipe"
      ? (pipes = pipePlacement({
          control,
          mountRoot: values["mount-root"]!,
          model,
          lease: { heartbeatMs: 2_000, expiryMs: 10_000, marginMs: 3_000 },
          runner: (m) => access.runner(m),
          machineStatus: (m) => access.status(m),
          retire: (m) => access.retire(m),
          tokenPrefix: "pda-d1-",
          onResource,
          log,
        }))
      : (direct = directPlacement({ control, driver: access.driver, ensure: { leaseExpiryMs: 10_000, startGraceMs: 60_000, tokenPrefix: "pda-d1-" }, onResource })),
});
// Off every start's clock: attribute the disk's pathless delegations once.
void direct?.primeResolver();

mkdirSync(values["mount-root"]!, { recursive: true });
const origin = Date.now();
const feed = new Feed();
const sourceLabel = "your browser tab";
let source: RunRef = { disk, region, id: values.source ?? `d1-src-${stamp}` };
if (!values.source) {
  // Tracked: a signal while its directory is being created waits for the create, then deletes what it made.
  await creating(makeSourceRun({
    control,
    ref: source,
    mountRoot: values["mount-root"]!,
    story: "Design a creature that walks, then train it in eight universes and bring the best one home.",
    ...(values["source-files"] ? { files: values["source-files"] } : {}),
    onResource,
    log,
  }));
}
feed.emit({
  t: "run",
  at: 0,
  run: source.id,
  origin,
  environments: [{ id: "tab", label: "Tab", kind: "tab" }, { id: "universes", label: "Universes", kind: "sandbox" }],
  source: "live",
  // train.py scores on the held-out course when the run has one (it says so as score_unit on every line).
  ...(values["score-unit"] || training ? { scoreUnit: values["score-unit"] ?? (values["source-files"] && existsSync(join(values["source-files"], "terrain", "course.json")) ? COURSE_SCORE_UNIT : TRAIN_SCORE_UNIT) } : {}),
});
feed.emit({ t: "place", at: 0, place: { where: "tab", host: sourceLabel }, env: "tab" });
feed.emit({ t: "stay.begin", at: 0, stay: { id: "run:source", lane: "run", host: sourceLabel, hostKind: "tab", from: 0 } });

/** D2's universe file k (1-based): its hypothesis is the stage's reward line, its scales go to train.py. */
const trainUniverse = (k: number): { hypothesis: string; reward_scales: unknown; [key: string]: unknown } => JSON.parse(readFileSync(join(values["universes-dir"]!, `u${k}.json`), "utf8"));
const universes: UniverseSpec[] = Array.from({ length: n }, (_, i): UniverseSpec => {
  if (!training) {
    return {
      id: `u${i + 1}`,
      reward: REWARDS[i % REWARDS.length]!,
      env: { UNIVERSE_SEED: String(i + 1), UNIVERSE_TOTAL_STEPS: values.steps!, UNIVERSE_STEP_MS: values["step-ms"]!, UNIVERSE_CHECKPOINT_EVERY: values["checkpoint-every"]! },
    };
  }
  const u = trainUniverse(i + 1);
  return {
    id: `u${i + 1}`,
    reward: u.hypothesis,
    env: {
      UNIVERSE_WORKLOAD: "train",
      UNIVERSE_TRAIN_PY: values["train-py"]!,
      UNIVERSE_PYTHON: values.python!,
      UNIVERSE_SPEC: JSON.stringify({ ...u, name: `u${i + 1}` }),
      UNIVERSE_MINUTES: values.minutes!,
      ...(values["compile-cache"] ? { UNIVERSE_COMPILE_CACHE: values["compile-cache"] } : {}),
      UNIVERSE_EXPORT_PY: values["export-py"]!,
      UNIVERSE_GETUP: values.getup!,
      ...(values["checkpoint-steps"] ? { UNIVERSE_TRAIN_ARGS: JSON.stringify(["--checkpoint-steps", values["checkpoint-steps"]]) } : {}),
    },
  };
});
const runPrefix = `d1-${stamp}-`;
// forkMany (#64: one source mount, every new run copied at once) when this build of the package has it; otherwise the
// multiverse forks one run after another.
type ForkMany = (ref: RunRef, ids: readonly string[], options: ForkOptions) => Promise<{ outcomes: ({ run: string; ok: true; result: { ms: number; files: number; bytes: number } } | { run: string; ok: false; error: Error })[] }>;
const forkMany = ((await import("@parcha/pi-durable-disk")) as unknown as { forkMany?: ForkMany }).forkMany;
const forkAll = forkMany
  ? async (ref: RunRef, ids: readonly string[], options: ForkOptions) => {
      const r = await forkMany(ref, ids, options);
      const failed = r.outcomes.find((o) => !o.ok);
      if (failed && !failed.ok) throw failed.error;
      return r.outcomes.map((o) => (o.ok ? { run: o.run, ms: o.result.ms, files: o.result.files, bytes: o.result.bytes } : { run: o.run, ms: 0, files: 0, bytes: 0 }));
    }
  : undefined;
log("forks", { with: forkMany ? "forkMany" : "fork, one by one" });
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
  log,
  ...(forkAll ? { forkAll } : {}),
  ...(training ? { progress: (run: RunRef, spec: UniverseSpec) => readTrainProgress(control, run, spec.id), scoresMeasured: true, resumeTimeoutMs: 600_000 } : {}),
  // A fork's run is listed for cleanup by onResource, as the source's is.
  onResource,
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
    case "switch":
      // Home: the stage sends a switch to the tab once the multiverse collapsed.
      if (cmd.to !== "tab") return { ok: false, error: `the multiverse goes home to the tab, not to ${cmd.to}` };
      return answer(mv.home({ label: "your browser tab", env: "tab", onSealed: (run, universe) => homes.adopt(run, universe) }), "home");
    default:
      return { ok: false, error: `${cmd.t} is not this producer's command` };
  }
}

/**
 * The policy the tab loads: the combined walk + getup file when the winner's machine made one the tab accepts (strict
 * JSON, the run's body), else the winner's own walking policy, and the stage is told why getup is missing.
 */
async function homePolicyPath(run: RunRef, universe: string): Promise<string | null> {
  const read = (path: string) => control.getObject(`runs/${run.id}/work/${path}`).then((b) => ({ text: new TextDecoder().decode(b) }), () => null);
  // A creature that is incomplete or broken throws: the adoption sends no policy home and the stage is told
  // (home-adoption.ts). Only a run with no creature at all skips the check.
  const body = homeBody((await read("creature/creature.xml"))?.text ?? null, (await read("creature/body.json"))?.text ?? null);
  if (!body) {
    log("home.policy-unchecked", { run: run.id, why: "the run has no creature" });
    return `train/${universe}/policy.json`;
  }
  const choice = await chooseHomePolicy({ read, universe, ...body });
  if (choice.reason) {
    feed.emit({ t: "note", at: Date.now() - origin, kind: "home", text: choice.path ? `${choice.reason[0]!.toUpperCase()}${choice.reason.slice(1)}; the walking policy goes home alone.` : `No policy goes home: ${choice.reason}.` });
    log("home.policy", { run: run.id, path: choice.path, reason: choice.reason });
  }
  return choice.path;
}

const homes = homeAdoption({
  server: values["home-server"],
  tokenFile: values["home-token-file"],
  policy: homePolicyPath,
  onPolicyFailed(run, error) {
    feed.emit({ t: "note", at: Date.now() - origin, kind: "home", text: "No policy goes home: its check failed." });
    log("home.policy-failed", { run: run.id, error: error.message });
  },
  log,
});

const server = await serveFeed({
  feed,
  port: Number(values.port),
  command,
  // Where the tab finds the run to attach when it is called home: the winner's run, once there is one.
  routes: { winner: () => mv.winner()?.placed.run, home: () => homes.home },
});
log("feed", { url: server.url, source: source.id, universes: n, transport, ttlMinutes });

// The feed is up: from here on the cleanup is the whole one.
cleanupReady(async () => {
  // No adoption starts from here on; one in flight decides whether the winner's run is the tab's, so it ends (30 s at
  // most) before any run goes.
  const adopted = homes.close();
  await mv.close({ machines: !values.keep });
  await adopted;
  if (values.keep) return;
  await pipes?.releaseAll();
  const swept = await fleet.sweep();
  // A create that gave up can place before Modal tags it: the app is this driver's alone, so every running sandbox goes.
  if (modal) swept.push(...(await modal.sweepApp().catch((e: unknown) => (log("modal.sweep-failed", { error: (e as Error).message }), []))));
  await removeTokensAndRuns(values["delete-home"] ? undefined : homes.handed);
  log("cleanup", { swept, runs: createdRuns.length, open: ledger.openRows().filter((r) => r.kind !== "daytona-box" || !swept.includes(r.id)).length });
  server.close();
  feed.close();
});

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
    // A trainer compiles before its first checkpoint (minutes cold): training waits longer than the stand-in.
    const firstCheckpointS = training ? 900 : 120;
    const allTraining = async () => {
      for (let i = 0; i < firstCheckpointS * 2; i++) {
        if (mv.lines().filter((l) => l.slot !== null).every((l) => l.status === "training")) return;
        await sleep(500);
      }
      throw new Error(`not every universe reached training in ${firstCheckpointS} s`);
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
    // Let every universe finish its budget (or train for --collapse-after seconds), then keep the best.
    const until = Date.now() + (values["collapse-after"] ? Number(values["collapse-after"]) * 1000 : 600_000);
    while (Date.now() < until) {
      const st = feed.state;
      if (!values["collapse-after"] && Object.values(st.universes).filter((u) => u.slot !== null).every((u) => u.progress >= 1)) break;
      await sleep(1000);
    }
    // Each live machine's instance output: its open steps and timings ("running" lines) for the report.
    for (const line of mv.lines().filter((l) => l.machine && l.slot !== null)) {
      const out = await fleet.logs(mv.machine(line.id)!);
      for (const l of out.split("\n").filter((x) => x.includes('"running"') || x.includes('"notice"') || x.includes("trainer.start") || x.includes("train.") || x.includes("checkpoint."))) log("measure.instance", { line: line.id, out: l.slice(0, 600) });
      // The trainer's own last words, for a run that did not do what it should.
      log("measure.instance-tail", { line: line.id, tail: out.trim().split("\n").slice(-12).map((x) => x.slice(0, 300)) });
    }
    const collapse = await mv.collapse();
    log("measure.collapse", collapse);
    log("measure.report", {
      universes: n,
      forkMs: fanout.forks.map((f) => f.ms),
      startMs: fanout.starts.map((s) => s.ms),
      fanoutMs: fanout.ms,
      takeovers: takeovers.map((t) => ({ openMs: t.openMs, trainingMs: t.trainingMs, killMs: t.killMs, startMs: t.startMs, revoked: t.revoked })),
      collapse: { ms: collapse.ms, sealed: await Promise.all(collapse.sealed.map(async (s) => ({ ...(await readRunStatus(control, s.run).then((r) => ({ status: r?.status, sealedSeq: r?.sealedSeq })).catch(() => ({}))), ms: s.ms }))) },
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
