// The CLI harnesses, installed on first use: one table (HARNESS_INSTALLS), one way in. AgentRun ships neither the Claude
// Agent SDK nor Codex: the first run on its harness here, or the first agent saved on it, installs the version its adapter
// pins from npm into `<data>/harnesses/<harness>`, with the npm that runs this server, and every run of it loads its CLI
// (and, for Claude Code, its SDK and the MCP library) from there and nowhere else: each is checked to be its own
// package's file inside that tree, never one from a node_modules above it, a copy beside the server or a global one.
// Written for AgentRun; the shape follows OpenMA's ACP harness releases (pinned, installed into a cache of the host's own
// the first time a session needs it, no fallback to another version, the installer handed no provider key).
//
// Each install is pinned by the lock AgentRun ships for it (harnesses/<harness>/: a package.json that names the package
// at the pin alone, and npm's lock for it, every package of the tree by sha512, the CLI's optional platform packages
// included), which `npm ci` holds every tarball to, from whichever registry the person's npm config names: a mirror can
// serve those bytes or fail, never others. The optional platform package that holds the CLI is always included, whatever
// that config omits, and no package's install script runs, by the server or by the command it names for a person to run
// by hand. The locks are metadata; the CLIs still come from npm, never from us.
//
// One install of each harness at a time: the server holds its data root alone (server-lock.ts), and an install in flight
// is the one every run and save that needs it waits for; a server that stops stops its npm (SIGTERM). An install lands
// whole or not at all: npm writes into a fresh directory beside `<data>/harnesses/<harness>`, the result is checked there
// (the entry's `lacking`), and only then is it renamed into place and made read-only. A crash or a kill part way leaves
// that directory, never a half install, and the next install removes it; a tree that is not whole (an install by hand
// cut short) is never loaded, and the next install replaces it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withoutSecrets } from "./secrets.js";

/** The data's directory the first-use installs go into, one directory each. */
export const HARNESSES_DIR = "harnesses";
/** The most an install may take: Claude Code is about 120 MB from npm, Codex about 100. Past it npm is stopped, and the
 *  runs waiting on it fail with the command that installs it by hand. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** What an install of one harness needs to know: its package's pinned version, and this platform's suffix for the package
 *  that holds its CLI (`linux-x64`, say), with the target directory inside it where Codex keeps its binary. */
export type HarnessPins = { version: string; platform: string; target?: string };

/** One harness that installs on first use: its name for people, the package an install names (at its pin), the lock
 *  AgentRun ships for it, what an install in a directory lacks of a whole one (undefined when it is whole), and the
 *  package that holds its CLI for this platform (undefined where its adapter knows of no build for it). */
export type HarnessInstallEntry = { id: string; label: string; package: string; lock: string; lacking(dir: string, pins: HarnessPins): string | undefined; platformPackage(pins: HarnessPins): string | undefined };

/** The data's harnesses directory, and the one a harness installs into. */
export const harnessesOf = (data: string): string => join(data, HARNESSES_DIR);
export const installDirOf = (data: string, harness: string): string => join(harnessesOf(data), harness);

/** What a run shows while its harness installs (a `phase` row of its timeline). */
export const installingWords = (label: string): string => `Installing ${label} (first use)…`;

const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/** The command that installs a harness by hand into `dir`, as a first use does: the lock and the package.json it locks
 *  copied into a fresh directory beside `dir`, `npm ci` there with no package's install script and with the optional
 *  platform package that holds the CLI (whatever the person's npm config omits), and only then that directory put in
 *  place of `dir`, made writable first (an install this server made is read-only). A step that fails stops it, `dir`
 *  as it was. */
export function installLine(dir: string, lock: string): string {
  const [at, next] = [shellWord(dir), shellWord(`${dir}.new`)];
  return `rm -rf ${next} && mkdir -p ${next} && cp ${shellWord(join(dirname(lock), "package.json"))} ${shellWord(lock)} ${next}/ && npm ci --prefix ${next} --ignore-scripts --include=optional && (chmod -R u+w ${at} 2>/dev/null || true) && rm -rf ${at} && mv ${next} ${at}`;
}

/** Where `specifier` (a package, or a file of one) resolves from `dir`'s node_modules, only when it is that package's own
 *  file there: undefined when the package is not in `dir`, or its file resolves outside it (a node_modules above `dir`,
 *  NODE_PATH, a global one). A package linked into `dir` counts by where its link points. */
export function inTree(dir: string, specifier: string): string | undefined {
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

/** The file at `path` inside `dir`'s package `name`, when it is that package's own file (where a link points counts). */
function fileInPackage(dir: string, name: string, ...path: string[]): string | undefined {
  const home = join(dir, "node_modules", ...name.split("/"));
  const file = join(home, ...path);
  try {
    return realpathSync(file).startsWith(realpathSync(home) + sep) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** The version of package `name` installed in `dir`'s node_modules, as its package.json says, or undefined. */
function versionIn(dir: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "node_modules", ...name.split("/"), "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

// ---- Claude Code ------------------------------------------------------------------------------------------------------

/** The Claude Agent SDK's package. */
export const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";
/** The MCP library the SDK serves a session's tools with: its peer, installed beside it. */
const MCP_PARTS = ["@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk/types.js"] as const;
/** The CLI an install in `dir` holds for `platform` (the SDK's platform package's). */
const claudeCliIn = (dir: string, platform: string): string | undefined => fileInPackage(dir, `@anthropic-ai/claude-agent-sdk-${platform}`, process.platform === "win32" ? "claude.exe" : "claude");

/** The SDK as installed in `dir`, checked: its package.json names it at `version`, and its entry resolves inside it. */
export function installedSdk(dir: string, version: string): { entry: string } | undefined {
  if (versionIn(dir, CLAUDE_SDK) !== version) return undefined;
  const entry = inTree(dir, CLAUDE_SDK);
  return entry ? { entry } : undefined;
}

const CLAUDE: HarnessInstallEntry = {
  id: "claude-agent",
  label: "Claude Code",
  package: CLAUDE_SDK,
  lock: fileURLToPath(new URL("../harnesses/claude-agent/package-lock.json", import.meta.url)),
  // The SDK at the pin and its entry, this platform's CLI, and the MCP library (its server and its types).
  lacking: (dir, { version, platform }) => (!installedSdk(dir, version) ? `${CLAUDE_SDK}@${version}` : !claudeCliIn(dir, platform) ? `its CLI for ${platform}` : MCP_PARTS.find((part) => !inTree(dir, part))),
  platformPackage: ({ platform }) => `@anthropic-ai/claude-agent-sdk-${platform}`,
};

/** What claude-agent's adapter takes from an install (its `sdk`, `sdkVersion`, `cliPath` and `mcp`). */
export type LoadedSdk = { sdk: unknown; sdkVersion: string; cliPath: string; mcp: { server: unknown; types: unknown } };

/** The SDK in `dir`, its CLI and the MCP library, each loaded from inside `dir`. Throws a HarnessNotInstalled when the
 *  install there is not whole. */
export async function loadSdk(dir: string, pins: HarnessPins): Promise<LoadedSdk> {
  const missing = CLAUDE.lacking(dir, pins);
  if (missing) throw new HarnessNotInstalled(CLAUDE, dir, pins.version, existsSync(dir) ? `Claude Code in ${dir} is not whole: it lacks ${missing}` : undefined);
  const load = (specifier: string) => import(pathToFileURL(inTree(dir, specifier)!).href) as Promise<unknown>;
  const [sdk, server, types] = await Promise.all([load(CLAUDE_SDK), load(MCP_PARTS[0]), load(MCP_PARTS[1])]);
  return { sdk, sdkVersion: pins.version, cliPath: claudeCliIn(dir, pins.platform)!, mcp: { server, types } };
}

// ---- Codex --------------------------------------------------------------------------------------------------------------

/** Codex's package: a launcher, whose binary is in one optional package per platform, an npm alias of the launcher at
 *  `<version>-<platform>` (`@openai/codex-linux-x64`, say), at `vendor/<target>/bin/codex`. */
export const CODEX_PACKAGE = "@openai/codex";
const codexPlatform = (platform: string): string => `${CODEX_PACKAGE}-${platform}`;

const CODEX: HarnessInstallEntry = {
  id: "codex",
  label: "Codex",
  package: CODEX_PACKAGE,
  lock: fileURLToPath(new URL("../harnesses/codex/package-lock.json", import.meta.url)),
  // The launcher at the pin, and this platform's package at the pin with its binary.
  lacking: (dir, pins) => (versionIn(dir, CODEX_PACKAGE) !== pins.version ? `${CODEX_PACKAGE}@${pins.version}` : !codexBinaryIn(dir, pins) ? `its binary for ${pins.platform}` : undefined),
  // Only where the adapter knows the binary's target (and pins its sha256): a platform package it cannot check is none.
  platformPackage: ({ platform, target }) => (target ? codexPlatform(platform) : undefined),
};

/** The Codex binary an install in `dir` holds, with its platform package's version, as the Codex adapter takes it
 *  (its `binary`): undefined when that package is not this platform's at the pin, or has no binary of its own. */
export function codexBinaryIn(dir: string, { version, platform, target }: HarnessPins): { path: string; packageVersion: string } | undefined {
  if (!target) return undefined;
  const packageVersion = versionIn(dir, codexPlatform(platform));
  if (packageVersion !== `${version}-${platform}`) return undefined;
  const path = fileInPackage(dir, codexPlatform(platform), "vendor", target, "bin", process.platform === "win32" ? "codex.exe" : "codex");
  return path ? { path, packageVersion } : undefined;
}

/** The CLI harnesses that install on first use, by id. */
export const HARNESS_INSTALLS: Readonly<Record<string, HarnessInstallEntry>> = Object.freeze({ [CLAUDE.id]: CLAUDE, [CODEX.id]: CODEX });

// ---- installing -----------------------------------------------------------------------------------------------------------

const lockPackages = new Map<string, ReadonlySet<string>>();
/** The package paths a lock names (`node_modules/<name>`), read once per lock. */
function packagesOf(lock: string): ReadonlySet<string> {
  let known = lockPackages.get(lock);
  if (!known) lockPackages.set(lock, (known = new Set(Object.keys((JSON.parse(readFileSync(lock, "utf8")) as { packages?: Record<string, unknown> }).packages ?? {}))));
  return known;
}

/** Why `entry` is never installed on this platform, or undefined: no build of its CLI for `pins.platform`, in its
 *  adapter's own table or in the lock it installs by. Such a harness is unavailable for it, and nothing is installed:
 *  an install would end without its CLI, every time. */
export function noBuild(entry: HarnessInstallEntry, pins: HarnessPins, lock: string = entry.lock): string | undefined {
  const pkg = entry.platformPackage(pins);
  return pkg && packagesOf(lock).has(`node_modules/${pkg}`) ? undefined : `no ${entry.label} build for this platform (${pins.platform})`;
}

/** A harness is not installed in `dir` (or not whole): its message names the command that installs it by hand. */
export class HarnessNotInstalled extends Error {
  readonly code = "HARNESS_NOT_INSTALLED";
  constructor(entry: HarnessInstallEntry, readonly dir: string, readonly version: string, why?: string, lock: string = entry.lock) {
    super(`${why ?? `${entry.label} (${entry.package}@${version}) is not installed in ${dir}`}. Install it by hand with: ${installLine(dir, lock)}; then run the agent again.`);
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

/** Installs `entry`'s package at `pins.version` into `dir` by `lock` (default the one AgentRun ships) and the package.json
 *  beside it: `npm ci` in a fresh directory beside `dir`, with no key of this server's in its environment, no package's
 *  install script and the optional platform package included; checked whole there (its `lacking`), then renamed into
 *  place and made read-only. Resolves once it is in; rejects with HarnessNotInstalled naming why, and leaves `dir` as it
 *  was. `signal`: aborted, npm is stopped (SIGTERM). */
export async function npmInstall(entry: HarnessInstallEntry, dir: string, pins: HarnessPins, { lock = entry.lock, env = process.env, timeoutMs = INSTALL_TIMEOUT_MS, signal }: { lock?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  const { version } = pins;
  const fail = (why: string) => new HarnessNotInstalled(entry, dir, version, `Couldn't install ${entry.label} (${entry.package}@${version}) from npm: ${why}`, lock);
  const manifest = join(dirname(lock), "package.json");
  const root = (JSON.parse(await readFile(lock, "utf8")) as { packages?: Record<string, { dependencies?: Record<string, string> }> }).packages?.[""];
  const named = (JSON.parse(await readFile(manifest, "utf8")) as { dependencies?: Record<string, string> }).dependencies;
  const alone = (deps: Record<string, string> | undefined) => deps?.[entry.package] === version && Object.keys(deps).length === 1;
  if (!alone(root?.dependencies) || !alone(named)) throw fail(`its lock (${lock}) is not for ${entry.package}@${version} alone`);
  const parent = dirname(dir);
  const prefix = `.${basename(dir)}-`;
  await mkdir(parent, { recursive: true });
  // What an earlier install left part way: never read, removed now.
  for (const name of await readdir(parent)) if (name.startsWith(prefix)) await writable(join(parent, name), true).then(() => rm(join(parent, name), { recursive: true, force: true }));
  const staging = await mkdtemp(join(parent, prefix));
  try {
    await copyFile(manifest, join(staging, "package.json"));
    await copyFile(lock, join(staging, "package-lock.json"));
    // --include=optional: the CLI is an optional platform package, which a person's omit=optional would leave out.
    await runNpm(["ci", "--prefix", staging, "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund", "--loglevel=error"], env, timeoutMs, signal).catch((why: Error) => Promise.reject(fail(why.message)));
    const missing = entry.lacking(staging, pins);
    if (missing) throw fail(`npm ended, and the install lacks ${missing}`);
    // Into place whole: what was there (an install cut short, one by hand) goes aside first, then away.
    const old = existsSync(dir) ? `${staging}-old` : undefined;
    if (old) await rename(dir, old);
    await rename(staging, dir);
    // Read-only once in place: a write into it by mistake fails. (The server's own uid could change that back; each CLI's
    // sha256 is checked at every run.)
    await writable(dir, false);
    if (old) await writable(old, true).then(() => rm(old, { recursive: true, force: true }));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error instanceof HarnessNotInstalled ? error : fail((error as Error).message);
  }
}

/** What an earlier build left at the top of `<data>/harnesses`, when it installed Claude Code there itself: its
 *  package.json, its lock and its node_modules, and nothing else. */
const FLAT_INSTALL = new Set(["package.json", "package-lock.json", "node_modules"]);

/** Removes Claude Code as an earlier build installed it, at the top of `harnesses` (read-only, as it left it), so the
 *  per-harness installs can go in beside nothing: only when the directory holds that layout and nothing else (any other
 *  entry, a per-harness install among them, and it is left as it is). Nothing of the old tree is read or kept. Resolves
 *  true when it removed one. */
export async function removeFlatInstall(harnesses: string): Promise<boolean> {
  const entries: string[] = await readdir(harnesses).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
  if (!entries.length || !entries.every((name) => FLAT_INSTALL.has(name)) || !(entries.includes("package.json") || entries.includes("node_modules"))) return false;
  await chmod(harnesses, (await lstat(harnesses)).mode | 0o700);
  for (const name of entries) await writable(join(harnesses, name), true).then(() => rm(join(harnesses, name), { recursive: true, force: true }));
  return true;
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

/** The server's one installer of a harness into `dir`: `ensure()` resolves once it is installed whole, installing it first
 *  when it is not, and every caller while an install runs waits for that one. A failed install is not kept: the next call
 *  tries again. `stop()` stops an install that runs (its npm, SIGTERM) and waits for it to end. `onInstalled` hears of an
 *  install this server made, and how long it took. */
export class HarnessInstall {
  private running?: Promise<void>;
  private done = false;
  private readonly stopping = new AbortController();

  /** Whether this server knows the harness is installed whole (read once, then kept). */
  get installed(): boolean {
    return this.done;
  }
  constructor(readonly entry: HarnessInstallEntry, readonly dir: string, private readonly pins: () => Promise<HarnessPins>, private readonly install: (entry: HarnessInstallEntry, dir: string, pins: HarnessPins, signal: AbortSignal) => Promise<void> = (entry, dir, pins, signal) => npmInstall(entry, dir, pins, { signal }), private readonly onInstalled?: (ms: number) => void, private readonly lock: string = entry.lock) {}

  /** What a run waiting for it shows (a `phase` row). */
  get installingWords(): string {
    return installingWords(this.entry.label);
  }

  /** Why this harness is never installed here (noBuild: no build of its CLI for this platform, in the lock this server
   *  installs by), or undefined. A run on it ends with these words, never waiting and never launched. */
  async never(): Promise<string | undefined> {
    return noBuild(this.entry, await this.pins(), this.lock);
  }

  /** Whether a run must wait for an install: false once the harness is installed whole (read once, then kept). Ask
   *  never() first: where there is no build, the harness is neither installed nor installable, and this is true. */
  async needed(): Promise<boolean> {
    if (this.done) return false;
    if (this.running) return true;
    this.done = this.entry.lacking(this.dir, await this.pins()) === undefined;
    return !this.done;
  }

  ensure(): Promise<void> {
    if (this.done) return Promise.resolve();
    if (this.stopping.signal.aborted) return Promise.reject(new Error("the server is stopping"));
    this.running ??= (async () => {
      const pins = await this.pins();
      // Refused before npm, a temp directory or a registry request: no install of it ever lands here.
      const never = noBuild(this.entry, pins, this.lock);
      if (never) throw new Error(never);
      if (this.entry.lacking(this.dir, pins) === undefined) return void (this.done = true);
      const started = performance.now();
      await this.install(this.entry, this.dir, pins, this.stopping.signal);
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
