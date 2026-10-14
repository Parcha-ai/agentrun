// The pi-durable adapter: `createVisionExtension` installs the `read` wrap (for hosts whose `read` is pi's) and the
// guard over every tool's images, takes the eyes from `api.models` where pi has it, and gives a host whose `read` is its
// own the media half of `read`, the fit of any result's images and a PDF's text as functions. It is the only module that
// touches pi-durable, by types alone: the extension is the plain object pi's identity helpers build, and the one value it
// needs at run time is imported when a guard first meets an image. Every tool it installs is replay-safe: a call cut by
// a crash runs again with the same task and memos, and a paid answer is a memo before the result that reports it.
import type { Context, JsonValue } from "@earendil-works/chord";
import type { ConversationId, Extension, HookApi, HookRegistration, ModelRef, ToolExecutionApi, ToolExecutionResult, ToolHooks, ToolRegistration, Wrap } from "@earendil-works/pi-durable";
import { withReadMedia } from "./core/contract.js";
import type { VisionEnv } from "./core/env.js";
import { guardResult } from "./core/guard.js";
import type { CallContext, CallSetup, Eyes, Json, ReadArgs, ToolResult, VisionOptions } from "./core/host.js";
import type { ImageProcessor } from "./core/image.js";
import { resolveLimits } from "./core/limits.js";
import { pdfText } from "./core/pdf.js";
import { detectOnce } from "./core/provider.js";
import { readMedia, readWithoutSetup } from "./core/read.js";
import { modelsEyes, modelsOf, type ModelsDoor } from "./eyes/models.js";
import { childEnvOf, nodeVisionEnv, type ChildEnv } from "./node.js";
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

/** The names pi-durable gives a result's blocks: `output` from 1.2, `content` in 1.0 and 1.1. Each release reads its own
 *  and ignores the other, and 1.2 reads a result without `output` as empty, so a result is written under both and read
 *  from `output`, else `content`. These names, read and written only by the two functions below, are the one place
 *  that knows. */
const BLOCKS = ["output", "content"] as const;

/** pi's tool result for the core's: the blocks, the error flag, the details and the usage pi folds into the
 *  conversation's spend under the tool's name. */
export function piResult(result: ToolResult): ToolExecutionResult {
  const blocks = [...result.content];
  return {
    ...Object.fromEntries(BLOCKS.map((name) => [name, blocks])),
    ...(result.isError ? { isError: true } : {}),
    ...(result.details ? { details: result.details as JsonValue } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  } as ToolExecutionResult;
}

function coreResult(result: ToolExecutionResult): ToolResult {
  const blocks = BLOCKS.map((name) => (result as Record<string, unknown>)[name]).find(Array.isArray);
  return {
    content: blocks ? blocks.filter((b): b is ToolResult["content"][number] => b?.type === "text" || b?.type === "image") : [],
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

/** What pi handed the call a context was built from: its own conversation id, which `scope` is given, and its `Models`
 *  (1.1 or later), which `eyesModel` looks through. */
const piCalls = new WeakMap<CallContext, { readonly id: ConversationId; readonly models: ModelsDoor | undefined }>();

function contextOf(api: Pick<HookApi, "conversationId" | "memo">, callId: string, ref: ModelRef | undefined, context: Context, tool?: string): CallContext {
  const models = modelsOf(api);
  const call: CallContext = { conversationId: String(api.conversationId), callId, ...(tool ? { tool } : {}), model: modelFrom(ref, models), signal: context.abortSignal, memo: memoOf(api, context) };
  piCalls.set(call, { id: api.conversationId, models });
  return call;
}

/** The call context of one pi tool call, for a pi-durable host whose `read` is its own: pass it as it is to
 *  `handle.read` and `handle.fit`, which then look through the call's `api.models` too. `tool` names the tool whose
 *  result `fit` guards, for its rows; pi's tool API does not say it. */
export async function callContext(api: ToolExecutionApi, context: Context, tool?: string): Promise<CallContext> {
  return contextOf(api, api.callId, (await api.agent(context)).model, context, tool);
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

/** `env` as the core is given it: the same files and programs, with every program started on the adapter's child
 *  environment and nothing else. pi's environments give a program the whole of the host process's unless a call says
 *  not to, so each call says so. */
function withChildEnv(env: VisionEnv, childEnv: () => Record<string, string>): VisionEnv {
  return {
    get id() { return env.id; },
    get cwd() { return env.cwd; },
    set cwd(value) { env.cwd = value; },
    readBinaryFile: (path, context) => env.readBinaryFile(path, context),
    openBinaryReader: (path, opened, context) => env.openBinaryReader(path, opened, context),
    writeFile: (path, content, context) => env.writeFile(path, content, context),
    renameFile: (from, to, context) => env.renameFile(from, to, context),
    createDir: (path, created, context) => env.createDir(path, created, context),
    createTempDir: (prefix, context) => env.createTempDir(prefix, context),
    fileInfo: (path, context) => env.fileInfo(path, context),
    remove: (path, removed, context) => env.remove(path, removed, context),
    exec: (command, run, context) => {
      const started: Parameters<VisionEnv["exec"]>[1] & { inheritEnv: false } = { ...run, env: { ...childEnv(), ...run?.env }, inheritEnv: false };
      return env.exec(command, started, context);
    },
  };
}

/** The host contract, and one thing only an adapter that starts programs needs: `env`, the whole environment of every
 *  program a read starts (a PDF reader, ffmpeg, LibreOffice), in whichever environment the call runs and whatever
 *  that environment would give a program itself. Without it a program gets `inheritedEnv()` of `./node`: where
 *  programs are found, home, temp, locale and time zone, and never the rest of this process's environment. A host
 *  whose calls run on another machine names that machine's. `scope` is also given pi's own conversation id, which
 *  pi's documents and `harness.snapshot` take; it is undefined only for a call context the host built itself rather
 *  than through `callContext`. */
export type VisionAdapterOptions = Omit<VisionOptions, "scope"> & {
  readonly scope: (conversationId: string, id: ConversationId | undefined) => ReturnType<VisionOptions["scope"]>;
  readonly env?: ChildEnv;
};

export function createVisionExtension(options: VisionAdapterOptions): VisionHandle {
  const childEnv = () => childEnvOf(options.env);
  // The host's converters first, then the package's own; Photon fits images when the host gives no processor and this
  // process can load it, since it runs here and not in the call's environment.
  const providers = [...(options.providers ?? []), ...packageProviders()];
  const photon = options.images ? undefined : photonImages();
  const here = nodeVisionEnv({ cwd: process.cwd(), ...(options.env ? { env: options.env } : {}) });
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
    eyes: eyesFor(call.conversationId, piCalls.get(call)?.models),
    scope: await options.scope(call.conversationId, piCalls.get(call)?.id),
    evidence: options.evidence,
    ...(await images().then((processor) => (processor ? { images: processor } : {}))),
    providers,
    sources: options.sources ?? {},
    ...(options.allow ? { allow: options.allow } : {}),
    // `onLook` reaches the core as the host gave it: the core never lets it fail a call, and reads its throw as the host
    // not having heard of the look.
    ...(options.onLook ? { onLook: options.onLook } : {}),
    ...(onMiss ? { onMiss } : {}),
  });
  // A setup the host's own callbacks fail to make is a typed miss for the model and the host's `onMiss`, never their error.
  const readFor = async (env: VisionEnv, args: ReadArgs, call: CallContext): Promise<ToolResult | null> => {
    const port = withChildEnv(env, childEnv);
    let made: CallSetup;
    try { made = await setup(call); } catch (error) {
      if (call.signal?.aborted) throw error;
      return readWithoutSetup(port, args, call, error, { sources: options.sources ?? {}, onMiss });
    }
    return readMedia(port, args, call, made);
  };

  // The wrapped `read` serves media itself and gives plain text to the tool it wraps. Both halves only read, so a cut
  // call runs again; an answer the eyes gave is a memo by then and is not asked for twice.
  const readWrap: Wrap = {
    tool: "read",
    wrap: (tool: ToolRegistration): ToolRegistration => ({
      ...withReadMedia(tool),
      replay: "safe",
      prepareArguments: (args) => withoutPageZero(tool.prepareArguments ? tool.prepareArguments(args) : args),
      execute: async (args, api, context) => {
        const media = api.env ? await readFor(api.env, args as ReadArgs, await callContext(api, context)) : null;
        return media ? piResult(media) : tool.execute(args, api, context);
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
      const at = contextOf(api, call.id, (await api.snapshot(AgentDoc, api.conversationId, context))?.model, context, call.name);
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
    read: readFor,
    fit: async (result, call) => guardResult(result, call, await setup(call)),
    pdfText: (bytes, signal) => pdfText(bytes, { env: here, providers, ...(signal ? { signal } : {}) }),
  };
}
