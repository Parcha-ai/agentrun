// The census-then-kill sweep. A child runs the workflow once with the crossings counted (the census); then, for every
// crossing of every point, a fresh run is killed there and a later process resumes it. The calls the child makes go to a
// counting server in this process, outside every killed one, so what was dispatched is read from the one place a kill
// cannot reach. The sweep holds the at-most-once rule: no effect is dispatched twice, whichever crossing was cut.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CRASH_PLAN_ENV, CRASH_POINTS, type CrashPlan, type CrashPoint } from "./crash-points.js";

/** What a child reports: how it ended (an exit code, or the signal that killed it), the JSON lines it printed, and
 *  what it wrote to stderr. By convention a child that ends its run prints `{"outcome": ...}` and exits 0. */
export type ChildRun = { exit: number | string | null; rows: Array<Record<string, unknown>>; stderr: string };

const LOOPBACK = "127.0.0.1";

/** The header a child's calls carry, and the environment variable that holds its value. */
export const COUNT_TOKEN_HEADER = "x-agentrun-count-token";
export const COUNT_TOKEN_ENV = "COUNT_TOKEN";

/** The requests a counting server has seen, by path: only those that carry its token, since anything else on this
 *  machine may reach a port this server holds. */
export type CountingServer = { url: string; token: string; counts: Record<string, number>; close(): Promise<void> };

/** A server for the calls a child's effects make, counted by path. A request counts when it carries the server's token
 *  in the `x-agentrun-count-token` header. `POST /effect/<id>` answers `{ ok: true, id }`; any other path answers
 *  `{ ok: true }`. */
export async function countingServer(): Promise<CountingServer> {
  const counts: Record<string, number> = {};
  const token = randomUUID();
  const server = http.createServer((request, response) => {
    request.resume();
    if (request.headers[COUNT_TOKEN_HEADER] === token) counts[request.url ?? "/"] = (counts[request.url ?? "/"] ?? 0) + 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, id: request.url?.startsWith("/effect/") ? request.url.slice("/effect/".length) : undefined }));
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const address = server.address() as { port: number };
  return { url: `http://${LOOPBACK}:${address.port}`, token, counts, close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

export type SweepCase = {
  point: CrashPoint; nth: number;
  /** The process that was killed. */
  killed: ChildRun;
  /** The process that resumed the run, then one more that opened it after it ended. */
  resumed: ChildRun; reopened: ChildRun;
  /** The counting server's counts after each process: killed, resumed, reopened. */
  counts: Array<Record<string, number>>;
  violations: string[];
};

export type SweepOptions = {
  /** The child script. It is run as `node` with the preload module loaded, then `<child> <start|resume> <directory>` in a run directory
   *  that holds the run, with `COUNT_URL` set to the counting server, `COUNT_TOKEN` to the token its calls carry, and the crash plan in `AGENTRUN_CRASH_PLAN`.
   *  `start` begins the run and `resume` opens one a process left, and both print their outcome. */
  child: string;
  /** Extra environment for every child (a planted fault, a fixture's knobs). */
  env?: Record<string, string>;
  /** Points to sweep; default every point the census crossed. */
  points?: readonly CrashPoint[];
  /** 1 resumes in the run's own directory; 2 resumes in a copy of it, as a second machine would that was handed the
   *  run's files. */
  machines?: 1 | 2;
  /** What the sweep checks beyond the at-most-once rule: the reasons this case is wrong, if it is. `census` is the
   *  uncut run. */
  expect?(found: SweepCase, census: ChildRun): string[];
  /** A directory for the run directories; default the system's temporary directory. */
  directory?: string;
};

export type SweepResult = { census: ChildRun; crossings: Record<string, number>; cases: SweepCase[]; violations: string[] };

const PRELOAD = fileURLToPath(new URL("./preload.js", import.meta.url));

function runChild(options: SweepOptions, server: CountingServer, mode: "start" | "resume", directory: string, plan: CrashPlan | undefined): Promise<ChildRun> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, COUNT_URL: server.url, [COUNT_TOKEN_ENV]: server.token };
    delete env.NODE_TEST_CONTEXT;
    delete env[CRASH_PLAN_ENV];
    if (plan) env[CRASH_PLAN_ENV] = JSON.stringify(plan);
    const child = spawn(process.execPath, [`--import=${PRELOAD}`, options.child, mode, directory], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code, signal) => resolve({
      exit: signal ?? code,
      rows: out.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } }),
      stderr: err.trim(),
    }));
  });
}

const outcomeOf = (run: ChildRun) => run.rows.find((row) => row.outcome !== undefined)?.outcome;

/** The effects dispatched more than once, as the reasons the rule failed. */
const doubled = (counts: Record<string, number>) => Object.entries(counts).filter(([path, count]) => path.startsWith("/effect/") && count > 1).map(([path, count]) => `${path} was dispatched ${count} times`);

/** Run the sweep. The census runs the workflow once with nothing killed; every crossing it counted is then cut in a
 *  fresh run, resumed by a later process, and opened once more after the run ended, which changes nothing. */
export async function crashSweep(options: SweepOptions): Promise<SweepResult> {
  const server = await countingServer();
  const base = mkdtempSync(join(options.directory ?? tmpdir(), "agentrun-crash-"));
  const fresh = (name: string) => { const directory = join(base, name); mkdirSync(directory); return directory; };
  try {
    const clear = () => { for (const key of Object.keys(server.counts)) delete server.counts[key]; };
    const census = await (async () => {
      const directory = fresh("census"); const file = join(base, "census.log"); writeFileSync(file, "");
      return runChild(options, server, "start", directory, { mode: "census", file });
    })();
    const crossings: Record<string, number> = {};
    for (const point of readFileSync(join(base, "census.log"), "utf8").split("\n").filter(Boolean)) crossings[point] = (crossings[point] ?? 0) + 1;
    const violations: string[] = [];
    if (census.exit !== 0 || outcomeOf(census) === undefined) violations.push(`the census run did not end its run: exit ${census.exit}${census.stderr ? `, ${census.stderr.slice(0, 200)}` : ""}`);
    violations.push(...doubled(server.counts).map((reason) => `census: ${reason}`));
    const cases: SweepCase[] = [];
    for (const point of options.points ?? CRASH_POINTS.filter((candidate) => crossings[candidate])) {
      for (let nth = 1; nth <= (crossings[point] ?? 0); nth += 1) {
        clear();
        const name = `${point}-${nth}`;
        const one = fresh(`${name}-a`);
        const killed = await runChild(options, server, "start", one, { mode: "kill", point, nth });
        const afterKilled = { ...server.counts };
        let there = one;
        if (options.machines === 2) { there = join(base, `${name}-b`); cpSync(one, there, { recursive: true }); }
        const resumed = await runChild(options, server, "resume", there, undefined);
        const afterResumed = { ...server.counts };
        const reopened = await runChild(options, server, "resume", there, undefined);
        const found: SweepCase = { point, nth, killed, resumed, reopened, counts: [afterKilled, afterResumed, { ...server.counts }], violations: [] };
        if (killed.exit !== "SIGKILL") found.violations.push(`the kill at ${name} did not land: exit ${killed.exit}`);
        if (resumed.exit !== 0 || outcomeOf(resumed) === undefined) found.violations.push(`the resume after ${name} did not end the run: exit ${resumed.exit}${resumed.stderr ? `, ${resumed.stderr.slice(0, 200)}` : ""}`);
        found.violations.push(...doubled(server.counts));
        if (JSON.stringify(outcomeOf(reopened)) !== JSON.stringify(outcomeOf(resumed))) found.violations.push(`a later open after ${name} changed the run's outcome`);
        const made = Object.keys(server.counts).filter((path) => server.counts[path] !== (afterResumed[path] ?? 0));
        if (made.length) found.violations.push(`a later open after ${name} made calls: ${made.join(", ")}`);
        found.violations.push(...(options.expect?.(found, census) ?? []));
        cases.push(found);
        violations.push(...found.violations.map((reason) => `${name}: ${reason}`));
      }
    }
    return { census, crossings, cases, violations };
  } finally {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
}
