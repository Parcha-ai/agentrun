// Claude Code, installed on first use. AgentRun never ships the Claude Agent SDK (its licence: the SDK and its CLI are the
// person's to fetch from npm, not ours to redistribute). The first claude-agent run here, or the first agent made on
// claude-agent, installs the version @parcha/agentrun-harness-claude pins (CLAUDE_AGENT_SDK_VERSION) from npm into
// `<data>/harnesses`, with the npm that runs this server, and every claude-agent run loads the SDK, its CLI and the MCP
// library it serves its tools with from there and nowhere else: never a copy beside the server or a global one. Written
// for AgentRun; the shape follows OpenMA's ACP harness releases (pinned, installed into a cache of the host's own the
// first time a session needs it, no fallback to another version, the installer handed no provider key).
//
// The install is pinned by the lock AgentRun ships (harnesses/claude-agent.lock.json: the SDK at the pin, and every package
// of its tree, its CLI's platform packages and its peers' dependencies included, each by sha512), which `npm ci` holds every
// tarball to, from whichever registry the person's npm config names: a mirror can serve those bytes or fail, never others.
// No package's install script runs. The lock is metadata; the SDK itself still comes from npm, never from us.
//
// One install at a time: the server holds its data root alone (server-lock.ts), and an install in flight is the one every
// run and save that needs it waits for. An install lands whole or not at all: npm writes into a fresh directory beside
// `<data>/harnesses`, the result is checked there (the SDK at the pin, its entry, this platform's CLI and the MCP library),
// and only then is it renamed into place. A crash or a kill part way leaves that directory, never a half
// `<data>/harnesses`, and the next install removes it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withoutSecrets } from "./secrets.js";

/** The SDK's package. */
export const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";
/** The data's directory a first use installs harness packages into. */
export const HARNESSES_DIR = "harnesses";
/** What a run shows while Claude Code installs (a `phase` row of its timeline). */
export const INSTALLING_CLAUDE = "Installing Claude Code (first use)…";
/** The most an install may take: the SDK and its CLI are about 120 MB from npm. Past it npm is stopped, and the runs waiting
 *  on it fail with the command that installs it by hand. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The lock AgentRun ships for the install: npm's own (lockfileVersion 3), for a package.json that names the SDK at the
 *  pin alone. A release that moves the pin makes it again (`npm install --package-lock-only` of that package.json). */
export const CLAUDE_LOCK = fileURLToPath(new URL("../harnesses/claude-agent.lock.json", import.meta.url));

/** The data's harnesses directory. */
export const harnessesOf = (data: string): string => join(data, HARNESSES_DIR);

const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/** The command that installs Claude Code by hand, into `dir`, as a first use does. */
export const installLine = (dir: string, version: string): string => `npm install --prefix ${shellWord(dir)} ${CLAUDE_SDK}@${version}`;

/** The SDK as installed in `dir`, checked: its package.json names it at `version`, and its entry resolves from `dir`.
 *  Undefined when either is not so. */
export function installedSdk(dir: string, version: string): { entry: string } | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "node_modules", ...CLAUDE_SDK.split("/"), "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (manifest.name !== CLAUDE_SDK || manifest.version !== version) return undefined;
    const entry = createRequire(join(dir, "package.json")).resolve(CLAUDE_SDK);
    return existsSync(entry) ? { entry } : undefined;
  } catch {
    return undefined;
  }
}

/** What claude-agent's adapter takes from an install (its `sdk`, `sdkVersion`, `cliPath` and `mcp`). */
export type LoadedSdk = { sdk: unknown; sdkVersion: string; cliPath: string; mcp: { server: unknown; types: unknown } };

/** The SDK in `dir`, its CLI for `platform` (`linux-x64`, say: the SDK's platform package) and the MCP library, each loaded
 *  from `dir`. Throws a ClaudeNotInstalled when the SDK there is not the pinned one; the CLI and the MCP library are the
 *  adapter's to check (it says what is wrong with each). */
export async function loadSdk(dir: string, version: string, platform: string): Promise<LoadedSdk> {
  const found = installedSdk(dir, version);
  if (!found) throw new ClaudeNotInstalled(dir, version);
  const from = createRequire(join(dir, "package.json"));
  const load = (specifier: string) => import(pathToFileURL(from.resolve(specifier)).href) as Promise<unknown>;
  const [sdk, server, types] = await Promise.all([import(pathToFileURL(found.entry).href) as Promise<unknown>, load("@modelcontextprotocol/sdk/server/mcp.js"), load("@modelcontextprotocol/sdk/types.js")]);
  return { sdk, sdkVersion: version, cliPath: cliIn(dir, platform), mcp: { server, types } };
}

/** The CLI an install in `dir` holds for `platform` (its platform package's). */
const cliIn = (dir: string, platform: string): string => join(dir, "node_modules", "@anthropic-ai", `claude-agent-sdk-${platform}`, process.platform === "win32" ? "claude.exe" : "claude");

/** What an install in `dir` lacks of a whole one, or undefined: the SDK at `version` and its entry, this platform's CLI,
 *  and the MCP library (its server and its types), each resolved from `dir`. */
export function lacking(dir: string, version: string, platform: string): string | undefined {
  if (!installedSdk(dir, version)) return `${CLAUDE_SDK}@${version}`;
  if (!existsSync(cliIn(dir, platform))) return `its CLI for ${platform}`;
  const from = createRequire(join(dir, "package.json"));
  for (const part of ["@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk/types.js"]) {
    try {
      from.resolve(part);
    } catch {
      return part;
    }
  }
  return undefined;
}

/** Claude Code is not installed in `dir` (no SDK at the pin there): its message names the command that installs it. */
export class ClaudeNotInstalled extends Error {
  readonly code = "CLAUDE_AGENT_NOT_INSTALLED";
  constructor(readonly dir: string, readonly version: string, why?: string) {
    super(`${why ?? `Claude Code (${CLAUDE_SDK}@${version}) is not installed in ${dir}`}. Install it by hand with: ${installLine(dir, version)}; then run the agent again.`);
  }
}

/** The npm a first use runs: the one that started this server (npm_execpath, under npx), else the one beside this node,
 *  else `npm` on PATH. */
function npmCommand(env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const exec = env.npm_execpath;
  if (exec && /\.c?js$/.test(exec) && existsSync(exec)) return { command: process.execPath, args: [exec] };
  const beside = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(beside)) return { command: process.execPath, args: [beside] };
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: [] };
}

/** What an install needs to know: the SDK version pinned, and this platform's suffix for its CLI's package. */
export type ClaudePins = { version: string; platform: string };

/** Installs the SDK at `pins.version` into `dir` by `lock` (default the one AgentRun ships): `npm ci` in a fresh directory
 *  beside `dir`, with no key of this server's in its environment and no package's install script; checked whole there
 *  (lacking), then renamed into place. Resolves once it is in; rejects with ClaudeNotInstalled naming why, and leaves
 *  `dir` as it was. */
export async function npmInstall(dir: string, pins: ClaudePins, { lock = CLAUDE_LOCK, env = process.env, timeoutMs = INSTALL_TIMEOUT_MS }: { lock?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<void> {
  const { version, platform } = pins;
  const fail = (why: string) => new ClaudeNotInstalled(dir, version, `Couldn't install Claude Code (${CLAUDE_SDK}@${version}) from npm: ${why}`);
  const text = await readFile(lock, "utf8");
  const root = (JSON.parse(text) as { name?: string; packages?: Record<string, { name?: string; dependencies?: Record<string, string> }> }).packages?.[""];
  if (root?.dependencies?.[CLAUDE_SDK] !== version || Object.keys(root.dependencies).length !== 1) throw fail(`its lock (${lock}) is not for ${CLAUDE_SDK}@${version} alone`);
  const parent = dirname(dir);
  const prefix = `.${basename(dir)}-`;
  await mkdir(parent, { recursive: true });
  // What an earlier install left part way: never read, removed now.
  for (const name of await readdir(parent)) if (name.startsWith(prefix)) await writable(join(parent, name), true).then(() => rm(join(parent, name), { recursive: true, force: true }));
  const staging = await mkdtemp(join(parent, prefix));
  try {
    await writeFile(join(staging, "package.json"), `${JSON.stringify({ name: root.name ?? "agentrun-claude-code", private: true, dependencies: root.dependencies }, null, 2)}\n`);
    await writeFile(join(staging, "package-lock.json"), text);
    await runNpm(["ci", "--prefix", staging, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], env, timeoutMs).catch((why: Error) => Promise.reject(fail(why.message)));
    const missing = lacking(staging, version, platform);
    if (missing) throw fail(`npm ended, and the install lacks ${missing}`);
    // Into place whole: what was there (an install by hand, say) goes aside first, then away.
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

/** Runs npm with `args`, with no key of this server's in its environment; rejects with npm's last words. */
function runNpm(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  const npm = npmCommand(env);
  return new Promise((resolve, reject) => {
    let said = "";
    const child = spawn(npm.command, [...npm.args, ...args], { env: withoutSecrets(env), stdio: ["ignore", "pipe", "pipe"], shell: npm.command.endsWith(".cmd") });
    const hear = (chunk: Buffer) => void (said = (said + chunk.toString("utf8")).slice(-4_000));
    child.stdout.on("data", hear);
    child.stderr.on("data", hear);
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), child.kill("SIGTERM")), timeoutMs);
    timer.unref();
    child.once("error", (error) => (clearTimeout(timer), reject(new Error(`npm did not start (${error.message})`))));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const last = said.trim().split("\n").filter((line) => line.trim()).slice(-3).join(" ").replace(/\s+/g, " ").slice(0, 600);
      if (timedOut) return reject(new Error(`npm took more than ${Math.round(timeoutMs / 60_000)} minutes and was stopped`));
      if (signal) return reject(new Error(`npm was stopped (${signal})`));
      if (code !== 0) return reject(new Error(last ? `npm exited ${code}: ${last}` : `npm exited ${code}`));
      resolve();
    });
  });
}

/** The server's one installer of Claude Code into `dir`: `ensure()` resolves once it is installed, installing it first
 *  when it is not, and every caller while an install runs waits for that one. A failed install is not kept: the next
 *  call tries again. `onInstalled` hears of an install this server made, and how long it took. */
export class ClaudeInstall {
  private running?: Promise<void>;
  private done = false;

  /** Whether this server knows Claude Code is installed (read once, then kept). */
  get installed(): boolean {
    return this.done;
  }
  constructor(readonly dir: string, private readonly pins: () => Promise<ClaudePins>, private readonly install: (dir: string, pins: ClaudePins) => Promise<void> = (dir, pins) => npmInstall(dir, pins), private readonly onInstalled?: (ms: number) => void) {}

  /** Whether a run must wait for an install: false once Claude Code is installed (read once, then kept). */
  async needed(): Promise<boolean> {
    if (this.done) return false;
    if (this.running) return true;
    this.done = Boolean(installedSdk(this.dir, (await this.pins()).version));
    return !this.done;
  }

  ensure(): Promise<void> {
    if (this.done) return Promise.resolve();
    this.running ??= (async () => {
      const pins = await this.pins();
      if (installedSdk(this.dir, pins.version)) return void (this.done = true);
      const started = performance.now();
      await this.install(this.dir, pins);
      this.done = true;
      this.onInstalled?.(Math.round(performance.now() - started));
    })().finally(() => (this.running = undefined));
    return this.running;
  }
}
