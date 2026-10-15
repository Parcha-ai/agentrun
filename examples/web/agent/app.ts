// The agent app of the web example: `pi-durable-disk run --dir <runs>/<id> --app examples/web/agent/app.ts --serve 0`
// loads it (start-run.mjs does that). It reads the agent's definition (agent.json) and skills from this directory and
// returns pi-durable's Harness options: the model the host picks, the workspace's file tools, and a Browserbase browser
// whose context is the agent's, so a sign-in made in one run is still there in the next.
//
// The serve door creates the root conversation on the first request, with the definition's prompt and tools and the
// browser's configuration in the commit that creates it. Two host files sit beside the run and outside `work/`, the only
// place the model's file tools reach: `live.json`, the browser's live view for the page to show the person, and the
// agent home's `browser.json`, the context id. Neither ever enters a model-visible string.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createRegistry, type ConversationId, type Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { DEFAULT_BROWSER_POLICY, type BrowserPolicy, type EvidenceRecord, type SessionChange, type SessionRow } from "@parcha/pi-browser";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { stagehandDriver } from "@parcha/pi-browser/driver/stagehand";
import { browserbaseProvider } from "@parcha/pi-browser/providers/browserbase";
import { ArchilCodingTools, recordWake, type AppContext, type AppOptions } from "@parcha/pi-durable-disk";

/** The agent definition's fields. The host picks the model; the definition never names one. */
export type AgentDefinition = {
  id: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  skills: string[];
  tools: string[];
  input_schema: Record<string, unknown> | null;
  output_schema: Record<string, unknown> | null;
  workflow: Record<string, unknown> | null;
  max_cost_usd: number | null;
};

/** A sign-in the agent keeps between runs. Tonight it is the Browserbase context id alone. */
export type SignIn = { contextId: string };

const AGENT_DIR = import.meta.dirname;
const THINKING: readonly ModelThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
/** Long enough for a person to sign in in the live view while the agent's turn has ended. */
const IDLE_RELEASE_S = 900;
const MODEL_PROVIDER = "agent-model";

export async function loadDefinition(dir = AGENT_DIR): Promise<AgentDefinition> {
  const raw = JSON.parse(await readFile(join(dir, "agent.json"), "utf8")) as Record<string, unknown>;
  const text = (name: string) => {
    if (typeof raw[name] !== "string" || !raw[name]) throw new Error(`agent.json: ${name} must be a non-empty string`);
    return raw[name] as string;
  };
  const names = (name: string) => {
    const value = raw[name];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(item))) {
      throw new Error(`agent.json: ${name} must be a list of lower-case names`);
    }
    return value as string[];
  };
  const schema = (name: string) => {
    const value = raw[name] ?? null;
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error(`agent.json: ${name} must be an object or null`);
    return value as Record<string, unknown> | null;
  };
  if ("model" in raw) throw new Error("agent.json: a definition names no model; the host picks it");
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) throw new Error("agent.json: version must be a positive integer");
  const cost = raw.max_cost_usd ?? null;
  if (cost !== null && (typeof cost !== "number" || !(cost > 0))) throw new Error("agent.json: max_cost_usd must be a positive number or null");
  return {
    id: text("id"), version: raw.version as number, name: text("name"), description: text("description"), instructions: text("instructions"),
    skills: names("skills"), tools: names("tools"), input_schema: schema("input_schema"), output_schema: schema("output_schema"), workflow: schema("workflow"),
    max_cost_usd: cost as number | null,
  };
}

/** The definition's instructions, then each skill it names, in order. */
export async function promptOf(definition: AgentDefinition, dir = AGENT_DIR): Promise<string> {
  const skills = await Promise.all(definition.skills.map(async (name) => {
    const body = await readFile(join(dir, "skills", `${name}.md`), "utf8").catch(() => {
      throw new Error(`agent.json names the skill ${name}, and skills/${name}.md is missing`);
    });
    return `<skill name="${name}">\n${body.trim()}\n</skill>`;
  }));
  return [definition.instructions.trim(), ...(skills.length ? ["Your skills follow. Use the one that fits the step you are on.", ...skills] : [])].join("\n\n");
}

/** Each tool name is a tool or a whole extension; every name must resolve. */
export function toolsOf(definition: AgentDefinition, available: Record<string, readonly ToolRegistration[]>): ToolRegistration[] {
  const byName = new Map(Object.values(available).flat().map((tool) => [tool.name, tool]));
  const picked = definition.tools.flatMap((name) => {
    const found = available[name] ?? (byName.has(name) ? [byName.get(name)!] : undefined);
    if (!found) throw new Error(`agent.json names the tool ${name}, which this host does not have (it has ${[...Object.keys(available), ...byName.keys()].join(", ")})`);
    return found;
  });
  return [...new Map(picked.map((tool) => [tool.name, tool])).values()];
}

// ---- sign-ins: a private file in the agent home. The seam pi-durable-agent's sign-ins replace. -------------------------

const signInFile = (home: string) => join(home, "browser.json");

export async function loadSignIn(home: string): Promise<SignIn | null> {
  try {
    const saved = JSON.parse(await readFile(signInFile(home), "utf8")) as Partial<SignIn>;
    return typeof saved.contextId === "string" && saved.contextId ? { contextId: saved.contextId } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Written once: a second run that raced this one keeps the sign-in that landed first. */
export async function saveSignIn(home: string, signIn: SignIn): Promise<SignIn> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await writeFile(signInFile(home), `${JSON.stringify(signIn)}\n`, { mode: 0o600, flag: "wx" });
    return signIn;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await loadSignIn(home)) ?? signIn;
  }
}

/** A new Browserbase context, the browser profile a sign-in is saved in. */
async function createContext(env: NodeJS.ProcessEnv): Promise<SignIn> {
  const base = (env.BROWSERBASE_BASE_URL || "https://api.browserbase.com").replace(/\/+$/, "");
  const response = await fetch(`${base}/v1/contexts`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bb-api-key": env.BROWSERBASE_API_KEY ?? "" },
    body: JSON.stringify(env.BROWSERBASE_PROJECT_ID ? { projectId: env.BROWSERBASE_PROJECT_ID } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Browserbase refused to create a context: HTTP ${response.status}`);
  const { id } = (await response.json()) as { id?: unknown };
  if (typeof id !== "string" || !id) throw new Error("Browserbase created a context without an id");
  return { contextId: id };
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

/** The run's Harness options, and the browser extension they install (its documents name what the run holds). */
export async function createAgent(where: AppContext, env: NodeJS.ProcessEnv = process.env, dir = AGENT_DIR) {
  if (!env.BROWSERBASE_API_KEY) throw new Error("set BROWSERBASE_API_KEY");
  const definition = await loadDefinition(dir);
  const instructions = await promptOf(definition, dir);
  const { models, model, thinking } = modelsOf(env);
  // The agent home holds what outlives a run; by default it sits beside the runs directory.
  const home = resolve(env.AGENT_HOME || join(dirname(where.root), "..", "agent-home"));
  const signIn = (await loadSignIn(home)) ?? (await saveSignIn(home, await createContext(env)));
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
    redact: { values: () => [signIn.contextId] },
    // In the order the changes came: a release written before a late launch would show a dead view.
    onSession: (row, change) => void (liveWrites = liveWrites.then(() => writePrivate(live, liveOf(row, change))).catch(() => undefined)),
  });
  const policy: BrowserPolicy = { ...DEFAULT_BROWSER_POLICY, contextId: signIn.contextId, idleReleaseS: IDLE_RELEASE_S };
  const registry = createRegistry();
  for (const extension of [ArchilCodingTools, browser.extension]) registry.install(extension);
  const tools = toolsOf(definition, { [ArchilCodingTools.name]: ArchilCodingTools.tools ?? [], browser: browser.tools });

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
    // A run that a killed process left with a live session finds it again, or learns that it ended.
    beforeResume: async ({ harness, context }) => void (await browser.reconcile(harness, () => true, context)),
    root: {
      agent: { model, thinkingLevel: thinking, instructions, tools },
      init: async (tx, id) => {
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
