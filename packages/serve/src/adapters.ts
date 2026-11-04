// The adapter a harness id runs on, and whether this server can run it. With a faux harness module (FAUX_HARNESS_ENV)
// every id runs on run-adapters' faux harness, scripted by the module's `script(spec)`, as `--faux` runs pi on the
// faux model. Otherwise codex runs on @parcha/agentrun-harness-codex and claude-agent on @parcha/agentrun-harness-claude, each
// with serve's own model, price and endpoint, under the run's confinement, and claude-agent with its own web search
// where the run's web_search resolves native, and codex with its own; a package or a pinned CLI that is missing says
// so with the one line that installs it: an npm install beside serve, or, when serve runs from npx, the npx line that
// runs it with the missing package (claude-agent's SDK, Codex).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentAdapter, SessionSpec } from "@parcha/agentrun-kernel";
import { DATA_ENV, defaultData } from "./files.js";
import { FAUX_HARNESS_ENV } from "./harness.js";
import type { ModelRef } from "./model.js";
import type { SkillCheck, SkillFiles } from "./skills.js";
import { planeOf } from "./tool-plane.js";
import { NATIVE_SEARCH_ALLOWANCE_TOKENS } from "./cap.js";

/** The one line that installs each harness beside serve. */
export const INSTALL: Record<string, string> = {
  "claude-agent": "npm install @parcha/agentrun-harness-claude @anthropic-ai/claude-agent-sdk@0.3.286 zod",
  codex: "npm install @parcha/agentrun-harness-codex @openai/codex@0.164.0",
};

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
const HARNESS_PACKAGES = ["@anthropic-ai/claude-agent-sdk", "@openai/codex"];

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
  const packages = [...(command ? [command] : []), `@parcha/agentrun-serve@${SERVE_VERSION}`, ...kept, spec];
  const data = env[DATA_ENV];
  const named = data && (command || resolve(data) !== resolve(defaultData(env))) ? ` --data ${shellWord(resolve(data))}` : "";
  return `npx ${packages.map((name) => `-p ${name}`).join(" ")} ${command ? "agentrun" : "agentrun-serve"}${named}`;
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

/** The event of a harness's own lines in the run's log (its model proxy's refusals and failures): a failed run's message
 *  is never taken from one (runs.ts lastLogLine). */
export const HARNESS_LOG_EVENT = "harness";

/** Names whose values are secrets: no line of the run's log carries one. */
const SECRET_NAME = /(_API_KEY|_TOKEN)$|SECRET/i;

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
    .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === "string" && value.length >= 8)
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

/** What fixes a harness that is not on this machine as its adapter needs it: `install`, its package or binary is missing;
 *  `pins`, what is installed is not the pinned build. */
export type InstallFix = "install" | "pins";

/** Why this server cannot run a harness here, in words a person can act on; `fix`, when installing is the fix. */
export class HarnessUnavailable extends Error {
  constructor(message: string, readonly fix?: InstallFix) {
    super(message);
  }
}

/** What an adapter's own setup error says installing fixes, by its typed code: none for any other error. */
function fixOf(error: unknown): InstallFix | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "CLAUDE_AGENT_NOT_INSTALLED" || code === "CODEX_NOT_INSTALLED") return "install";
  if (code === "CLAUDE_AGENT_PIN_MISMATCH" || code === "CODEX_PIN_MISMATCH") return "pins";
  return undefined;
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
 *  names none, and with the adapter's own install line (`pinned`) made npx's where serve runs from npx (installHint):
 *  installing is its fix unless the line became npx's, which restarts AgentRun itself. */
function unavailable(harness: string, error: unknown, pinned: { npmLine: string; spec: string } | undefined, npx: boolean, env: NodeJS.ProcessEnv): HarnessUnavailable {
  const message = (error as Error).message;
  const said = message.includes("npm install") ? message : `${message} (${INSTALL[harness]})`;
  const hinted = pinned ? installHint(said, pinned.npmLine, pinned.spec, npx, env) : said;
  return new HarnessUnavailable(hinted, hinted === said ? fixOf(error) : undefined);
}

type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };
/** A child's command under the run's confinement (pi-durable-disk's confinePrefix): only added in front. */
export type ConfineChild = (child: Readonly<{ command: string; args: string[] }>) => { command: string; args: string[] };
/** What a run's adapter needs of serve: its model, the catalog that prices it as it prices pi's runs, the run's
 *  confinement for the harness's own process, and the skills it loads itself (claude-agent's, which its own check took:
 *  skills.ts). */
export type AdapterNeeds = { model: ModelRef; models: { getModel(provider: string, id: string): { cost?: Partial<ModelCost> } | undefined }; confine?: ConfineChild; skills?: readonly SkillFiles[] };

/** The ConfineChild that starts a child under `prefix` (the argv pi's commands start under, ending in "--"); none when
 *  the run confines nothing, since an adapter refuses a confinement that adds nothing. */
export function confineOf(prefix: readonly string[]): ConfineChild | undefined {
  if (!prefix.length) return undefined;
  return (child) => ({ command: prefix[0]!, args: [...prefix.slice(1), child.command, ...child.args] });
}

/** Hosts a gateway may be reached at over plain http: this machine. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]); // key-gate: loopback-rule names this machine only, the hosts a gateway may use plain http on; an allow-list, the line dials nothing

/**
 * The base `setting` (a gateway's URL) gives the model proxy: its origin and its path, one trailing `/v1` taken off, since
 * every route the proxy sends to begins with `/v1/`. So `https://openrouter.ai/api` and `https://openrouter.ai/api/v1` both
 * send to `https://openrouter.ai/api/v1/...`. A provider's key goes wherever this points, so a value that could point
 * somewhere other than it reads is refused, by the setting's name: userinfo, a query or a fragment, a "." or ".." path
 * segment (raw or percent-encoded), a backslash, whitespace, or plain http to anything but this machine.
 */
export function gatewayBase(setting: string, value: string): string {
  const wrong = (why: string) => new HarnessUnavailable(`${setting} must be an https URL of a gateway, with a path if it serves the API under one; it ${why}.`);
  if (/\s/.test(value)) throw wrong("holds whitespace");
  // The URL parser reads a backslash as a path separator, so a ".." between backslashes would resolve where "/../" is refused.
  if (value.includes("\\")) throw wrong("holds a backslash");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw wrong("is not a URL");
  }
  if (url.username || url.password) throw wrong("names a user");
  if (url.search || url.hash || /[?#]/.test(value)) throw wrong("has a query or a fragment");
  // The URL parser resolves dot segments, so they are looked for in the text as given.
  const path = value.slice(value.indexOf("//") + 2).replace(/^[^/]*/, "");
  if (path.split("/").some((segment) => /^(\.|%2e){1,2}$/i.test(segment))) throw wrong("has a . or .. path segment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw wrong(`is ${url.protocol.replace(/:$/, "")}, not https`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
}

/** Where Codex's model requests go: OpenAI with its key, or a gateway at AGENT_MODEL_BASE_URL's base (gatewayBase: the
 *  proxy sends the Responses API to <base>/v1/responses). */
export function codexProvider(env: NodeJS.ProcessEnv, model: ModelRef): { origin: string; credential: () => string } {
  if (env.AGENT_MODEL_BASE_URL) return { origin: gatewayBase("AGENT_MODEL_BASE_URL", env.AGENT_MODEL_BASE_URL), credential: () => env.AGENT_MODEL_API_KEY || "none" };
  if (model.provider !== "openai") throw new HarnessUnavailable(`codex runs OpenAI models; the run's model is ${model.provider}/${model.modelId}.`);
  if (!env.OPENAI_API_KEY) throw new HarnessUnavailable("codex needs OPENAI_API_KEY, or a gateway in AGENT_MODEL_BASE_URL.");
  return { origin: "https://api.openai.com", credential: () => env.OPENAI_API_KEY ?? "" };
}

/** A response's price in USD, from the same catalog that prices pi's runs; null when the model has no price. The
 *  usage's input is net of the cached tokens, which are priced at their own rate. */
export function priceOf(needs: AdapterNeeds) {
  return (_model: string, usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number | null => {
    const cost = needs.models.getModel(needs.model.provider, needs.model.modelId)?.cost;
    if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") return null;
    return (usage.input * cost.input + usage.output * cost.output + (usage.cacheRead ?? 0) * (cost.cacheRead ?? 0) + (usage.cacheWrite ?? 0) * (cost.cacheWrite ?? 0)) / 1e6;
  };
}

/** Where claude-agent's requests go: Anthropic Messages only, at ANTHROPIC_BASE_URL's base (an Anthropic-compatible
 *  endpoint, with its path: <base>/v1/messages) or api.anthropic.com, with ANTHROPIC_API_KEY. Its own settings only: AGENT_MODEL_BASE_URL is the other
 *  harnesses' gateway, and Claude's requests never go there. */
export function claudeProvider(env: NodeJS.ProcessEnv, model: ModelRef): { origin: string; credential: () => string } {
  if (model.provider !== "anthropic") throw new HarnessUnavailable(`claude-agent runs Anthropic models; the run's model is ${model.provider}/${model.modelId}.`);
  if (!env.ANTHROPIC_API_KEY) throw new HarnessUnavailable("claude-agent needs ANTHROPIC_API_KEY.");
  const origin = env.ANTHROPIC_BASE_URL ? gatewayBase("ANTHROPIC_BASE_URL", env.ANTHROPIC_BASE_URL) : "https://api.anthropic.com";
  return { origin, credential: () => env.ANTHROPIC_API_KEY ?? "" };
}

/** The model id claude-agent sends, and prices: Anthropic's own, the model id with dots as dashes. Anthropic's ids hold no
 *  dot; a gateway such as OpenRouter names the same models with dots (anthropic/claude-sonnet-5.5) and takes Anthropic's
 *  own id too, and the catalog prices them by Anthropic's id. */
export function claudeModelId(model: ModelRef): string {
  return model.provider === "anthropic" ? model.modelId.replaceAll(".", "-") : model.modelId;
}

/** claude-agent's model: the revision's (or the server's default) as `provider/model-id`, its price from pi-ai's
 *  catalog. Never the gateway's model or price, which serve the other harnesses. Whether it is an Anthropic model is
 *  claudeProvider's to say. */
export function claudeModel(env: NodeJS.ProcessEnv, ref: string | undefined): { model: ModelRef } | { why: string; host: boolean } {
  const named = ref ?? env.AGENT_MODEL;
  if (!named) return { why: "The revision names no model, and this host has no default: name an anthropic/<model-id> in the definition.", host: true };
  const slash = named.indexOf("/");
  if (slash < 1) return { why: `claude-agent runs a model named anthropic/<model-id>; the run's model is ${named}.`, host: ref === undefined };
  const [provider, modelId] = [named.slice(0, slash), named.slice(slash + 1)];
  // One provider, then the model's own id: a second segment (anthropic/anthropic/<model>, once a workaround) is refused
  // by name, never sent on to fail at the provider.
  if (modelId.includes("/")) return { why: `claude-agent runs a model named ${provider}/<model-id>; ${named} names more than one segment: name it ${provider}/${modelId.slice(modelId.lastIndexOf("/") + 1)}.`, host: ref === undefined };
  // Anthropic's own id from here on, so the cap's model lookup, the price and the wire all name one model the catalog
  // knows: a dotted name (OpenRouter's) would find no model, and a cap with no model would admit nothing it could price.
  return { model: { provider, modelId: claudeModelId({ provider, modelId }) } };
}

/** The package that runs claude-agent, imported by a name the build does not resolve: it is installed beside serve
 *  only by the person who wants it (its SDK is an optional peer). */
const CLAUDE_PACKAGE = "@parcha/agentrun-harness-claude";
const loadClaude = (): Promise<unknown> => import(CLAUDE_PACKAGE);

/** The installed claude-agent adapter's own check of the skills it would load (its skillProblems), from `load` (a test
 *  gives its own): what it refuses stays in the run's prompt (skills.ts), so claudeOf never hands it a skill it throws
 *  on. None where the package is not installed, or has no such check: every skill stays inlined, and claudeOf says
 *  what is missing. */
export async function claudeSkillCheck(load: () => Promise<unknown> = loadClaude): Promise<SkillCheck | undefined> {
  const claude = (await load().catch(() => undefined)) as { skillProblems?: unknown } | undefined;
  return typeof claude?.skillProblems === "function" ? (claude.skillProblems as SkillCheck) : undefined;
}

/** What a harness's adapter takes from the run's plane (tool-plane.ts) where web_search resolves native: claude-agent,
 *  Claude's own WebSearch with the input a search request may read in beyond its body (cap.ts), which its proxy adds to
 *  that request's bound; codex, Codex's own search, live (its adapter books each search); nothing otherwise. */
export function nativeOptions(harness: string, env: NodeJS.ProcessEnv): { webSearch?: true | "live"; webSearchAllowance?: number } {
  if (planeOf(env).web_search !== "native") return {};
  if (harness === "claude-agent") return { webSearch: true, webSearchAllowance: NATIVE_SEARCH_ALLOWANCE_TOKENS };
  if (harness === "codex") return { webSearch: "live" };
  return {};
}

/** claude-agent's adapter, from `load` (the installed package; a test gives its own). */
export async function claudeOf(env: NodeJS.ProcessEnv, needs: AdapterNeeds, load: () => Promise<unknown> = loadClaude, npx = startedByNpx()): Promise<AgentAdapter> {
  const claude = (await load().catch(() => {
    throw new HarnessUnavailable(`claude-agent is not installed here: ${INSTALL["claude-agent"]}`, "install");
  })) as { claudeAgentAdapter(options: Record<string, unknown>): AgentAdapter; CLAUDE_AGENT_SDK_INSTALL?: string; CLAUDE_AGENT_SDK_VERSION?: string };
  // What no key fixes is said first: the adapter is built before the provider's refusal is thrown, and its construction
  // checks the SDK's version, zod and the pinned CLI (claude --version, once). The provider is read only when a session
  // opens, so an adapter built with an unusable one is never returned.
  let provider: ReturnType<typeof claudeProvider> | undefined;
  let refused: unknown;
  try {
    provider = claudeProvider(env, needs.model);
  } catch (error) {
    refused = error;
  }
  let adapter: AgentAdapter;
  try {
    const native = { ...needs, model: { ...needs.model, modelId: claudeModelId(needs.model) } };
    // The skills only when there are some: with none, the adapter keeps its Skill tool off.
    adapter = claude.claudeAgentAdapter({ model: { default: native.model.modelId }, provider: provider ?? { origin: "", credential: () => "" }, price: priceOf(native), log: harnessLog("claude-agent", env), ...(needs.confine ? { confine: needs.confine } : {}), ...(needs.skills?.length ? { skills: needs.skills } : {}), ...nativeOptions("claude-agent", env) });
  } catch (error) {
    const pinned = claude.CLAUDE_AGENT_SDK_INSTALL && claude.CLAUDE_AGENT_SDK_VERSION ? { npmLine: claude.CLAUDE_AGENT_SDK_INSTALL, spec: `@anthropic-ai/claude-agent-sdk@${claude.CLAUDE_AGENT_SDK_VERSION}` } : undefined;
    throw unavailable("claude-agent", error, pinned, npx, env);
  }
  if (refused !== undefined) throw refused;
  return adapter;
}

/** The run's thinking level as the harness takes it: serve's levels run to max; Codex's reasoning efforts stop at xhigh. */
export const thinkingFor = (harness: string, level: string): SessionSpec["thinking"] => (harness === "codex" && level === "max" ? "xhigh" : level) as SessionSpec["thinking"];

/** The bare id Codex takes: serve's "openai/<id>" without its provider. */

/** codex's adapter, from `load` (the installed package; a test gives its own). */
export async function codexOf(env: NodeJS.ProcessEnv, needs: AdapterNeeds, load: () => Promise<typeof import("@parcha/agentrun-harness-codex")> = () => import("@parcha/agentrun-harness-codex"), npx = startedByNpx()): Promise<AgentAdapter> {
  const codex = await load().catch(() => {
    throw new HarnessUnavailable(`codex is not installed here: ${INSTALL.codex}`, "install");
  });
  const standIn = env[CODEX_STANDIN_ENV] ? (JSON.parse(env[CODEX_STANDIN_ENV]) as { command: string; args?: string[]; env?: Record<string, string> }) : undefined;
  if (!standIn) {
    try {
      codex.verifyCodex();
    } catch (error) {
      throw unavailable("codex", error, { npmLine: codex.CODEX_INSTALL, spec: `@openai/codex@${codex.CODEX_VERSION}` }, npx, env);
    }
  }
  // The id as model.ts chose it: a gateway's own name for the model, whole (AGENT_MODEL_GATEWAY_IDS says whether it is
  // provider-qualified), or OpenAI's model id, which chooseModel has already taken out of "openai/<id>".
  return codex.codexAdapter({ model: needs.model.modelId, provider: codexProvider(env, needs.model), price: priceOf(needs), log: harnessLog("codex", env), ...(nativeOptions("codex", env).webSearch === "live" ? { webSearch: "live" as const } : {}), ...(needs.confine ? { confine: needs.confine } : {}), ...(standIn ? { standIn } : {}) });
}

export async function adapterFor(harness: string, env: NodeJS.ProcessEnv, needs: AdapterNeeds): Promise<AgentAdapter> {
  const faux = env[FAUX_HARNESS_ENV];
  if (faux) {
    const [{ fauxAdapter }, module] = await Promise.all([import("@parcha/agentrun-kernel/testing"), import(pathToFileURL(faux).href) as Promise<{ script?: (spec: SessionSpec) => never[]; opened?: (harness: string, options: Record<string, unknown>) => void }>]);
    if (typeof module.script !== "function") throw new Error(`${FAUX_HARNESS_ENV} names ${faux}, which exports no script(spec)`);
    // The options the harness's own adapter would be built with from the run (its web search), told to the module.
    module.opened?.(harness, nativeOptions(harness, env));
    return fauxAdapter({ script: module.script });
  }
  if (harness === "codex") return codexOf(env, needs);
  if (harness === "claude-agent") return claudeOf(env, needs);
  throw new HarnessUnavailable(`This server does not run ${harness} yet.`);
}

/** Why `harness` cannot run here, or undefined when it can: its package and pins, its provider, and the adapter's own
 *  check of the model `given` names (with none, a model of the harness's own provider: whether it runs here at all).
 *  `atStart`: asked by the start's probe, whose offers hold until a restart, so a reason installing fixes ends saying
 *  to restart AgentRun once it is installed (startReason). */
export async function harnessReason(harness: string, env: NodeJS.ProcessEnv, given: AdapterNeeds | undefined, { atStart = false }: { atStart?: boolean } = {}): Promise<string | undefined> {
  if (env[FAUX_HARNESS_ENV]) return undefined;
  const needs = given ?? { model: { provider: harness === "claude-agent" ? "anthropic" : "openai", modelId: "default" }, models: { getModel: () => undefined } };
  try {
    const adapter = await adapterFor(harness, env, needs);
    const problems = adapter.check({ key: "capabilities", label: "capabilities", system: [], tools: [], context: "fresh" });
    return problems.length ? problems.join(" ") : undefined;
  } catch (error) {
    return atStart ? startReason(error) : (error as Error).message;
  }
}
