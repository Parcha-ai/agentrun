// pi's tools as the kernel registry's executors: read, write, edit and bash's own run, each pi's own tool on the run's
// file environment (pi-env.ts), its answer as a tool answer the registry passes on and a host renders (answerText).
// One answer for every harness: the output a tool keeps within its limits as it comes (its tail, bash's; its head,
// read's), then the failure's words, then its diagnostics, the same text host-tools.ts has given another harness's
// call since the host tools began, now for pi's runs too.
//
// pi's tools take only the environment, their output and their diagnostics from a call's API, and read its agent's
// model for an image's limits: a call here has no pi model, so read uses pi's default image limits, as a host tool
// always has. A tool's thrown failure (bash's timeout, a nonzero exit is a result) is not thrown on: it is the
// answer's `error`, so the output that came before it is kept, and the registry's bound on bash can add its words to it.
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** pi's limits on a tool's output (its DEFAULT_MAX_BYTES and DEFAULT_MAX_LINES), unless the tool names its own: read's
 *  head and bash's tail are held to them (the host-bounds test reads pi's own words for them). */
export const MAX_BYTES = 50 * 1024;
export const MAX_LINES = 2000;

/** Whether `byte` continues a UTF-8 character (0b10xxxxxx), so a cut before it would split one. */
const continues = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

/** `bytes` (UTF-8) cut to at most `max` bytes, its tail or its head, at a character boundary: a character the limit
 *  would split is left out whole, so the text never ends or starts in a U+FFFD. */
export function cutUtf8(bytes: Uint8Array, max: number, tail: boolean): Uint8Array {
  if (bytes.length <= max) return bytes;
  if (tail) {
    let start = bytes.length - max;
    while (continues(bytes[start])) start++;
    return bytes.subarray(start);
  }
  // The byte at `end` is the first one left out: while it continues a character, that character goes too.
  let end = max;
  while (end > 0 && continues(bytes[end])) end--;
  return bytes.subarray(0, end);
}

/** A call's output, held within the tool's limits as it arrives: its tail (bash's) or its head. */
export function bounded(limits: ToolRegistration["outputLimits"]) {
  const maxBytes = limits?.maxBytes ?? MAX_BYTES;
  const maxLines = limits?.maxLines ?? MAX_LINES;
  const tail = limits?.retain === "tail";
  // Bytes are decoded as one stream: a character whose bytes arrive in two chunks is one character.
  const decoder = new StringDecoder("utf8");
  let kept = "";
  let cut = false;
  const trim = (text: string): string => {
    const lines = text.split("\n");
    let out = lines.length > maxLines ? (tail ? lines.slice(-maxLines) : lines.slice(0, maxLines)).join("\n") : text;
    const bytes = Buffer.from(out, "utf8");
    if (bytes.length > maxBytes) out = Buffer.from(cutUtf8(bytes, maxBytes, tail)).toString("utf8");
    if (out !== text) cut = true;
    return out;
  };
  return {
    push(chunk: string | Uint8Array) {
      const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
      if (!tail && cut) return;
      kept += text;
      // Trimmed once it is twice the limit, so a long output costs a bounded amount of memory and work.
      if (kept.length > 2 * maxBytes) kept = trim(kept);
    },
    /** What is kept so far, and whether any was cut: pi 1.2's `retainedOutput`. */
    retained: () => {
      const text = trim(kept);
      return { text, truncated: cut };
    },
    text(): string {
      const out = trim(kept);
      return cut ? (tail ? `[earlier output omitted]\n${out}` : `${out}\n[later output omitted]`) : out;
    },
  };
}

/** A result's text blocks, joined. */
export const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "")).join("") : "";

/** A result's image blocks (pi-ai's `ImageContent`), as a host tool's `images`. */
export const imagesOf = (content: unknown): { mimeType: string; data: string }[] =>
  Array.isArray(content) ? content.flatMap((block) => (block && typeof block === "object" && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string" ? [{ mimeType: block.mimeType, data: block.data }] : [])) : [];

/** A tool's answer, as the kernel registry's ToolAnswer, with the failure's words apart (`error`). */
export type PiAnswer = {
  readonly text: string;
  readonly images?: readonly { mimeType: string; data: string }[];
  readonly isError?: boolean;
  /** The words of the failure the tool threw ("Command timed out after 120 seconds"), after its output. */
  readonly error?: string;
  readonly diagnostics?: readonly { readonly severity: "info" | "warn" | "error"; readonly code?: string; readonly message: string }[];
};
/** A call's world, as the kernel registry gives it to an executor: its signal, and where output streamed goes. */
export type PiCall = { readonly signal?: AbortSignal; output?(chunk: string): void };
export type PiExecutor = (args: unknown, call: PiCall) => Promise<PiAnswer>;

/** The text a model reads for `answer`: the output, the failure's words, then each diagnostic, apart by blank lines. */
export const answerText = (answer: PiAnswer): string =>
  [answer.text, answer.error, ...(answer.diagnostics ?? []).map((note) => note.message)].filter((part) => part).join("\n\n");

/** pi's `tool` as an executor on file environment `env`, its context `context` (each call's signal added). */
export function piExecutor(tool: ToolRegistration, env: ExecutionEnv, context: Context): PiExecutor {
  return async (args, call) => {
    const out = bounded(tool.outputLimits);
    const notes: PiAnswer["diagnostics"] & object[] = [];
    const api = {
      env, callId: randomUUID(),
      commit: () => { throw new Error("a host tool commits nothing to a run's pi store"); },
      output: (chunk: string | Uint8Array) => {
        out.push(chunk);
        call.output?.(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      },
      outputWindow: undefined, retainedOutput: () => out.retained(),
      diagnostic: (note: { severity: "info" | "warn" | "error"; code?: string; message: string }) => void notes.push(note),
      // pi's read asks the calling agent for its model, for an image's limits: none here, so pi's defaults.
      agent: async () => ({ model: undefined }),
      models: createModels(),
    };
    // Only these members (host-tools.ts HOST_API_MEMBERS, which scripts/host-tool-api.test.mjs holds to every member
    // pi's tools read): a read of any other names it, rather than reading as "is not a function".
    const guarded = new Proxy(api, {
      get: (target, key) => {
        if (typeof key === "symbol" || key === "then" || Object.hasOwn(target, key)) return Reflect.get(target, key);
        throw new Error(`a host tool's api has no ${key}: pi gives it only to a tool its own tool task runs`);
      },
    }) as unknown as ToolExecutionApi;
    const signal = call.signal ?? new AbortController().signal;
    let result: { output?: unknown; isError?: boolean; diagnostics?: readonly { severity: "info" | "warn" | "error"; code?: string; message: string }[] };
    try {
      result = (await tool.execute(args as never, guarded, withAbortSignal(signal, context))) as typeof result;
    } catch (error) {
      if (signal.aborted) throw error;
      return { text: out.text(), isError: true, error: (error as Error)?.message ?? String(error), diagnostics: notes };
    }
    const images = imagesOf(result.output);
    return {
      text: textOf(result.output) || out.text(),
      isError: result.isError === true,
      diagnostics: [...notes, ...(result.diagnostics ?? [])],
      ...(images.length ? { images } : {}),
    };
  };
}
