// The brain swap. The agent's conversation did the trip on the cloud model. When the trained model comes home (its manifest is on the run's disk), this tab loads
// it (the 04 tab's ModelHost: chunks verified against the manifest's sha256s, the load, a judged self-check answer), registers it as the `tab-local` provider,
// and opens a FRESH conversation on it: the cloud conversation stays exactly as it was, and the small model never sees its tool calls or its system prompt.
// The chat input then goes to the new conversation, durable on the run's disk like any other.
//
// What the transcript says (passive entries, no model messages, so no model ever reads them; the page and the stage fold them into the chat):
//   root conversation:   `brain.loading` {name, bytes, quant, sha256, topic?, mechanism?}   the model is coming home (once per model)
//                        `brain.swap`    {conversation, provider, model, name, ...}        the swap happened; its `conversation` is how a reload finds it
//                        `brain.failed`  {reason, sha256?}                                 the model did not load: the agent keeps its brain
//   new conversation:    `brain.swap`    (the same data) as its first entry
// Portable: no Node API.
import type { Context } from "@earendil-works/chord";
import type { AgentChange, Conversation, EntryRecord, Harness, ToolRegistration } from "@earendil-works/pi-durable";
import type { MutableModels } from "@earendil-works/pi-ai";
import { ModelHost, type HistoryMode, type Llm } from "../../04-walks-home/tab/src/modelhost.ts";
import { describeHome, readHomeManifest, type FileStore } from "../../04-walks-home/tab/src/homecoming.ts";
import { BRAIN_PROVIDER, brainModel, brainProvider, DEFAULT_TOOL_DECODING, type ToolDecoding } from "./brain-provider.ts";

import { BRAIN_FAILED, BRAIN_LOADING, BRAIN_MOVE, BRAIN_SWAP } from "./brain-kinds.ts";
export { BRAIN_FAILED, BRAIN_LOADING, BRAIN_MOVE, BRAIN_SWAP };
/** Where the trained model's manifest is on the run's disk (relative to work/); its appearance is the go signal. */
export const MANIFEST_PATH = "home/model/manifest.json";

/** The short prompt the model is configured with when the conversation keeps its tools: what it is and what to do (the tool spec itself comes from the format, tool-format.ts). */
export const TOOL_PROMPT = "You write and run code on a small computer in the user's browser, using your tools. Do what the user asks with them, then say in one short sentence what you did.";
// (The model never reads this text: its prompt is the format's own spec, tool-format.ts. It is the conversation's instructions for pi and for the transcript.)

export interface BrainDeps {
  /**
   * `fresh` (default): the swap opens a NEW conversation on the model, with no tools and no instructions (the trip stays behind). `configure`: ONE conversation: the trip's own conversation
   * is configured onto the model (`conversation.configure({model, tools, instructions})`), so the agent keeps its transcript and its tools, and the provider shows the model a window of it,
   * never the trip (tool-window.ts).
   */
  mode?: "fresh" | "configure";
  /**
   * `configure`, routed: the model is loaded and registered as a provider, but the conversation is NOT configured onto it: the page decides per message which brain answers
   * (brain-router.ts) and calls `use` to configure the conversation onto the chosen one, only when it changes.
   */
  route?: boolean;
  /** `configure`: the tools the model gets (pi's registrations: read, write, edit, bash). */
  tools?: readonly ToolRegistration[];
  /** A model with its own tool template (MiniCPM5): loaded with its jinja and this context (tokens), asked through `toolChat`. `warm` is the prefix the first request shares: it is prefilled after the load. */
  native?: { nCtx: number };
  /** `configure`: the instructions the conversation is configured with. Default TOOL_PROMPT. */
  instructions?: string;
  /** `configure`: how a tool turn is decoded (token caps, grammar or free, a per-turn report). Default DEFAULT_TOOL_DECODING. */
  decoding?: Partial<ToolDecoding>;
  harness: Harness;
  models: MutableModels;
  /** The conversation that did the trip. */
  root: Conversation;
  /** A file of the run's disk (work/), or null when it is not there. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** The dark-content judge: anything but 'show' holds the answer. */
  judge(prompt: string, answer: string): Promise<"show" | "refuse">;
  llm: Llm;
  /** Whole model files kept by sha256 for a base-and-adapters homecoming (homecoming.ts `opfsFileStore` in the page). */
  files?: FileStore;
  threads: number;
  history?: HistoryMode;
  context: Context;
  /** The model's own progress (loading, download, loaded, answered, failed), for the page. */
  onProgress?(type: string, body: Record<string, unknown>): void;
  now?(): number;
}

export interface BrainSwapData {
  /** The conversation's id as pi-durable made it (a number): a reload looks the conversation up with it. */
  conversation: number;
  provider: string;
  model: string;
  name: string;
  quant: string;
  bytes: number;
  sha256: string;
  topic?: string;
  mechanism?: string;
  history: HistoryMode;
  /** `configure`: the swap configured the trip's own conversation (its id is `conversation`); `fresh` (absent): a new one. */
  mode?: "fresh" | "configure";
  sampling: Record<string, unknown>;
  load_ms: number | null;
  first_answer_ms: number | null;
  tokens_per_s: number | null;
}

const entriesOf = async (c: Conversation, context: Context): Promise<EntryRecord[]> => (await c.entries({}, 500, undefined, context)).items as EntryRecord[];

/** The newest brain swap in the root conversation, if one happened (a reload finds its conversation here). */
export async function findSwap(root: Conversation, context: Context): Promise<{ data: BrainSwapData } | undefined> {
  const hit = (await entriesOf(root, context)).find((e) => e.kind === BRAIN_SWAP); // newest first
  return hit ? { data: hit.data as unknown as BrainSwapData } : undefined;
}

export class Brain {
  readonly host: ModelHost;
  conversation: Conversation | undefined;
  /** The provider model id of the loaded model, once it is registered. */
  modelId: string | undefined;
  /** The brain's identity (the manifest's `id`: the merged model's sha256, or the active adapter's) now, once a model is loaded; a new id coming home is a new model. */
  currentId: string | undefined;
  /** How many times a later homecoming replaced the model (`rehome`), for checks. */
  rehomes = 0;
  /** How many times the conversation was configured to the other brain (`use`), for checks. */
  switches = 0;
  private starting: Promise<Conversation | undefined> | undefined;

  private readonly d: BrainDeps;
  private readonly adopted: boolean;

  /** `adopt`: a host that already holds the loaded model (the page taking the run offline keeps the model it has, instead of loading it again). */
  constructor(d: BrainDeps, adopt?: ModelHost) {
    this.d = d;
    this.adopted = adopt !== undefined;
    this.host = adopt ?? new ModelHost({
      ...(d.files ? { files: d.files } : {}),
      ...(d.native ? { native: d.native } : {}),
      post: (type, body = {}) => d.onProgress?.(type, body),
      readChunk: (path) => d.readFile(path),
      writeFile: async () => {}, // the receipt of a load: the swap entry carries it
      sha256: async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join(""),
      judge: d.judge, llm: d.llm, threads: d.threads, isNotHolder: () => false, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      mode: "progressive", now: d.now ?? (() => performance.now()), ...(d.history ? { history: d.history } : {}),
    });
  }

  /** Load the model the manifest names and make a conversation on it (a fresh one, or the one an earlier swap left). Never throws: a failure is the `brain.failed` entry. */
  start(manifestText: string): Promise<Conversation | undefined> {
    return (this.starting ??= this.run(manifestText).finally(() => { if (!this.conversation) this.starting = undefined; })); // a failed start may be tried again
  }

  private async run(manifestText: string): Promise<Conversation | undefined> {
    const { harness, models, root, context } = this.d;
    let manifest;
    // either manifest: a merged model, or a base and its adapters (homecoming.ts); `id` is the brain's identity either way
    try { manifest = await describeHome(manifestText, sha256hex); } catch (e) { return this.failed(e instanceof Error ? e.message : String(e)); }
    if (!manifest.ready) return undefined; // the base is on its way, no adapter yet: nothing to swap to
    manifest = { ...manifest, sha256: manifest.id };
    const common = { name: manifest.name, bytes: manifest.bytes, quant: manifest.quant, sha256: manifest.sha256, ...(manifest.topic ? { topic: manifest.topic } : {}), ...(manifest.mechanism ? { mechanism: manifest.mechanism } : {}) };
    await root.submit({ type: "write", requestId: `brain-loading:${manifest.sha256}`, entry: { kind: BRAIN_LOADING, data: common } }, context);
    if (!(this.adopted && this.host.state().phase === "answered")) await this.host.onManifest(manifestText);
    const s = this.host.state();
    if (s.phase !== "answered") return this.failed(s.error ?? "the model did not answer its self-check", manifest.sha256);
    const modelId = manifest.sha256.slice(0, 12);
    models.setProvider(brainProvider(this.provided, brainModel(modelId, manifest.name, 2048, s.sampling.max_tokens), { ...DEFAULT_TOOL_DECODING, ...this.d.decoding }));
    this.modelId = modelId;
    this.currentId = manifest.id;
    if (this.d.mode === "configure" && this.d.route) {
      this.conversation = root;
      return root;
    }
    if (this.d.mode === "configure") return this.configured(modelId, common, s);
    const swap = await findSwap(root, context);
    let conversation = swap && swap.data.sha256 === manifest.sha256 ? await harness.conversation(swap.data.conversation as never, context) : undefined;
    if (!conversation) {
      // the agent: this model, no thinking level asked, NO instructions, no extensions, no tools
      conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: BRAIN_PROVIDER, modelId }, thinkingLevel: "off", instructions: null, extensions: [] } }, context);
      const data: BrainSwapData = { ...common, conversation: conversation.id as unknown as number, provider: BRAIN_PROVIDER, model: modelId, history: this.host.historyMode(), sampling: { ...s.sampling }, load_ms: s.load_ms, first_answer_ms: s.first_answer_ms, tokens_per_s: s.tokens_per_s };
      await conversation.submit({ type: "write", requestId: `brain-swap:${manifest.sha256}`, entry: { kind: BRAIN_SWAP, data: data as never } }, context);
      await root.submit({ type: "write", requestId: `brain-swap:${manifest.sha256}`, entry: { kind: BRAIN_SWAP, data: data as never } }, context);
    }
    this.conversation = conversation;
    return conversation;
  }

  /**
   * ONE conversation: configure the trip's own conversation onto this model, with the tools and a short tool prompt. Once per model: a conversation already configured onto it (a reload)
   * is left as it is. The swap entry is written once, in this conversation, and says so.
   */
  private async configured(modelId: string, common: Pick<BrainSwapData, "name" | "bytes" | "quant" | "sha256" | "topic" | "mechanism">, s: ReturnType<ModelHost["state"]>): Promise<Conversation> {
    const { root, context } = this.d;
    const agent = await root.agent(context);
    if (!(agent.model?.provider === BRAIN_PROVIDER && agent.model.modelId === modelId)) {
      await root.configure({ model: { provider: BRAIN_PROVIDER, modelId }, thinkingLevel: "off", tools: this.d.tools ?? [], instructions: this.d.instructions ?? TOOL_PROMPT }, context);
    }
    const data: BrainSwapData = { ...common, conversation: root.id as unknown as number, provider: BRAIN_PROVIDER, model: modelId, mode: "configure", history: this.host.historyMode(), sampling: { ...s.sampling }, load_ms: s.load_ms, first_answer_ms: s.first_answer_ms, tokens_per_s: s.tokens_per_s };
    await root.submit({ type: "write", requestId: `brain-swap:${common.sha256}`, entry: { kind: BRAIN_SWAP, data: data as never } }, context);
    this.conversation = root;
    return root;
  }

  /**
   * A new model came home (the manifest's id changed: another adapter, or a new merged model): load it in place of the old one and make the conversation run on it. Only what the file store lacks is
   * fetched (an adapter over a cached base is tens of MB). A conversation that was running on this brain is configured onto the new model id (with the same tools and prompt) before anything is asked of
   * it, so the caller waits until the agent is idle first; one running on the cloud stays there, and the next `use("tab-local")` uses the new model. Resolves `same` (the id did not change, the manifest
   * is not ready, or the brain is not in the one-conversation mode), `swapped`, or `failed` (the old model is gone: a conversation that was on it goes back to `cloud`, when one is given).
   */
  async rehome(manifestText: string, cloud?: AgentChange): Promise<"same" | "swapped" | "failed"> {
    const { models, root, context } = this.d;
    if (this.d.mode !== "configure" || this.modelId === undefined) return "same";
    let manifest;
    try { manifest = await describeHome(manifestText, sha256hex); } catch { return "same"; }
    if (!manifest.ready || manifest.id === this.currentId) return "same";
    const wasLocal = (await this.current()) === "tab-local";
    const common = { name: manifest.name, bytes: manifest.bytes, quant: manifest.quant, sha256: manifest.id, ...(manifest.topic ? { topic: manifest.topic } : {}), ...(manifest.mechanism ? { mechanism: manifest.mechanism } : {}) };
    await root.submit({ type: "write", requestId: `brain-loading:${manifest.id}`, entry: { kind: BRAIN_LOADING, data: common } }, context);
    await this.host.rehome(manifestText).catch((e: Error) => this.d.onProgress?.("model-failed", { reason: e.message }));
    const s = this.host.state();
    if (s.phase !== "answered") {
      await this.failed(s.error ?? "the model did not answer its self-check", manifest.id);
      if (wasLocal && cloud) { await root.configure(cloud, context); this.switches++; }
      return "failed";
    }
    const modelId = manifest.id.slice(0, 12);
    models.setProvider(brainProvider(this.provided, brainModel(modelId, manifest.name, 2048, s.sampling.max_tokens), { ...DEFAULT_TOOL_DECODING, ...this.d.decoding }));
    this.modelId = modelId;
    this.currentId = manifest.id;
    if (wasLocal) await root.configure({ model: { provider: BRAIN_PROVIDER, modelId }, thinkingLevel: "off", tools: this.d.tools ?? [], instructions: this.d.instructions ?? TOOL_PROMPT }, context);
    const data: BrainSwapData = { ...common, conversation: root.id as unknown as number, provider: BRAIN_PROVIDER, model: modelId, mode: "configure", history: this.host.historyMode(), sampling: { ...s.sampling }, load_ms: s.load_ms, first_answer_ms: s.first_answer_ms, tokens_per_s: s.tokens_per_s };
    await root.submit({ type: "write", requestId: `brain-swap:${manifest.id}`, entry: { kind: BRAIN_SWAP, data: data as never } }, context);
    this.rehomes++;
    return "swapped";
  }

  /**
   * Routed: which brain the conversation runs on now (its agent's model is this model: `tab-local`, else `cloud`).
   */
  async current(): Promise<"tab-local" | "cloud"> {
    const agent = await this.d.root.agent(this.d.context);
    return agent.model?.provider === BRAIN_PROVIDER && agent.model.modelId === this.modelId ? "tab-local" : "cloud";
  }

  /**
   * Routed: run the conversation on `brain`. The conversation is configured only when the brain changes (the model's prompt cache survives a run of local turns); `cloud` is the agent
   * the conversation had before (the whole registry, the cloud model). Resolves whether it changed.
   */
  async use(brain: "tab-local" | "cloud", cloud: AgentChange): Promise<boolean> {
    if (this.modelId === undefined) throw new Error("the trained model is not loaded");
    if ((await this.current()) === brain) return false;
    const { root, context } = this.d;
    if (brain === "tab-local") await root.configure({ model: { provider: BRAIN_PROVIDER, modelId: this.modelId }, thinkingLevel: "off", tools: this.d.tools ?? [], instructions: this.d.instructions ?? TOOL_PROMPT }, context);
    else await root.configure(cloud, context);
    this.switches++;
    return true;
  }

  /**
   * Native tool template: prefill the prefix every request shares (the system prompt and the tools, which the model's template renders at the start of the prompt) with one throwaway turn of one
   * token, so the first real command pays only its own few tokens (measured on a loaded box: 110 s cold against 10 s warm). Resolves how long it took; a failure is not an error of the demo.
   */
  async warm(system: string, tools: import("../../04-walks-home/tab/src/modelhost.ts").ToolChatTool[]): Promise<number | undefined> {
    const run = this.#warm(system, tools);
    this.warming = run.then(() => undefined);
    return run;
  }

  /** The warm-up turn that is running, if any: the model serves one request at a time, so the first real turn waits for it instead of being refused as busy. */
  private warming: Promise<void> = Promise.resolve();

  /** The host as the provider sees it: the same host, whose native tool turn waits for the warm-up. */
  private get provided(): ModelHost {
    const host = this.host;
    return new Proxy(host, {
      get: (target, key) => {
        if (key === "toolChat") return async (...args: Parameters<ModelHost["toolChat"]>) => { await this.warming; return target.toolChat(...args); };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async #warm(system: string, tools: import("../../04-walks-home/tab/src/modelhost.ts").ToolChatTool[]): Promise<number | undefined> {
    const started = performance.now();
    try {
      await this.host.toolChat({ messages: [{ role: "system", content: system }, { role: "user", content: "Hello." }], tools, maxTokens: 1, templateKwargs: { enable_thinking: false } });
      return performance.now() - started;
    } catch {
      return undefined;
    }
  }

  /** The page is done with the model (the run left this tab): release its workers. */
  dispose(): Promise<void> {
    return this.host.dispose();
  }

  /**
   * The run is moving to another host. The model this brain runs on is in this tab, so what the move does is defined, and said where the chat is: the move carries the
   * run (its root conversation) and the agent there runs on the cloud model again; this conversation stays in the transcript, dormant, and the trained model takes over
   * again, in this conversation, when the run is back in a tab. Written once per move (`switchId`), in the trip's conversation and in this one, so every viewer reads it.
   */
  async noteMove(switchId: string, to: string): Promise<void> {
    const { root, context } = this.d;
    const conversation = this.conversation;
    if (!conversation) return;
    const text = `The agent is moving to ${to}. The model it trained stays in this tab: there the agent runs on the cloud model again, and this conversation waits. The trained model takes over again here when the run is back in a tab.`;
    const entry = { kind: BRAIN_MOVE, data: { code: "TAB_LOCAL_BRAIN_STAYS", switchId, to, text, conversation: conversation.id as unknown as number } };
    const requestId = `brain-move:${switchId}`;
    await conversation.submit({ type: "write", requestId, entry: entry as never }, context);
    await root.submit({ type: "write", requestId, entry: entry as never }, context);
  }

  private async failed(reason: string, sha256?: string): Promise<undefined> {
    this.d.onProgress?.("model-failed", { reason });
    await this.d.root.submit({ type: "write", requestId: `brain-failed:${sha256 ?? "manifest"}:${reason.slice(0, 40)}`, entry: { kind: BRAIN_FAILED, data: { reason, ...(sha256 ? { sha256 } : {}) } } }, this.d.context).catch(() => undefined);
    return undefined;
  }
}

/** The judge the brain answers through: the dark-content judge only when asked for (`?judge=on`); off, every answer is shown, the self-check included, so online and offline behave the same. */
export const judgeFor = (on: boolean, remote: BrainDeps["judge"]): BrainDeps["judge"] => (on ? remote : async () => "show");

/** The manifest on the disk, as text (a base and adapters at home/manifest.json first, else a merged model's); null while the trainer has written neither. */
export async function readManifest(readFile: BrainDeps["readFile"]): Promise<string | null> {
  return readHomeManifest(readFile);
}

const sha256hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
