// pi as an AgentAdapter (the one-ledger ruling, B2c; kernel page tangle 3): pi-durable's own engine inside, on the
// same contract as claude-agent, codex and opencode. The adapter loop (runner/adapter-loop.ts) opens the run's one
// Harness on the claim's journal and lends it here (`PiRun`); this adapter adds pi's tools and turns to it.
//
// pi's model requests go through the session's model proxy (the kernel's startModelProxy), as the CLI harnesses' do:
// pi-ai's provider points at the proxy, so every paid request is admitted and booked by the runner's booking (io.models),
// the one ledger; pi's own createCap is not used. The proxy speaks the provider's wire (provider.api, main's set: Anthropic's
// Messages or OpenAI's Responses), under that wire's CLI policy, and pi-ai's client speaks the same. The host's tools run through HostTool.call, where the kernel's rule
// before a side effect sits (runner/adapter-loop.ts); the gate is asked before pi stores a call's intent (pi's beforeTool
// hook), through io.gate.
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { type Conversation, defineExtension, defineTool, type Extension, GenerationTask, type Harness, hook, type Registry, type Submission, ToolTask } from "@earendil-works/pi-durable";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import type { AdapterSession, AgentAdapter, HostTool, SessionIO, SessionSpec, TurnStatus, Wire } from "@parcha/agentrun-kernel";
import { type ModelProxy, type ProviderPolicy, startModelProxy } from "@parcha/agentrun-kernel/host";
import { randomBytes } from "node:crypto";
import { DEFAULT_HARNESS } from "../../harness.js";
import { sessionProvider } from "../../port-models.js";
import { KINDS } from "../journal-kinds.js";

/** What the adapter loop lends pi for one claim: the run's Harness, its registry, and where pi's models go. */
export interface PiRun {
  readonly harness: Harness;
  readonly registry: Registry;
  /** The Harness reads its models through this (HarnessOptions.models as a function): the adapter sets them at open. */
  setModels(models: Models): void;
}

/** A call as the gate is asked about it, before pi stores its intent. */
export interface PreIntentCall {
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** The host's answer before a call's intent: run it, refuse it, or park the run on it (the call never moves on here). */
export type PreIntentAnswer = "allow" | { readonly deny: string } | { readonly park: true };

/** SessionIO with the gate asked before a call's intent (SessionIO.gate in the adapter contract: "allow", a deny, or a park). */
export type PiSessionIO = SessionIO & {
  gate?: (call: PreIntentCall, context: Context) => Promise<PreIntentAnswer>;
  /** What the request that just answered cost, as the runner's booking wrote it (the session's ledger): its figure, null
   *  when unknown, undefined when none was booked. pi's own price for the model is none (the adapter does not know it). */
  bookedCost?: () => Promise<number | null | undefined>;
};

export interface PiAdapterOptions {
  readonly run: PiRun;
  /** The provider the session's proxy forwards to: the API it speaks (a wire main's pi speaks, provider.ts: Anthropic's
   *  Messages or OpenAI's Responses) at `origin`, its credential, sent as `auth` says (Messages' default x-api-key;
   *  Responses' is always a bearer token). `api` is the one source of the session's wire: its policy, pi-ai's client and
   *  its port all read it. */
  readonly provider: { readonly api: Wire; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>>; readonly auth?: "bearer" | "x-api-key" };
  /** The model pi asks for. */
  readonly model: string;
  /** The catalog's entry for the model: whether it reasons, its window and its output ceiling, as pi-ai's model of it. */
  readonly like?: { readonly reasoning?: boolean; readonly contextWindow?: number; readonly maxTokens?: number };
  /** The price of a request's usage, for the proxy's booking. */
  readonly price?: (model: string, usage: never) => number | null;
  /** The proxy's upstream fetch (a test's scripted origin). */
  readonly fetch?: typeof fetch;
  /** The runner's one redactor, which a provider's error passes through in the session's proxy before pi has it
   *  (ModelProxyOptions.redact; the proxy's own cut of the credential comes first). */
  readonly redact?: (text: string) => string;
  /** pi-native extensions the run's root agent carries beside the session's own (the browser's durable extension, as a
   *  pi DurableRun on main installs it): installed in the claim's registry, so their tools run as pi's own tool tasks (a
   *  taskId, a memo, conversations they own) and their own task kinds (a browser.release) under pi's recovery, all in the
   *  claim's Harness. Their tools pass the session's gate (its beforeTool hook), and every conversation they open takes
   *  its model from the root's agent, through this session's proxy and its booking. */
  readonly extensions?: readonly Extension[];
}

const PROVIDER = "agentrun-session";
const INPUT_REQUEST = "agentrun:input";

/** pi as an AgentAdapter for one claim's run. */
export function piAdapter(options: PiAdapterOptions): AgentAdapter {
  return {
    // pi is the default harness: its id is the harness table's, never a literal of its own.
    id: DEFAULT_HARNESS,
    capabilities: () => ({}),
    check: () => [],
    open: (spec, io) => openPi(options, spec, io as PiSessionIO),
  };
}

/** The names of the run's pi-native extensions' tools (options.extensions): the model is offered them beside the session's
 *  own (so it may call one), and pi runs it. Offered and run by one mechanism; sessionOn never also piTool-wraps a session
 *  tool a native extension already owns, so the name is in the request's tools exactly once. */
const nativeToolNames = (options: PiAdapterOptions): readonly string[] =>
  (options.extensions ?? []).flatMap((extension) => extension.tools ?? []).map((tool) => tool.name);

async function openPi(options: PiAdapterOptions, spec: SessionSpec, io: PiSessionIO): Promise<AdapterSession> {
  const { model } = options;
  const context = withAbortSignal(io.signal, BACKGROUND_CONTEXT);
  // The session's route: pi-ai's requests reach the provider only through this proxy, which admits and books each one
  // through the runner's booking (io.models).
  const proxy = await startModelProxy({
    policy: await policyFor(options.provider, model, [...spec.tools.map((tool) => tool.name), ...nativeToolNames(options)]),
    hooks: io.models,
    model,
    origin: options.provider.origin,
    credential: async () => (await options.provider.credential()) ?? "",
    ...(options.price ? { price: options.price as never } : {}),
    ...(options.provider.headers ? { headers: options.provider.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.redact ? { redact: options.redact } : {}),
  }, randomBytes(32).toString("base64url"));
  // An open that fails from here (the claim lost while the session opened) closes the proxy: its server would hold the
  // runner's process open.
  try {
    return await sessionOn(proxy, options, spec, io, context);
  } catch (error) {
    await proxy.close().catch(() => undefined);
    throw error;
  }
}

/** The session proxy's policy on Messages: claude-agent's (no fork), with pi's tools, the host's own names (`tools`), as
 *  the names its client offers by themselves (its builtins). The CLI's own `mcp__hands__` prefix is not pi's: under it
 *  every one of pi's tool definitions would be dropped and the model offered none. Every other tool definition is
 *  dropped, and a request that offers the session's tools is the turn's answer request. `auth`: how the provider takes
 *  its credential (default x-api-key). */
export function piPolicy(model: string, tools: readonly string[], auth?: "bearer" | "x-api-key"): ProviderPolicy {
  return anthropicPolicy({ model, tools: [], builtins: tools, ...(auth ? { auth } : {}) });
}

/** The policy of the session's wire, the one each CLI harness of that wire applies (no fork of either): Anthropic's
 *  Messages as claude-agent's (piPolicy), OpenAI's Responses as codex's, which takes pi's tools as the session's own by
 *  name. Either way every other tool definition is dropped and the request that offers them is the turn's answer
 *  request. */
export async function policyFor(provider: PiAdapterOptions["provider"], model: string, tools: readonly string[]): Promise<ProviderPolicy> {
  if (provider.api === "anthropic-messages") return piPolicy(model, tools, provider.auth);
  // Loaded when a session of its wire opens, as the runner loads the codex harness.
  const { codexPolicy } = (await import("@parcha/agentrun-harness-codex")) as { codexPolicy(options: { model: string; tools: readonly string[] }): ProviderPolicy };
  return codexPolicy({ model, tools });
}

/** The session on its proxy: pi's models through it, the host's tools and the gate as pi's extension, the root's state. */
async function sessionOn(proxy: ModelProxy, options: PiAdapterOptions, spec: SessionSpec, io: PiSessionIO, context: Context): Promise<AdapterSession> {
  const { run, model, like } = options;
  const { api } = options.provider;
  const models = createModels();
  // pi-ai's client of the session's wire at its proxy (port-models.ts sessionProvider). pi prices nothing itself (the
  // proxy's booking does), so the model's cost stays $0. Image input on either wire (sessionModel): a host tool's images
  // (a screenshot) reach the model in its tool result.
  models.setProvider(sessionProvider(api, proxy, model, { provider: PROVIDER, keyName: "AGENTRUN_SESSION_KEY", ...(like ? { like } : {}), reasoning: false }));
  run.setModels(models);

  // A session tool whose name a native extension already owns is run by that extension (pi's own tool task), so it is not
  // piTool-wrapped here too: one tool by that name on the agent, offered once.
  const owned = new Set(nativeToolNames(options));
  const tools = spec.tools.filter((tool) => !owned.has(tool.name)).map((tool) => piTool(tool, io));
  // A refused call's words (the gate's deny, main's), by call: its result is those words alone, as main gives them.
  const refusals = refusalWords();
  const extension = defineExtension({
    name: `agentrun-session-${spec.key}`,
    tools,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, _api, hookContext: Context) => {
          if (!io.gate) return undefined;
          const answer = await io.gate({ callId: call.id, tool: call.name, args: (call.arguments ?? {}) as Record<string, unknown> }, hookContext);
          if (answer === "allow") return undefined;
          if ("deny" in answer) {
            refusals.refuse(call.id, answer.deny);
            return { block: answer.deny };
          }
          // Parked: held until pi closes the Session, so the call never reaches its intent in this process.
          return new Promise<never>((_, reject) => {
            const signal = hookContext.abortSignal;
            if (signal?.aborted) return reject(new Error("parked"));
            signal?.addEventListener("abort", () => reject(new Error("parked")), { once: true });
          });
        },
        // A call the gate refused: its result is main's words alone, an error, never pi's framing of a blocked call (its
        // diagnostic, which the model reads as "<harness>[error] Tool call blocked: ..."). Every other result is pi's.
        afterTool: async (call, result) => refusals.resultOf(call.id, result) as never,
      }),
      // An answer's cost is the runner's booking of its request, never pi's $0 for a model it has no price for: set on
      // the answer before pi stores it, so the answer, pi.usage and the live timeline carry it; unknown stays unknown.
      hook(GenerationTask, {
        afterResponse: async (message) => {
          if (!io.bookedCost) return;
          const usd = await io.bookedCost();
          if (usd === undefined) return;
          const cost = (message.usage as { cost?: Record<string, unknown> } | undefined)?.cost;
          if (cost) cost.total = usd;
        },
      }),
    ],
  });
  run.registry.install(extension);
  // The run's pi-native extensions (options.extensions), in the claim's registry beside the session's.
  const native = options.extensions ?? [];
  for (const each of native) run.registry.install(each);
  // The root conversation may exist already (the loop's session records live beside it, under it): its agent is set here,
  // the session's model, the run's system text (pi's instructions, its parts as the CLI adapters join them), this
  // session's tools and the run's native extensions, on every open. A conversation a native tool opens takes this agent's
  // model (pi copies its owner's), so its requests go through this session's proxy.
  const instructions = spec.system.join("\n\n");
  const agent = { model: { provider: PROVIDER, modelId: model }, extensions: [extension, ...native], ...(instructions ? { instructions } : {}) };
  const root: Conversation = await run.harness.root(context, { agent } as never);
  await root.configure(agent as never, context);

  // The run's input submission, if one was placed: its state says where the session is. Answered: idle. Open, or settled
  // unanswered (a failed turn whose end the loop never read: a claim lost before the run's end landed): an open turn,
  // whose end recover() reads, so a failed turn ends the run failed, never as a completed one.
  let input: Submission | undefined;
  /** The session closed (its proxy with it): its port gives no route. */
  let closed = false;
  const existing = await run.harness.commit((tx) => tx.submissionByRequest(root.id, INPUT_REQUEST), context);
  if (existing) input = await run.harness.submission(existing.id, context);
  let state: AdapterSession["state"] = existing === undefined ? "new" : existing.status === "done" ? "idle" : "open_turn";
  let running: Promise<{ status: TurnStatus; error?: string }> | undefined;
  const watch = (submission: Submission) => {
    running = submission.wait(context).then(
      (record) => {
        state = "idle";
        const status: TurnStatus = record.status === "done" ? "completed" : "failed";
        io.onEvent({ type: "turn_end", status });
        return { status };
      },
      (error: Error) => {
        io.onEvent({ type: "turn_end", status: "interrupted" });
        return { status: "interrupted" as TurnStatus, error: error.message };
      },
    );
  };
  // No watch here: recover() starts it. A watch from open would set state idle as soon as a settled (or fast-recovered)
  // turn's wait returned, before the loop read state, and the loop would take the turn as never placed and so completed.

  return {
    get state() {
      return state;
    },
    async send(text, options) {
      // The run's first input under INPUT_REQUEST; a follow-up (a raised run's turn) under its own id, a turn of its own.
      // With `origin` (a trigger's first input), the host's input entry carries it, as a trigger's steer's does.
      const entry = options?.origin ? { entry: { kind: KINDS.input, data: { origin: options.origin } as JsonValue } } : {};
      input = await root.submit({ type: "input", content: text, requestId: options?.id ?? INPUT_REQUEST, ...entry } as never, context);
      state = "open_turn";
      watch(input);
    },
    async recover() {
      // pi recovers its own tasks when its Harness opens; the turn is the input's.
      if (input) watch(input);
    },
    async settleOpenTurn() {
      await root.abort(context).catch(() => undefined);
      await run.harness.waitForIdle(context).catch(() => undefined);
      state = "idle";
    },
    async turnEnd() {
      if (!running) throw new Error("pi: no turn is in flight");
      return running;
    },
    async interrupt() {
      await root.abort(context).catch(() => undefined);
    },
    async close() {
      closed = true;
      await proxy.close().catch(() => undefined);
    },
    // The session's own model route for a request the host sends beside pi's (a learned workflow's model node): its proxy
    // with a side key minted for `label`, pi's model and the provider's wire (never a literal), so the request goes through
    // the same policy, origin, credential, price and booking as pi's own, labelled. None once the session is closed.
    port: (label: string) => (closed ? undefined : { url: proxy.url, key: proxy.sideKey(label), model, api }),
    // A steer: pi places it in the turn in flight, at its next boundary. `id`: its request id (the command's), so the
    // commit that places it is the one that takes its row. `origin` (a trigger's message): its input is the host's user
    // entry (KINDS.input) with that origin, in the same submission, so the attribution lands with the message or not at all.
    async steer(text: string, id?: string, mode: "steer" | "followUp" = "steer", options?: { readonly origin?: { readonly [key: string]: unknown } }) {
      const entry = options?.origin ? { entry: { kind: KINDS.input, data: { origin: options.origin } as JsonValue } } : {};
      await root.submit({ type: "input", content: text, whenBusy: mode, ...(id ? { requestId: id } : {}), ...entry } as never, context);
    },
  } satisfies AdapterSession;
}

/** A refused call's words by call (the gate's deny, main's words), held from the refusal (beforeTool's block) to the
 *  call's result (afterTool): a blocked result becomes those words alone, an error, as main gives a refused call's
 *  result, never pi's framing of a blocked call. Every other result is pi's own. `held`: the words still held. */
export function refusalWords() {
  const words = new Map<string, string>();
  return {
    refuse(callId: string, text: string): void {
      words.set(callId, text);
    },
    resultOf(callId: string, result: { readonly diagnostics?: readonly { readonly code?: string }[] }): { output: { type: "text"; text: string }[]; isError: true } | undefined {
      const text = words.get(callId);
      // Let go on every result: the call has its one result now, whatever it is.
      words.delete(callId);
      const blocked = result.diagnostics?.some((diagnostic) => diagnostic.code === "blocked");
      if (text === undefined || !blocked) return undefined;
      return { output: [{ type: "text", text }], isError: true };
    },
    get held(): number {
      return words.size;
    },
  };
}

/** A host tool as a pi tool: replay-safe or at most once, its answer the host's text and any images it shows. */
function piTool(tool: HostTool, io: PiSessionIO) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as never,
    replay: tool.replay === "safe" ? "safe" : "unsafe",
    execute: async (args: unknown, api, toolContext: Context) => {
      io.onEvent({ type: "tool_start", callId: api.callId, name: tool.name, args });
      const answer = await tool.call(args ?? {}, { callId: api.callId, signal: toolContext.abortSignal ?? io.signal });
      io.onEvent({ type: "tool_end", callId: api.callId, name: tool.name, isError: Boolean(answer.isError), result: answer.text });
      const images = (answer.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
      return { output: [{ type: "text" as const, text: answer.text }, ...images], ...(answer.isError ? { isError: true } : {}) } as never;
    },
  });
}
