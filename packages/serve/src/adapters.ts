// The adapter a harness id runs on, and whether this server can run it. With a faux harness module (FAUX_HARNESS_ENV)
// every id runs on run-adapters' faux harness, scripted by the module's `script(spec)`, as `--faux` runs pi on the
// faux model. Otherwise codex runs on @parcha/agentrun-codex and claude-agent on @parcha/agentrun-claude-agent, each
// with serve's own model, price and endpoint, under the run's confinement; a package or a pinned CLI that is missing
// says so with the one line that installs it.
import { pathToFileURL } from "node:url";
import type { AgentAdapter, SessionSpec } from "@parcha/agentrun-adapters";
import { FAUX_HARNESS_ENV } from "./harness.js";
import type { ModelRef } from "./model.js";

/** The one line that installs each harness beside serve. */
export const INSTALL: Record<string, string> = {
  "claude-agent": "npm install @parcha/agentrun-claude-agent @anthropic-ai/claude-agent-sdk@0.3.286 zod",
  codex: "npm install @parcha/agentrun-codex @openai/codex@0.164.0",
};

/** For tests: a JSON `{command, args?, env?}` that speaks Codex's app-server protocol in place of Codex. agentrun-codex
 *  takes it only under its own guard (AGENTRUN_CODEX_STANDIN=1, under a test runner). */
export const CODEX_STANDIN_ENV = "AGENTRUN_SERVE_CODEX_STANDIN";

/** Why this server cannot run a harness here, in words a person can act on. */
export class HarnessUnavailable extends Error {}

type ModelCost = { input: number; output: number; cacheRead: number; cacheWrite: number };
/** A child's command under the run's confinement (pi-durable-disk's confinePrefix): only added in front. */
export type ConfineChild = (child: Readonly<{ command: string; args: string[] }>) => { command: string; args: string[] };
/** What a run's adapter needs of serve: its model, the catalog that prices it as it prices pi's runs, and the run's
 *  confinement for the harness's own process. */
export type AdapterNeeds = { model: ModelRef; models: { getModel(provider: string, id: string): { cost?: Partial<ModelCost> } | undefined }; confine?: ConfineChild };

/** The ConfineChild that starts a child under `prefix` (the argv pi's commands start under, ending in "--"); none when
 *  the run confines nothing, since an adapter refuses a confinement that adds nothing. */
export function confineOf(prefix: readonly string[]): ConfineChild | undefined {
  if (!prefix.length) return undefined;
  return (child) => ({ command: prefix[0]!, args: [...prefix.slice(1), child.command, ...child.args] });
}

/** Where Codex's model requests go: OpenAI with its key, or a gateway at its origin (the proxy sends the Responses API
 *  to origin + /v1/responses, so a gateway under another path cannot be reached yet). */
export function codexProvider(env: NodeJS.ProcessEnv, model: ModelRef): { origin: string; credential: () => string } {
  if (env.AGENT_MODEL_BASE_URL) {
    const url = new URL(env.AGENT_MODEL_BASE_URL);
    const path = url.pathname.replace(/\/+$/, "");
    if (path !== "" && path !== "/v1") throw new HarnessUnavailable(`codex sends the Responses API to the gateway's origin + /v1/responses; AGENT_MODEL_BASE_URL has the path ${path}, which it cannot reach yet.`);
    return { origin: url.origin, credential: () => env.AGENT_MODEL_API_KEY || "none" };
  }
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

/** Where claude-agent's requests go: Anthropic Messages only, at ANTHROPIC_BASE_URL's origin (an Anthropic-compatible
 *  endpoint) or api.anthropic.com, with ANTHROPIC_API_KEY. Its own settings only: AGENT_MODEL_BASE_URL is the other
 *  harnesses' gateway, and Claude's requests never go there. */
export function claudeProvider(env: NodeJS.ProcessEnv, model: ModelRef): { origin: string; credential: () => string } {
  if (model.provider !== "anthropic") throw new HarnessUnavailable(`claude-agent runs Anthropic models; the run's model is ${model.provider}/${model.modelId}.`);
  if (!env.ANTHROPIC_API_KEY) throw new HarnessUnavailable("claude-agent needs ANTHROPIC_API_KEY.");
  let origin = "https://api.anthropic.com";
  if (env.ANTHROPIC_BASE_URL) {
    const url = new URL(env.ANTHROPIC_BASE_URL);
    if (url.pathname.replace(/\/+$/, "") !== "") throw new HarnessUnavailable(`claude-agent sends Anthropic Messages to the endpoint's origin + /v1/messages; ANTHROPIC_BASE_URL has the path ${url.pathname}, which it cannot reach yet.`);
    origin = url.origin;
  }
  return { origin, credential: () => env.ANTHROPIC_API_KEY ?? "" };
}

/** claude-agent's model: the revision's (or the server's default) as `provider/model-id`, its price from pi-ai's
 *  catalog. Never the gateway's model or price, which serve the other harnesses. Whether it is an Anthropic model is
 *  claudeProvider's to say. */
export function claudeModel(env: NodeJS.ProcessEnv, ref: string | undefined): { model: ModelRef } | { why: string; host: boolean } {
  const named = ref ?? env.AGENT_MODEL;
  if (!named) return { why: "The revision names no model, and this host has no default: name an anthropic/<model-id> in the definition.", host: true };
  const slash = named.indexOf("/");
  if (slash < 1) return { why: `claude-agent runs a model named anthropic/<model-id>; the run's model is ${named}.`, host: ref === undefined };
  return { model: { provider: named.slice(0, slash), modelId: named.slice(slash + 1) } };
}

/** The package that runs claude-agent, imported by a name the build does not resolve: it is installed beside serve
 *  only by the person who wants it (its SDK is an optional peer). */
const CLAUDE_PACKAGE = "@parcha/agentrun-claude-agent";

/** claude-agent's adapter, from `load` (the installed package; a test gives its own). */
export async function claudeOf(env: NodeJS.ProcessEnv, needs: AdapterNeeds, load: () => Promise<unknown> = () => import(CLAUDE_PACKAGE)): Promise<AgentAdapter> {
  const claude = (await load().catch(() => {
    throw new HarnessUnavailable(`claude-agent is not installed here: ${INSTALL["claude-agent"]}`);
  })) as { claudeAgentAdapter(options: Record<string, unknown>): AgentAdapter };
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
    adapter = claude.claudeAgentAdapter({ model: { default: needs.model.modelId }, provider: provider ?? { origin: "", credential: () => "" }, price: priceOf(needs), ...(needs.confine ? { confine: needs.confine } : {}) });
  } catch (error) {
    const message = (error as Error).message;
    throw new HarnessUnavailable(message.includes("npm install") ? message : `${message} (${INSTALL["claude-agent"]})`);
  }
  if (refused !== undefined) throw refused;
  return adapter;
}

/** The run's thinking level as the harness takes it: serve's levels run to max; Codex's reasoning efforts stop at xhigh. */
export const thinkingFor = (harness: string, level: string): SessionSpec["thinking"] => (harness === "codex" && level === "max" ? "xhigh" : level) as SessionSpec["thinking"];

/** The bare id Codex takes: serve's "openai/<id>" without its provider. */

async function codexOf(env: NodeJS.ProcessEnv, needs: AdapterNeeds): Promise<AgentAdapter> {
  const codex = await import("@parcha/agentrun-codex").catch(() => {
    throw new HarnessUnavailable(`codex is not installed here: ${INSTALL.codex}`);
  });
  const standIn = env[CODEX_STANDIN_ENV] ? (JSON.parse(env[CODEX_STANDIN_ENV]) as { command: string; args?: string[]; env?: Record<string, string> }) : undefined;
  if (!standIn) {
    try {
      codex.verifyCodex();
    } catch (error) {
      const message = (error as Error).message;
      throw new HarnessUnavailable(message.includes("npm install") ? message : `${message} (${INSTALL.codex})`);
    }
  }
  // The id as model.ts chose it: a gateway's own name for the model, whole (AGENT_MODEL_GATEWAY_IDS says whether it is
  // provider-qualified), or OpenAI's model id, which chooseModel has already taken out of "openai/<id>".
  return codex.codexAdapter({ model: needs.model.modelId, provider: codexProvider(env, needs.model), price: priceOf(needs), ...(needs.confine ? { confine: needs.confine } : {}), ...(standIn ? { standIn } : {}) });
}

export async function adapterFor(harness: string, env: NodeJS.ProcessEnv, needs: AdapterNeeds): Promise<AgentAdapter> {
  const faux = env[FAUX_HARNESS_ENV];
  if (faux) {
    const [{ fauxAdapter }, module] = await Promise.all([import("@parcha/agentrun-adapters/testing"), import(pathToFileURL(faux).href) as Promise<{ script?: (spec: SessionSpec) => never[] }>]);
    if (typeof module.script !== "function") throw new Error(`${FAUX_HARNESS_ENV} names ${faux}, which exports no script(spec)`);
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
