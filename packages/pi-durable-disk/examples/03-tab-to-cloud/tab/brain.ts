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
import type { Conversation, EntryRecord, Harness } from "@earendil-works/pi-durable";
import type { MutableModels } from "@earendil-works/pi-ai";
import { ModelHost, type HistoryMode, type Llm } from "../../04-walks-home/tab/src/modelhost.ts";
import { parseManifest } from "../../04-walks-home/tab/src/model.ts";
import { BRAIN_PROVIDER, brainModel, brainProvider } from "./brain-provider.ts";

import { BRAIN_FAILED, BRAIN_LOADING, BRAIN_MOVE, BRAIN_SWAP } from "./brain-kinds.ts";
export { BRAIN_FAILED, BRAIN_LOADING, BRAIN_MOVE, BRAIN_SWAP };
/** Where the trained model's manifest is on the run's disk (relative to work/); its appearance is the go signal. */
export const MANIFEST_PATH = "home/model/manifest.json";

export interface BrainDeps {
  harness: Harness;
  models: MutableModels;
  /** The conversation that did the trip. */
  root: Conversation;
  /** A file of the run's disk (work/), or null when it is not there. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** The dark-content judge: anything but 'show' holds the answer. */
  judge(prompt: string, answer: string): Promise<"show" | "refuse">;
  llm: Llm;
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
  sampling: Record<string, unknown>;
  load_ms: number | null;
  first_answer_ms: number | null;
  tokens_per_s: number | null;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const entriesOf = async (c: Conversation, context: Context): Promise<EntryRecord[]> => (await c.entries({}, 500, undefined, context)).items as EntryRecord[];

/** The newest brain swap in the root conversation, if one happened (a reload finds its conversation here). */
export async function findSwap(root: Conversation, context: Context): Promise<{ data: BrainSwapData } | undefined> {
  const hit = (await entriesOf(root, context)).find((e) => e.kind === BRAIN_SWAP); // newest first
  return hit ? { data: hit.data as unknown as BrainSwapData } : undefined;
}

export class Brain {
  readonly host: ModelHost;
  conversation: Conversation | undefined;
  private starting: Promise<Conversation | undefined> | undefined;

  private readonly d: BrainDeps;

  constructor(d: BrainDeps) {
    this.d = d;
    this.host = new ModelHost({
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
    try { manifest = parseManifest(manifestText); } catch (e) { return this.failed(e instanceof Error ? e.message : String(e)); }
    const common = { name: manifest.name, bytes: manifest.size, quant: manifest.quant, sha256: manifest.sha256, ...(manifest.topic ? { topic: manifest.topic } : {}), ...(manifest.mechanism ? { mechanism: manifest.mechanism } : {}) };
    await root.submit({ type: "write", requestId: `brain-loading:${manifest.sha256}`, entry: { kind: BRAIN_LOADING, data: common } }, context);
    await this.host.onManifest(manifestText);
    const s = this.host.state();
    if (s.phase !== "answered") return this.failed(s.error ?? "the model did not answer its self-check", manifest.sha256);
    const modelId = manifest.sha256.slice(0, 12);
    models.setProvider(brainProvider(this.host, brainModel(modelId, manifest.name, 2048, s.sampling.max_tokens)));
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

/** The manifest on the disk, as text; null while the trainer has not written it. */
export async function readManifest(readFile: BrainDeps["readFile"]): Promise<string | null> {
  const b = await readFile(MANIFEST_PATH);
  return b ? decode(b) : null;
}
