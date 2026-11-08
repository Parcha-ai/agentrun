// pi as an AgentAdapter (the one-ledger ruling, B2c; kernel page tangle 3): pi-durable's own engine inside, on the
// same contract as claude-agent, codex and opencode. The adapter loop (runner/adapter-loop.ts) opens the run's one
// Harness on the claim's journal and lends it here (`PiRun`); this adapter adds pi's tools and turns to it.
//
// pi's model requests go through the session's model proxy (the kernel's startModelProxy), as the CLI harnesses' do:
// pi-ai's provider points at the proxy, so every paid request is admitted and booked by the runner's booking (io.models),
// the one ledger; pi's own createCap is not used. The host's tools run through HostTool.call, where the kernel's rule
// before a side effect sits (runner/adapter-loop.ts); the gate is asked before pi stores a call's intent (pi's beforeTool
// hook), through io.gate.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { type Conversation, defineExtension, defineTool, type Harness, hook, type Registry, type Submission, ToolTask } from "@earendil-works/pi-durable";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import type { AdapterSession, AgentAdapter, HostTool, SessionIO, SessionSpec, TurnStatus } from "@parcha/agentrun-kernel";
import { startModelProxy } from "@parcha/agentrun-kernel/host";
import { randomBytes } from "node:crypto";

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
export type PiSessionIO = SessionIO & { gate?: (call: PreIntentCall, context: Context) => Promise<PreIntentAnswer> };

export interface PiAdapterOptions {
  readonly run: PiRun;
  /** The provider the session's proxy forwards to: Anthropic's Messages API at `origin`. */
  readonly provider: { readonly api: "anthropic-messages"; readonly origin: string; readonly credential: () => string | Promise<string>; readonly headers?: Readonly<Record<string, string>> };
  /** The model pi asks for. */
  readonly model: string;
  /** The price of a request's usage, for the proxy's booking. */
  readonly price?: (model: string, usage: never) => number | null;
  /** The proxy's upstream fetch (a test's scripted origin). */
  readonly fetch?: typeof fetch;
}

const PROVIDER = "agentrun-session";
const INPUT_REQUEST = "agentrun:input";

/** pi as an AgentAdapter for one claim's run. */
export function piAdapter(options: PiAdapterOptions): AgentAdapter {
  return {
    id: "pi",
    capabilities: () => ({}),
    check: () => [],
    open: (spec, io) => openPi(options, spec, io as PiSessionIO),
  };
}

async function openPi(options: PiAdapterOptions, spec: SessionSpec, io: PiSessionIO): Promise<AdapterSession> {
  const { run, model } = options;
  const context = withAbortSignal(io.signal, BACKGROUND_CONTEXT);
  // The session's route: pi-ai's requests reach the provider only through this proxy, which admits and books each one
  // through the runner's booking (io.models).
  const proxy = await startModelProxy({
    policy: anthropicPolicy({ model, tools: [] }),
    hooks: io.models,
    model,
    origin: options.provider.origin,
    credential: async () => (await options.provider.credential()) ?? "",
    ...(options.price ? { price: options.price as never } : {}),
    ...(options.provider.headers ? { headers: options.provider.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }, randomBytes(32).toString("base64url"));
  const models = createModels();
  models.setProvider(createProvider({
    id: PROVIDER,
    baseUrl: proxy.url,
    auth: { apiKey: { name: "AGENTRUN_SESSION_KEY", resolve: async () => ({ auth: { apiKey: proxy.key }, source: "session" }) } },
    // The proxy knows the session by `authorization: Bearer <key>` (the Anthropic policy's keyOf); pi-ai's own x-api-key
    // stays here, since the proxy forwards only its routes' listed headers.
    models: [{ id: model, name: model, api: "anthropic-messages", provider: PROVIDER, baseUrl: proxy.url, headers: { authorization: `Bearer ${proxy.key}` }, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_000 }],
    api: anthropicMessagesApi(),
  } as never));
  run.setModels(models);

  const tools = spec.tools.map((tool) => piTool(tool, io));
  const extension = defineExtension({
    name: `agentrun-session-${spec.key}`,
    tools,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, _api, hookContext: Context) => {
          if (!io.gate) return undefined;
          const answer = await io.gate({ callId: call.id, tool: call.name, args: (call.arguments ?? {}) as Record<string, unknown> }, hookContext);
          if (answer === "allow") return undefined;
          if ("deny" in answer) return { block: answer.deny };
          // Parked: held until pi closes the Session, so the call never reaches its intent in this process.
          return new Promise<never>((_, reject) => {
            const signal = hookContext.abortSignal;
            if (signal?.aborted) return reject(new Error("parked"));
            signal?.addEventListener("abort", () => reject(new Error("parked")), { once: true });
          });
        },
      }),
    ],
  });
  run.registry.install(extension);
  // The root conversation may exist already (the loop's session records live beside it, under it): its agent is set here,
  // the session's model and this session's tools, on every open.
  const agent = { model: { provider: PROVIDER, modelId: model }, extensions: [extension] };
  const root: Conversation = await run.harness.root(context, { agent } as never);
  await root.configure(agent as never, context);

  // The run's input submission, if one was placed: its state says where the session is.
  let input: Submission | undefined;
  const existing = await run.harness.commit((tx) => tx.submissionByRequest(root.id, INPUT_REQUEST), context);
  if (existing) input = await run.harness.submission(existing.id, context);
  let state: AdapterSession["state"] = existing === undefined ? "new" : existing.status === "done" || existing.status === "unanswered" ? "idle" : "open_turn";
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
  if (input && state === "open_turn") watch(input);

  return {
    get state() {
      return state;
    },
    async send(text) {
      input = await root.submit({ type: "input", content: text, requestId: INPUT_REQUEST }, context);
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
      await proxy.close().catch(() => undefined);
    },
    // A steer: pi places it in the turn in flight, at its next boundary. `id`: its request id (the command's), so the
    // commit that places it is the one that takes its row.
    async steer(text: string, id?: string) {
      await root.submit({ type: "input", content: text, whenBusy: "steer", ...(id ? { requestId: id } : {}) }, context);
    },
  } as AdapterSession & { steer(text: string, id?: string): Promise<void> };
}

/** A host tool as a pi tool: replay-safe or at most once, its answer the host's text. */
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
      return { output: [{ type: "text" as const, text: answer.text }], ...(answer.isError ? { isError: true } : {}) } as never;
    },
  });
}
