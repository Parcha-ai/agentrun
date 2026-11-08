// What serve hands a harness's adapter: each adapter's factory (claudeOf, codexOf, opencodeOf, which the harness table
// names: harness-table.ts), with serve's own model, price and endpoint (provider.ts), under the run's confinement, and the
// harness's own web search where the run's web_search resolves native and the harness has one (its facts). claude-agent's
// Claude Agent SDK and codex's Codex are installed on first use into the data's harnesses directory and loaded from there
// alone (harness-install.ts); opencode's pinned CLI that is missing says so with the one line that installs it: an npm
// install beside serve, or, when serve runs from npx, the npx line that runs it with the missing package.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterFacts, AgentAdapter, SessionSpec } from "@parcha/agentrun-kernel";
import { facts as claudeFacts } from "@parcha/agentrun-harness-claude/facts";
import { facts as codexFacts } from "@parcha/agentrun-harness-codex/facts";
import { facts as openCodeFacts } from "./harness-opencode/facts.js";
import { CLAUDE_SDK, codexBinaryIn, type HarnessPins, HarnessNotInstalled, installDirOf, installLine, loadSdk, type LoadedSdk } from "./harness-install.js";
import { DATA_ENV, defaultData } from "./files.js";
import { type HarnessEntry, harnessOf, onAdapter } from "./harness-table.js";
import type { ModelRef } from "./model.js";
import { HarnessUnavailable, type InstallFix, providerFor } from "./provider.js";
import { keyShaped } from "./secret-cut.js";
import { servedSkill } from "./learn/skills.js";
import { runKeyOf } from "./key-refusal.js";
import type { SkillCheck, SkillFiles } from "./skills.js";
import { planeOf } from "./tool-plane.js";
import { NATIVE_SEARCH_ALLOWANCE_TOKENS } from "./cap.js";

/** This server's version: an npx line names it, so the server it runs is the one that said what was missing. */
const SERVE_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Whether this server runs from npx's cache (`npx @parcha/agentrun-serve`), where there is no project to install a
 *  package into: npm keeps what npx runs under `<npm cache>/_npx/<hash>/node_modules`. Read from where this file is, not
 *  from npm's environment (`npm_command=exec`), which every child of an npm command inherits and which npx sets too
 *  when it runs a copy a project installed, whose fix stays `npm install`. */
export const startedByNpx = (file: string = fileURLToPath(import.meta.url)): boolean => file.split(sep).includes("_npx");

/** Set by `npx @parcha/agentrun` on the server it starts: that command's package at its version
 *  (`@parcha/agentrun@0.3.0`), so a hint names the command the person ran, not the server's own. */
export const NPX_PACKAGE_ENV = "AGENTRUN_NPX_PACKAGE";

/** The package each harness needs beside the server, as an npx line adds it. */
const HARNESS_PACKAGES = ["opencode-ai"];

/** The version of `name` installed where Node would look for it from `from`, or undefined. */
export function installedHere(name: string, from: string = fileURLToPath(import.meta.url)): string | undefined {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", name, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
        if (pkg.name === name && typeof pkg.version === "string") return pkg.version;
      } catch {}
    }
    if (dirname(dir) === dir) return undefined;
  }
}

const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * The one command that starts this same AgentRun again with `spec` beside it: the command the person ran
 * (`npx @parcha/agentrun`, which NPX_PACKAGE_ENV names, or the server's own), this server's version, every other
 * harness's package already here (so following one harness's hint never takes another away), and `--data` with this
 * server's store, so the command opens this same store: always after `npx @parcha/agentrun`, whose own store
 * (~/.agentrun) is not the server's default, and after the server's own command when the store is not its default.
 */
export function npxLine(spec: string, env: NodeJS.ProcessEnv = {}, installed: (name: string) => string | undefined = installedHere): string {
  const door = env[NPX_PACKAGE_ENV];
  const command = door !== undefined && /^@parcha\/agentrun@\d[\w.+-]*$/.test(door) ? door : undefined;
  const own = spec.slice(0, spec.lastIndexOf("@"));
  const kept = HARNESS_PACKAGES.filter((name) => name !== own).flatMap((name) => {
    const version = installed(name);
    return version ? [`${name}@${version}`] : [];
  });
  // Pinned even after a command that depends on this server: an older one (0.3.1) fetches the server on its own.
  const packages = [...(command ? [command] : []), `@parcha/agentrun-serve@${SERVE_VERSION}`, ...kept, spec];
  const data = env[DATA_ENV];
  const named = data && (command || resolve(data) !== resolve(defaultData(env))) ? ` --data ${shellWord(resolve(data))}` : "";
  // And how the person started it (startedWith): npx's -y, the port they named, and the browser as they had it:
  // `npx @parcha/agentrun` opens it unless --no-open, agentrun-serve only with --open.
  const yes = env.npm_config_yes === "true" ? "-y " : "";
  const port = env[STARTED_PORT_ENV];
  const flags = [...(port && /^\d{1,5}$/.test(port) ? [`--port ${port}`] : []), ...(command && env[STARTED_OPEN_ENV] === "0" ? ["--no-open"] : []), ...(!command && env[STARTED_OPEN_ENV] === "1" ? ["--open"] : [])];
  return `npx ${yes}${packages.map((name) => `-p ${name}`).join(" ")} ${command ? "agentrun" : "agentrun-serve"}${named}${flags.map((flag) => ` ${flag}`).join("")}`;
}

/** The port the server was started on when `--port` named one, and whether `--open` was given (1 or 0): set by its CLI
 *  for itself and its runs (startedWith), read by npxLine, so a hint keeps them. */
export const STARTED_PORT_ENV = "AGENTRUN_SERVE_PORT";
export const STARTED_OPEN_ENV = "AGENTRUN_SERVE_OPEN";

/** What the server's CLI records of how it was started (STARTED_PORT_ENV, STARTED_OPEN_ENV). */
export function startedWith({ port, open }: { port?: string; open: boolean }): Record<string, string> {
  return { ...(port !== undefined ? { [STARTED_PORT_ENV]: port } : {}), [STARTED_OPEN_ENV]: open ? "1" : "0" };
}

/** `message` with an adapter's own install line (`npmLine`, which installs `spec` into a project) as the npx line that
 *  starts this same AgentRun with `spec` beside it (npxLine), when the server runs from npx. Any other message is left
 *  as it is. */
export function installHint(message: string, npmLine: string, spec: string, npx = startedByNpx(), env: NodeJS.ProcessEnv = {}, installed?: (name: string) => string | undefined): string {
  if (!npx || !message.includes(npmLine)) return message;
  const line = `restart AgentRun with it: ${npxLine(spec, env, installed)}`;
  return message.includes(`install it with: ${npmLine}`) ? message.replace(`install it with: ${npmLine}`, line) : message.replace(npmLine, line);
}

/** For tests: a JSON `{command, args?, env?}` that speaks Codex's app-server protocol in place of Codex. agentrun-harness-codex
 *  takes it only under its own guard (AGENTRUN_CODEX_STANDIN=1, under a test runner). */
export const CODEX_STANDIN_ENV = "AGENTRUN_SERVE_CODEX_STANDIN";

/** For tests: a JSON `{command, args?, env?}` that speaks `opencode serve`'s HTTP API in place of OpenCode. The OpenCode
 *  adapter (src/harness-opencode) takes it only under its own guard (AGENTRUN_OPENCODE_STANDIN=1, under a test runner). */
export const OPENCODE_STANDIN_ENV = "AGENTRUN_SERVE_OPENCODE_STANDIN";

/** The event of a harness's own lines in the run's log (its model proxy's refusals and failures): a failed run's message
 *  is never taken from one (runs.ts lastLogLine). */
export const HARNESS_LOG_EVENT = "harness";

/**
 * A harness's log, into the run's log: the run process's stderr, which serve opens on the run's process.log. One JSON
 * line per call, as pi-durable-disk writes them (`{at, event, message, ...}`). A request's path loses its query string,
 * and every value of the environment's key-shaped variables is cut out of the line, so a key a client sent in either
 * place, or one serve holds, never reaches the log.
 */
export function harnessLog(harness: string, env: NodeJS.ProcessEnv, write: (line: string) => void = (line) => void process.stderr.write(line)) {
  // Every own name, enumerable or not: an environment object may hold a key it does not list.
  const secrets = Object.getOwnPropertyNames(env)
    .map((name) => [name, env[name]] as const)
    .filter(([name, value]) => keyShaped(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string);
  const cut = (text: string) => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
  // Every string is cut before it is serialized, field names included: JSON escapes a quote or a backslash, and a
  // secret holding one would no longer match in the line. An object that serializes itself (toJSON) is cut as what it
  // gives. The line is cut again after, as a backstop.
  // toJSON is called once per value, as JSON.stringify does: what it returns is not asked again (one that returns
  // `this` would never end), though the values inside it are.
  const scrub = (value: unknown, asked = false): unknown => {
    if (typeof value === "string") return cut(value);
    if (!asked && value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON === "function") return scrub((value as { toJSON(): unknown }).toJSON(), true);
    if (Array.isArray(value)) return value.map((inner) => scrub(inner));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, inner]) => [cut(name), scrub(inner)]));
    return value;
  };
  return (message: string, fields: Record<string, unknown> = {}): void => {
    const { path, ...rest } = fields;
    const line = JSON.stringify(scrub({ at: new Date().toISOString(), event: HARNESS_LOG_EVENT, harness, message, ...rest, ...(typeof path === "string" ? { path: path.split("?")[0] } : {}) }));
    write(`${cut(line)}\n`);
  };
}

/** What an adapter's own setup error says installing fixes, by the code its facts name for each: none for any other error. */
function fixOf(facts: AdapterFacts, error: unknown): InstallFix | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return code === facts.install.codes.install ? "install" : code === facts.install.codes.pins ? "pins" : undefined;
}

/** How a reason found at the start's probe ends (harness.ts' harnessOffers), which is the only one: what is installed
 *  after it shows once AgentRun restarts. */
const RESTART: Record<InstallFix, string> = { install: "once it is installed, restart AgentRun to pick it up", pins: "once the pinned build is installed, restart AgentRun" };

/** The reason the start's probe gives for `error`: its message, ending with the restart (RESTART) where installing is
 *  the fix. A message whose install line is npx's has no `fix`: running that line is the restart. */
export function startReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const fix = error instanceof HarnessUnavailable ? error.fix : undefined;
  return fix ? `${message.replace(/\.$/, "")}; ${RESTART[fix]}.` : message;
}

/** A HarnessUnavailable for an adapter's own setup `error`: its message, with the line that installs the harness when it
 *  names none, and with the adapter's own install line (its facts') made npx's where serve runs from npx (installHint):
 *  installing is its fix unless the line became npx's, which restarts AgentRun itself. */
function unavailable(facts: AdapterFacts, error: unknown, npx: boolean, env: NodeJS.ProcessEnv): HarnessUnavailable {
  const message = (error as Error).message;
  const said = message.includes("npm install") ? message : `${message} (${facts.install.npmLine})`;
  const hinted = installHint(said, facts.install.npmLine, facts.install.spec, npx, env);
  return new HarnessUnavailable(hinted, hinted === said ? fixOf(facts, error) : undefined);
}

type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };
/** A child's command under the run's confinement (pi-durable-disk's confinePrefix): only added in front. */
export type ConfineChild = (child: Readonly<{ command: string; args: string[] }>) => { command: string; args: string[] };
/** What a run's adapter needs of serve: its model, the catalog that prices it as it prices pi's runs, the run's
 *  confinement for the harness's own process, and the skills it loads itself (claude-agent's, codex's and opencode's,
 *  which its own check took: skills.ts). */
export type AdapterNeeds = { model: ModelRef; models: { getModel(provider: string, id: string): { cost?: Partial<ModelCost> } | undefined }; confine?: ConfineChild; skills?: readonly SkillFiles[]; unpriced?: ReadonlySet<string> };

/** The ConfineChild that starts a child under `prefix` (the argv pi's commands start under, ending in "--"); none when
 *  the run confines nothing, since an adapter refuses a confinement that adds nothing. */
export function confineOf(prefix: readonly string[]): ConfineChild | undefined {
  if (!prefix.length) return undefined;
  return (child) => ({ command: prefix[0]!, args: [...prefix.slice(1), child.command, ...child.args] });
}

/** The model key a run on `harness` (one on an adapter, by its wire's route) of `model` (the revision's; none, the host's default for the
 *  harness) takes: the one its requests carry on the route its provider below takes, as key-refusal.ts' runKeyOf names
 *  it. codex: the gateway's when AGENT_MODEL_BASE_URL is set, else OpenAI's, or OpenRouter's on OpenRouter's route;
 *  claude-agent: Anthropic's, for api.anthropic.com or ANTHROPIC_BASE_URL alike, or OpenRouter's on OpenRouter's route.
 *  None for pi, whose keys are its models' (model.ts' modelKeys). */
export function harnessModelKeys(harness: string, env: NodeJS.ProcessEnv, model?: string): string[] {
  if (!onAdapter(env, harness)) return [];
  const key = runKeyOf(env, harness, model);
  return key ? [key.field] : [];
}

/** A response's price in USD, from the same catalog that prices pi's runs; null when the model has no price. The
 *  usage's input is net of the cached tokens, which are priced at their own rate. */
export function priceOf(needs: AdapterNeeds) {
  return (_model: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number | null => {
    // A model serve has no price for (runModels' `unpriced`) carries a placeholder cost of zeros: unknown, never $0.
    if (needs.unpriced?.has(needs.model.modelId)) return null;
    const cost = needs.models.getModel(needs.model.provider, needs.model.modelId)?.cost;
    if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") return null;
    return (usage.input * cost.input + usage.output * cost.output + (usage.cacheRead ?? 0) * (cost.cacheRead ?? 0) + (usage.cacheWrite ?? 0) * (cost.cacheWrite ?? 0)) / 1e6;
  };
}

/** The package that runs claude-agent, imported by a name the build does not resolve (a test gives its own). Its Agent
 *  SDK is not beside it: a first use installs it into the data's harnesses directory (harness-install.ts). */
const CLAUDE_PACKAGE = "@parcha/agentrun-harness-claude";
const loadClaude = (): Promise<unknown> => import(CLAUDE_PACKAGE);

/** What serve reads of the claude-agent package: the adapter, the SDK version it pins and the SDK's install line it
 *  names, and this platform's suffix for the SDK's CLI package. */
type ClaudePackage = { claudeAgentAdapter(options: Record<string, unknown>): AgentAdapter; CLAUDE_AGENT_SDK_VERSION: string; CLAUDE_AGENT_SDK_INSTALL: string; claudeAgentPlatform(): string };

/** This server's data, as `env` names it (the server sets it for itself and its runs). */
const dataOf = (env: NodeJS.ProcessEnv): string => env[DATA_ENV] || defaultData(env);

/** The SDK version claude-agent pins: the one constant, the package's own (CLAUDE_AGENT_SDK_VERSION). */
export async function claudeSdkVersion(load: () => Promise<unknown> = loadClaude): Promise<string> {
  return ((await load()) as ClaudePackage).CLAUDE_AGENT_SDK_VERSION;
}

/** What claude-agent's install needs (harness-install.ts HarnessPins): the pinned SDK version, and this platform's CLI package. */
export async function claudePins(load: () => Promise<unknown> = loadClaude): Promise<HarnessPins> {
  const claude = (await load()) as ClaudePackage;
  return { version: claude.CLAUDE_AGENT_SDK_VERSION, platform: claude.claudeAgentPlatform() };
}

/** What codex's install needs: the pinned Codex version (its adapter's one constant, CODEX_VERSION), and this platform's
 *  package and the target directory its binary is in. No platform Codex ships for has none. */
export async function codexPins(): Promise<HarnessPins> {
  const codex = await import("@parcha/agentrun-harness-codex");
  const target = codex.codexTarget();
  return { version: codex.CODEX_VERSION, platform: target?.pkg ?? `${process.platform}-${process.arch}`, ...(target ? { target: target.target } : {}) };
}

/** Whether a harness that installs on first use (its entry's `installs`) is installed whole in this server's data; true
 *  for any other harness. */
export async function harnessInstalled(harness: HarnessEntry, env: NodeJS.ProcessEnv): Promise<boolean> {
  return !harness.installs || !harness.pins || harness.installs.lacking(installDirOf(dataOf(env), harness.id), await harness.pins()) === undefined;
}

/** An adapter package's own check of the skills its adapter would load (its `skillProblems`), from `load`, the package
 *  (each harness's table entry names its own: claude-agent's Skill tool; codex's, which lists them from its session's
 *  CODEX_HOME/skills; opencode's, whose instructions name them): what it refuses stays in the run's prompt (skills.ts),
 *  so its adapter is never handed a skill it throws on. None where the package has no such check: every skill stays
 *  inlined. */
export async function packageSkillCheck(load: () => Promise<unknown>): Promise<SkillCheck | undefined> {
  const pkg = (await load()) as { skillProblems?: unknown } | undefined;
  return typeof pkg?.skillProblems === "function" ? (pkg.skillProblems as SkillCheck) : undefined;
}

/** What a harness's adapter takes from the run's plane (tool-plane.ts) where web_search resolves native, by its own search
 *  (its facts' webSearch): `native`, the provider's search through its proxy, with the input a search request may read in
 *  beyond its body (cap.ts), which its proxy adds to that request's bound; `live`, its own live search (its adapter books
 *  each search); nothing for a harness with none. */
export function nativeOptions(facts: AdapterFacts, env: NodeJS.ProcessEnv): { webSearch?: true | "live"; webSearchAllowance?: number } {
  if (planeOf(env).web_search !== "native" || !facts.webSearch) return {};
  return facts.webSearch === "native" ? { webSearch: true, webSearchAllowance: NATIVE_SEARCH_ALLOWANCE_TOKENS } : { webSearch: "live" };
}

/** claude-agent's adapter, from `load` (the package; a test gives its own), on the Agent SDK, its CLI and the MCP library
 *  `sdkOf` loads (by default from the data's harnesses directory, where a first use installed them, and from nowhere
 *  else: harness-install.ts). Not installed there, it says the command that installs it by hand. */
export async function claudeOf(env: NodeJS.ProcessEnv, needs: AdapterNeeds, load: () => Promise<unknown> = loadClaude, sdkOf: (version: string, platform: string) => Promise<LoadedSdk> = (version, platform) => loadSdk(installDirOf(dataOf(env), claudeFacts.id), { version, platform })): Promise<AgentAdapter> {
  const claude = (await load()) as ClaudePackage;
  const dir = installDirOf(dataOf(env), claudeFacts.id);
  const line = installLine(dir, harnessOf(env, claudeFacts.id)!.installs!.lock);
  const version = claude.CLAUDE_AGENT_SDK_VERSION;
  const sdk = await sdkOf(version, claude.claudeAgentPlatform()).catch((error: Error) => {
    throw new HarnessUnavailable(error.message, "install");
  });
  // What no key fixes is said first: the adapter is built before the provider's refusal is thrown, and its construction
  // checks the SDK's version, zod and the pinned CLI (claude --version, once). The provider is read only when a session
  // opens, so an adapter built with an unusable one is never returned.
  let provider: ReturnType<typeof providerFor> | undefined;
  let refused: unknown;
  try {
    provider = providerFor(claudeFacts.wire, env, needs.model, claudeFacts.id);
  } catch (error) {
    refused = error;
  }
  let adapter: AgentAdapter;
  try {
    const native = { ...needs, model: claudeFacts.normalizeModel(needs.model) };
    // The CLI runs Anthropic's own id, which it knows the limits and betas of, and sends it as it is, OpenRouter too
    // (providerFor's modelId); the key goes as the endpoint takes it, and the run is priced by the catalog entry of
    // whoever bills it (its priceModel).
    const endpoint = provider ? { origin: provider.origin, credential: provider.credential, auth: provider.auth } : { origin: "", credential: () => "" };
    const priced = provider ? { ...needs, model: provider.priceModel } : native;
    // The skills only when there are some: with none, the adapter keeps its Skill tool off.
    adapter = claude.claudeAgentAdapter({ model: { default: provider?.modelId ?? native.model.modelId }, provider: endpoint, price: priceOf(priced), log: harnessLog(claudeFacts.id, env), sdk: sdk.sdk, sdkVersion: sdk.sdkVersion, cliPath: sdk.cliPath, mcp: sdk.mcp, ...(needs.confine ? { confine: needs.confine } : {}), ...(needs.skills?.length ? { skills: needs.skills } : {}), ...nativeOptions(claudeFacts, env) });
  } catch (error) {
    // The adapter's own install line is a project's; here Claude Code is installed into the data's harnesses directory.
    const message = (error as Error).message.split(claude.CLAUDE_AGENT_SDK_INSTALL).join(line);
    throw new HarnessUnavailable(message.includes(line) ? message : `${message.replace(/\.$/, "")}. Install ${CLAUDE_SDK}@${version} again with: ${line}`, fixOf(claudeFacts, error));
  }
  if (refused !== undefined) throw refused;
  return adapter;
}

/** The run's thinking level as the harness takes it (its facts' levels): serve's run to max; one above the harness's
 *  highest (OpenAI's reasoning efforts stop at xhigh) runs at that highest. */
export const thinkingFor = (facts: AdapterFacts, level: string): SessionSpec["thinking"] => ((facts.thinking as readonly string[]).includes(level) ? level : facts.thinking[facts.thinking.length - 1]) as SessionSpec["thinking"];

/** codex's adapter, from `load` (the package; a test gives its own), on the Codex binary installed on first use into the
 *  data's harnesses directory, and from nowhere else (harness-install.ts): not installed there, or not its pinned build,
 *  it says the command that installs it by hand. A test's stand-in runs no Codex. */
export async function codexOf(env: NodeJS.ProcessEnv, needs: AdapterNeeds, load: () => Promise<typeof import("@parcha/agentrun-harness-codex")> = () => import("@parcha/agentrun-harness-codex")): Promise<AgentAdapter> {
  const codex = await load();
  const standIn = env[CODEX_STANDIN_ENV] ? (JSON.parse(env[CODEX_STANDIN_ENV]) as { command: string; args?: string[]; env?: Record<string, string> }) : undefined;
  let binary: { path: string; packageVersion: string } | undefined;
  if (!standIn) {
    const entry = harnessOf(env, codexFacts.id)!.installs!;
    const dir = installDirOf(dataOf(env), codexFacts.id);
    const pins = await codexPins();
    const missing = entry.lacking(dir, pins);
    if (missing) throw new HarnessUnavailable(new HarnessNotInstalled(entry, dir, pins.version, existsSync(dir) ? `Codex in ${dir} is not whole: it lacks ${missing}` : undefined).message, "install");
    binary = codexBinaryIn(dir, pins);
    try {
      codex.verifyCodex(binary);
    } catch (error) {
      const line = installLine(dir, entry.lock);
      const message = (error as Error).message.split(codex.CODEX_INSTALL).join(line);
      throw new HarnessUnavailable(message.includes(line) ? message : `${message.replace(/\.$/, "")}. Install ${entry.package}@${pins.version} again with: ${line}`, fixOf(codexFacts, error));
    }
  }
  // The id as the provider's endpoint names it (providerFor): a gateway's own name for the model as model.ts chose it,
  // whole (AGENT_MODEL_GATEWAY_IDS says whether it is provider-qualified), OpenAI's model id, which chooseModel has
  // already taken out of "openai/<id>", or OpenRouter's whole slug.
  const provider = providerFor(codexFacts.wire, env, needs.model, codexFacts.id);
  return codex.codexAdapter({ model: provider.modelId, provider: { origin: provider.origin, credential: provider.credential }, price: priceOf({ ...needs, model: provider.priceModel }), log: harnessLog(codexFacts.id, env), ...(nativeOptions(codexFacts, env).webSearch === "live" ? { webSearch: "live" as const } : {}), ...(needs.confine ? { confine: needs.confine } : {}), ...(needs.skills?.length ? { skills: needs.skills } : {}), ...(standIn ? { standIn } : binary ? { binary } : {}) });
}

/** opencode's adapter, from `load` (this server's own, src/harness-opencode; a test gives its own). Its model goes where
 *  its wire's do (providerFor): serve's gateway (AGENT_MODEL_BASE_URL), OpenAI or OpenRouter, on the Responses API,
 *  through the adapter's proxy. */
export async function opencodeOf(env: NodeJS.ProcessEnv, needs: AdapterNeeds, load: () => Promise<typeof import("./harness-opencode/index.js")> = () => import("./harness-opencode/index.js"), npx = startedByNpx()): Promise<AgentAdapter> {
  const opencode = await load();
  const standIn = env[OPENCODE_STANDIN_ENV] ? (JSON.parse(env[OPENCODE_STANDIN_ENV]) as { command: string; args?: string[]; env?: Record<string, string> }) : undefined;
  if (!standIn) {
    try {
      opencode.verifyOpenCode();
    } catch (error) {
      // serve's own line, which installs the adapter with its pinned CLI, in place of the adapter's (the CLI alone).
      const message = (error as Error).message.replace(opencode.OPENCODE_INSTALL, openCodeFacts.install.npmLine);
      throw unavailable(openCodeFacts, Object.assign(new Error(message), { code: (error as { code?: unknown } | null)?.code }), npx, env);
    }
  }
  // The shared date line (environment.ts) reaches OpenCode in the session's system prompt (app.ts), as it reaches every
  // harness.
  // The id as the provider's endpoint names it (providerFor, as codexOf takes it): OpenRouter's is the whole slug.
  const provider = providerFor(openCodeFacts.wire, env, needs.model, openCodeFacts.id);
  // Its instructions list each skill by the description its SKILL.md's front matter gives on one LF line, which is all the
  // adapter reads: each SKILL.md goes as servedSkill writes it (its name and description, as a prompt reads them, on one
  // line each), as a learned skill already does, so a CRLF file or a folded description is listed by its own words.
  const skills = needs.skills?.map((skill) => ({ ...skill, files: { ...skill.files, ...(skill.files["SKILL.md"] === undefined ? {} : { "SKILL.md": servedSkill(skill.files["SKILL.md"]) }) } }));
  return opencode.openCodeAdapter({ model: provider.modelId, provider: { origin: provider.origin, credential: provider.credential }, price: priceOf({ ...needs, model: provider.priceModel }), log: harnessLog(openCodeFacts.id, env), ...(needs.confine ? { confine: needs.confine } : {}), ...(skills?.length ? { skills } : {}), ...(standIn ? { standIn } : {}) });
}

/** `harness`'s adapter for a run, as its entry in the harness table builds it (harness-table.ts). */
export async function adapterFor(harness: string, env: NodeJS.ProcessEnv, needs: AdapterNeeds): Promise<AgentAdapter> {
  const make = harnessOf(env, harness)?.adapter;
  if (!make) throw new HarnessUnavailable(`This server does not run ${harness} yet.`);
  return make(env, needs);
}

/** Why `harness` cannot run here, or undefined when it can (its entry's refusal): its package and pins, its provider, and
 *  the adapter's own check of the model `given` names (with none, a model of its wire's vendor: whether it runs here at
 *  all). `atStart`: asked by the start's probe, whose offers hold until a restart, so a reason installing fixes ends
 *  saying to restart AgentRun once it is installed (startReason). `keys`: the model keys any one of which lets it run when
 *  a key is all it lacks (HarnessUnavailable's `keys`): the start's probe keeps them on the offer, for the key rows
 *  (tool-keys.ts). */
export async function harnessRefusal(harness: string, env: NodeJS.ProcessEnv, given: AdapterNeeds | undefined, { atStart = false }: { atStart?: boolean } = {}): Promise<{ reason: string; keys?: readonly string[] } | undefined> {
  const entry = harnessOf(env, harness);
  if (!entry) return { reason: `This server does not run ${harness} yet.` };
  return entry.refusal(env, given, { atStart });
}

/** harnessRefusal's reason alone. */
export async function harnessReason(harness: string, env: NodeJS.ProcessEnv, given: AdapterNeeds | undefined, { atStart = false }: { atStart?: boolean } = {}): Promise<string | undefined> {
  return (await harnessRefusal(harness, env, given, { atStart }))?.reason;
}
