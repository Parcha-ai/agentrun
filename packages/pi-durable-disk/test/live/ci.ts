// The live disk check: pi-durable-disk's live suites against a real Archil scratch disk, as the ship skill runs them before a
// change to this package ships. From the repository root, under your credential wrapper:
//
//   npm run build && node packages/pi-durable-disk/test/live/ci.ts all
//
//   all [--slow] [--list]    preflight, the host suites, then the Docker suites, then the sweep (always) and the summary.
//                            The last line on stdout is `ok: live disk check passed (<n> suites[ incl. slow], sweep left 0)`
//                            or `not ok: <first failing step>: <reason>`; the exit code is 0 only with the first. `--slow`
//                            adds supervise-slow (three tests that wait out fixed windows, about 17 minutes); `--list`
//                            prints the suites and their commands and runs nothing.
//   preflight                refuse to start without the key and a scratch disk
//   suites <name>...         npm run test:live:<name> for each, one after another, each under a deadline
//   sweep                    remove the run directories and token users this run's ledgers still list
//   summary                  each suite's result and the measured timings, as Markdown
//
// Environment: ARCHIL_API_KEY (a key of a scratch organisation), PDA_LIVE_DISK (a scratch disk, dsk-...) and
// PDA_LIVE_REGION (default aws-us-east-1). The suites create and delete run directories and token users on whatever disk
// they are given, so never a production key or disk. PDA_STATE_DIR is where the suites write their ledgers and results; a
// fresh temporary directory when unset. No value of any of these is ever printed.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_REGION = "aws-us-east-1";
/** The host suites the default check runs, in order. */
export const HOST_SUITES = ["claim", "env", "run", "store", "supervise", "lifecycle"] as const;
/** The tests that wait out fixed windows (the archil client's 5 min token refresh, five minutes of backoff): `--slow` only. */
export const SLOW_SUITES = ["supervise-slow"] as const;
/** The suites `suites` accepts: the package's `test:live:<name>` scripts. */
export const SUITES = [...HOST_SUITES, ...SLOW_SUITES, "docker"] as const;

/** The suites `all` runs, in order: the host suites (with supervise-slow after supervise when `slow`), then docker. */
export function suitesFor(slow: boolean): string[][] {
  const host: string[] = slow ? HOST_SUITES.flatMap((s) => (s === "supervise" ? [s, ...SLOW_SUITES] : [s])) : [...HOST_SUITES];
  return [host, ["docker"]];
}
const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));
const SUITES_LOG = "suites.jsonl";
/** The lock every live run on one host takes: the suites' mount roots are fixed, so two at once break each other. */
export const LOCK = "/tmp/pda-live.lock";
const IMAGE = "pi-durable-disk:live-check";

type Env = Record<string, string | undefined>;
type Command = readonly [string, readonly string[]];

/** What is missing or malformed for a live run; empty when it may start. No value is ever repeated in a message. */
export function preflight(env: Env): string[] {
  const problems: string[] = [];
  if (!env.ARCHIL_API_KEY) problems.push("ARCHIL_API_KEY is not set");
  if (!env.PDA_LIVE_DISK) problems.push("PDA_LIVE_DISK is not set");
  else if (!/^dsk-[0-9a-z]+$/i.test(env.PDA_LIVE_DISK)) problems.push("PDA_LIVE_DISK is not a disk id (dsk-...)");
  if (env.PDA_LIVE_REGION && !/^[a-z0-9-]+$/.test(env.PDA_LIVE_REGION)) problems.push("PDA_LIVE_REGION is not a region name (such as aws-us-east-1)");
  return problems;
}

/** `$PDA_STATE_DIR` as an absolute path (the suites run from this package's directory, the sweep from anywhere), or a fresh temporary directory. */
export function stateDirOf(env: Env): string {
  if (env.PDA_STATE_DIR) {
    const dir = resolve(env.PDA_STATE_DIR);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return mkdtempSync(join(tmpdir(), "pda-live-state-"));
}

/** The environment the live suites read. */
export function liveEnv(env: Env, stateDir: string): Env {
  return {
    ...env,
    PDA_LIVE: "1",
    PDA_LIVE_REGION: env.PDA_LIVE_REGION || DEFAULT_REGION,
    PDA_STATE_DIR: stateDir,
    // The store suite writes its measurements only when told where.
    PDA_P2_RESULTS: join(stateDir, "P2-live-results.json"),
    PDA_DOCKER_IMAGE: env.PDA_DOCKER_IMAGE || IMAGE,
  };
}

const removeTarballs: Command = [process.execPath, ["-e", 'const fs = require("node:fs"); for (const f of fs.readdirSync("docker/package")) if (f.endsWith(".tgz")) fs.rmSync(`docker/package/${f}`);']];

/** The commands of one suite, run in this package's directory. The Docker suites first build the image from this checkout. */
export function suiteSteps(suite: string, env: Env): Command[] {
  if (suite !== "docker") return [["npm", ["run", `test:live:${suite}`]]];
  return [
    removeTarballs,
    ["npm", ["pack", "--silent", "--pack-destination", "docker/package"]],
    ["docker", ["build", "-q", "-f", "docker/Dockerfile", "-t", env.PDA_DOCKER_IMAGE || IMAGE, "."]],
    removeTarballs,
    ["npm", ["run", "test:live:docker"]],
  ];
}

/** Each suite's deadline: the Docker suites include a takeover and a parked run of about 3 minutes; the host suites less. */
export function deadlineOf(suite: string, env: Env): number {
  if (env.PDA_LIVE_SUITE_DEADLINE_MS) return Number(env.PDA_LIVE_SUITE_DEADLINE_MS);
  return (suite === "docker" ? 60 : 25) * 60_000;
}

export interface SuiteResult {
  readonly suite: string;
  readonly result: "pass" | "fail" | "deadline" | "interrupted";
  readonly seconds: number;
  /** What failed: the command and its exit, the deadline, or the signal. */
  readonly detail?: string;
}

const duration = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms / 1000} s`);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Run `file args` in its own process group; resolves with its exit code (null once `stop.kill` killed the group). */
function runStep([file, args]: Command, env: Env, stop: { kill?: () => void }): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: PACKAGE, env, stdio: "inherit", detached: true });
    stop.kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // the group is gone
      }
    };
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code));
  });
}

/**
 * Each suite in turn, its commands in a process group of their own, killed with the group at the suite's deadline or when
 * `signal` aborts; the next suite runs whatever the last one did, until `signal` aborts. Every start and end is appended to
 * <state>/suites.jsonl as it happens, so a run killed from outside still names the suite it was in.
 */
export async function runSuites(
  names: readonly string[],
  options: {
    readonly env: Env;
    readonly stateDir: string;
    readonly deadlineMs?: (suite: string) => number;
    readonly steps?: (suite: string, env: Env) => readonly Command[];
    readonly signal?: AbortSignal;
  },
): Promise<SuiteResult[]> {
  const steps = options.steps ?? suiteSteps;
  const deadline = options.deadlineMs ?? ((suite: string) => deadlineOf(suite, options.env));
  mkdirSync(options.stateDir, { recursive: true });
  const log = (entry: object) => appendFileSync(join(options.stateDir, SUITES_LOG), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const results: SuiteResult[] = [];
  for (const suite of names) {
    if (options.signal?.aborted) break;
    log({ suite, event: "start" });
    const started = performance.now();
    const stop: { kill?: () => void } = {};
    let ended: "deadline" | "interrupted" | undefined;
    const end = (why: "deadline" | "interrupted") => {
      ended ??= why;
      stop.kill?.();
    };
    const timer = setTimeout(() => end("deadline"), deadline(suite));
    const onAbort = () => end("interrupted");
    options.signal?.addEventListener("abort", onAbort);
    let failed: string | undefined;
    for (const command of steps(suite, options.env)) {
      const code = await runStep(command, options.env, stop);
      if (ended) break;
      if (code !== 0) {
        failed = `${[command[0], ...command[1]].join(" ")} exited ${code}`;
        break;
      }
    }
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    const seconds = Math.round((performance.now() - started) / 1000);
    const result: SuiteResult = ended === "deadline"
      ? { suite, result: "deadline", seconds, detail: `killed at its deadline of ${duration(deadline(suite))}` }
      : ended === "interrupted"
        ? { suite, result: "interrupted", seconds, detail: `stopped by ${String(options.signal?.reason ?? "a signal")}` }
        : failed
          ? { suite, result: "fail", seconds, detail: failed }
          : { suite, result: "pass", seconds };
    log({ event: "end", ...result });
    results.push(result);
  }
  return results;
}

const CLOSED = ["deletedAt", "removedAt", "closedAt", "markerRemovedAt", "unmountedAt"];
const DIRECTORY_LISTS = new Set(["subdirectories", "runDirectories", "subpaths", "subdirs"]);
const RUN_DIRECTORY = /^runs\/[A-Za-z0-9._-]+\/?$/;
/** What the suites make on the host, by the names they give it: mounts under /mnt/pda/, units and containers named pda-*. */
const MOUNTPOINT = /^\/mnt\/pda\/[A-Za-z0-9._/-]+$/;
const HOST_NAME = /^pda-[A-Za-z0-9._@-]+$/;

export interface OpenResources {
  /** Run directories on the disk, `runs/<name>/`. */
  directories: string[];
  /** Token users on the disk, by identifier. */
  tokens: string[];
  /** On the host: systemd units, Docker containers and mounts the suites made. */
  units: string[];
  containers: string[];
  mounts: string[];
  /** Anything a ledger lists outside those names: reported, never touched. */
  refused: string[];
}

/**
 * What the suites' ledgers recorded and never stamped as removed: run directories and token users on the disk, and units,
 * containers and mounts on the host, which a suite killed at its deadline leaves (its `after` never ran). The ledgers differ
 * by suite (`subdirectories`, `runDirectories`, `subpaths`, `archil.subdirs`; `tokenUsers`, `archil.tokens`; `units`;
 * `containers`; `mounts`; removed as `deletedAt`, `removedAt`, `closedAt`, `markerRemovedAt` or `unmountedAt`). Only a
 * plain `runs/<name>/`, a mount under /mnt/pda/ and a unit or container named pda-* is ever swept; anything else a ledger
 * lists is reported as refused.
 */
export function openResources(ledgers: readonly unknown[]): OpenResources {
  const directories = new Set<string>();
  const tokens = new Set<string>();
  const units = new Set<string>();
  const containers = new Set<string>();
  const mounts = new Set<string>();
  const refused = new Set<string>();
  const take = (into: Set<string>, value: unknown, pattern: RegExp) => {
    if (typeof value !== "string") return;
    if (pattern.test(value) && !value.includes("..")) into.add(value);
    else refused.add(value);
  };
  const open = (entry: Record<string, unknown>) => !CLOSED.some((field) => entry[field] !== undefined);
  const walk = (value: unknown, key: string) => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        if (/token/i.test(key) && typeof e.identifier === "string" && open(e)) tokens.add(e.identifier);
        const path = typeof e.key === "string" ? e.key : typeof e.path === "string" ? e.path : undefined;
        if (DIRECTORY_LISTS.has(key) && path !== undefined && open(e)) {
          if (RUN_DIRECTORY.test(path) && !path.includes("..")) directories.add(path.endsWith("/") ? path : `${path}/`);
          else refused.add(path);
        }
        if (!open(e)) continue;
        if (key === "units") take(units, e.name, HOST_NAME);
        if (key === "containers") take(containers, e.name, HOST_NAME);
        if (key === "mounts") take(mounts, e.mountpoint, MOUNTPOINT);
      }
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  for (const ledger of ledgers) walk(ledger, "");
  const sorted = (set: Set<string>) => [...set].sort();
  return { directories: sorted(directories), tokens: sorted(tokens), units: sorted(units), containers: sorted(containers), mounts: sorted(mounts), refused: sorted(refused) };
}

/** Every file in `dir` whose name matches, parsed. */
function stateFiles(dir: string, pattern: RegExp): { name: string; data: unknown }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => ({ name, data: JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown }));
}

/**
 * What the sweep does: on the host, stop a unit, remove a container, unmount a mount (each throws if the thing is still
 * there); on the disk, the package's own run-tree delete (it revokes the run's delegations first) and token-user removal.
 */
export interface SweepOps {
  stopUnit(name: string): Promise<unknown>;
  removeContainer(name: string): Promise<unknown>;
  unmount(mountpoint: string): Promise<unknown>;
  deleteRunTree(id: string): Promise<{ objects: number; revoked: number }>;
  removeUser(identifier: string): Promise<unknown>;
}

export interface SweepReport {
  readonly lines: string[];
  readonly directoriesLeft: number;
  readonly tokensLeft: number;
  /** Units, containers and mounts left on the host. */
  readonly hostLeft: number;
}

/**
 * The host first, in the order its resources hold each other (a unit's instance holds its mount; a container holds its
 * own), then the disk: each run directory (`runs/<id>/`, its delegations revoked first) and each token user. Reports what is left.
 */
export async function sweepWith(ops: SweepOps, open: Pick<OpenResources, "directories" | "tokens" | "units" | "containers" | "mounts">): Promise<SweepReport> {
  const lines: string[] = [];
  let directoriesLeft = 0;
  let tokensLeft = 0;
  let hostLeft = 0;
  for (const [kind, names, op] of [["unit", open.units, ops.stopUnit], ["container", open.containers, ops.removeContainer], ["mount", open.mounts, ops.unmount]] as const) {
    for (const name of names) {
      try {
        await op(name);
        lines.push(`${kind} ${name}: removed`);
      } catch (error) {
        lines.push(`${kind} ${name}: not removed (${(error as Error).message})`);
        hostLeft++;
      }
    }
  }
  for (const prefix of open.directories) {
    const id = prefix.slice("runs/".length, -1);
    try {
      const { objects, revoked } = await ops.deleteRunTree(id);
      lines.push(`swept ${prefix}: ${objects} objects, ${revoked} delegations revoked`);
    } catch (error) {
      lines.push(`not swept ${prefix}: ${(error as Error).message}`);
      directoriesLeft++;
    }
  }
  for (const identifier of open.tokens) {
    try {
      await ops.removeUser(identifier);
      lines.push(`token user ${identifier}: removed`);
    } catch (error) {
      lines.push(`token user ${identifier}: not removed (${(error as Error).message})`);
      tokensLeft++;
    }
  }
  return { lines, directoriesLeft, tokensLeft, hostLeft };
}

/** The sweep over this run's ledgers, on the disk the environment names. It talks to the disk only when something is left. */
export async function sweep(env: Env, stateDir: string): Promise<SweepReport> {
  const open = openResources(stateFiles(stateDir, /-STATE\.json$/).map((f) => f.data));
  const refused = open.refused.map((name) => `not swept (not a name the suites use): ${name}`);
  if ([open.directories, open.tokens, open.units, open.containers, open.mounts].every((list) => list.length === 0)) {
    return { lines: [...refused, "sweep: nothing left; every run directory, token user, unit, container and mount the suites recorded was removed"], directoriesLeft: 0, tokensLeft: 0, hostLeft: 0 };
  }
  // Loaded here, not at the top, so that preflight and the summary need nothing installed.
  const { configure, getDisk } = await import("disk");
  const { deleteRunTree } = await import("../../src/supervise.ts");
  const { unmountClaim } = await import("../../src/claim.ts");
  configure({ apiKey: env.ARCHIL_API_KEY!, region: env.PDA_LIVE_REGION || DEFAULT_REGION });
  const disk = await getDisk(env.PDA_LIVE_DISK!);
  const run = (file: string, args: string[]) => spawnSync(file, args, { encoding: "utf8", timeout: 120_000 });
  const mounted = (mountpoint: string) => readFileSync("/proc/mounts", "utf8").split("\n").some((line) => line.split(" ")[1] === mountpoint);
  const report = await sweepWith({
    stopUnit: async (name) => {
      run("sudo", ["-n", "systemctl", "stop", name]);
      run("sudo", ["-n", "systemctl", "reset-failed", name]);
      const state = run("systemctl", ["is-active", name]).stdout.trim();
      if (["active", "activating", "deactivating", "reloading"].includes(state)) throw new Error(`still ${state}`);
    },
    removeContainer: async (name) => {
      run("docker", ["rm", "-f", name]);
      if (run("docker", ["inspect", "--type", "container", name]).status === 0) throw new Error("still there after docker rm -f");
    },
    unmount: async (mountpoint) => {
      if (mounted(mountpoint)) await unmountClaim(mountpoint);
      if (mounted(mountpoint)) throw new Error("still mounted");
    },
    deleteRunTree: (id) => deleteRunTree(disk, id),
    removeUser: (identifier) => disk.removeUser("token", identifier),
  }, open);
  return { ...report, lines: [...refused, ...report.lines] };
}

const SUITE_OF: Record<string, string> = { P1: "claim", P2: "store", P3: "env", P4: "run", P5: "supervise", "P5-slow": "supervise-slow", P8: "lifecycle", docker: "docker" };
/** The results files the suites write: P<n>-live-results.json, and the Docker suites' docker-T13.json and docker-park.json. */
const RESULTS = /^(P\d+(?:-slow)?-live-results|docker-T13|docker-park)\.json$/;
const TIMING = /(^ms|Ms)$/;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
const n2 = (x: number) => String(Math.round(x * 10) / 10);

/** The timing measurements in one results file, as table rows: `[what, value]`. Nothing but numbers leaves the file. */
export function timings(data: unknown): [string, string][] {
  const rows: [string, string][] = [];
  const walk = (value: unknown, path: string, key: string) => {
    if (typeof value === "number") {
      if (TIMING.test(key)) rows.push([path, `${n2(value)} ms`]);
    } else if (Array.isArray(value)) {
      if (value.length && value.every((v) => typeof v === "number") && TIMING.test(key)) {
        rows.push([path, `median ${n2(median(value))}, max ${n2(Math.max(...value))} ms (n ${value.length})`]);
      } else value.forEach((v, i) => walk(v, `${path}[${i}]`, key));
    } else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      if (typeof o.p50 === "number" && typeof o.p95 === "number") {
        rows.push([path, `p50 ${n2(o.p50)}, p95 ${n2(o.p95)}${typeof o.max === "number" ? `, max ${n2(o.max)}` : ""} ms${typeof o.n === "number" ? ` (n ${o.n})` : ""}`]);
        return;
      }
      for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k, k);
    }
  };
  walk(data, "", "");
  return rows;
}

/** Each suite's result and time, the archil client, and every suite's timing measurements, as Markdown. */
export function summarize(suites: readonly SuiteResult[], results: readonly { name: string; data: unknown }[], limit = 40): string {
  const lines = ["## Live disk check", ""];
  if (suites.length === 0) lines.push("No suite ran.");
  else {
    lines.push("| Suite | Result | Time |", "|---|---|---|");
    for (const s of suites) lines.push(`| ${s.suite} | ${s.result}${s.detail ? `: ${s.detail}` : ""} | ${s.seconds} s |`);
  }
  const client = results.map((r) => (r.data as { client?: unknown }).client).find((c) => typeof c === "string" && c.startsWith("Archil Client"));
  if (typeof client === "string") lines.push("", `${client.split(",")[0]}`);
  for (const { name, data } of results) {
    const rows = timings(data);
    if (!rows.length) continue;
    const lane = /^(P\d+(?:-slow)?|docker)/.exec(name)?.[1] ?? name;
    lines.push("", `### ${SUITE_OF[lane] ?? lane} (${name})`, "", "| Measurement | Value |", "|---|---|");
    for (const [what, value] of rows.slice(0, limit)) lines.push(`| ${what} | ${value} |`);
    if (rows.length > limit) lines.push(`| ... | ${rows.length - limit} more in ${name} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** The suites' starts and ends, as `runSuites` logged them; a start with no end is a suite something killed from outside. */
function loggedSuites(dir: string): SuiteResult[] {
  const file = join(dir, SUITES_LOG);
  if (!existsSync(file)) return [];
  const entries = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as SuiteResult & { event: string; at: string });
  const out: SuiteResult[] = [];
  for (const e of entries) {
    if (e.event === "end") out.push({ suite: e.suite, result: e.result, seconds: e.seconds, detail: e.detail });
    else if (!entries.some((x) => x.event === "end" && x.suite === e.suite && x.at >= e.at)) out.push({ suite: e.suite, result: "interrupted", seconds: Math.round((Date.now() - Date.parse(e.at)) / 1000), detail: "started and never ended" });
  }
  return out;
}

/** The summary of the run whose ledgers and results are in `stateDir`. */
export function summaryOf(stateDir: string): string {
  return summarize(loggedSuites(stateDir), stateFiles(stateDir, RESULTS));
}

/**
 * The whole check: preflight, the host suites, the Docker suites, then always the sweep and the summary. Every line goes to
 * `out`; the last is `ok: live disk check passed (<n> suites, sweep left 0)` or `not ok: <first failing step>: <reason>`.
 * Resolves with the exit code: 0 only when preflight passed, every suite passed and the sweep left nothing.
 */
export async function runAll(
  env: Env,
  options: {
    readonly out: (line: string) => void;
    readonly signal?: AbortSignal;
    readonly steps?: (suite: string, env: Env) => readonly Command[];
    readonly deadlineMs?: (suite: string) => number;
    readonly sweep?: (env: Env, stateDir: string) => Promise<SweepReport>;
    /** Add the slow tier (`--slow`). */
    readonly slow?: boolean;
    /** Where the suites write their scratch output (`live-*`): this package's `.tmp/`. */
    readonly scratch?: string;
  },
): Promise<number> {
  const { out } = options;
  const stateDir = stateDirOf(env);
  // The supervise and lifecycle suites leave their scratch output in .tmp/live-*; only what this run adds is removed.
  const scratch = options.scratch ?? join(PACKAGE, ".tmp");
  const scratchBefore = new Set(existsSync(scratch) ? readdirSync(scratch) : []);
  out(`live suites' ledgers and results: ${stateDir}`);
  let failure: string | undefined;
  const suites: SuiteResult[] = [];
  const problems = preflight(env);
  if (problems.length) failure = `preflight: ${problems.join("; ")}`;
  else {
    out(`preflight: the key and a disk id are set (region ${env.PDA_LIVE_REGION || DEFAULT_REGION})`);
    const run = { env: liveEnv(env, stateDir), stateDir, signal: options.signal, steps: options.steps, deadlineMs: options.deadlineMs };
    // The Docker suites after the host suites, so the two never share the disk.
    for (const group of suitesFor(options.slow ?? false)) {
      for (const r of await runSuites(group, run)) {
        suites.push(r);
        out(`suite ${r.suite}: ${r.result} (${r.seconds} s)${r.detail ? `: ${r.detail}` : ""}`);
      }
    }
    const first = suites.find((r) => r.result !== "pass");
    if (first?.result === "interrupted") failure = `interrupted: ${first.detail} during suite ${first.suite}`;
    else if (first) failure = `suite ${first.suite}: ${first.result}: ${first.detail}`;
    else if (options.signal?.aborted) failure = `interrupted: stopped by ${String(options.signal.reason)} between suites`;
  }
  // The sweep always runs: after a failed preflight it finds nothing to do, after a cut suite it removes what was left.
  let report: SweepReport;
  try {
    report = await (options.sweep ?? sweep)(env, stateDir);
  } catch (error) {
    report = { lines: [`sweep failed: ${(error as Error).message}`], directoriesLeft: Number.NaN, tokensLeft: Number.NaN, hostLeft: Number.NaN };
  }
  for (const line of report.lines) out(line);
  for (const name of existsSync(scratch) ? readdirSync(scratch) : []) {
    if (!name.startsWith("live-") || scratchBefore.has(name)) continue;
    rmSync(join(scratch, name), { recursive: true, force: true });
    out(`removed the suites' scratch output ${join(scratch, name)}`);
  }
  const left = report.directoriesLeft + report.tokensLeft + report.hostLeft;
  if (left !== 0) {
    failure ??= Number.isNaN(left)
      ? "sweep: it did not finish, so what is left is unknown"
      : `sweep: ${count(report.directoriesLeft, "run directory", "run directories")}, ${count(report.tokensLeft, "token user", "token users")} and ${count(report.hostLeft, "host resource", "host resources")} (units, containers, mounts) left`;
  }
  out(summaryOf(stateDir).trimEnd());
  out(failure ? `not ok: ${failure}` : `ok: live disk check passed (${suites.length} suites${options.slow ? " incl. slow" : ""}, sweep left 0)`);
  return failure ? 1 : 0;
}

/**
 * Hold `lock` with flock, as `flock /tmp/pda-live.lock npm run test:live:...` does, until this process exits: a holder
 * process takes it and keeps it while its stdin, a pipe from this process, stays open. Resolves false when another run holds it.
 */
export function holdLock(lock: string): Promise<boolean> {
  const holder = spawn("flock", ["-n", "-E", "75", lock, process.execPath, "-e", 'process.on("SIGINT", () => {}); process.stdout.write("held\\n"); process.stdin.on("end", () => process.exit(0)).resume();'], {
    stdio: ["pipe", "pipe", "inherit"],
    detached: true,
  });
  // The holder stays referenced until this settles. When another run holds the lock, flock exits at once; unreferenced, its
  // pipes could close before its exit event and leave nothing to keep this process alive, and node exits 13 with the
  // caller's top-level await unsettled. Only a holder that holds the lock is let go, so it lives as long as this process.
  return new Promise((resolve) => {
    let settled = false;
    const settle = (held: boolean) => {
      if (settled) return;
      settled = true;
      if (held) holder.unref();
      resolve(held);
    };
    holder.stdout!.once("data", () => {
      holder.stdout!.destroy();
      settle(true);
    });
    holder.once("exit", () => settle(false));
    holder.once("close", () => settle(false));
    holder.once("error", () => settle(false));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [verb, ...rest] = process.argv.slice(2);
  const env = process.env as Env;
  if (verb === "all") {
    const flags = new Set(rest);
    const unknown = rest.filter((f) => f !== "--slow" && f !== "--list");
    if (unknown.length) {
      console.error(`usage: ci.ts all [--slow] [--list] (unknown: ${unknown.join(", ")})`);
      process.exit(2);
    }
    const slow = flags.has("--slow");
    if (flags.has("--list")) {
      for (const suite of suitesFor(slow).flat()) {
        for (const [file, args] of suiteSteps(suite, liveEnv(env, "<state>"))) console.log(`${suite}: ${[file === process.execPath ? "node" : file, ...args].join(" ")}`);
      }
      process.exit(0);
    }
    const lock = env.PDA_LIVE_LOCK || LOCK;
    if (!(await holdLock(lock))) {
      console.log(`not ok: lock: another live run on this host holds ${lock}`);
      process.exit(1);
    }
    // A first SIGINT or SIGTERM stops the running suite and goes on to the sweep; a second one exits at once.
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stop.signal.aborted ? process.exit(130) : stop.abort(signal)));
    process.exit(await runAll(env, { out: (line) => console.log(line), signal: stop.signal, slow }));
  } else if (verb === "preflight") {
    const problems = preflight(env);
    if (problems.length) {
      console.log(`not ok: preflight: ${problems.join("; ")}`);
      process.exit(1);
    }
    console.log(`ok: the key and a disk id are set (region ${env.PDA_LIVE_REGION || DEFAULT_REGION})`);
  } else if (verb === "suites") {
    const unknown = rest.filter((name) => !(SUITES as readonly string[]).includes(name));
    if (!rest.length || unknown.length) {
      console.error(`usage: ci.ts suites <${SUITES.join("|")}>... (unknown: ${unknown.join(", ") || "none given"})`);
      process.exit(2);
    }
    const problems = preflight(env);
    if (problems.length) {
      console.log(`not ok: preflight: ${problems.join("; ")}`);
      process.exit(1);
    }
    const stateDir = stateDirOf(env);
    console.log(`live suites' ledgers and results: ${stateDir}`);
    const results = await runSuites(rest, { env: liveEnv(env, stateDir), stateDir });
    for (const r of results) console.log(`suite ${r.suite}: ${r.result} (${r.seconds} s)${r.detail ? `: ${r.detail}` : ""}`);
    process.exit(results.every((r) => r.result === "pass") ? 0 : 1);
  } else if (verb === "sweep") {
    if (!env.PDA_STATE_DIR || !existsSync(env.PDA_STATE_DIR)) {
      console.log("sweep: nothing to do; PDA_STATE_DIR names no run's ledgers");
      process.exit(0);
    }
    const report = await sweep(env, resolve(env.PDA_STATE_DIR));
    for (const line of report.lines) console.log(line);
    process.exit(report.directoriesLeft + report.tokensLeft + report.hostLeft === 0 ? 0 : 1);
  } else if (verb === "summary") {
    process.stdout.write(summaryOf(env.PDA_STATE_DIR ? resolve(env.PDA_STATE_DIR) : ""));
  } else {
    console.error("usage: ci.ts all [--slow] [--list] | preflight | suites <name>... | sweep | summary");
    process.exit(2);
  }
}
