// The agent app of the web example: `pi-durable-disk run --dir <home>/runs/<id> --app examples/web/agent/app.ts --serve 0`
// loads it (start-run.mjs does that) on a run that `startRun` of @parcha/pi-durable-agent created in the agent home. It
// reads the agent's definition and skills from the home and returns pi-durable's Harness options: the model the host
// picks, the workspace's file tools, a Browserbase browser on the agent's saved sign-in, and `request_sign_in`, which
// ends the agent's turn while the person signs in. With a Browserbase key it also has `web_fetch` and `web_search`,
// through Browserbase's own Fetch and Search APIs, which open no browser session; an agent that lists no browser tool
// gets those and no browser.
//
// The sign-in is the run store's `browser.profiles` entry, which `startRun` seeded from the home and `carryBack` returns
// to it: the Browserbase context id, resolved before the run serves anything, and the sites it is for. `request_sign_in`
// adds the site it asked for (`allowedOrigins`, `startUrl`), and the agent's next page there after the person answers
// sets `verifiedAt`. The serve door creates the root conversation on the first request, with the definition's prompt and
// tools and the browser's configuration in the commit that creates it. Beside the run, outside `work/` (the only place
// the model's file tools reach), `live.json` holds the browser's live view for the person's page and `frames/` what the
// browser showed (frames.ts), with nothing kept while the person drives it. Neither the context id nor the live view
// enters a model-visible string. With `RECORD_DIR` set the run is recorded as well (record.ts).
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { ModelThinkingLevel, TSchema } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineDocFamily, defineExtension, defineTool, wrapTool, type ConversationId, type Harness, type JsonObject, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { DEFAULT_BROWSER_POLICY, type BrowserPolicy, type BrowserProvider, type EvidenceRecord, type SessionChange, type SessionRow } from "@parcha/pi-browser";
import { createBrowserExtension, createWebExtension } from "@parcha/pi-browser/durable";
import { stagehandDriver } from "@parcha/pi-browser/driver/stagehand";
import { browserbaseProvider } from "@parcha/pi-browser/providers/browserbase";
import { cdpProvider } from "@parcha/pi-browser/providers/cdp";
import { frameRecorder } from "@parcha/pi-browser/recorder";
import { durableProfileStore, openAgentHome, readAgentHome, type AgentDefinition, type AgentHomeState } from "@parcha/pi-durable-agent";
import { ArchilCodingTools, type AppContext, type AppOptions } from "@parcha/pi-durable-disk";
import { browserOf, CHROME_PROFILE, listsBrowser, type BrowserKind } from "./chrome.ts";
import { frameStore } from "./frames.ts";
import { openRunRecording } from "./record.ts";
import { composePrompt, variantsOf, type PromptVariant } from "./select.ts";
import { writeRememberPage } from "./remember.ts";

const THINKING: readonly ModelThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
/** Long enough for a person to sign in in the live view while the agent's turn has ended. */
const IDLE_RELEASE_S = 900;
const MODEL_PROVIDER = "agent-model";
/** The agent's one browser profile: a Browserbase context holds the sign-ins of every site. */
export const PROFILE = "default";
/** The live frames' pace: enough to follow the agent, little to store. */
const FRAMES_PER_SECOND = 2;
/** The endpoint of an agent that lists no browser tool: nothing ever dials it (no tool of the browser is listed). */
const NO_CHROME = "http://127.0.0.1:9";

/** pi-durable-agent's `browser.profiles`, by its kind: the run's copy of the agent's saved sign-ins, which `carryBack`
 *  returns to the home. Only the host writes it, and no tool reads it. */
const Profiles = defineDocFamily<JsonObject, null>({ kind: "browser.profiles", version: 1, scope: "session", family: true, initial: () => ({}) });
/** The conversation's label, the reference host's document of the same kind: a viewer heads the run with it. Here the
 *  agent's name. */
const Label = defineDoc<{ label: string }>({ kind: "reference.label", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ label: "" }) });

/** The home's prompt variants (`agent.prompts`, by id) and the variant each run's host chose for it (`agent.runs`). */
type Prompted = { prompts?: Record<string, Omit<PromptVariant, "id">>; runs?: Record<string, { prompt?: { id: string } }> };

/** The definition's instructions; then the run's guide, the home's base prompt and the variant the host chose for run
 *  `runId` (none when it chose none); then each skill the definition names (`<name>/SKILL.md` in the home), in order. */
export function promptOf(state: Pick<AgentHomeState, "definition" | "skills"> & Prompted, runId?: string): string {
  const chosen = runId ? state.runs?.[runId]?.prompt?.id : undefined;
  const guide = chosen && state.prompts ? [composePrompt({ variants: variantsOf(state.prompts) }, chosen)] : [];
  const skills = state.definition.skills.map((name) => {
    const file = state.skills[`${name}/SKILL.md`];
    if (!file) throw new Error(`the definition names the skill ${name}, and the agent home has no ${name}/SKILL.md`);
    return `<skill name="${name}">\n${file.content.trim()}\n</skill>`;
  });
  return [state.definition.instructions.trim(), ...guide, ...(skills.length ? ["Your skills follow. Use the one that fits the step you are on.", ...skills] : [])].join("\n\n");
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

/** The site a sign-in is for: the page the browser is on, or what the agent named when that is an address. */
export function signInSite(site: string, pageUrl: string | null): { origin: string; startUrl?: string } | null {
  const page = pageUrl ? URL.parse(pageUrl) : null;
  if (page && (page.protocol === "https:" || page.protocol === "http:")) return { origin: page.origin, startUrl: `${page.origin}${page.pathname}` };
  const named = site.trim();
  if (/\s/.test(named)) return null;
  const address = /^https?:\/\//i.test(named);
  const url = URL.parse(address ? named : `https://${named}`);
  if (!url || !(url.protocol === "https:" || url.protocol === "http:") || !url.hostname.includes(".")) return null;
  return address ? { origin: url.origin, startUrl: `${url.origin}${url.pathname}` } : { origin: url.origin };
}

type Asked = (site: string, api: ToolExecutionApi, context: Context) => Promise<void>;

/**
 * The agent asks for a sign-in and its turn ends: the result terminates the run, so no tool (and no browser call) runs
 * while the person signs in, until their next message. `asked` runs first, before the result exists: whatever it does
 * before its first await happens before the run can show it waits.
 */
export const signInTool = (asked: Asked = async () => {}) => defineTool({
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
  execute: async (args, api, context) => {
    const { site, reason } = args as { site: string; reason: string };
    await asked(site, api, context);
    return { content: [{ type: "text", text: signInAsked(site) }], details: { site, reason }, control: { terminate: true } };
  },
});

export const requestSignIn = signInTool();
const SIGN_IN = "sign-in";

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

// ---- the browser: Browserbase, or the run's own Chrome -------------------------------------------------------------------

export const NO_LOCAL_VIEW = "live view not available for local Chrome yet";

/** Which browser the run drives (`AGENT_BROWSER`), and the provider options for it: a local Chrome is the one
 *  start-run.mjs started for this run, attached by its endpoint, so a release leaves it running for start-run to stop. */
export function browserOptions(env: NodeJS.ProcessEnv): { kind: "browserbase"; options: { env: NodeJS.ProcessEnv } } | { kind: "chrome"; options: { endpoint: string } } {
  const kind: BrowserKind = browserOf(env);
  if (kind === "browserbase") {
    if (!env.BROWSERBASE_API_KEY) throw new Error("set BROWSERBASE_API_KEY");
    return { kind, options: { env } };
  }
  const endpoint = env.AGENT_CHROME_ENDPOINT;
  if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error("set AGENT_CHROME_ENDPOINT to the run's Chrome on 127.0.0.1 (start-run.mjs starts it and sets it)");
  return { kind, options: { endpoint } };
}

/** pi-browser's live view, by shape: the viewer's host, and the provider wrapper that hands its URL to `onSession`. */
type LiveViewHost = {
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): Promise<void>;
};
type LiveViewModule = {
  createLiveView(options: { hostOrigin: string | null; baseUrl?: string }): LiveViewHost;
  liveViewProvider(provider: BrowserProvider, host: LiveViewHost): BrowserProvider;
};

/**
 * A local Chrome's live view, when this pi-browser has one (`./live-view`; `AGENT_LIVE_VIEW_MODULE` names another
 * module) and the page's origin is known (`AGENT_PAGE_ORIGIN`). The viewer is mounted on a loopback server of this run,
 * whose port goes into `live-host.json` (0600) beside the run; the example's server reaches it at `/live/<run id>/`, on
 * the page's own origin, which the viewer checks every WebSocket against. Null otherwise: the page says so.
 */
async function localLiveView(where: AppContext, env: NodeJS.ProcessEnv): Promise<{ wrap(provider: BrowserProvider): BrowserProvider; close(): Promise<void> } | null> {
  const origin = env.AGENT_PAGE_ORIGIN;
  if (!origin) return null;
  const specifier: string = env.AGENT_LIVE_VIEW_MODULE || "@parcha/pi-browser/live-view";
  const mod = (await import(specifier).catch(() => null)) as Partial<LiveViewModule> | null;
  if (typeof mod?.createLiveView !== "function" || typeof mod.liveViewProvider !== "function") return null;
  const host = mod.createLiveView({ hostOrigin: origin, baseUrl: `${origin}/live/${where.ref.id}` });
  const server = createServer((req, res) => void (host.handle(req, res) || res.writeHead(404).end()));
  server.on("upgrade", (req, socket, head) => void (host.upgrade(req, socket, head) || socket.destroy()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writePrivate(join(where.root, "live-host.json"), { port: (server.address() as AddressInfo).port });
  const wrap = mod.liveViewProvider;
  return {
    wrap: (provider) => wrap(provider, host),
    close: async () => {
      await host.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---- the model -----------------------------------------------------------------------------------------------------------

/** The model the host names in its environment (`AGENT_MODEL` at `AGENT_MODEL_BASE_URL`), over the API `AGENT_MODEL_API`
 *  names: `openai-responses` (the default), or `anthropic-messages` for an Anthropic model, which takes pi-ai's own entry
 *  for it (its price, its limits, its adaptive thinking with summarized display) over the Messages API at the endpoint's
 *  root (the base URL without `/v1`; the client adds `/v1/messages`). A gateway's Responses or chat completions bridge
 *  does not return Claude's thinking; its Messages API does. */
function modelsOf(env: NodeJS.ProcessEnv) {
  const baseUrl = env.AGENT_MODEL_BASE_URL?.replace(/\/+$/, "");
  const id = env.AGENT_MODEL;
  if (!baseUrl || !id) throw new Error("set AGENT_MODEL_BASE_URL (an OpenAI Responses endpoint) and AGENT_MODEL (its model id)");
  const api = env.AGENT_MODEL_API || "openai-responses";
  if (api !== "openai-responses" && api !== "anthropic-messages") throw new Error(`AGENT_MODEL_API is openai-responses or anthropic-messages, not ${api}`);
  // USD per million input, output, cache-read and cache-write tokens (cache writes default to the input rate), so the
  // run's usage has a price; unset, it is $0, or pi-ai's own price for an Anthropic model.
  const [input = 0, output = 0, cacheRead = 0, cacheWrite = input] = (env.AGENT_MODEL_PRICE || "0").split(",").map(Number);
  if (![input, output, cacheRead, cacheWrite].every((rate) => rate >= 0)) throw new Error("AGENT_MODEL_PRICE is input,output,cacheRead[,cacheWrite] in USD per million tokens");
  const auth = { apiKey: { name: "AGENT_MODEL_API_KEY", resolve: async () => ({ auth: { apiKey: env.AGENT_MODEL_API_KEY || "none" }, source: "AGENT_MODEL_API_KEY" }) } };
  const models = createModels();
  if (api === "anthropic-messages") {
    const entry = anthropicProvider().getModels().find((model) => model.id === id);
    if (!entry) throw new Error(`pi-ai has no Anthropic model ${id}`);
    const root = baseUrl.replace(/\/v1$/, "");
    const cost = env.AGENT_MODEL_PRICE ? { cost: { input, output, cacheRead, cacheWrite } } : {};
    models.setProvider(createProvider({
      id: MODEL_PROVIDER, baseUrl: root, auth,
      models: [{ ...entry, ...cost, api: "anthropic-messages", provider: MODEL_PROVIDER, baseUrl: root }],
      api: anthropicMessagesApi(),
    } as never));
  } else {
    models.setProvider(createProvider({
      id: MODEL_PROVIDER,
      baseUrl,
      auth,
      models: [{
        id, name: id, api: "openai-responses", provider: MODEL_PROVIDER, baseUrl, reasoning: true, input: ["text", "image"],
        cost: { input, output, cacheRead, cacheWrite }, contextWindow: 128_000, maxTokens: 32_000,
        // `system`, not `developer`: every Responses-compatible endpoint takes it.
        compat: { supportsDeveloperRole: false },
      }],
      api: openAIResponsesApi(),
    }));
  }
  const thinking = (env.AGENT_THINKING || "medium") as ModelThinkingLevel;
  if (!THINKING.includes(thinking)) throw new Error(`AGENT_THINKING must be one of ${THINKING.join(", ")}; thinking is never off`);
  return { models, model: { provider: MODEL_PROVIDER, modelId: id }, thinking };
}

// ---- the app -------------------------------------------------------------------------------------------------------------

/**
 * The run's Harness options, and the browser extension they install (its documents name what the run holds). The run is
 * `<home>/runs/<id>`; `AGENT_HOME` names the home when it is elsewhere. `makeContext` makes a new browser profile, a
 * Browserbase context by default; `provider` and `driver` stand in for the browser's own (a test's fakes).
 */
export async function createAgent(where: AppContext, env: NodeJS.ProcessEnv = process.env, { makeContext = (signal: AbortSignal) => createContext(env, signal), provider: given, driver = stagehandDriver(), fetcher }: { makeContext?: (signal: AbortSignal) => Promise<string>; provider?: BrowserProvider; driver?: ReturnType<typeof stagehandDriver>; fetcher?: Pick<BrowserProvider, "fetch" | "search"> } = {}) {
  const homeDir = resolve(env.AGENT_HOME || join(where.root, "..", ".."));
  const state = await readAgentHome(await openAgentHome(homeDir));
  const { definition } = state;
  const browsing = listsBrowser(definition);
  const chosen = browsing ? browserOptions(env) : ({ kind: "chrome", options: { endpoint: NO_CHROME } } as const);
  const instructions = promptOf(state as typeof state & Prompted, where.ref.id);
  const { models, model, thinking } = modelsOf(env);
  // Resolved before the run serves: the root conversation's creating commit carries it.
  let contextId: string | undefined;
  let resolved = false;
  const live = join(where.root, "live.json");
  const viewer = browsing && chosen.kind === "chrome" ? await localLiveView(where, env) : null;
  const note = chosen.kind === "chrome" && !viewer ? { note: NO_LOCAL_VIEW } : {};
  const page = { browser: chosen.kind, ...note };
  if (browsing && chosen.kind === "chrome") await writePrivate(live, { liveViewUrl: null, sessionId: null, change: "none", updatedAt: new Date().toISOString(), ...page });
  let liveWrites = Promise.resolve();
  const base = given ?? (chosen.kind === "chrome" ? cdpProvider(chosen.options) : browserbaseProvider(chosen.options));
  // `t` of every frame line is ms since the run started, so a resumed run's frames go on where they stopped; the
  // recording keeps the same clock.
  const startedAt = Date.parse(state.runs[where.ref.id]?.startedAt ?? "") || Date.now();
  const recording = env.RECORD_DIR ? await openRunRecording({ dir: resolve(env.RECORD_DIR), root: where.root, home: homeDir, started: new Date(startedAt).toISOString(), env }) : null;
  const viewed = viewer ? viewer.wrap(base) : base;
  const provider = recording ? recording.provider(viewed) : viewed;
  const frames = frameStore(where.root, () => Date.now() - startedAt, recording ? (line, bytes) => recording.frame(line, bytes) : undefined);
  const recorder = frameRecorder({ sink: frames.sink, clock: () => Date.now() - startedAt, maxFps: FRAMES_PER_SECOND });

  // ---- the sign-in's site, on the run's profile ------------------------------------------------------------------------
  // The profile the run signs in with: the Browserbase context, or a shared local Chrome profile; a Chrome profile of the
  // run's own is thrown away, so it records nothing.
  const profileKey = !browsing ? null : chosen.kind === "browserbase" ? PROFILE : env.AGENT_CHROME_PROFILE === "shared" ? CHROME_PROFILE : null;
  const pages = new Map<number, string | null>();
  let pending: { origin: string; answered: boolean } | null = null;
  let opened: Harness | undefined;
  let profileWrites = Promise.resolve();
  /** A change to the run's profile, only when the run holds it ready (another run's lease leaves it without a ref). */
  async function editProfile(target: Pick<Harness, "snapshot" | "commit">, context: Context, change: (profile: JsonObject) => void): Promise<void> {
    if (!profileKey || (await target.snapshot(Profiles, profileKey, context))?.state !== "ready") return;
    await target.commit(async (tx) => change(await tx.doc(Profiles, profileKey, null)), context);
  }
  const asked: Asked = async (site, api, context) => {
    // First, before any await: nothing the browser shows from here on is kept, until the agent's next step.
    frames.hold();
    const at = signInSite(site, pages.get(api.conversationId) ?? null);
    pending = at ? { origin: at.origin, answered: false } : null;
    if (!at) return;
    await editProfile(api, context, (profile) => {
      const origins = Array.isArray(profile.allowedOrigins) ? profile.allowedOrigins.filter((o): o is string => typeof o === "string") : [];
      profile.allowedOrigins = origins.includes(at.origin) ? origins : [...origins, at.origin];
      if (at.startUrl) profile.startUrl = at.startUrl;
    });
  };
  /** The person has answered (the agent took its next step): frames are kept again. */
  const answered = () => {
    if (!frames.held) return;
    frames.lift();
    if (pending) pending.answered = true;
  };
  /** A page the agent's browser loaded: the first on the sign-in's site after the answer verifies the sign-in. */
  function seen(url: string | null): Promise<void> {
    const origin = url ? URL.parse(url)?.origin : undefined;
    if (!pending?.answered || origin !== pending.origin || !opened) return profileWrites;
    pending = null;
    const harness = opened;
    return (profileWrites = profileWrites.then(() => editProfile(harness, BACKGROUND_CONTEXT, (profile) => void (profile.verifiedAt = new Date().toISOString()))).catch(() => undefined));
  }

  // Each read the model cites is filed in the workspace, named by its hash, so a read replayed after a crash files the
  // same path again.
  const evidence = {
    async file(label: string, record: EvidenceRecord) {
      if (record.status === "ok") void seen(record.facts.final_url ?? null);
      const body = typeof record.body === "string" ? record.body : Buffer.from(record.body).toString("base64");
      const text = JSON.stringify({ ...record, body }, null, 2);
      const path = join("evidence", label, `${record.tool}-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.json`);
      await mkdir(join(where.work, "evidence", label), { recursive: true });
      await writeFile(join(where.work, path), text);
      return { path };
    },
  };
  const keys = [env.BROWSERBASE_API_KEY, env.BROWSERBASE_PROJECT_ID].filter((value): value is string => Boolean(value));
  const browser = createBrowserExtension({
    provider: ({ conversationId }) => recorder.watch(provider, conversationId),
    driver,
    evidence,
    redact: { values: () => (contextId ? [contextId] : []) },
    // In the order the changes came: a release written before a late launch would show a dead view.
    onSession: (row, change) => {
      pages.set(row.conversationId, row.session.lastUrl);
      if (change === "updated") void seen(row.session.lastUrl);
      liveWrites = liveWrites.then(() => writePrivate(live, { ...liveOf(row, change), ...page })).catch(() => undefined);
    },
  });
  // Fetch and search with no browser session: Browserbase's own APIs, on the key. Without one the tools are not listed.
  const keyed = fetcher ?? (env.BROWSERBASE_API_KEY ? browserbaseProvider({ env }) : null);
  const web = createWebExtension({
    providers: keyed ? { name: "browserbase", fetch: keyed.fetch && ((request, signal) => keyed.fetch!(request, signal)), search: keyed.search && ((request, signal) => keyed.search!(request, signal)) } : {},
    evidence,
    redact: { values: () => keys },
  });
  const signIn = signInTool(asked);
  const tools = toolsOf(definition, { [ArchilCodingTools.name]: ArchilCodingTools.tools ?? [], browser: browser.tools, web: web.tools, [SIGN_IN]: [signIn] });
  // request_sign_in ends the turn, so the agent's next tool call comes after the person's next message: each of its
  // other tools ends the hold first.
  const afterAnswer = (tool: ToolRegistration): ToolRegistration => ({ ...tool, execute: (args, api, context) => (answered(), tool.execute(args, api, context)) });
  const handover = defineExtension({ name: SIGN_IN, tools: [signIn], wraps: tools.filter((tool) => tool.name !== signIn.name).map((tool) => wrapTool(tool, afterAnswer)) });
  const registry = createRegistry();
  for (const extension of [ArchilCodingTools, browser.extension, web.extension, handover]) registry.install(extension);

  /** Every session the run still holds is released (Browserbase saves the context then), and the releases finish. */
  async function releaseBrowsers(harness: Harness, context: Context): Promise<void> {
    const rows = Object.values((await harness.snapshot(browser.docs.Inventory, context))?.rows ?? {}).filter((row) => row.state === "creating" || row.state === "live");
    for (const conversationId of new Set(rows.map((row) => row.conversationId))) {
      const conversation = await harness.conversation(conversationId as ConversationId, context);
      if (conversation) await browser.release(conversation, "close", context);
    }
    await browser.drain(harness, context, AbortSignal.timeout(25_000));
    await browser.close();
    await viewer?.close();
    await recorder.close();
    await Promise.all([frames.flush(), profileWrites]);
  }

  const options: AppOptions = {
    models,
    registry,
    // Before anything is served: the agent's browser profile from the run store (`startRun` seeded it from the home), or a
    // new one committed there for `carryBack` to return to the home. Then a run that a killed process left with a live
    // session finds it again, or learns that it ended.
    // A local Chrome's profile is a directory of the home: the run that opened it records it, so `carryBack` gives the
    // home the profile and its save lease decides the next run that may open it.
    // A recorded run learns its saved profile's id, then takes its snapshot at the hook's head before anything here commits.
    beforeResume: async (run) => {
      const { harness, context } = run;
      opened = harness;
      if (recording) {
        const saved = profileKey ? (await harness.snapshot(Profiles, profileKey, context))?.ref : null;
        recording.profile(typeof saved === "string" ? saved : null);
        await recording.attach(run);
      }
      const made = async (ref: string) => (recording?.profile(ref), ref);
      if (chosen.kind === "browserbase") contextId = await durableProfileStore(harness).resolve(PROFILE, async (signal) => made(await makeContext(signal)));
      else if (env.AGENT_CHROME_PROFILE === "shared") await durableProfileStore(harness, { provider: "chrome" }).resolve(CHROME_PROFILE, () => made(`chrome/${CHROME_PROFILE}`));
      resolved = true;
      await browser.reconcile(harness, () => true, context);
    },
    root: {
      agent: { model, thinkingLevel: thinking, instructions, tools },
      init: async (tx, id) => {
        if (!resolved) throw new Error("the browser profile is resolved before the root conversation is created");
        const policy: BrowserPolicy = { ...DEFAULT_BROWSER_POLICY, contextId: contextId ?? null, idleReleaseS: IDLE_RELEASE_S };
        Object.assign(await tx.doc(browser.docs.Config, id), { label: definition.id, run: where.ref.id, policy });
        (await tx.doc(Label, id)).label = definition.name;
      },
    },
    // On SIGTERM the instance records its wake and lets go of the run; the browser goes first, so nothing paid stays open.
    wake: async (run, at) => {
      await releaseBrowsers(run.harness, BACKGROUND_CONTEXT).catch(() => undefined);
      // Beside the agent's report, for an agent that remembers: what it keeps for next time, the sign-in's sites, its memory
      // and its runs, never the ref.
      const saved = profileKey ? await run.harness.snapshot(Profiles, profileKey, BACKGROUND_CONTEXT).catch(() => null) : null;
      const sites = Array.isArray(saved?.allowedOrigins) ? saved.allowedOrigins.filter((site): site is string => typeof site === "string") : [];
      const runs = Object.values(state.runs).map((record) => ({ startedAt: record.startedAt, outcome: record.outcome ?? null })).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      if (definition.skills.includes("memory")) await writeRememberPage(where.work, { signIns: saved ? [{ sites, verifiedAt: typeof saved.verifiedAt === "string" ? saved.verifiedAt : null }] : [], runs }).catch(() => undefined);
      await recording?.detach().catch((error: Error) => console.error(`the recording is refused: ${error.message}`));
      // The default wake, through the run's own API: sleeping, with the deadline its work waits for (null: idle, woken on demand).
      await run.setStatus("sleeping", { reason: at === null ? "idle" : "waiting" }, { wakeAt: at === null ? null : new Date(at).toISOString() });
    },
  };
  return { options, browser, frames, recording, signIn: { seen } };
}

export default async function app(where: AppContext): Promise<AppOptions> {
  return (await createAgent(where)).options;
}
