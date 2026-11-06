// Claude Code, installed on first use. AgentRun never ships the Claude Agent SDK (its licence: the SDK and its CLI are the
// person's to fetch from npm, not ours to redistribute). The first claude-agent run here, or the first agent made on
// claude-agent, installs the version @parcha/agentrun-harness-claude pins (CLAUDE_AGENT_SDK_VERSION) from npm into
// `<data>/harnesses`, with the npm that runs this server, and every claude-agent run loads the SDK, its CLI and the MCP
// library it serves its tools with from there and nowhere else: never a copy beside the server or a global one. Written
// for AgentRun; the shape follows OpenMA's ACP harness releases (pinned, installed into a cache of the host's own the
// first time a session needs it, no fallback to another version, the installer handed no provider key).
//
// One install at a time: the server holds its data root alone (server-lock.ts), and an install in flight is the one every
// run and save that needs it waits for. An install is checked before it counts (the SDK's package.json says the pin, and
// its entry resolves from that directory); one a crash cut short reads as not installed, and the next install mends it.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
  const cliPath = join(dir, "node_modules", "@anthropic-ai", `claude-agent-sdk-${platform}`, process.platform === "win32" ? "claude.exe" : "claude");
  return { sdk, sdkVersion: version, cliPath, mcp: { server, types } };
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

/** Runs npm to install the SDK at `version` into `dir`, with no key of this server's in its environment and no package's
 *  install script (the SDK and its CLI have none). Resolves once the install is checked; rejects with ClaudeNotInstalled
 *  naming npm's last words. */
export function npmInstall(dir: string, version: string, { env = process.env, timeoutMs = INSTALL_TIMEOUT_MS }: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<void> {
  const npm = npmCommand(env);
  const args = [...npm.args, "install", "--prefix", dir, "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", `${CLAUDE_SDK}@${version}`];
  return new Promise((resolve, reject) => {
    let said = "";
    const child = spawn(npm.command, args, { env: withoutSecrets(env), stdio: ["ignore", "pipe", "pipe"], shell: npm.command.endsWith(".cmd") });
    const hear = (chunk: Buffer) => void (said = (said + chunk.toString("utf8")).slice(-4_000));
    child.stdout.on("data", hear);
    child.stderr.on("data", hear);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref();
    const fail = (why: string) => reject(new ClaudeNotInstalled(dir, version, `Couldn't install Claude Code (${CLAUDE_SDK}@${version}) from npm: ${why}`));
    child.once("error", (error) => (clearTimeout(timer), fail(`npm did not start (${error.message})`)));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const last = said.trim().split("\n").filter((line) => line.trim()).slice(-3).join(" ").replace(/\s+/g, " ").slice(0, 600);
      if (signal) return fail(`npm took more than ${Math.round(timeoutMs / 60_000)} minutes and was stopped`);
      if (code !== 0) return fail(last ? `npm exited ${code}: ${last}` : `npm exited ${code}`);
      if (!installedSdk(dir, version)) return fail(`npm ended, and ${dir} holds no ${CLAUDE_SDK}@${version}`);
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
  constructor(readonly dir: string, private readonly version: () => Promise<string>, private readonly install: (dir: string, version: string) => Promise<void> = (dir, version) => npmInstall(dir, version), private readonly onInstalled?: (ms: number) => void) {}

  /** Whether a run must wait for an install: false once Claude Code is installed (read once, then kept). */
  async needed(): Promise<boolean> {
    if (this.done) return false;
    if (this.running) return true;
    this.done = Boolean(installedSdk(this.dir, await this.version()));
    return !this.done;
  }

  ensure(): Promise<void> {
    if (this.done) return Promise.resolve();
    this.running ??= (async () => {
      const version = await this.version();
      if (installedSdk(this.dir, version)) return void (this.done = true);
      const started = performance.now();
      await this.install(this.dir, version);
      this.done = true;
      this.onInstalled?.(Math.round(performance.now() - started));
    })().finally(() => (this.running = undefined));
    return this.running;
  }
}
