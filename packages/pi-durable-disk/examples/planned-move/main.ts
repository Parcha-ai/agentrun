// A run that moves hosts, planned: it starts on this machine (host A), hands itself over at a step boundary, and goes on
// in a Daytona sandbox. A hand-over, not a take-over: nothing is revoked, no call comes back interrupted, and the new
// incarnation tells the agent where it now runs.
//
//   node examples/planned-move/main.ts [--package <tarball or npm spec>] [--snapshot <name>]
//
// Needs ARCHIL_API_KEY, PDA_LIVE_DISK and PDA_LIVE_REGION (a scratch organisation's key and a scratch disk),
// DAYTONA_API_KEY (an organisation with Tier 3 or 4 egress; DAYTONA_API_URL and DAYTONA_TARGET optional), and this
// machine set up as a host: Linux, the archil client, systemd, and passwordless sudo for the archil wrapper (README).
// The example is its own supervisor; the run's two incarnations are a systemd unit here and a process in the box.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  archilControl,
  daytonaHost,
  daytonaRest,
  deleteRunTree,
  ensureRunning,
  findDelegations,
  LABEL_FLEET,
  localHost,
  readRunStatus,
  removeMountToken,
  sweepSandboxes,
} from "@parcha/pi-durable-disk";
import type { EnsureResult, HostHandle, RunRecord } from "@parcha/pi-durable-disk";
import { BOX, prepareBox } from "./box.ts";
import { STEPS } from "./app.ts";

const MOVE_AFTER = 2;
const MOUNT_ROOT = "/mnt/pda/planned-move";
const APP = fileURLToPath(new URL("./app.ts", import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function fail(problem: string): never {
  console.error(`not ok: ${problem}`);
  process.exit(1);
}

/** The installed version of a package, read from its package.json beside where Node resolves it. */
function versionOf(name: string): string {
  for (let dir = dirname(fileURLToPath(import.meta.resolve(name))); dir !== dirname(dir); dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === name) return pkg.version!;
    }
  }
  throw new Error(`no package.json for ${name}`);
}

const { values } = parseArgs({ options: { package: { type: "string" }, snapshot: { type: "string", default: "daytona-medium" } } });
const env = process.env;
const missing = ["ARCHIL_API_KEY", "PDA_LIVE_DISK", "DAYTONA_API_KEY"].filter((name) => !env[name]);
if (missing.length) fail(`set ${missing.join(", ")} (see the README: a scratch Archil disk and a Daytona key)`);
const region = env.PDA_LIVE_REGION || "aws-us-east-1";
const uid = process.getuid!();
const gid = process.getgid!();
const id = `move-${Date.now().toString(36)}`;
const ref = { disk: env.PDA_LIVE_DISK!, region, id };
const pkg = values.package ?? `@parcha/pi-durable-disk@${versionOf("@parcha/pi-durable-disk")}`;
const peers = ["@earendil-works/pi-durable", "@earendil-works/chord", "@earendil-works/pi-ai"].map((name) => `${name}@${versionOf(name)}`);

process.on("uncaughtException", (error) => fail(String(error)));
process.on("unhandledRejection", (error) => fail(String(error)));
const control = await archilControl({ apiKey: env.ARCHIL_API_KEY!, disk: ref.disk, region });
const client = daytonaRest({ apiKey: env.DAYTONA_API_KEY!, apiUrl: env.DAYTONA_API_URL || undefined });
// Host A: this machine, the run's instance as a systemd unit of this user. It hands the run over after step 2.
const hostA = localHost({
  hostName: "host-a",
  mountRoot: MOUNT_ROOT,
  unitPrefix: "pda-move-",
  runArgs: ["--app", APP],
  env: { PDA_MOVE_AFTER: String(MOVE_AFTER), PDA_MOVE_TO: "daytona", PDA_HOST_LABEL: "host-a" },
  stopTimeoutMs: 10_000,
});
// The box: a default Daytona image, prepared with the runtime, this package and the app; the run user has host A's uid.
const box = daytonaHost({
  client,
  snapshot: values.snapshot!,
  target: env.DAYTONA_TARGET || "us",
  fleet: id,
  namePrefix: "pda-move-",
  mountRoot: MOUNT_ROOT,
  node: BOX.node,
  packageDir: BOX.packageDir,
  archil: BOX.archil,
  user: String(uid),
  group: String(gid),
  runArgs: ["--app", BOX.app],
  env: { PDA_HOST_LABEL: "a Daytona box" },
  ttlMinutes: 30,
  prepare: prepareBox({ uid, gid, mountRoot: MOUNT_ROOT, pkg, peers, appFile: APP }),
});

async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(1_000);
  }
}
const status = (): Promise<RunRecord | null> => readRunStatus(control, id);
const text = async (key: string) => new TextDecoder().decode(await control.getObject(`runs/${id}/${key}`));

const started: { driver: "a" | "box"; result: Extract<EnsureResult, { action: "started" }> }[] = [];
const problems: string[] = [];
let timings = "";
try {
  // Host A's mount root, as the production host setup makes it.
  spawnSync("sudo", ["-n", "install", "-d", "-o", String(uid), "-g", String(gid), "-m", "0755", MOUNT_ROOT, `${MOUNT_ROOT}/runs`]);
  console.log(`run ${id} on ${ref.disk} (${region}); host A is this machine, the box comes from ${values.snapshot} with ${pkg}`);

  const a = await ensureRunning(ref, hostA, { control, create: { uid, gid, mode: 0o755 } });
  if (a.action !== "started") throw new Error(`host A did not start the run: ${JSON.stringify(a)}`);
  started.push({ driver: "a", result: a });
  console.log(`host A: started generation 1 (${String(a.handle.unit)})`);

  // The step boundary: the instance records where it is going, releases (the seal), and exits 0.
  const paused = await waitFor("the run to pause at its step boundary", async () => {
    const record = await status();
    return record?.status === "paused" && (await findDelegations(control, id)).length === 0 && record;
  }, 180_000);
  const pausedAt = Date.now();
  console.log(`host A: generation 1 paused after step ${MOVE_AFTER} and released: ${JSON.stringify(paused.detail)}`);
  const exitedA = await hostA.status(a.handle);

  // The hand-over: a paused run with no holder, started where it asked to go.
  const t0 = Date.now();
  const b = await ensureRunning(ref, box, { control, demand: true });
  if (b.action !== "started") throw new Error(`the box did not start the run: ${JSON.stringify(b)}`);
  started.push({ driver: "box", result: b });
  const boxMs = Date.now() - t0;
  console.log(`box: started ${String(b.handle.name)} in ${seconds(boxMs)} (reason ${b.reason}, ${b.revoked.length} revoked)`);
  const resumed = await waitFor("generation 2 to open in the box", async () => {
    const record = await status();
    return record && record.generation === 2 && record;
  }, 300_000);
  const moveMs = Date.now() - pausedAt;
  const done = await waitFor("the run to finish in the box", async () => {
    const record = await status();
    return record?.status === "done" && record;
  }, 300_000);
  console.log(`box: generation 2 opened (holder ${String(resumed.holder?.host)}) and finished: ${JSON.stringify(done.detail)}`);

  // ---- compare -----------------------------------------------------------------------------------------------------------
  const steps = await Promise.all(Array.from({ length: STEPS }, async (_, i) => JSON.parse(await text(`work/step-${i + 1}.txt`)) as { step: number; generation: number; host: string }));
  const report = JSON.parse(await text("work/report.json")) as { results: { id: string; error: boolean }[]; moveNotes: string[]; stepOrder: string[] };
  for (const s of steps) console.log(`  step ${s.step}: generation ${s.generation} on ${s.host}`);
  for (const note of report.moveNotes) console.log(`  the agent was told: ${note}`);

  const detail = paused.detail as { moveTo?: string; from?: string; afterStep?: number } | null;
  if (detail?.moveTo !== "daytona" || detail.from !== "host-a" || detail.afterStep !== MOVE_AFTER) problems.push(`the pause said ${JSON.stringify(detail)}`);
  // A transient unit that exited 0 may already be unloaded ("gone"); either way it must not be running.
  if (exitedA !== "stopped" && exitedA !== "gone") problems.push(`host A's unit is ${exitedA} after the hand-over`);
  // A hand-over: no delegation was left to revoke. (`woke` stays false: it marks a sleeping run's wake, not a demand.)
  if (b.reason !== "none" || b.revoked.length !== 0) problems.push(`the box's start was a take-over: reason ${b.reason}, ${b.revoked.length} revoked`);
  if (done.generation !== 2 || done.holder?.driver !== "daytona") problems.push(`the run finished at generation ${done.generation} under ${String(done.holder?.driver)}`);
  steps.forEach((s, i) => {
    const expected = i < MOVE_AFTER ? 1 : 2;
    if (s.generation !== expected) problems.push(`step ${s.step} was done by generation ${s.generation}, not ${expected}`);
  });
  if (report.results.length !== STEPS || report.results.some((r) => r.error)) problems.push(`tool results: ${JSON.stringify(report.results)}`);
  if (report.moveNotes.length !== 1 || !report.moveNotes[0]!.includes(`from host-a`) || !report.moveNotes[0]!.includes(`after step ${MOVE_AFTER}`)) problems.push(`move notes: ${JSON.stringify(report.moveNotes)}`);
  const noteAt = report.stepOrder.findIndex((t) => t.startsWith("You were moved"));
  const nextStepAt = report.stepOrder.indexOf(`Do step ${MOVE_AFTER + 1}`);
  if (!(noteAt >= 0 && noteAt < nextStepAt)) problems.push(`the move note came at ${noteAt}, step ${MOVE_AFTER + 1} at ${nextStepAt}`);
  timings = `box ready in ${seconds(boxMs)}, pause to generation 2 in ${seconds(moveMs)}`;
} catch (error) {
  problems.push((error as Error).message);
} finally {
  // Everything this run made: the box (and any other box of this run's fleet), the unit, the token users, the run's tree.
  for (const { driver, result } of started.reverse()) {
    await (driver === "box" ? box : hostA).stop(result.handle as HostHandle).catch((e: unknown) => problems.push(`stop ${driver}: ${(e as Error).message}`));
    await removeMountToken(control, result.token.identifier).catch(() => {});
  }
  // The driver's stop deletes the box; a delete while Daytona is still changing its state is refused (409), so this
  // sweeps until no box of this run's fleet is listed.
  let left = 1;
  for (let i = 0; i < 12 && left; i++) {
    if (i) await sleep(5_000);
    await sweepSandboxes(client, { [LABEL_FLEET]: id }).catch(() => {});
    left = (await client.list({ [LABEL_FLEET]: id }).catch(() => [null])).length;
  }
  if (left) problems.push(`a box of fleet ${id} is still listed after a minute of deletes`);
  await deleteRunTree(control, id).catch((e: unknown) => problems.push(`run tree: ${(e as Error).message}`));
  spawnSync("sudo", ["-n", "rmdir", `${MOUNT_ROOT}/runs/${id}`]);
}
if (problems.length) fail(problems.join("; "));
console.log(`ok: the run moved from host-a to a Daytona box at step ${MOVE_AFTER}, with no revoke and no interrupted call (${timings})`);
process.exit(0);
