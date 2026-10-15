// The agent app of the web example: `pi-durable-disk run --dir <home>/runs/<id> --app examples/web/agent/app.ts --serve 0`
// loads it (start-run.mjs does that) on a run that `startRun` of @parcha/pi-durable-agent created in the agent home. It
// reads the agent's definition and skills from the home and returns pi-durable's Harness options: the model the host
// picks, the workspace's file tools, a Browserbase browser on the agent's saved sign-in, and `request_sign_in`, which
// ends the agent's turn while the person signs in.
//
// The sign-in is the run store's `browser.profiles` entry, which `startRun` seeded from the home and `carryBack` returns
// to it: the Browserbase context id, resolved before the run serves anything. The serve door creates the root
// conversation on the first request, with the definition's prompt and tools and the browser's configuration in the
// commit that creates it. `live.json` beside the run, outside `work/` (the only place the model's file tools reach),
// holds the browser's live view for the person's page. Neither the context id nor the live view enters a model-visible
// string.
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { ModelThinkingLevel, TSchema } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type ConversationId, type Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { DEFAULT_BROWSER_POLICY, type BrowserPolicy, type EvidenceRecord, type SessionChange, type SessionRow } from "@parcha/pi-browser";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { stagehandDriver } from "@parcha/pi-browser/driver/stagehand";
import { browserbaseProvider } from "@parcha/pi-browser/providers/browserbase";
import { durableProfileStore, openAgentHome, readAgentHome, type AgentDefinition, type AgentHomeState } from "@parcha/pi-durable-agent";
import { ArchilCodingTools, recordWake, type AppContext, type AppOptions } from "@parcha/pi-durable-disk";

const THINKING: readonly ModelThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
/** Long enough for a person to sign in in the live view while the agent's turn has ended. */
const IDLE_RELEASE_S = 900;
const MODEL_PROVIDER = "agent-model";
/** The agent's one browser profile: a Browserbase context holds the sign-ins of every site. */
export const PROFILE = "default";

/** The definition's instructions, then each skill it names (`<name>/SKILL.md` in the home), in order. */
export function promptOf(state: Pick<AgentHomeState, "definition" | "skills">): string {
  const skills = state.definition.skills.map((name) => {
    const file = state.skills[`${name}/SKILL.md`];
    if (!file) throw new Error(`the definition names the skill ${name}, and the agent home has no ${name}/SKILL.md`);
    return `<skill name="${name}">\n${file.content.trim()}\n</skill>`;
  });
  return [state.definition.instructions.trim(), ...(skills.length ? ["Your skills follow. Use the one that fits the step you are on.", ...skills] : [])].join("\n\n");
}

/** Each tool name is a tool or a whole extension; every name must resolve. */
export function toolsOf(definition: Pick<AgentDefinition, "tools">, available: Record<string, readonly ToolRegistration[]>): ToolRegistration[] {
  const byName = new Map(Object.values(available).flat().map((tool) => [tool.name, tool]));
  const picked = definition.tools.flatMap((name) => {
    const found = available[name] ?? (byName.has(name) ? [byName.get(name)!] : undefined);
    if (!found) throw new Error(`the definition names the tool ${name}, which this host does not have (it has ${[...Object.keys(available), ...byName.keys()].join(", ")})`);
    return found;
  });
  return [...new Map(picked.map((tool) => [tool.name, tool])).values()];
}

// ---- the sign-in hand-over ------------------------------------------------------------------------------------------------

/** What the person's page shows while the agent waits: the result of `request_sign_in`, the last item of an idle run. */
export const signInAsked = (site: string) => `Asked the person to sign in to ${site.slice(0, 200)} in the live view; waiting for them to reply done.`;

/**
 * The agent asks for a sign-in and its turn ends: the result terminates the run, so no tool (and no browser call) runs
 * while the person signs in, until their next message.
 */
export const requestSignIn = defineTool({
  name: "request_sign_in",
  description: "Ask the person to sign in to a site themselves, in the live view of your browser. Call it alone, once the site's sign-in page is open in your browser. It ends your turn; the person replies when they are done.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      site: { type: "string", minLength: 1, description: "The site's address or name." },
      reason: { type: "string", minLength: 1, description: "One sentence: what the sign-in is for." },
    },
    required: ["site", "reason"],
  } as unknown as TSchema,
  replay: "safe",
  execute: async (args) => {
    const { site, reason } = args as { site: string; reason: string };
    return { content: [{ type: "text", text: signInAsked(site) }], details: { site, reason }, control: { terminate: true } };
  },
});

const SignInHandover = defineExtension({ name: "sign-in", tools: [requestSignIn] });

// ---- the browser profile -----------------------------------------------------------------------------------------------

/** A new Browserbase context, the browser profile a sign-in is saved in. */
async function createContext(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const base = (env.BROWSERBASE_BASE_URL || "https://api.browserbase.com").replace(/\/+$/, "");
  const response = await fetch(`${base}/v1/contexts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bb-api-key": env.BROWSERBASE_API_KEY ?? "" },
    body: JSON.stringify(env.BROWSERBASE_PROJECT_ID ? { projectId: env.BROWSERBASE_PROJECT_ID } : {}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) throw new Error(`Browserbase refused to create a context: HTTP ${response.status}`);
  const { id } = (await response.json()) as { id?: unknown };
  if (typeof id !== "string" || !id) throw new Error("Browserbase created a context without an id");
  return id;
}

// ---- host files ----------------------------------------------------------------------------------------------------------

/** Replaced whole, mode 0600: a reader never sees half a file. */
async function writePrivate(path: string, value: unknown): Promise<void> {
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(partial, path);
}

/** `live.json` for the page: the session's live view while it is open, null once it is released. */
export function liveOf(row: SessionRow, change: SessionChange, at = new Date()) {
  const view = change === "released" ? null : row.liveView;
  return { liveViewUrl: view?.fullscreen ?? view?.framed ?? null, sessionId: row.session.resourceId, change, updatedAt: at.toISOString() };
}

// ---- the model -----------------------------------------------------------------------------------------------------------

/** An OpenAI Responses endpoint the host names in its environment. */
function modelsOf(env: NodeJS.ProcessEnv) {
  const baseUrl = env.AGENT_MODEL_BASE_URL?.replace(/\/+$/, "");
  const id = env.AGENT_MODEL;
  if (!baseUrl || !id) throw new Error("set AGENT_MODEL_BASE_URL (an OpenAI Responses endpoint) and AGENT_MODEL (its model id)");
  // USD per million input, output, cache-read and cache-write tokens (cache writes default to the input rate), so the
  // run's usage has a price; unset, it is $0.
  const [input = 0, output = 0, cacheRead = 0, cacheWrite = input] = (env.AGENT_MODEL_PRICE || "0").split(",").map(Number);
  if (![input, output, cacheRead, cacheWrite].every((rate) => rate >= 0)) throw new Error("AGENT_MODEL_PRICE is input,output,cacheRead[,cacheWrite] in USD per million tokens");
  const models = createModels();
  models.setProvider(createProvider({
    id: MODEL_PROVIDER,
    baseUrl,
    auth: { apiKey: { name: "AGENT_MODEL_API_KEY", resolve: async () => ({ auth: { apiKey: env.AGENT_MODEL_API_KEY || "none" }, source: "AGENT_MODEL_API_KEY" }) } },
    models: [{
      id, name: id, api: "openai-responses", provider: MODEL_PROVIDER, baseUrl, reasoning: true, input: ["text", "image"],
      cost: { input, output, cacheRead, cacheWrite }, contextWindow: 128_000, maxTokens: 32_000,
      // `system`, not `developer`: every Responses-compatible endpoint takes it.
      compat: { supportsDeveloperRole: false },
    }],
    api: openAIResponsesApi(),
  }));
  const thinking = (env.AGENT_THINKING || "medium") as ModelThinkingLevel;
  if (!THINKING.includes(thinking)) throw new Error(`AGENT_THINKING must be one of ${THINKING.join(", ")}; thinking is never off`);
  return { models, model: { provider: MODEL_PROVIDER, modelId: id }, thinking };
}

// ---- the app -------------------------------------------------------------------------------------------------------------

/**
 * The run's Harness options, and the browser extension they install (its documents name what the run holds). The run is
 * `<home>/runs/<id>`; `AGENT_HOME` names the home when it is elsewhere. `makeContext` makes a new browser profile, a
 * Browserbase context by default.
 */
export async function createAgent(where: AppContext, env: NodeJS.ProcessEnv = process.env, { makeContext = (signal: AbortSignal) => createContext(env, signal) } = {}) {
  if (!env.BROWSERBASE_API_KEY) throw new Error("set BROWSERBASE_API_KEY");
  const state = await readAgentHome(await openAgentHome(resolve(env.AGENT_HOME || join(where.root, "..", ".."))));
  const { definition } = state;
  const instructions = promptOf(state);
  const { models, model, thinking } = modelsOf(env);
  // Resolved before the run serves: the root conversation's creating commit carries it.
  let contextId: string | undefined;
  const live = join(where.root, "live.json");
  let liveWrites = Promise.resolve();
  const provider = browserbaseProvider({ env });

  const browser = createBrowserExtension({
    provider: () => provider,
    driver: stagehandDriver(),
    // Each read the model cites is filed in the workspace, named by its hash, so a read replayed after a crash files the
    // same path again.
    evidence: {
      async file(label: string, record: EvidenceRecord) {
        const body = typeof record.body === "string" ? record.body : Buffer.from(record.body).toString("base64");
        const text = JSON.stringify({ ...record, body }, null, 2);
        const path = join("evidence", label, `${record.tool}-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.json`);
        await mkdir(join(where.work, "evidence", label), { recursive: true });
        await writeFile(join(where.work, path), text);
        return { path };
      },
    },
    redact: { values: () => (contextId ? [contextId] : []) },
    // In the order the changes came: a release written before a late launch would show a dead view.
    onSession: (row, change) => void (liveWrites = liveWrites.then(() => writePrivate(live, liveOf(row, change))).catch(() => undefined)),
  });
  const registry = createRegistry();
  for (const extension of [ArchilCodingTools, browser.extension, SignInHandover]) registry.install(extension);
  const tools = toolsOf(definition, { [ArchilCodingTools.name]: ArchilCodingTools.tools ?? [], browser: browser.tools, [SignInHandover.name]: [requestSignIn] });

  /** Every session the run still holds is released (Browserbase saves the context then), and the releases finish. */
  async function releaseBrowsers(harness: Harness, context: Context): Promise<void> {
    const rows = Object.values((await harness.snapshot(browser.docs.Inventory, context))?.rows ?? {}).filter((row) => row.state === "creating" || row.state === "live");
    for (const conversationId of new Set(rows.map((row) => row.conversationId))) {
      const conversation = await harness.conversation(conversationId as ConversationId, context);
      if (conversation) await browser.release(conversation, "close", context);
    }
    await browser.drain(harness, context, AbortSignal.timeout(25_000));
    await browser.close();
  }

  const options: AppOptions = {
    models,
    registry,
    // Before anything is served: the agent's browser profile from the run store (`startRun` seeded it from the home), or a
    // new one committed there for `carryBack` to return to the home. Then a run that a killed process left with a live
    // session finds it again, or learns that it ended.
    beforeResume: async ({ harness, context }) => {
      contextId = await durableProfileStore(harness).resolve(PROFILE, makeContext);
      await browser.reconcile(harness, () => true, context);
    },
    root: {
      agent: { model, thinkingLevel: thinking, instructions, tools },
      init: async (tx, id) => {
        if (!contextId) throw new Error("the browser profile is resolved before the root conversation is created");
        const policy: BrowserPolicy = { ...DEFAULT_BROWSER_POLICY, contextId, idleReleaseS: IDLE_RELEASE_S };
        Object.assign(await tx.doc(browser.docs.Config, id), { label: definition.id, run: where.ref.id, policy });
      },
    },
    // On SIGTERM the instance records its wake and lets go of the run; the browser goes first, so nothing paid stays open.
    wake: async (run, at) => {
      await releaseBrowsers(run.harness, BACKGROUND_CONTEXT).catch(() => undefined);
      await recordWake(run, at);
    },
  };
  return { options, browser };
}

export default async function app(where: AppContext): Promise<AppOptions> {
  return (await createAgent(where)).options;
}
