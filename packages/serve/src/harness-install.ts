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
// is the one every run and save that needs it waits for; a server that stops stops its npm (runNpm). An install lands
// whole or not at all: npm writes into a fresh directory beside `<data>/harnesses/<harness>`, the result is checked there
// (the entry's `lacking`), and only then is it renamed into place and made read-only. A crash or a kill part way leaves
// that directory, never a half install, and the next install removes it; a tree that is not whole (an install by hand
// cut short) is never loaded, and the next install replaces it.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { facts as claudeFacts } from "@parcha/agentrun-harness-claude/facts";
import { facts as codexFacts } from "@parcha/agentrun-harness-codex/facts";
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
 *  AgentRun ships for it, and what an install in a directory lacks of a whole one (undefined when it is whole). */
export type HarnessInstallEntry = { id: string; label: string; package: string; lock: string; lacking(dir: string, pins: HarnessPins): string | undefined };

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
  id: claudeFacts.id,
  label: "Claude Code",
  package: CLAUDE_SDK,
  lock: fileURLToPath(new URL("../harnesses/claude-agent/package-lock.json", import.meta.url)),
  // The SDK at the pin and its entry, this platform's CLI, and the MCP library (its server and its types).
  lacking: (dir, { version, platform }) => (!installedSdk(dir, version) ? `${CLAUDE_SDK}@${version}` : !claudeCliIn(dir, platform) ? `its CLI for ${platform}` : MCP_PARTS.find((part) => !inTree(dir, part))),
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
  id: codexFacts.id,
  label: "Codex",
  package: CODEX_PACKAGE,
  lock: fileURLToPath(new URL("../harnesses/codex/package-lock.json", import.meta.url)),
  // The launcher at the pin, and this platform's package at the pin with its binary.
  lacking: (dir, pins) => (versionIn(dir, CODEX_PACKAGE) !== pins.version ? `${CODEX_PACKAGE}@${pins.version}` : !codexBinaryIn(dir, pins) ? `its binary for ${pins.platform}` : undefined),
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
 *  was. `signal`: aborted, npm is stopped (SIGTERM, then SIGKILL after NPM_STOP_GRACE_MS); `onKilled` hears of a SIGKILL. */
export async function npmInstall(entry: HarnessInstallEntry, dir: string, pins: HarnessPins, { lock = entry.lock, env = process.env, timeoutMs = INSTALL_TIMEOUT_MS, signal, onKilled }: { lock?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; onKilled?: () => void } = {}): Promise<void> {
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
    await runNpm(["ci", "--prefix", staging, "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund", "--loglevel=error"], env, timeoutMs, signal, onKilled).catch((why: Error) => Promise.reject(fail(why.message)));
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

/** How long npm has to exit after a SIGTERM before it gets SIGKILL. Once npm writes (its reify), a SIGTERM only marks
 *  it: npm finishes the step under way, which waits on every tarball, before it rolls back and exits, so a slow tarball
 *  would hold a server's close. npm writes only into the staging directory, which the install removes. */
export const NPM_STOP_GRACE_MS = 5_000;
/** How long the exit of an npm sent SIGKILL is waited for, at most (it is at once): the stop never hangs on it. */
export const NPM_KILLED_WAIT_MS = 5_000;

/** Runs npm with `args`, with no key of this server's in its environment and no shell; rejects with npm's last words.
 *  `signal`, aborted (or the timeout): npm is sent SIGTERM, then SIGKILL after NPM_STOP_GRACE_MS, and this rejects once
 *  it is gone, or NPM_KILLED_WAIT_MS after the SIGKILL at the latest. `onKilled` hears of the SIGKILL. */
function runNpm(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal, onKilled?: () => void): Promise<void> {
  const npm = npmCommand(env);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("the server stopped before npm started"));
    let said = "";
    const child = spawn(npm.command, [...npm.args, ...args], { env: withoutSecrets(env), stdio: ["ignore", "pipe", "pipe"] });
    const hear = (chunk: Buffer) => void (said = (said + chunk.toString("utf8")).slice(-4_000));
    child.stdout.on("data", hear);
    child.stderr.on("data", hear);
    let stopped: string | undefined;
    let kill: NodeJS.Timeout | undefined;
    let killed: NodeJS.Timeout | undefined;
    const stop = (why: string) => {
      if (stopped) return;
      stopped = why;
      child.kill("SIGTERM");
      kill = setTimeout(() => {
        child.kill("SIGKILL");
        onKilled?.();
        killed = setTimeout(() => (done(), reject(new Error(`${stopped} (killed)`))), NPM_KILLED_WAIT_MS);
      }, NPM_STOP_GRACE_MS);
    };
    const timer = setTimeout(() => stop(`npm took more than ${Math.round(timeoutMs / 60_000)} minutes and was stopped`), timeoutMs);
    timer.unref();
    const onAbort = () => stop("the server stopped, and npm with it");
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => (clearTimeout(timer), clearTimeout(kill), clearTimeout(killed), signal?.removeEventListener("abort", onAbort));
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

/** The file an install of a harness into `dir` (`<data>/harnesses/<harness>`) keeps in the data directory while it runs,
 *  for every process on this data (a runner beside the server, one of its own, or one in another container on the same
 *  volume): the installing host and process, and since when. A failed install leaves why in it until the next install;
 *  one that lands removes it. In the data directory, beside `<data>/harnesses`: that directory holds the installs alone. */
export const installMarkOf = (dir: string): string => join(dirname(dirname(dir)), `.harness-install-${basename(dir)}.json`);
type InstallMark = { readonly host: string; readonly pid: number; readonly startedAt: number } | { readonly failed: string; readonly at: number };

/** The mark written whole, beside it then renamed over it: a claim reading it while it changes reads the last mark or the
 *  new one, never part of one (which would read as no install). */
async function writeMark(dir: string, mark: InstallMark): Promise<void> {
  const at = installMarkOf(dir);
  await mkdir(dirname(at), { recursive: true });
  const next = `${at}.${process.pid}.next`;
  await writeFile(next, JSON.stringify(mark));
  await rename(next, at);
}

async function readMark(dir: string): Promise<InstallMark | undefined> {
  try {
    const mark = JSON.parse(await readFile(installMarkOf(dir), "utf8")) as Partial<{ host: string; pid: number; startedAt: number; failed: string; at: number }>;
    if (typeof mark.failed === "string") return { failed: mark.failed, at: Number(mark.at) };
    return typeof mark.host === "string" && typeof mark.pid === "number" && typeof mark.startedAt === "number" ? { host: mark.host, pid: mark.pid, startedAt: mark.startedAt } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether process `pid` is alive (signal 0: one of another user's reads as alive too, by EPERM). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Where a run's claim stands on a harness that installs on first use, in `dir`: "installed" once it is whole; while an
 *  install runs (its mark started within INSTALL_TIMEOUT_MS, by a live process when it names this host; another host's
 *  process can't be read from here, so its mark is trusted within that bound), it waits for that install, polling, never
 *  past that bound; `{ failed }` with the install's own words when the last install failed; "none" when nothing installs
 *  it (no mark, one past the bound, or one this host's installer that is gone left), so the caller says what is missing
 *  as before. `onWait`: told once, as it starts to wait. `signal` aborted (the run stopped, or its claim lost): it stops
 *  waiting and rejects; the install goes on. */
export async function installSettled(entry: HarnessInstallEntry, dir: string, pins: HarnessPins, { signal, onWait, pollMs = 250, timeoutMs = INSTALL_TIMEOUT_MS, isAlive = alive, host = hostname() }: { signal?: AbortSignal; onWait?: () => void; pollMs?: number; timeoutMs?: number; isAlive?: (pid: number) => boolean; host?: string } = {}): Promise<"installed" | "none" | { failed: string }> {
  let waiting = false;
  for (;;) {
    if (entry.lacking(dir, pins) === undefined) return "installed";
    const mark = await readMark(dir);
    if (mark === undefined) return "none";
    if ("failed" in mark) return { failed: mark.failed };
    if (Date.now() - mark.startedAt > timeoutMs || (mark.host === host && !isAlive(mark.pid))) return "none";
    signal?.throwIfAborted();
    if (!waiting) {
      waiting = true;
      onWait?.();
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, pollMs);
      function done() {
        signal?.removeEventListener("abort", stop);
        resolve();
      }
      function stop() {
        clearTimeout(timer);
        reject(signal!.reason);
      }
      signal?.addEventListener("abort", stop, { once: true });
    });
  }
}

/** The file an installer holds while it installs into `dir`, beside the install's mark: made exclusively, so of every
 *  process on this data (the server, a runner beside it, one of its own) one installs at a time, and the others wait for
 *  that install. npm's staging directories beside `dir` are each install's own, and an install removes what an earlier one
 *  left there, so two at once would undo each other. */
export const installHoldOf = (dir: string): string => `${installMarkOf(dir)}.hold`;
/** How young a hold that cannot be read is still taken as held (none is ever written part way: one left unreadable is a
 *  copy cut short, or a file of another's that this bound lets go of in time). */
const HOLD_WRITING_MS = 10_000;

type Hold = { readonly host: string; readonly pid: number; readonly startedAt: number; readonly token: string };

/** The hold at `at` as written, or undefined when it cannot be read (gone, cut short, not one). */
async function readHold(at: string): Promise<Partial<Hold> | undefined> {
  try {
    const held = JSON.parse(await readFile(at, "utf8")) as unknown;
    return held !== null && typeof held === "object" ? (held as Partial<Hold>) : undefined;
  } catch {
    return undefined;
  }
}

/** Takes the hold on installs into `dir` for this process: its token when it holds it now, undefined while another
 *  installer does (its process alive, when it names this host; within INSTALL_TIMEOUT_MS, when another host's). The hold
 *  is written whole beside its place and linked into it, which fails when a hold is there, so no reader sees one part
 *  way. A hold its installer left (gone, or past that bound, or unreadable and older than HOLD_WRITING_MS) is taken over
 *  by one taker alone: the one that links it to a name of that very file's removes it, and only while it is still that
 *  file, so a hold another taker made meanwhile is never removed. */
export async function takeHold(dir: string, { isAlive = alive, host = hostname(), timeoutMs = INSTALL_TIMEOUT_MS }: { isAlive?: (pid: number) => boolean; host?: string; timeoutMs?: number } = {}): Promise<string | undefined> {
  const at = installHoldOf(dir);
  await mkdir(dirname(at), { recursive: true });
  const token = randomUUID();
  const draft = `${at}.${token}`;
  await writeFile(draft, JSON.stringify({ host, pid: process.pid, startedAt: Date.now(), token } satisfies Hold));
  try {
    for (let tries = 0; tries < 3; tries++) {
      try {
        await link(draft, at);
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const judged = await lstat(at).catch(() => undefined);
      if (!judged) continue;
      const held = await readHold(at);
      const live = typeof held?.pid === "number" && typeof held.startedAt === "number"
        ? Date.now() - held.startedAt <= timeoutMs && (held.host !== host || isAlive(held.pid))
        : Date.now() - judged.mtimeMs <= HOLD_WRITING_MS;
      if (live) return undefined;
      // Left by its installer: reaped by one taker alone. The hold is never moved; a taker links it to a name of that very
      // file's (its device and inode), which only one can make, and that one removes the hold, once the link shows it is
      // still the hold judged left. The others wait. A reap a taker cut short left long ago is cleared for the next look.
      const reap = `${at}.reap-${judged.dev}-${judged.ino}`;
      try {
        await link(at, reap);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code !== "EEXIST") throw error;
        const since = (await lstat(reap).catch(() => undefined))?.ctimeMs;
        if (since !== undefined && Date.now() - since > HOLD_WRITING_MS) await rm(reap, { force: true });
        return undefined;
      }
      const reaped = await lstat(reap);
      if (reaped.ino === judged.ino && reaped.dev === judged.dev) await rm(at, { force: true });
      await rm(reap, { force: true });
    }
    return undefined;
  } finally {
    await rm(draft, { force: true }).catch(() => undefined);
  }
}

/** Lets go of the hold on installs into `dir` that `token` took; a hold of another's (one that took over this one past
 *  its bound) stays. */
export async function releaseHold(dir: string, token: string): Promise<void> {
  const at = installHoldOf(dir);
  if ((await readHold(at))?.token === token) await rm(at, { force: true });
}

/** The server's one installer of a harness into `dir`: `ensure()` resolves once it is installed whole, installing it first
 *  when it is not, and every caller while an install runs waits for that one. While another process installs it (it holds
 *  installHoldOf), this one waits for that install instead of starting its own. A failed install is not kept: the next call
 *  tries again. `stop()` stops an install that runs (its npm) and waits, bounded, for it to end. `onInstalled` hears of an
 *  install this server made, and how long it took. */
export class HarnessInstall {
  private running?: Promise<void>;
  private done = false;
  private readonly stopping = new AbortController();

  /** Whether this server knows the harness is installed whole (read once, then kept). */
  get installed(): boolean {
    return this.done;
  }
  constructor(readonly entry: HarnessInstallEntry, readonly dir: string, private readonly pins: () => Promise<HarnessPins>, private readonly install: (entry: HarnessInstallEntry, dir: string, pins: HarnessPins, signal: AbortSignal) => Promise<void> = (entry, dir, pins, signal) => npmInstall(entry, dir, pins, { signal }), private readonly onInstalled?: (ms: number) => void) {}

  /** What a run waiting for it shows (a `phase` row). */
  get installingWords(): string {
    return installingWords(this.entry.label);
  }

  /** Whether a run must wait for an install: false once the harness is installed whole (read once, then kept). */
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
      // One installer at a time on this data: while another process holds the install, wait for it to settle, then look
      // again (installed: done; failed: so is this; let go with nothing in: take the hold).
      let token: string | undefined;
      while (!(token = await takeHold(this.dir))) {
        if (this.stopping.signal.aborted) throw new Error("the server is stopping");
        const settled = await installSettled(this.entry, this.dir, await this.pins(), { signal: this.stopping.signal });
        if (settled === "installed") return void (this.done = true);
        if (typeof settled === "object") throw new Error(settled.failed);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      try {
        // The mark a run's claim reads, in this process or a runner's own (installSettled): installing now, then gone once
        // it is in, or why it failed. Written first, before anything is read, so a claim made as this install starts (a run
        // started just after the save that started it) finds it; gone at once when the harness is installed already.
        await writeMark(this.dir, { host: hostname(), pid: process.pid, startedAt: Date.now() });
        const pins = await this.pins().catch(async (error: unknown) => {
          await rm(installMarkOf(this.dir), { force: true }).catch(() => undefined);
          throw error;
        });
        if (this.entry.lacking(this.dir, pins) === undefined) {
          await rm(installMarkOf(this.dir), { force: true });
          return void (this.done = true);
        }
        const started = performance.now();
        try {
          await this.install(this.entry, this.dir, pins, this.stopping.signal);
        } catch (error) {
          // Why it failed, for the runs that waited on it; a server that stops leaves no mark (its npm was stopped, not refused).
          if (this.stopping.signal.aborted) await rm(installMarkOf(this.dir), { force: true }).catch(() => undefined);
          else await writeMark(this.dir, { failed: (error as Error).message, at: Date.now() }).catch(() => undefined);
          throw error;
        }
        await rm(installMarkOf(this.dir), { force: true });
        this.done = true;
        this.onInstalled?.(Math.round(performance.now() - started));
      } finally {
        await releaseHold(this.dir, token).catch(() => undefined);
      }
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  /** Stops an install that runs (its npm gets SIGTERM, then SIGKILL) and waits for it to end; none starts after. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.running?.catch(() => undefined);
  }
}

/** A runner's installs, by the directory each goes into: one HarnessInstall per directory in this process, which every
 *  claim that needs it waits on, and how many wait now. */
const claimInstalls = new Map<string, { install: HarnessInstall; waiting: number }>();

/** Installs `entry` into `dir` for a run's claim when nothing installs it (no install runs, or the last one failed before
 *  this claim): the claim installs it itself, by `lock` (default the one AgentRun ships), or waits for the install this
 *  process or another runs for it already; it resolves once it is in and rejects with the install's own words when it
 *  fails. `signal` aborted (the run stopped, its claim lost, the runner closing): this claim stops waiting at once, and the
 *  install's npm is stopped once no claim waits for it. */
export async function installForClaim(entry: HarnessInstallEntry, dir: string, pins: () => Promise<HarnessPins>, { lock, signal }: { lock?: string; signal?: AbortSignal } = {}): Promise<void> {
  let held = claimInstalls.get(dir);
  if (!held) {
    held = { install: new HarnessInstall(entry, dir, pins, (entry, dir, pins, stop) => npmInstall(entry, dir, pins, { signal: stop, ...(lock ? { lock } : {}) })), waiting: 0 };
    claimInstalls.set(dir, held);
  }
  const mine = held;
  mine.waiting += 1;
  try {
    const installing = mine.install.ensure();
    installing.catch(() => undefined);
    if (!signal) return await installing;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const stop = () => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      installing.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
  } finally {
    mine.waiting -= 1;
    if (mine.waiting === 0 && claimInstalls.get(dir) === mine) {
      claimInstalls.delete(dir);
      // Nothing waits for it any more: its npm stops (nothing to stop once it is in or has failed). The claim goes on at
      // once; the stop is kept until it ends, for the runner's close to wait on (claimInstallsStopped).
      const stopping = mine.install.stop();
      claimStops.add(stopping);
      void stopping.finally(() => claimStops.delete(stopping));
    }
  }
}

/** The stops of the claims' installs under way (installForClaim). */
const claimStops = new Set<Promise<void>>();

/** Resolves once every install a claim let go of has stopped (its npm ended, SIGTERM then SIGKILL past its grace, its
 *  staging directory and hold gone): a runner's close waits for it before the process can end, so no npm outlives it. */
export async function claimInstallsStopped(): Promise<void> {
  await Promise.all([...claimStops]);
}
