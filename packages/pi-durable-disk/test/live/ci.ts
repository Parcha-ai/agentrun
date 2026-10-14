// The daily live job's steps (.github/workflows/pi-durable-disk-live.yml) as one script, so each can be checked without a
// disk (test/live-ci.test.ts):
//
//   node test/live/ci.ts preflight           refuse to start without the scratch disk's secrets
//   node test/live/ci.ts suites <name>...    npm run test:live:<name> for each, one after another, each under a deadline
//   node test/live/ci.ts sweep               remove the run directories and token users this run's ledgers still list
//   node test/live/ci.ts summary             each suite's result and the measured numbers, as Markdown
//
// Environment: ARCHIL_API_KEY, ARCHIL_SCRATCH_DISK and ARCHIL_SCRATCH_REGION (the repository secrets of the same names;
// the region defaults to aws-us-east-1), and PDA_STATE_DIR, where the suites write their ledgers and results. Without
// the key the suites skip every test, so the job would pass having checked nothing: preflight is what stops that.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_REGION = "aws-us-east-1";
/** The suites `suites` accepts: the package's `test:live:<name>` scripts. */
export const SUITES = ["claim", "env", "run", "store", "supervise", "lifecycle", "docker"] as const;
const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));
const SUITES_LOG = "suites.jsonl";

type Env = Record<string, string | undefined>;

/** What is missing or malformed for a live run; empty when it may start. Values are never repeated in the messages. */
export function preflight(env: Env): string[] {
  const problems: string[] = [];
  if (!env.ARCHIL_API_KEY) problems.push("the repository secret ARCHIL_API_KEY is not set");
  if (!env.ARCHIL_SCRATCH_DISK) problems.push("the repository secret ARCHIL_SCRATCH_DISK is not set");
  else if (!/^dsk-[0-9a-z]+$/i.test(env.ARCHIL_SCRATCH_DISK)) problems.push("ARCHIL_SCRATCH_DISK is not a disk id (dsk-...)");
  if (env.ARCHIL_SCRATCH_REGION !== undefined && env.ARCHIL_SCRATCH_REGION !== "" && !/^[a-z0-9-]+$/.test(env.ARCHIL_SCRATCH_REGION)) {
    problems.push("ARCHIL_SCRATCH_REGION is not a region name (such as aws-us-east-1)");
  }
  if (!env.PDA_STATE_DIR) problems.push("PDA_STATE_DIR is not set (the workflow points it at the runner's temporary directory)");
  return problems;
}

/** The environment the live suites read, from the secrets' names. */
export function liveEnv(env: Env): Env {
  const state = env.PDA_STATE_DIR!;
  return {
    ...env,
    PDA_LIVE: "1",
    PDA_LIVE_DISK: env.ARCHIL_SCRATCH_DISK,
    PDA_LIVE_REGION: env.ARCHIL_SCRATCH_REGION || DEFAULT_REGION,
    // The store suite writes its measurements only when told where.
    PDA_P2_RESULTS: join(state, "P2-live-results.json"),
  };
}

export interface SuiteResult {
  readonly suite: string;
  readonly result: "pass" | "fail" | "deadline";
  readonly seconds: number;
}

/**
 * Each suite in turn, in a process group of its own, killed with its group at `deadlineMs`; the next one runs whatever
 * the last one did. Every start and end is appended to <state>/suites.jsonl as it happens, so a step killed by its own
 * timeout still names the suite it was in.
 */
export async function runSuites(
  names: readonly string[],
  options: { readonly env: Env; readonly stateDir: string; readonly deadlineMs: number; readonly command?: (suite: string) => readonly [string, readonly string[]] },
): Promise<SuiteResult[]> {
  const command = options.command ?? ((suite: string) => ["npm", ["run", `test:live:${suite}`]] as const);
  mkdirSync(options.stateDir, { recursive: true });
  const log = (entry: object) => appendFileSync(join(options.stateDir, SUITES_LOG), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  const results: SuiteResult[] = [];
  for (const suite of names) {
    log({ suite, event: "start" });
    const started = performance.now();
    const [file, args] = command(suite);
    const child = spawn(file, args, { cwd: PACKAGE, env: options.env, stdio: "inherit", detached: true });
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // the group is gone
      }
    }, options.deadlineMs);
    const code = await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("close", (status) => resolve(status));
    });
    clearTimeout(timer);
    const result: SuiteResult = { suite, result: late ? "deadline" : code === 0 ? "pass" : "fail", seconds: Math.round((performance.now() - started) / 1000) };
    log({ event: "end", ...result });
    results.push(result);
  }
  return results;
}

const CLOSED = ["deletedAt", "removedAt", "closedAt", "markerRemovedAt"];
const DIRECTORY_LISTS = new Set(["subdirectories", "runDirectories", "subpaths", "subdirs"]);
const RUN_DIRECTORY = /^runs\/[A-Za-z0-9._-]+\/?$/;

/**
 * The run directories and token users that the suites' ledgers recorded and never stamped as removed. The ledgers differ by
 * suite (`subdirectories`, `runDirectories`, `subpaths`, `archil.subdirs`; `tokenUsers`, `archil.tokens`; removed as
 * `deletedAt`, `removedAt`, `closedAt` or `markerRemovedAt`). Only a plain `runs/<name>/` is ever swept; anything else a
 * ledger lists is reported as refused.
 */
export function openResources(ledgers: readonly unknown[]): { directories: string[]; tokens: string[]; refused: string[] } {
  const directories = new Set<string>();
  const tokens = new Set<string>();
  const refused = new Set<string>();
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
      }
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  for (const ledger of ledgers) walk(ledger, "");
  return { directories: [...directories].sort(), tokens: [...tokens].sort(), refused: [...refused].sort() };
}

/** Every ledger (<name>-STATE.json) and results file (<name>-live-results.json, <name>-PROBE.json) in `dir`. */
function stateFiles(dir: string, pattern: RegExp): { name: string; data: unknown }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => ({ name, data: JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown }));
}

/** The calls of the `disk` client the sweep makes. */
export interface SweepDisk {
  listObjects(prefix: string, options: { recursive: boolean }): Promise<{ objects: readonly { key: string }[] }>;
  deleteObjects(keys: string[], options: { quiet: boolean }): Promise<unknown>;
  removeUser(type: "token", identifier: string): Promise<unknown>;
}

/** Delete each directory (files first, then its markers deepest first, as the suites do) and remove each token user. */
export async function sweepWith(disk: SweepDisk, open: { directories: readonly string[]; tokens: readonly string[] }): Promise<{ lines: string[]; left: number }> {
  const lines: string[] = [];
  let left = 0;
  for (const prefix of open.directories) {
    const keys = (await disk.listObjects(prefix, { recursive: true })).objects.map((o) => o.key);
    const markers = [...new Set([...keys.filter((k) => k.endsWith("/")), prefix])];
    const depth = (k: string) => k.split("/").length;
    const files = keys.filter((k) => !k.endsWith("/"));
    if (files.length) await disk.deleteObjects(files, { quiet: true });
    // A directory with children refuses, so the deepest go first.
    for (const d of [...new Set(markers.map(depth))].sort((a, b) => b - a)) await disk.deleteObjects(markers.filter((k) => depth(k) === d), { quiet: true });
    const remaining = (await disk.listObjects(prefix, { recursive: true })).objects.length;
    lines.push(`swept ${prefix}: ${keys.length} objects, ${remaining} left`);
    if (remaining) left++;
  }
  for (const identifier of open.tokens) {
    const removed = await disk.removeUser("token", identifier).then(() => "removed", (error: unknown) => `not removed (${(error as Error).message})`);
    lines.push(`token user ${identifier}: ${removed}`);
    if (removed !== "removed") left++;
  }
  return { lines, left };
}

async function sweep(env: Env): Promise<number> {
  const open = openResources(stateFiles(env.PDA_STATE_DIR!, /-STATE\.json$/).map((f) => f.data));
  for (const path of open.refused) console.log(`not swept (not a run directory): ${path}`);
  if (open.directories.length === 0 && open.tokens.length === 0) {
    console.log("nothing left to sweep: every run directory and token user the suites recorded was removed");
    return 0;
  }
  const { configure, getDisk } = await import("disk");
  configure({ apiKey: env.ARCHIL_API_KEY!, region: env.ARCHIL_SCRATCH_REGION || DEFAULT_REGION });
  const { lines, left } = await sweepWith(await getDisk(env.ARCHIL_SCRATCH_DISK!), open);
  for (const line of lines) console.log(line);
  return left ? 1 : 0;
}

const SUITE_OF: Record<string, string> = { P1: "claim", P2: "store", P3: "env", P4: "run", P5: "supervise", P8: "lifecycle", docker: "docker" };
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

/** The job summary: each suite's result and time, the archil client, and every suite's timing measurements. */
export function summarize(suites: readonly SuiteResult[], results: readonly { name: string; data: unknown }[], limit = 40): string {
  const lines = ["## pi-durable-disk live", ""];
  if (suites.length === 0) lines.push("No suite ran.");
  else {
    lines.push("| Suite | Result | Time |", "|---|---|---|");
    for (const s of suites) lines.push(`| ${s.suite} | ${s.result} | ${s.seconds} s |`);
  }
  const client = results.map((r) => (r.data as { client?: unknown }).client).find((c) => typeof c === "string" && c.startsWith("Archil Client"));
  if (typeof client === "string") lines.push("", `${client.split(",")[0]}`);
  for (const { name, data } of results) {
    const rows = timings(data);
    if (!rows.length) continue;
    const lane = /^(P\d+|docker)/.exec(name)?.[1] ?? name;
    lines.push("", `### ${SUITE_OF[lane] ?? lane} (${name})`, "", "| Measurement | Value |", "|---|---|");
    for (const [what, value] of rows.slice(0, limit)) lines.push(`| ${what} | ${value} |`);
    if (rows.length > limit) lines.push(`| ... | ${rows.length - limit} more in ${name} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** The suites' starts and ends, as `runSuites` logged them; a start with no end is a suite the step's timeout cut. */
function loggedSuites(dir: string): SuiteResult[] {
  const file = join(dir, SUITES_LOG);
  if (!existsSync(file)) return [];
  const entries = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as SuiteResult & { event: string; at: string });
  const out: SuiteResult[] = [];
  for (const e of entries) {
    if (e.event === "end") out.push({ suite: e.suite, result: e.result, seconds: e.seconds });
    else if (!entries.some((x) => x.event === "end" && x.suite === e.suite && x.at >= e.at)) out.push({ suite: e.suite, result: "deadline", seconds: Math.round((Date.now() - Date.parse(e.at)) / 1000) });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [verb, ...rest] = process.argv.slice(2);
  const env = process.env as Env;
  if (verb === "preflight") {
    const problems = preflight(env);
    if (problems.length) {
      console.error(`not ok: the live job cannot start: ${problems.join("; ")}.`);
      console.error("Set the secrets under Settings > Secrets and variables > Actions. Without them every live suite skips, and the job would pass having checked nothing.");
      process.exit(1);
    }
    console.log(`ok: the scratch disk's secrets are set (region ${env.ARCHIL_SCRATCH_REGION || DEFAULT_REGION})`);
  } else if (verb === "suites") {
    const unknown = rest.filter((name) => !(SUITES as readonly string[]).includes(name));
    if (!rest.length || unknown.length) {
      console.error(`usage: ci.ts suites <${SUITES.join("|")}>... (unknown: ${unknown.join(", ") || "none given"})`);
      process.exit(2);
    }
    const problems = preflight(env);
    if (problems.length) {
      console.error(`not ok: ${problems.join("; ")}`);
      process.exit(1);
    }
    const deadlineMs = Number(env.PDA_LIVE_SUITE_DEADLINE_MS ?? 25 * 60_000);
    const results = await runSuites(rest, { env: liveEnv(env), stateDir: env.PDA_STATE_DIR!, deadlineMs });
    for (const r of results) console.log(`${r.suite}: ${r.result} (${r.seconds} s)`);
    process.exit(results.every((r) => r.result === "pass") ? 0 : 1);
  } else if (verb === "sweep") {
    if (!env.PDA_STATE_DIR || !existsSync(env.PDA_STATE_DIR)) {
      console.log("nothing to sweep: no suite ran");
      process.exit(0);
    }
    process.exit(await sweep(env));
  } else if (verb === "summary") {
    const dir = env.PDA_STATE_DIR ?? "";
    process.stdout.write(summarize(loggedSuites(dir), stateFiles(dir, /(-live-results|-PROBE)\.json$/)));
  } else {
    console.error("usage: ci.ts preflight | suites <name>... | sweep | summary");
    process.exit(2);
  }
}
