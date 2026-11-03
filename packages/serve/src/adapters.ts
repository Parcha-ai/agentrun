// The adapter a harness id runs on, and whether this server can run it. With a faux harness module (FAUX_HARNESS_ENV)
// every id runs on run-adapters' faux harness, scripted by the module's `script(spec)`, as `--faux` runs pi on the
// faux model. Otherwise codex runs on @parcha/agentrun-harness-codex and claude-agent on @parcha/agentrun-harness-claude, each
// with serve's own model, price and endpoint, under the run's confinement, and claude-agent with its own web search
// where the run's web_search resolves native, and codex with its own; a package or a pinned CLI that is missing says
// so with the one line that installs it: an npm install beside serve, or, when serve runs from npx, the npx line that
// runs it with the missing package (claude-agent's SDK, Codex).
import { readFileSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentAdapter, SessionSpec } from "@parcha/agentrun-kernel";
import { FAUX_HARNESS_ENV } from "./harness.js";
import { chooseModel, FAUX_ENV, hostModel, type ModelRef } from "./model.js";
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

/** `message` with an adapter's own install line (`npmLine`, which installs `spec` into a project) as the npx line that
 *  runs this same server with `spec` beside it, when the server runs from npx. Any other message is left as it is. */
export function installHint(message: string, npmLine: string, spec: string, npx = startedByNpx()): string {
  return npx && message.includes(npmLine) ? message.replace(npmLine, `npx -p @parcha/agentrun-serve@${SERVE_VERSION} -p ${spec} agentrun-serve`) : message;
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

/** Why this server cannot run a harness here, in words a person can act on. */
export class HarnessUnavailable extends Error {}

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

/** OpenRouter's API: its Anthropic Messages endpoint (`<base>/v1/messages`) and its Responses API (`<base>/v1/responses`)
 *  under one base, its key taken as a bearer token. The OpenRouter key goes nowhere else. */
export const OPENROUTER_BASE = "https://openrouter.ai/api";

/**
 * Whether `harness` reaches its vendor's models here only through OpenRouter: OPENROUTER_API_KEY is set and none of the
 * harness's own settings is. Those win, as on a host with no OpenRouter key: the endpoint the host names
 * (ANTHROPIC_BASE_URL for claude-agent, which needs ANTHROPIC_API_KEY; serve's gateway AGENT_MODEL_BASE_URL for codex,
 * with AGENT_MODEL_API_KEY or none), then the vendor's own key (ANTHROPIC_API_KEY, OPENAI_API_KEY), then OpenRouter. An
 * endpoint the host names never gets the OpenRouter key.
 */
export function openRouterOnly(harness: "claude-agent" | "codex", env: NodeJS.ProcessEnv): boolean {
  if (!env.OPENROUTER_API_KEY) return false;
  return harness === "claude-agent" ? !env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_API_KEY : !env.AGENT_MODEL_BASE_URL && !env.OPENAI_API_KEY;
}

/** OpenRouter's key, read per request, refused by name where it is not set (a model named on OpenRouter, a host
 *  without its key). */
function openRouterKey(env: NodeJS.ProcessEnv, harness: string, named: string): () => string {
  if (!env.OPENROUTER_API_KEY) throw new HarnessUnavailable(`${harness} runs ${named} through OpenRouter, which needs OPENROUTER_API_KEY.`);
  return () => env.OPENROUTER_API_KEY ?? "";
}

/** Where codex's model requests go, and the model id sent there: a gateway at AGENT_MODEL_BASE_URL's base (gatewayBase:
 *  the proxy sends the Responses API to <base>/v1/responses) with its key, the model as model.ts chose it; OpenAI with
 *  its key, OpenAI's id; or OpenRouter's Responses API (openRouterOnly, or a model the run names on it,
 *  `openrouter/openai/<model-id>`) with OpenRouter's key, the model's whole id (`openai/gpt-6-sol`). Codex sends each key
 *  as a bearer token. */
export type CodexProvider = { origin: string; credential: () => string; modelId: string };
export function codexProvider(env: NodeJS.ProcessEnv, model: ModelRef): CodexProvider {
  if (env.AGENT_MODEL_BASE_URL) return { origin: gatewayBase("AGENT_MODEL_BASE_URL", env.AGENT_MODEL_BASE_URL), credential: () => env.AGENT_MODEL_API_KEY || "none", modelId: model.modelId };
  const named = `${model.provider}/${model.modelId}`;
  if (model.provider === "openrouter" && model.modelId.startsWith("openai/")) return { origin: OPENROUTER_BASE, credential: openRouterKey(env, "codex", named), modelId: model.modelId };
  if (model.provider !== "openai") throw new HarnessUnavailable(`codex runs OpenAI models; the run's model is ${named}.`);
  if (openRouterOnly("codex", env)) return { origin: OPENROUTER_BASE, credential: openRouterKey(env, "codex", named), modelId: named };
  if (!env.OPENAI_API_KEY) throw new HarnessUnavailable("codex needs OPENAI_API_KEY, OPENROUTER_API_KEY (OpenAI's models through OpenRouter), or a gateway in AGENT_MODEL_BASE_URL.");
  return { origin: "https://api.openai.com", credential: () => env.OPENAI_API_KEY ?? "", modelId: model.modelId };
}

/** codex's model for `ref` (a revision's; none, the host's default for codex): as model.ts chooses it, except where
 *  codex reaches OpenAI only through OpenRouter (openRouterOnly), where an OpenAI model needs no OpenAI key, only a
 *  model pi-ai's catalog lists (it prices the run): OpenRouter's key is the one codexProvider sends. A save, a run and
 *  capabilities all ask this. */
export async function codexModel(env: NodeJS.ProcessEnv, ref: string | undefined): ReturnType<typeof chooseModel> {
  const named = ref ?? hostModel(env, "default", "codex");
  if (env[FAUX_ENV] || env[FAUX_HARNESS_ENV] || !openRouterOnly("codex", env) || !named?.startsWith("openai/")) return chooseModel(env, ref, "default", "codex");
  const modelId = named.slice("openai/".length);
  const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
  if (!builtinModels().getModel("openai", modelId)) return { why: `pi-ai knows no model ${modelId} of openai. Name one of its models, or route every model through a gateway with AGENT_MODEL_BASE_URL.`, host: ref === undefined, needs: "model" };
  return { model: { provider: "openai", modelId } };
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

/**
 * Where claude-agent's model requests go, as its proxy sends them and anything else that calls the same model (the
 * learning grader) must: the endpoint's origin (the proxy appends `/v1/messages`), its key, read per request, how the
 * endpoint takes it, the model id on the wire, and the catalog entry (pi-ai's) that prices the run.
 */
export type ClaudeProvider = { origin: string; credential: () => string; auth: "bearer" | "x-api-key"; modelId: string; priceModel: { provider: string; id: string } };

/** Where claude-agent's requests go, Anthropic Messages only: at ANTHROPIC_BASE_URL's base (an Anthropic-compatible
 *  endpoint, with its path: <base>/v1/messages) or api.anthropic.com, with ANTHROPIC_API_KEY as `x-api-key`, priced as
 *  Anthropic's; or OpenRouter's Messages endpoint (openRouterOnly, or a model the run names on it,
 *  `openrouter/anthropic/<model-id>`), with OPENROUTER_API_KEY as a bearer token, priced as OpenRouter's (OpenRouter
 *  bills it). Either way the wire carries Anthropic's own id (`claude-sonnet-5-5`), the one the CLI knows the limits of
 *  and OpenRouter takes too. Its own settings only: AGENT_MODEL_BASE_URL is the other harnesses' gateway, and Claude's
 *  requests never go there. */
export function claudeProvider(env: NodeJS.ProcessEnv, model: ModelRef): ClaudeProvider {
  const named = `${model.provider}/${model.modelId}`;
  if (model.provider === "openrouter" && model.modelId.startsWith("anthropic/")) {
    const own = claudeModelId({ provider: "anthropic", modelId: model.modelId.slice("anthropic/".length) });
    return { origin: OPENROUTER_BASE, credential: openRouterKey(env, "claude-agent", named), auth: "bearer", modelId: own, priceModel: { provider: "openrouter", id: `anthropic/${openRouterName(own)}` } };
  }
  if (model.provider !== "anthropic") throw new HarnessUnavailable(`claude-agent runs Anthropic models; the run's model is ${named}.`);
  const own = claudeModelId(model);
  if (openRouterOnly("claude-agent", env)) return { origin: OPENROUTER_BASE, credential: openRouterKey(env, "claude-agent", named), auth: "bearer", modelId: own, priceModel: { provider: "openrouter", id: `anthropic/${openRouterName(own)}` } };
  if (!env.ANTHROPIC_API_KEY) throw new HarnessUnavailable(env.ANTHROPIC_BASE_URL ? "claude-agent needs ANTHROPIC_API_KEY." : "claude-agent needs ANTHROPIC_API_KEY, or OPENROUTER_API_KEY to run Anthropic's models through OpenRouter.");
  const origin = env.ANTHROPIC_BASE_URL ? gatewayBase("ANTHROPIC_BASE_URL", env.ANTHROPIC_BASE_URL) : "https://api.anthropic.com";
  return { origin, credential: () => env.ANTHROPIC_API_KEY ?? "", auth: "x-api-key", modelId: own, priceModel: { provider: "anthropic", id: own } };
}

/** Anthropic's own model id, the model id with dots as dashes: Anthropic's ids hold no dot, and OpenRouter names the same
 *  models with dots (anthropic/claude-sonnet-5.5), so a revision may name either, and the catalog prices them by
 *  Anthropic's id. */
export function claudeModelId(model: ModelRef): string {
  return model.provider === "anthropic" ? model.modelId.replaceAll(".", "-") : model.modelId;
}

/** OpenRouter's name for Anthropic's model `id` (Anthropic's own), as its catalog and pi-ai's list it: the version's
 *  last two numbers joined by a dot (claude-sonnet-5-5 is claude-sonnet-5.5; claude-opus-5 stays). */
export const openRouterName = (id: string): string => id.replace(/-(\d+)-(\d+)$/, "-$1.$2");

/** The catalog entry a claude-agent run on `model` is priced and capped by: claudeProvider's, or the model's own where
 *  claude-agent does not run here (its run is refused before any request). */
export function claudePriceModel(env: NodeJS.ProcessEnv, model: ModelRef): ModelRef {
  try {
    const { priceModel } = claudeProvider(env, model);
    return { provider: priceModel.provider, modelId: priceModel.id };
  } catch {
    return { ...model, modelId: claudeModelId(model) };
  }
}

/** claude-agent's model: the revision's (or the server's default for claude-agent, hostModel) as `provider/model-id`.
 *  Never the gateway's model, which serves the other harnesses. An Anthropic model (`anthropic/<id>`) is Anthropic's
 *  own id, dots as dashes, except where claude-agent reaches Anthropic only through OpenRouter (openRouterOnly), where it
 *  keeps the name it was given (OpenRouter's dotted one, as capabilities show it): claudeProvider names the id on the
 *  wire and the catalog entry that prices it. OpenRouter's name for an Anthropic model (pi's,
 *  `openrouter/anthropic/<id>`) runs through OpenRouter. Whether it is an Anthropic model is claudeProvider's to say. */
export function claudeModel(env: NodeJS.ProcessEnv, ref: string | undefined): { model: ModelRef } | { why: string; host: boolean } {
  const named = ref ?? hostModel(env, "default", "claude-agent");
  if (!named) return { why: "No model yet for claude-agent: add an OpenRouter or Anthropic key in Settings → Model keys, or set OPENROUTER_API_KEY or ANTHROPIC_API_KEY where AgentRun starts.", host: true };
  const slash = named.indexOf("/");
  if (slash < 1) return { why: `claude-agent runs a model named anthropic/<model-id>; the run's model is ${named}.`, host: ref === undefined };
  const [provider, modelId] = [named.slice(0, slash), named.slice(slash + 1)];
  // OpenRouter's name for a model is OpenRouter's provider, then the vendor's model; another vendor's is claudeProvider's
  // to refuse.
  const [vendor, id, ...more] = modelId.split("/");
  if (provider === "openrouter" && id && !more.length) return { model: { provider, modelId: vendor === "anthropic" ? `anthropic/${openRouterName(claudeModelId({ provider: vendor, modelId: id }))}` : modelId } };
  // One provider, then the model's own id: a second segment (anthropic/anthropic/<model>, once a workaround) is refused
  // by name, never sent on to fail at the provider.
  if (modelId.includes("/")) return { why: `claude-agent runs a model named ${provider}/<model-id>; ${named} names more than one segment: name it ${provider}/${modelId.slice(modelId.lastIndexOf("/") + 1)}.`, host: ref === undefined };
  if (provider === "anthropic" && openRouterOnly("claude-agent", env)) return { model: { provider, modelId } };
  // Anthropic's own id from here on, so the cap's model lookup, the price and the wire all name one model the catalog
  // knows: a dotted name (OpenRouter's) would find no model under anthropic, and a cap with no model would admit nothing
  // it could price.
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
    throw new HarnessUnavailable(`claude-agent is not installed here: ${INSTALL["claude-agent"]}`);
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
    // The CLI runs Anthropic's own id, which it knows the limits and betas of, and sends it as it is, OpenRouter too
    // (claudeProvider's modelId); the key goes as the endpoint takes it, and the run is priced by the catalog entry of
    // whoever bills it (its priceModel).
    const endpoint = provider ? { origin: provider.origin, credential: provider.credential, auth: provider.auth } : { origin: "", credential: () => "" };
    const priced = provider ? { ...needs, model: { provider: provider.priceModel.provider, modelId: provider.priceModel.id } } : native;
    // The skills only when there are some: with none, the adapter keeps its Skill tool off.
    adapter = claude.claudeAgentAdapter({ model: { default: provider?.modelId ?? native.model.modelId }, provider: endpoint, price: priceOf(priced), log: harnessLog("claude-agent", env), ...(needs.confine ? { confine: needs.confine } : {}), ...(needs.skills?.length ? { skills: needs.skills } : {}), ...nativeOptions("claude-agent", env) });
  } catch (error) {
    const message = (error as Error).message;
    const said = message.includes("npm install") ? message : `${message} (${INSTALL["claude-agent"]})`;
    throw new HarnessUnavailable(claude.CLAUDE_AGENT_SDK_INSTALL && claude.CLAUDE_AGENT_SDK_VERSION ? installHint(said, claude.CLAUDE_AGENT_SDK_INSTALL, `@anthropic-ai/claude-agent-sdk@${claude.CLAUDE_AGENT_SDK_VERSION}`, npx) : said);
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
    throw new HarnessUnavailable(`codex is not installed here: ${INSTALL.codex}`);
  });
  const standIn = env[CODEX_STANDIN_ENV] ? (JSON.parse(env[CODEX_STANDIN_ENV]) as { command: string; args?: string[]; env?: Record<string, string> }) : undefined;
  if (!standIn) {
    try {
      codex.verifyCodex();
    } catch (error) {
      const message = (error as Error).message;
      const said = message.includes("npm install") ? message : `${message} (${INSTALL.codex})`;
      throw new HarnessUnavailable(installHint(said, codex.CODEX_INSTALL, `@openai/codex@${codex.CODEX_VERSION}`, npx));
    }
  }
  // The id as the provider's endpoint names it (codexProvider): a gateway's own name for the model as model.ts chose it,
  // whole (AGENT_MODEL_GATEWAY_IDS says whether it is provider-qualified), OpenAI's model id, which chooseModel has
  // already taken out of "openai/<id>", or OpenRouter's whole slug.
  const provider = codexProvider(env, needs.model);
  return codex.codexAdapter({ model: provider.modelId, provider: { origin: provider.origin, credential: provider.credential }, price: priceOf(needs), log: harnessLog("codex", env), ...(nativeOptions("codex", env).webSearch === "live" ? { webSearch: "live" as const } : {}), ...(needs.confine ? { confine: needs.confine } : {}), ...(standIn ? { standIn } : {}) });
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
 *  check of the model `given` names (with none, a model of the harness's own provider: whether it runs here at all). */
export async function harnessReason(harness: string, env: NodeJS.ProcessEnv, given: AdapterNeeds | undefined): Promise<string | undefined> {
  if (env[FAUX_HARNESS_ENV]) return undefined;
  const needs = given ?? { model: { provider: harness === "claude-agent" ? "anthropic" : "openai", modelId: "default" }, models: { getModel: () => undefined } };
  try {
    const adapter = await adapterFor(harness, env, needs);
    const problems = adapter.check({ key: "capabilities", label: "capabilities", system: [], tools: [], context: "fresh" });
    return problems.length ? problems.join(" ") : undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
