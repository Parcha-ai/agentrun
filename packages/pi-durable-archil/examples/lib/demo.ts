// Shared by the example demos: the options every demo takes, a check that this host can run them, the supervisor as a
// child process (the same `pi-durable-archil supervise` you would run yourself), host faults, and cleanup.
//
// "Host A" and "host B" are two mount roots on this machine. Each has its own FUSE client, so to Archil they are two
// machines: a kill takes host A's instance and its FUSE daemon together, which is what losing a VM does to a mount.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmdirSync, statSync, accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ARCHIL_SCOPED, localHost, runPath, unmountClaim } from "@parcha/pi-durable-archil";
import type { HostHandle } from "@parcha/pi-durable-archil";

export interface DemoOptions {
  disk: string;
  region: string;
  /** The environment variable holding the Archil API key. Only the supervisor processes see it. */
  apiKeyEnv: string;
  /** host A and host B: two mount roots, each with its own FUSE client. */
  mountRoots: { a: string; b: string };
  /** The archil wrapper the instances mount through. */
  archil: string;
  id: string;
  keep: boolean;
  scenario: string;
  /** Run as root and start the instances as this unprivileged user (the production setup). Default: the invoking user. */
  user: string | null;
}

/** The lease the demos use: short, so a frozen host is replaced in seconds. Production defaults are 20 s, 90 s and 15 s. */
export const DEMO_LEASE = { heartbeatMs: 2_000, expiryMs: 10_000, marginMs: 3_000 };

/** Where the Quickstart installs the root-owned wrapper. */
export const INSTALLED_WRAPPER = "/usr/local/lib/pi-durable-archil/archil-scoped";

export const USAGE = `options:
  --disk D            the Archil disk id or name (or $ARCHIL_DISK)
  --region R          the disk's region, e.g. aws-us-east-1 (or $ARCHIL_REGION)
  --api-key-env NAME  the variable holding the Archil API key (default ARCHIL_API_KEY)
  --mount-root-a DIR  host A's mount root (default /mnt/archil-a)
  --mount-root-b DIR  host B's mount root (default /mnt/archil-b)
  --archil PATH       the archil wrapper (default $ARCHIL_WRAPPER, else ${INSTALLED_WRAPPER} if it exists, else the package's own bin/archil-scoped)
  --id RUN            the run id (default <example>-<random>)
  --user NAME         run as root and start instances as this unprivileged user, as a production host does
  --keep              keep the run's directory on the disk (default: delete it at the end)`;

export function parseOptions(example: string, scenarios: string[], argv: string[]): DemoOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      disk: { type: "string" },
      region: { type: "string" },
      "api-key-env": { type: "string" },
      "mount-root-a": { type: "string" },
      "mount-root-b": { type: "string" },
      archil: { type: "string" },
      id: { type: "string" },
      user: { type: "string" },
      keep: { type: "boolean" },
    },
  });
  const scenario = positionals[0] ?? scenarios[0];
  if (!scenarios.includes(scenario) || positionals.length > 1) usage(`usage: node demo.ts [${scenarios.join("|")}] [options]\n${USAGE}`);
  const disk = values.disk ?? process.env.ARCHIL_DISK;
  const region = values.region ?? process.env.ARCHIL_REGION;
  if (!disk || !region) usage(`--disk and --region (or $ARCHIL_DISK and $ARCHIL_REGION) are required\n${USAGE}`);
  return {
    disk,
    region,
    apiKeyEnv: values["api-key-env"] ?? "ARCHIL_API_KEY",
    mountRoots: { a: values["mount-root-a"] ?? "/mnt/archil-a", b: values["mount-root-b"] ?? "/mnt/archil-b" },
    archil: values.archil ?? process.env.ARCHIL_WRAPPER ?? (existsSync(INSTALLED_WRAPPER) ? INSTALLED_WRAPPER : ARCHIL_SCOPED),
    id: values.id ?? `${example}-${Math.random().toString(36).slice(2, 8)}`,
    keep: Boolean(values.keep),
    scenario,
    user: values.user ?? null,
  };
}

/** A command line the demo cannot start with: nothing ran yet, so there is nothing to clean up. */
function usage(message: string): never {
  console.error(message);
  process.exit(2);
}

/** A demo step that cannot go on. Thrown, so the demo's `finally` still cleans up what it started. */
export class DemoFailure extends Error {}

export function fail(message: string): never {
  throw new DemoFailure(message);
}

/** The demo's last word on an error: a failure prints its message, anything else its stack. */
export function report(error: unknown): void {
  console.error(error instanceof DemoFailure ? `\n${error.message}` : error);
  process.exitCode = 1;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
export const say = (line: string) => console.log(`\n${stamp()}  ${line}`);
export const note = (tag: string, line: string) => console.log(`${stamp()}    ${tag.padEnd(8)} ${line}`);

// ---- can this host run the demos ---------------------------------------------------------------------------------------

/** What is missing on this host, each as the command that fixes it. Empty: ready. */
export function preflight(opts: DemoOptions): string[] {
  const problems: string[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) problems.push(`Node ${process.versions.node} is too old: the package needs 22.19 or later`);
  if (!process.env[opts.apiKeyEnv]) problems.push(`$${opts.apiKeyEnv} is empty: export the Archil API key there (the supervisor reads it; no instance does)`);
  if (!existsSync("/dev/fuse")) problems.push("/dev/fuse is missing: this host cannot mount FUSE (install fuse and libfuse2, or use a VM, not a container without the device)");
  if (!existsSync("/usr/bin/archil")) problems.push("/usr/bin/archil is missing: install the archil client (curl -s https://archil.com/install | sh)");
  if (!existsSync("/usr/bin/setpriv")) problems.push("/usr/bin/setpriv is missing: install util-linux");
  if (!existsSync("/usr/bin/fusermount")) problems.push("/usr/bin/fusermount is missing: install fuse3 (it cleans a dead mount)");
  if (spawnSync("sudo", ["-n", "true"]).status !== 0) problems.push("passwordless sudo is not available: the archil client needs root, and the instance reaches it through `sudo -n`");
  const isRoot = process.getuid?.() === 0;
  if (isRoot && !opts.user) problems.push("running as root: pass --user NAME, the unprivileged user the instances run as (they never run as root)");
  if (!isRoot && opts.user) problems.push("--user needs root: the supervisor starts units for another user");
  if (isRoot && opts.user) {
    const uid = spawnSync("id", ["-u", opts.user], { encoding: "utf8" });
    if (uid.status !== 0) problems.push(`no such user: ${opts.user}`);
    else {
      for (const [name, root] of Object.entries(opts.mountRoots)) {
        try {
          if (statSync(join(root, "runs")).uid !== Number(uid.stdout)) problems.push(`host ${name.toUpperCase()}: ${join(root, "runs")} must be owned by ${opts.user}: chown ${opts.user} ${join(root, "runs")}`);
        } catch {
          // reported below as missing
        }
      }
      const reach = (what: string, argv: string[]) => {
        if (spawnSync("runuser", ["-u", opts.user!, "--", ...argv]).status !== 0) problems.push(`${opts.user} cannot ${what}: install Node system-wide and keep the package where ${opts.user} can read it`);
      };
      reach(`run ${process.execPath}`, [process.execPath, "--version"]);
      reach(`read the package at ${CLI}`, ["test", "-r", CLI]);
    }
  }
  if (spawnSync("systemctl", ["is-system-running"], { encoding: "utf8" }).stdout.trim() === "") problems.push("systemd is not running: the local host driver starts instances as systemd units");
  for (const [name, root] of Object.entries(opts.mountRoots)) {
    const runs = join(root, "runs");
    try {
      accessSync(runs, constants.W_OK);
    } catch {
      problems.push(`host ${name.toUpperCase()}: ${runs} must exist and be writable by ${opts.user ?? "you"}: sudo mkdir -p ${runs} && sudo chown ${opts.user ?? '"$USER"'} ${runs}`);
    }
  }
  try {
    statSync(opts.archil);
  } catch {
    problems.push(`${opts.archil} does not exist`);
  }
  return problems;
}

/** With `--user`, the demo (root) hands its scratch directory to that user, who writes the app's log into it. */
export function shareWith(opts: DemoOptions, dir: string): void {
  if (opts.user) spawnSync("chown", [opts.user, dir]);
}

/** An `open` event from an instance: with `--user` it must not be running as root (the demo then exits 1). */
export function instanceUid(opts: DemoOptions, event: Record<string, unknown>): string {
  const uid = Number(event.uid);
  if (opts.user && uid === 0) {
    process.exitCode = 1;
    return "uid 0, ROOT: an instance must run as an unprivileged user";
  }
  return `uid ${uid}`;
}

// ---- the supervisor, as a process ------------------------------------------------------------------------------------

/** `dist/cli.js` next to the package's entry point: the same CLI an installed package puts on the PATH. */
export const CLI = join(dirname(fileURLToPath(import.meta.resolve("@parcha/pi-durable-archil"))), "cli.js");

export type Line = Record<string, unknown> & { action?: string; handle?: HostHandle };

export interface HostSpec {
  name: "host-a" | "host-b";
  mountRoot: string;
  /** The app's environment and run flags (an `--app` module and the lease). */
  env: Record<string, string>;
  /** Host A has no restarter in the demos: after a kill nothing starts it again, as with a VM that is gone. */
  restart: boolean;
}

export function superviseArgs(opts: DemoOptions, host: HostSpec, extra: string[] = []): string[] {
  const flags = [
    "supervise",
    "--disk", opts.disk,
    "--region", opts.region,
    "--api-key-env", opts.apiKeyEnv,
    "--id", opts.id,
    "--mount-root", host.mountRoot,
    "--host-name", host.name,
    "--unit-prefix", `pda-demo-${host.name === "host-a" ? "a" : "b"}-`,
    "--archil", opts.archil,
    ...(opts.user ? ["--user", opts.user] : []),
    "--lease-expiry", `${DEMO_LEASE.expiryMs}ms`,
    ...(host.restart ? [] : ["--no-restart"]),
    `--run-arg=--heartbeat-ms=${DEMO_LEASE.heartbeatMs}`,
    `--run-arg=--lease-expiry-ms=${DEMO_LEASE.expiryMs}`,
    `--run-arg=--lease-margin-ms=${DEMO_LEASE.marginMs}`,
    ...Object.entries(host.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    ...extra,
  ];
  return flags;
}

/** The command a reader could type, with the key shown as a reference. */
export function printable(opts: DemoOptions, args: string[]): string {
  const quote = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a}'`);
  // One line per flag: a flag and its value (the next argument, unless that is a flag too) stay together.
  const lines: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && !a.includes("=") && i + 1 < args.length && !args[i + 1].startsWith("--")) lines.push(`${a} ${quote(args[++i])}`);
    else lines.push(quote(a));
  }
  return `$ ${opts.apiKeyEnv}=… node ${CLI.replace(`${process.cwd()}/`, "")} ${lines.join(" \\\n      ")}`;
}

const supervisorEnv = (opts: DemoOptions) => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_NO_WARNINGS: "1", [opts.apiKeyEnv]: process.env[opts.apiKeyEnv]! });

export function parseLines(text: string): Line[] {
  return text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Line);
}

/** One supervise pass; resolves with the lines it printed. */
export function superviseOnce(opts: DemoOptions, host: HostSpec, extra: string[] = []): { code: number | null; lines: Line[]; stderr: string } {
  const args = superviseArgs(opts, host, extra);
  console.log(printable(opts, args));
  const r = spawnSync(process.execPath, [CLI, ...args], { env: supervisorEnv(opts), encoding: "utf8", timeout: 180_000 });
  const lines = parseLines(r.stdout);
  for (const l of lines) note("supervise", describe(l));
  return { code: r.status, lines, stderr: r.stderr };
}

/** `supervise --every`: a loop in its own process, as a service would run it. */
export function superviseLoop(opts: DemoOptions, host: HostSpec, every: string, extra: string[] = []) {
  const args = superviseArgs(opts, host, ["--every", every, ...extra]);
  console.log(printable(opts, args));
  const child: ChildProcess = spawn(process.execPath, [CLI, ...args], { env: supervisorEnv(opts), stdio: ["ignore", "pipe", "pipe"] });
  const lines: Line[] = [];
  let buf = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const text = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!text.startsWith("{")) continue;
      const line = JSON.parse(text) as Line;
      if (line.action !== "healthy" && line.action !== "pending") note("supervise", describe(line));
      lines.push(line);
    }
  });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => process.stderr.write(chunk));
  return {
    lines,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once("exit", resolve)));
    },
  };
}

function describe(l: Line): string {
  const { at: _at, ms: _ms, ...rest } = l as Record<string, unknown>;
  const handle = l.handle as HostHandle | undefined;
  if (l.action === "started") return `started ${handle?.unit} on ${handle?.host} (${String(l.reason)}${(l.revoked as unknown[] | undefined)?.length ? `, revoked ${(l.revoked as unknown[]).length} delegation` : ""})`;
  if (l.action === "terminal") return `run is ${String(l.status)}`;
  return JSON.stringify(rest).slice(0, 200);
}

export function startedUnit(lines: Line[]): HostHandle {
  const started = lines.find((l) => l.action === "started");
  if (!started?.handle) fail(`the supervisor did not start an instance: ${JSON.stringify(lines)}`);
  return started.handle;
}

// ---- the app's log -----------------------------------------------------------------------------------------------------

/** Follow a JSON-lines file the app appends to (`$EXAMPLE_LOG`). */
export function followLog(file: string, onEvent: (event: Record<string, unknown>) => void) {
  let offset = 0;
  let partial = "";
  const events: Record<string, unknown>[] = [];
  const timer = setInterval(() => {
    if (!existsSync(file)) return;
    const text = readFileSync(file, "utf8");
    if (text.length <= offset) return;
    partial += text.slice(offset);
    offset = text.length;
    for (let i = partial.indexOf("\n"); i >= 0; i = partial.indexOf("\n")) {
      const line = partial.slice(0, i);
      partial = partial.slice(i + 1);
      if (!line.startsWith("{")) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      onEvent(event);
    }
  }, 100);
  return { events, stop: () => clearInterval(timer) };
}

export async function waitFor<T>(what: string, fn: () => T | undefined | false | null, timeoutMs: number): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) fail(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(100);
  }
}

// ---- host faults -------------------------------------------------------------------------------------------------------

const sudo = (...argv: string[]) => spawnSync("sudo", ["-n", ...argv], { encoding: "utf8" });

/** The FUSE daemon's scopes for an instance's unit: the daemon lives outside the unit's cgroup, in `<unit>-fuse-<n>.scope`. */
function fuseScopes(unit: string): string[] {
  const r = spawnSync("systemctl", ["list-units", "--all", "--plain", "--no-legend", "--type=scope", `${unit}-fuse-*`], { encoding: "utf8" });
  return r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 3 && f[2] === "active").map((f) => f[0]);
}

/** Every process in a unit's control group. */
function cgroupPids(name: string): number[] {
  const cg = spawnSync("systemctl", ["show", name, "--property=ControlGroup", "--value"], { encoding: "utf8" }).stdout.trim();
  if (!cg) return [];
  try {
    return readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/**
 * `kill`: SIGKILL the instance and its FUSE daemon at once, which is what a power cut does to a mount. `freeze`: SIGSTOP
 * the FUSE daemon, a host whose mount hangs while the host looks alive. `thaw`: SIGCONT it. The signal goes to every
 * process in the control group (`systemctl kill` can refuse a unit whose main process is already gone).
 */
export function fault(kind: "kill" | "freeze" | "thaw", unit: string): void {
  const scopes = fuseScopes(unit);
  if (scopes.length === 0) fail(`no FUSE daemon found for ${unit}`);
  const signal = kind === "kill" ? "SIGKILL" : kind === "freeze" ? "SIGSTOP" : "SIGCONT";
  const targets = kind === "kill" ? [`${unit}.service`, ...scopes] : scopes;
  const pids = targets.flatMap(cgroupPids);
  note("fault", `${kind}: sudo kill -s ${signal} ${pids.join(" ")}   (the processes of ${targets.join(" and ")})`);
  const r = sudo("kill", "-s", signal, ...pids.map(String));
  if (r.status !== 0) fail(`kill failed: ${r.stderr}`);
}

/** The unit's main exit status, once it has exited. */
export function exitStatus(unit: string): { active: string; status: number | null } {
  const r = spawnSync("systemctl", ["show", `${unit}.service`, "--property=ActiveState,ExecMainStatus"], { encoding: "utf8" });
  const f = Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]));
  return { active: f.ActiveState ?? "unknown", status: f.ExecMainStatus === undefined ? null : Number(f.ExecMainStatus) };
}

// ---- cleanup -----------------------------------------------------------------------------------------------------------

/**
 * Stop whatever the demo left on each host (the unit, a dead mount, its token file); when the run finished, drop its
 * token users; unless `keep`, delete the run's directory from the disk.
 */
export async function cleanup(opts: DemoOptions, handles: HostHandle[], hosts: HostSpec[], finished: boolean): Promise<void> {
  say("cleanup");
  for (const handle of handles) {
    const host = hosts.find((h) => h.name === handle.host)!;
    const driver = localHost({ mountRoot: host.mountRoot, hostName: host.name, archil: opts.archil, unitPrefix: `pda-demo-${host.name === "host-a" ? "a" : "b"}-`, ...(opts.user ? { user: opts.user } : {}) });
    await driver.stop(handle).catch((e: unknown) => note("cleanup", `stop ${String(handle.unit)}: ${(e as Error).message}`));
    note("cleanup", `stopped ${String(handle.unit)}`);
  }
  // A killed host leaves a dead mount behind (its daemon is gone); `unmountClaim` cleans it with `fusermount -u`.
  for (const host of hosts) {
    const mountpoint = join(host.mountRoot, runPath(opts.id));
    if (readFileSync("/proc/self/mounts", "utf8").split("\n").some((l) => l.split(" ")[1] === mountpoint)) {
      const via = await unmountClaim(mountpoint).catch((e: unknown) => `failed: ${(e as Error).message}`);
      note("cleanup", `unmounted ${mountpoint} (${via})`);
    }
    // The mountpoint is an empty directory in the host's mount root; once nothing is mounted on it, it goes too.
    try {
      rmdirSync(mountpoint);
    } catch {
      // not there, or still in use
    }
  }
  if (finished) {
    // A pass over a finished run starts nothing and removes the token users of runs that hold nothing (grace 0: no start is in flight).
    const sweep = superviseOnce(opts, { name: "host-a", mountRoot: opts.mountRoots.a, env: {}, restart: false }, ["--token-grace", "0s"]);
    if (sweep.code !== 0) note("cleanup", `token sweep exited ${sweep.code}: ${sweep.stderr.trim()}`);
  } else {
    note("cleanup", "the run did not finish, so its token users stay (they expire in 24 h); remove them with `supervise --sweep-tokens` once the run is released");
  }
  if (!opts.keep) {
    const { configure, getDisk } = await import("disk");
    configure({ apiKey: process.env[opts.apiKeyEnv]!, region: opts.region });
    const disk = await getDisk(opts.disk);
    const prefix = `${runPath(opts.id)}/`;
    const keys = (await disk.listObjects(prefix, { recursive: true })).objects.map((o) => o.key);
    const dirs = [...new Set([...keys.filter((k) => k.endsWith("/")), prefix])].sort((x, y) => y.split("/").length - x.split("/").length);
    await disk.deleteObjects(keys.filter((k) => !k.endsWith("/")), { quiet: true });
    for (const d of dirs) await disk.deleteObjects([d], { quiet: true });
    note("cleanup", `deleted ${prefix} from the disk`);
  }
}
