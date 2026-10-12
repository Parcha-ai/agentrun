// The pi-durable adapter: `createVisionExtension` installs the `read` wrap (for hosts whose `read` is pi's) and the
// guard over every tool's images, takes the eyes from `api.models` where pi has it, and gives a host whose `read` is its
// own the media half of `read`, the fit of any result's images and a PDF's text as functions. It is the only module that
// touches pi-durable, by types alone: the extension is the plain object pi's identity helpers build, and the one value it
// needs at run time is imported when a guard first meets an image. Every tool it installs is replay-safe: a call cut by
// a crash runs again with the same task and memos, and a paid answer is a memo before the result that reports it.
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Extension, HookApi, HookRegistration, ModelRef, ToolExecutionApi, ToolExecutionResult, ToolHooks, ToolRegistration, Wrap } from "@earendil-works/pi-durable";
import { withReadMedia } from "./core/contract.js";
import type { VisionEnv } from "./core/env.js";
import { guardResult } from "./core/guard.js";
import type { CallContext, CallSetup, Eyes, Json, ReadArgs, ToolResult, VisionOptions } from "./core/host.js";
import type { ImageProcessor } from "./core/image.js";
import { resolveLimits } from "./core/limits.js";
import { pdfText } from "./core/pdf.js";
import { detectOnce } from "./core/provider.js";
import { readMedia } from "./core/read.js";
import { modelsEyes, modelsOf, type ModelsDoor } from "./eyes/models.js";
import { nodeVisionEnv } from "./node.js";
import { packageProviders } from "./providers/defaults.js";
import { photonImages } from "./providers/photon.js";

export { modelsEyes, modelsOf, type ModelsDoor, type ModelsEyesOptions } from "./eyes/models.js";
export { packageProviders } from "./providers/defaults.js";

export type VisionHandle = {
  /** Install once per Harness; select per conversation. */
  readonly extension: Extension;
  /** `look`, for `wrapTool` and a conversation's tool filter. */
  readonly tools: readonly ToolRegistration[];
  /** The media half of `read`, for a host whose `read` is its own. Null when the path reads as plain text. */
  read(env: VisionEnv, args: ReadArgs, call: CallContext): Promise<ToolResult | null>;
  /** One tool result's image blocks fitted to the call's route, for a host that shapes results itself. */
  fit(result: ToolResult, call: CallContext): Promise<ToolResult>;
  /** The text of a PDF held in memory; null when it has none. */
  pdfText(bytes: Uint8Array, signal?: AbortSignal): Promise<string | null>;
};

/** pi-durable 1.0 and 1.1 carry a result's blocks in `content`; its next release names them `output`. This name, read
 *  and written only by the two functions below, is the one place that knows. */
const BLOCKS = "content";

/** pi's tool result for the core's: the blocks, the error flag, the details and the usage pi folds into the
 *  conversation's spend under the tool's name. */
export function piResult(result: ToolResult): ToolExecutionResult {
  return {
    [BLOCKS]: [...result.content],
    ...(result.isError ? { isError: true } : {}),
    ...(result.details ? { details: result.details as JsonValue } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

function coreResult(result: ToolExecutionResult): ToolResult {
  const blocks = (result as Record<string, unknown>)[BLOCKS];
  return {
    content: Array.isArray(blocks) ? blocks.filter((b): b is ToolResult["content"][number] => b?.type === "text" || b?.type === "image") : [],
    ...(result.isError ? { isError: true } : {}),
    ...(result.details && typeof result.details === "object" && !Array.isArray(result.details) ? { details: result.details as Record<string, unknown> } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

/** The call's memo port on pi's memos: the kept value when there is one, else `compute`'s, committed before it is
 *  returned. The first committed value wins, so two attempts that both computed agree on one. */
function memoOf(api: Pick<HookApi, "memo">, context: Context): NonNullable<CallContext["memo"]> {
  return async <T extends Json>(key: string, compute: () => Promise<T>) => {
    const kept = await api.memo<JsonValue>(key, context);
    return (kept !== undefined ? kept : await api.memo<JsonValue>(key, (await compute()) as JsonValue, context)) as T;
  };
}

/** The lead's model as the route knows it: the catalog's entry where pi hands tools its `Models` (1.1 or later), else
 *  the reference the conversation's agent names. */
const modelFrom = (ref: ModelRef | undefined, models: ModelsDoor | undefined): unknown => (ref ? (models?.getModel(ref.provider, ref.modelId) ?? ref) : undefined);

/** The `Models` pi handed the call a context was built from (1.1 or later), which `eyesModel` looks through. */
const callModels = new WeakMap<CallContext, ModelsDoor>();

function contextOf(api: Pick<HookApi, "conversationId" | "memo">, callId: string, ref: ModelRef | undefined, context: Context): CallContext {
  const models = modelsOf(api);
  const call: CallContext = { conversationId: String(api.conversationId), callId, model: modelFrom(ref, models), signal: context.abortSignal, memo: memoOf(api, context) };
  if (models) callModels.set(call, models);
  return call;
}

/** The call context of one pi tool call, for a pi-durable host whose `read` is its own: pass it as it is to
 *  `handle.read` and `handle.fit`, which then look through the call's `api.models` too. */
export async function callContext(api: ToolExecutionApi, context: Context): Promise<CallContext> {
  return contextOf(api, api.callId, (await api.agent(context)).model, context);
}

/** What the model reads in place of an image the guard could not run on. */
const GUARD_FAILED = "[An image was removed from this result: it could not be checked against this model's image limits.]";

/** A route that fills in every argument sends `page: 0`, which no one asks for and the schema refuses: it is dropped
 *  before pi validates the call. The other filled-in values are valid and the core reads them as absent. */
function withoutPageZero<T>(args: T): T {
  if (!args || typeof args !== "object" || (args as { page?: unknown }).page !== 0) return args;
  const { page: _zero, ...rest } = args as Record<string, unknown>;
  return rest as T;
}

/** A host callback that never fails the call it reports on. */
const quiet = <E>(report: ((event: E) => void | Promise<void>) | undefined) =>
  report && (async (event: E) => { try { await report(event); } catch { /* the host's rows are its own */ } });

export function createVisionExtension(options: VisionOptions): VisionHandle {
  const onLook = quiet(options.onLook);
  // The host's converters first, then the package's own; Photon fits images when the host gives no processor and this
  // process can load it, since it runs here and not in the call's environment.
  const providers = [...(options.providers ?? []), ...packageProviders()];
  const photon = options.images ? undefined : photonImages();
  const here = nodeVisionEnv({ cwd: process.cwd() });
  const images = async (): Promise<ImageProcessor | undefined> =>
    options.images ?? (photon && (await detectOnce(photon, here)).available ? photon : undefined);
  const onMiss = quiet(options.onMiss);
  const eyesFor = (conversationId: string, models: ModelsDoor | undefined): Eyes | undefined => {
    if (typeof options.eyes === "function") return options.eyes({ conversationId });
    if (options.eyes) return options.eyes;
    return options.eyesModel && models ? modelsEyes(models, options.eyesModel, { thinking: options.eyesModel.thinking }) : undefined;
  };
  const setup = async (call: CallContext): Promise<CallSetup> => ({
    limits: resolveLimits(call.model, options.limits?.({ conversationId: call.conversationId, model: call.model })),
    eyes: eyesFor(call.conversationId, callModels.get(call)),
    scope: await options.scope(call.conversationId),
    evidence: options.evidence,
    ...(await images().then((processor) => (processor ? { images: processor } : {}))),
    providers,
    sources: options.sources ?? {},
    ...(options.allow ? { allow: options.allow } : {}),
    ...(onLook ? { onLook } : {}),
    ...(onMiss ? { onMiss } : {}),
  });

  // The wrapped `read` serves media itself and gives plain text to the tool it wraps. Both halves only read, so a cut
  // call runs again; an answer the eyes gave is a memo by then and is not asked for twice.
  const readWrap: Wrap = {
    tool: "read",
    wrap: (tool: ToolRegistration): ToolRegistration => ({
      ...withReadMedia(tool),
      replay: "safe",
      prepareArguments: (args) => withoutPageZero(tool.prepareArguments ? tool.prepareArguments(args) : args),
      execute: async (args, api, context) => {
        if (api.env) {
          const call = await callContext(api, context);
          const media = await readMedia(api.env, args as ReadArgs, call, await setup(call));
          if (media) return piResult(media);
        }
        return tool.execute(args, api, context);
      },
    }),
  };

  // Runs inside the tool's own task, before its result is committed, on every tool's result that carries an image. pi
  // keeps the result a throwing hook was given, so a guard that cannot run removes the images instead.
  const afterTool: ToolHooks["afterTool"] = async (call, result, api, context) => {
    const core = coreResult(result);
    if (!core.content.some((block) => block.type === "image")) return undefined;
    try {
      const { AgentDoc } = await import("@earendil-works/pi-durable");
      const at = contextOf(api, call.id, (await api.snapshot(AgentDoc, api.conversationId, context))?.model, context);
      return { ...result, ...piResult(await guardResult(core, at, await setup(at))) };
    } catch (error) {
      if (context.abortSignal?.aborted) throw error;
      return { ...result, ...piResult({ ...core, content: core.content.map((block) => (block.type === "image" ? { type: "text", text: GUARD_FAILED } : block)) }) };
    }
  };
  // `hook(ToolTask, ...)` as plain data: pi matches hooks to its built-in tool task by this name.
  const guard: HookRegistration = { task: "pi.tool", handlers: { afterTool } };

  const install = options.install ?? {};
  const extension: Extension = {
    name: options.name ?? "vision",
    tools: [],
    wraps: install.read === "off" ? [] : [readWrap],
    hooks: install.guard === false ? [] : [guard],
  };
  return {
    extension,
    tools: [],
    read: async (env, args, call) => readMedia(env, args, call, await setup(call)),
    fit: async (result, call) => guardResult(result, call, await setup(call)),
    pdfText: (bytes, signal) => pdfText(bytes, { env: here, providers, ...(signal ? { signal } : {}) }),
  };
}
