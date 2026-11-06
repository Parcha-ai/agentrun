// Claude Code, installed on first use. AgentRun never ships the Claude Agent SDK (its licence: the SDK and its CLI are the
// person's to fetch from npm, not ours to redistribute). The first claude-agent run here, or the first agent made on
// claude-agent, installs the version @parcha/agentrun-harness-claude pins (CLAUDE_AGENT_SDK_VERSION) from npm into
// `<data>/harnesses`, with the npm that runs this server, and every claude-agent run loads the SDK, its CLI and the MCP
// library it serves its tools with from there and nowhere else: each is checked to resolve inside that tree, never from
// a node_modules above it, a copy beside the server or a global one. Written for AgentRun; the shape follows OpenMA's ACP
// harness releases (pinned, installed into a cache of the host's own the first time a session needs it, no fallback to
// another version, the installer handed no provider key).
//
// The install is pinned by the lock AgentRun ships (harnesses/claude-agent/: a package.json that names the SDK at the pin
// alone, and npm's lock for it, every package of the tree by sha512, its CLI's platform packages and its peers'
// dependencies included), which `npm ci` holds every tarball to, from whichever registry the person's npm config names: a
// mirror can serve those bytes or fail, never others. No package's install script runs, by the server or by the command
// it names for a person to run by hand. The lock is metadata; the SDK itself still comes from npm, never from us.
//
// One install at a time: the server holds its data root alone (server-lock.ts), and an install in flight is the one every
// run and save that needs it waits for; a server that stops stops its npm (SIGTERM). An install lands whole or not at
// all: npm writes into a fresh directory beside `<data>/harnesses`, the result is checked there (lacking), and only then
// is it renamed into place and made read-only. A crash or a kill part way leaves that directory, never a half
// `<data>/harnesses`, and the next install removes it; a tree that is not whole (an install by hand cut short) is never
// loaded, and the next install replaces it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withoutSecrets } from "./secrets.js";

/** The SDK's package. */
export const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";
/** The MCP library the SDK serves a session's tools with: its peer, installed beside it. */
const MCP_PARTS = ["@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk/types.js"] as const;
/** The data's directory a first use installs harness packages into. */
export const HARNESSES_DIR = "harnesses";
/** What a run shows while Claude Code installs (a `phase` row of its timeline). */
export const INSTALLING_CLAUDE = "Installing Claude Code (first use)…";
/** The most an install may take: the SDK and its CLI are about 120 MB from npm. Past it npm is stopped, and the runs waiting
 *  on it fail with the command that installs it by hand. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The lock AgentRun ships for the install: npm's own (lockfileVersion 3), beside the package.json it locks, which names the
 *  SDK at the pin alone. `node scripts/claude-lock.mjs` makes both again when the pin moves. */
export const CLAUDE_LOCK = fileURLToPath(new URL("../harnesses/claude-agent/package-lock.json", import.meta.url));

/** The data's harnesses directory. */
export const harnessesOf = (data: string): string => join(data, HARNESSES_DIR);

const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/** The command that installs Claude Code by hand into `dir`, as a first use does: the lock and the package.json it locks
 *  copied in, then `npm ci` with no package's install script. */
export const installLine = (dir: string, lock: string = CLAUDE_LOCK): string =>
  `mkdir -p ${shellWord(dir)} && cp ${shellWord(join(dirname(lock), "package.json"))} ${shellWord(lock)} ${shellWord(dir)}/ && npm ci --prefix ${shellWord(dir)} --ignore-scripts`;

/** Where `specifier` (a package, or a file of one) resolves from `dir`'s node_modules, only when it is that package's own
 *  file there: undefined when the package is not in `dir`, or its file resolves outside it (a node_modules above `dir`,
 *  NODE_PATH, a global one). A package linked into `dir` counts by where its link points. */
function inTree(dir: string, specifier: string): string | undefined {
  const parts = specifier.split("/");
  const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  const home = join(dir, "node_modules", name);
  if (!existsSync(join(home, "package.json"))) return undefined;
  try {
    const found = createRequire(join(dir, "package.json")).resolve(specifier);
    return realpathSync(found).startsWith(realpathSync(home) + sep) ? found : undefined;
  } catch {
    return undefined;
  }
}

/** The SDK as installed in `dir`, checked: its package.json names it at `version`, and its entry resolves inside it.
 *  Undefined when either is not so. Whether the install is whole is `lacking`'s to say. */
export function installedSdk(dir: string, version: string): { entry: string } | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "node_modules", ...CLAUDE_SDK.split("/"), "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (manifest.name !== CLAUDE_SDK || manifest.version !== version) return undefined;
    const entry = inTree(dir, CLAUDE_SDK);
    return entry ? { entry } : undefined;
  } catch {
    return undefined;
  }
}

/** The CLI an install in `dir` holds for `platform` (its platform package's). */
const cliIn = (dir: string, platform: string): string => join(dir, "node_modules", "@anthropic-ai", `claude-agent-sdk-${platform}`, process.platform === "win32" ? "claude.exe" : "claude");

/** What an install in `dir` lacks of a whole one, or undefined: the SDK at `version` and its entry, this platform's CLI,
 *  and the MCP library (its server and its types), each its own package's file inside `dir` (inTree). */
export function lacking(dir: string, version: string, platform: string): string | undefined {
  if (!installedSdk(dir, version)) return `${CLAUDE_SDK}@${version}`;
  const cli = cliIn(dir, platform);
  try {
    if (!realpathSync(cli).startsWith(realpathSync(dirname(cli)) + sep)) return `its CLI for ${platform}`;
  } catch {
    return `its CLI for ${platform}`;
  }
  return MCP_PARTS.find((part) => !inTree(dir, part));
}

/** What claude-agent's adapter takes from an install (its `sdk`, `sdkVersion`, `cliPath` and `mcp`). */
export type LoadedSdk = { sdk: unknown; sdkVersion: string; cliPath: string; mcp: { server: unknown; types: unknown } };

/** The SDK in `dir`, its CLI for `platform` (`linux-x64`, say: the SDK's platform package) and the MCP library, each loaded
 *  from inside `dir`. Throws a ClaudeNotInstalled when the install there is not whole (lacking). */
export async function loadSdk(dir: string, version: string, platform: string): Promise<LoadedSdk> {
  const missing = lacking(dir, version, platform);
  if (missing) throw new ClaudeNotInstalled(dir, version, existsSync(dir) ? `Claude Code in ${dir} is not whole: it lacks ${missing}` : undefined);
  const load = (specifier: string) => import(pathToFileURL(inTree(dir, specifier)!).href) as Promise<unknown>;
  const [sdk, server, types] = await Promise.all([load(CLAUDE_SDK), load(MCP_PARTS[0]), load(MCP_PARTS[1])]);
  return { sdk, sdkVersion: version, cliPath: cliIn(dir, platform), mcp: { server, types } };
}

/** Claude Code is not installed in `dir`: its message names the command that installs it by hand (installLine). */
export class ClaudeNotInstalled extends Error {
  readonly code = "CLAUDE_AGENT_NOT_INSTALLED";
  constructor(readonly dir: string, readonly version: string, why?: string, lock: string = CLAUDE_LOCK) {
    super(`${why ?? `Claude Code (${CLAUDE_SDK}@${version}) is not installed in ${dir}`}. Install it by hand with: ${installLine(dir, lock)}; then run the agent again.`);
  }
}

/** The npm a first use runs, as node and npm's own script (no shell, so no argument is split or read by one): the one that
 *  started this server (npm_execpath, under npx), else the one installed with this node, else `npm` on PATH. */
function npmCommand(env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const exec = env.npm_execpath;
  if (exec && /\.c?js$/.test(exec) && existsSync(exec)) return { command: process.execPath, args: [exec] };
  for (const beside of [join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (existsSync(beside)) return { command: process.execPath, args: [beside] };
  }
  return { command: "npm", args: [] };
}

/** What an install needs to know: the SDK version pinned, and this platform's suffix for its CLI's package. */
export type ClaudePins = { version: string; platform: string };

/** Installs the SDK at `pins.version` into `dir` by `lock` (default the one AgentRun ships) and the package.json beside it:
 *  `npm ci` in a fresh directory beside `dir`, with no key of this server's in its environment and no package's install
 *  script; checked whole there (lacking), then renamed into place and made read-only. Resolves once it is in; rejects
 *  with ClaudeNotInstalled naming why, and leaves `dir` as it was. `signal`: aborted, npm is stopped (SIGTERM). */
export async function npmInstall(dir: string, pins: ClaudePins, { lock = CLAUDE_LOCK, env = process.env, timeoutMs = INSTALL_TIMEOUT_MS, signal }: { lock?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  const { version, platform } = pins;
  const fail = (why: string) => new ClaudeNotInstalled(dir, version, `Couldn't install Claude Code (${CLAUDE_SDK}@${version}) from npm: ${why}`, lock);
  const manifest = join(dirname(lock), "package.json");
  const root = (JSON.parse(await readFile(lock, "utf8")) as { packages?: Record<string, { dependencies?: Record<string, string> }> }).packages?.[""];
  const named = (JSON.parse(await readFile(manifest, "utf8")) as { dependencies?: Record<string, string> }).dependencies;
  const alone = (deps: Record<string, string> | undefined) => deps?.[CLAUDE_SDK] === version && Object.keys(deps).length === 1;
  if (!alone(root?.dependencies) || !alone(named)) throw fail(`its lock (${lock}) is not for ${CLAUDE_SDK}@${version} alone`);
  const parent = dirname(dir);
  const prefix = `.${basename(dir)}-`;
  await mkdir(parent, { recursive: true });
  // What an earlier install left part way: never read, removed now.
  for (const name of await readdir(parent)) if (name.startsWith(prefix)) await writable(join(parent, name), true).then(() => rm(join(parent, name), { recursive: true, force: true }));
  const staging = await mkdtemp(join(parent, prefix));
  try {
    await copyFile(manifest, join(staging, "package.json"));
    await copyFile(lock, join(staging, "package-lock.json"));
    await runNpm(["ci", "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], env, timeoutMs, signal).catch((why: Error) => Promise.reject(fail(why.message)));
    const missing = lacking(staging, version, platform);
    if (missing) throw fail(`npm ended, and the install lacks ${missing}`);
    // Into place whole: what was there (an install cut short, one by hand) goes aside first, then away.
    const old = existsSync(dir) ? `${staging}-old` : undefined;
    if (old) await rename(dir, old);
    await rename(staging, dir);
    // Read-only once in place: a write into it by mistake fails. (The server's own uid could change that back; the CLI's
    // sha256 is checked at every run.)
    await writable(dir, false);
    if (old) await writable(old, true).then(() => rm(old, { recursive: true, force: true }));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error instanceof ClaudeNotInstalled ? error : fail((error as Error).message);
  }
}

/** Every file and directory under `dir` (no link followed) made writable by its owner, or read-only for everyone. */
async function writable(dir: string, on: boolean): Promise<void> {
  const walk = async (path: string): Promise<void> => {
    const st = await lstat(path).catch(() => undefined);
    if (!st || st.isSymbolicLink()) return;
    if (on) await chmod(path, st.mode | 0o200);
    if (st.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
    if (!on) await chmod(path, st.mode & ~0o222);
  };
  await walk(dir);
}

/** Runs npm with `args`, with no key of this server's in its environment and no shell; rejects with npm's last words.
 *  `signal`, aborted: npm is sent SIGTERM (it rolls back what it was writing) and this rejects once it is gone. */
function runNpm(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const npm = npmCommand(env);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("the server stopped before npm started"));
    let said = "";
    const child = spawn(npm.command, [...npm.args, ...args], { env: withoutSecrets(env), stdio: ["ignore", "pipe", "pipe"] });
    const hear = (chunk: Buffer) => void (said = (said + chunk.toString("utf8")).slice(-4_000));
    child.stdout.on("data", hear);
    child.stderr.on("data", hear);
    let stopped: string | undefined;
    const stop = (why: string) => {
      stopped ??= why;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => stop(`npm took more than ${Math.round(timeoutMs / 60_000)} minutes and was stopped`), timeoutMs);
    timer.unref();
    const onAbort = () => stop("the server stopped, and npm with it");
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => (clearTimeout(timer), signal?.removeEventListener("abort", onAbort));
    child.once("error", (error) => (done(), reject(new Error(`npm did not start (${error.message})`))));
    child.once("close", (code, by) => {
      done();
      const last = said.trim().split("\n").filter((line) => line.trim()).slice(-3).join(" ").replace(/\s+/g, " ").slice(0, 600);
      if (stopped) return reject(new Error(stopped));
      if (by) return reject(new Error(`npm was stopped (${by})`));
      if (code !== 0) return reject(new Error(last ? `npm exited ${code}: ${last}` : `npm exited ${code}`));
      resolve();
    });
  });
}

/** The server's one installer of Claude Code into `dir`: `ensure()` resolves once it is installed whole, installing it
 *  first when it is not, and every caller while an install runs waits for that one. A failed install is not kept: the
 *  next call tries again. `stop()` stops an install that runs (its npm, SIGTERM) and waits for it to end. `onInstalled`
 *  hears of an install this server made, and how long it took. */
export class ClaudeInstall {
  private running?: Promise<void>;
  private done = false;
  private readonly stopping = new AbortController();

  /** Whether this server knows Claude Code is installed whole (read once, then kept). */
  get installed(): boolean {
    return this.done;
  }
  constructor(readonly dir: string, private readonly pins: () => Promise<ClaudePins>, private readonly install: (dir: string, pins: ClaudePins, signal: AbortSignal) => Promise<void> = (dir, pins, signal) => npmInstall(dir, pins, { signal }), private readonly onInstalled?: (ms: number) => void) {}

  /** Whether a run must wait for an install: false once Claude Code is installed whole (read once, then kept). */
  async needed(): Promise<boolean> {
    if (this.done) return false;
    if (this.running) return true;
    const { version, platform } = await this.pins();
    this.done = lacking(this.dir, version, platform) === undefined;
    return !this.done;
  }

  ensure(): Promise<void> {
    if (this.done) return Promise.resolve();
    if (this.stopping.signal.aborted) return Promise.reject(new Error("the server is stopping"));
    this.running ??= (async () => {
      const pins = await this.pins();
      if (lacking(this.dir, pins.version, pins.platform) === undefined) return void (this.done = true);
      const started = performance.now();
      await this.install(this.dir, pins, this.stopping.signal);
      this.done = true;
      this.onInstalled?.(Math.round(performance.now() - started));
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  /** Stops an install that runs (its npm gets SIGTERM) and waits for it to end; none starts after. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.running?.catch(() => undefined);
  }
}
