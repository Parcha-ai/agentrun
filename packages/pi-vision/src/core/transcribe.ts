// `vision.transcribe`, a code-mode global beside `vision.see`: the host's speech-to-text model writes what is said in
// one audio or video file, as words with their start and end in seconds of that file. The host picks the model and holds
// its key (`VisionOptions.transcriber`, built by `@parcha/pi-vision/transcribers`); the call never sees it. The answer is
// kept before it is filed and told, so a call run again, or a new call after a cut one, pays once. Cutting a long file
// into pieces, the transcript file and searching it stay with the agent (the `transcribe` skill).

import { VISION_TRANSCRIBE } from "./contract.js";
import { visionContext, type VisionEnv } from "./env.js";
import { fileLook, fileTold, keptAnswer, lookKey, type Filing, type LookRecord } from "./evidence.js";
import type { CallContext, CallSetup } from "./host.js";
import { sniffKind, SNIFF_BYTES, type Kind } from "./kinds.js";
import { once, throwMiss } from "./media.js";
import { ProviderMiss } from "./derive.js";
import { firstLine, type Miss } from "./misses.js";
import { argvPath } from "./paths.js";
import { sha256Hex } from "./primitives.js";
import { lookTiming } from "./timing.js";
import type { CodeGlobal } from "./see.js";

/** A word and where it is, in seconds from the start of the file. */
export type TranscriptWord = { readonly text: string; readonly start: number; readonly end: number };
/** What a transcriber answers: the words, the text, the model that answered, and the file's length when the provider
 *  says it. */
export type Transcript = { readonly words: readonly TranscriptWord[]; readonly text: string; readonly model?: string; readonly durationS?: number };
/** A speech-to-text model as the host reaches it. It holds its own key; nothing it returns carries the key. */
export type Transcriber = {
  readonly provider: string;
  readonly model: string;
  /** The largest file one request takes, in bytes, and how the miss names it; a bigger file is an `over_budget` miss
   *  before any request. */
  readonly maxBytes?: number;
  readonly limit?: string;
  /** The list price per audio minute. Absent, a transcript's price is unknown (null), never 0. */
  readonly usdPerMinute?: number;
  /** Throws a `ProviderMiss` only before it sends a request; anything else it throws may have been billed. */
  transcribe(audio: { readonly bytes: Uint8Array; readonly mimeType: string; readonly name: string }, options: { readonly language?: string }, signal?: AbortSignal): Promise<Transcript>;
};
/** What `vision.transcribe` is asked: the file, the part of it (a `#t=` fragment) and a language the speech is in, when known. */
export type TranscribeRequest = { readonly path: string; readonly fragment?: string; readonly language?: string };
/** What `vision.transcribe` gives back: the words with their seconds, the text, who answered and with which model, the price (null when unknown) and the receipts filed. */
export type TranscribeAnswer = { readonly words: readonly TranscriptWord[]; readonly text: string; readonly provider: string; readonly model: string; readonly costUsd: number | null; readonly receipts: readonly string[]; readonly kept?: true };
/** `vision.transcribe` as a code-mode global: the contract's words and `execute`, which has a speech-to-text model write what a recording says. */
export type TranscribeGlobal = CodeGlobal<typeof VISION_TRANSCRIBE, TranscribeAnswer>;

/** What is kept for a file: the words and text, who answered, and the price. */
type Heard = { readonly words: readonly TranscriptWord[]; readonly text: string; readonly provider: string; readonly model: string; readonly costUsd: number | null };

function checked(input: unknown): TranscribeRequest {
  const r = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const optional = (value: unknown) => value === undefined || (typeof value === "string" && value.trim() !== "");
  if (typeof r.path !== "string" || !r.path.trim() || !optional(r.fragment) || !optional(r.language)) {
    throw new TypeError("vision.transcribe takes { path: string, fragment?: string, language?: string }: one audio or video file");
  }
  return r as TranscribeRequest;
}

/** The transcript as the receipt shows it: a row at each pause of 0.8 s or more, or after 12 words. */
function rows(words: readonly TranscriptWord[]): string {
  const out: { start: number; end: number; words: string[] }[] = [];
  for (const w of words) {
    const last = out.at(-1);
    if (last && w.start - last.end < 0.8 && last.words.length < 12) { last.words.push(w.text); last.end = w.end; } else out.push({ start: w.start, end: w.end, words: [w.text] });
  }
  return out.map((r) => `${r.start.toFixed(2)}\t${r.end.toFixed(2)}\t${r.words.join(" ")}`).join("\n");
}

/** The file's length from ffprobe in the call's environment, when it is there. */
async function durationOf(env: VisionEnv, path: string, signal: AbortSignal | undefined): Promise<number | undefined> {
  const ctx = visionContext(signal);
  const dir = await env.createTempDir("pi-vision-duration-", ctx);
  if (!dir.ok) return undefined;
  try {
    const out = `${dir.value}/duration.txt`;
    const run = await env.exec(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "-o", out, argvPath(path)], { timeout: 60 }, ctx);
    if (!run.ok || run.value.exitCode !== 0) return undefined;
    const read = await env.readBinaryFile(out, ctx);
    const seconds = read.ok ? Number(Buffer.from(read.value).toString("utf8").trim()) : NaN;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } finally { await env.remove(dir.value, { recursive: true, force: true }, ctx); }
}

/** One `vision.transcribe` call: the file read through the call's environment, asked once, filed and told. */
export async function transcribe(input: unknown, env: VisionEnv | undefined, call: CallContext, setup: CallSetup): Promise<TranscribeAnswer> {
  const request = checked(input);
  const heard = setup.transcriber;
  const fragment = request.fragment ?? request.path;
  const model = heard?.model ?? "no transcriber";
  const filing: Filing = { conversationId: call.conversationId, label: setup.scope.label, evidence: setup.evidence, onLook: setup.onLook, onMiss: setup.onMiss };
  let sha256 = "", kind: Kind = "unknown";
  const plan = [heard?.provider ?? null, request.language ?? null];
  const record = (body: string, facts: Partial<LookRecord["facts"]> = {}): LookRecord => ({
    tool: "transcribe", args: { path: fragment, model, native: false, ...(heard ? { via: heard.provider } : {}) }, status: "ok", body,
    facts: { sha256, kind, fragment: "", key: lookKey({ sha256, fragment: "", ask: "transcribe", model, plan }), ...(heard ? { provider: heard.provider } : {}), ...lookTiming(call), ...facts },
  });
  const fail = (cause: Miss, spent: Partial<LookRecord["facts"]> = { cost_usd: 0 }): Promise<never> => throwMiss(filing, VISION_TRANSCRIBE.name, call, cause, record("", spent));
  if (!heard) return fail({ code: "no_vision_route", reason: "this host gives vision.transcribe no speech-to-text model" });
  if (!env) return fail({ code: "refused", reason: `${request.path} cannot be read: this host gives vision.transcribe no environment` });

  const ctx = visionContext(call.signal);
  const info = await env.fileInfo(request.path, ctx);
  if (!info.ok || info.value.kind !== "file") return fail({ code: "unreadable", reason: `${request.path} is not a file that opens${info.ok ? "" : ` (${firstLine(info.error)})`}` });
  if (heard.maxBytes !== undefined && info.value.size > heard.maxBytes) {
    return fail({ code: "over_budget", reason: `${request.path} is ${info.value.size} bytes, over the ${heard.limit ?? `${heard.maxBytes} bytes`} ${heard.provider} takes in one request; cut it into shorter pieces with ffmpeg and transcribe each` });
  }
  const read = await env.readBinaryFile(request.path, ctx);
  if (!read.ok) return fail({ code: "unreadable", reason: `${request.path} could not be read (${firstLine(read.error)})` });
  const sniffed = sniffKind(read.value.subarray(0, SNIFF_BYTES), request.path);
  sha256 = sha256Hex(read.value);
  if (!sniffed.ok) return fail(sniffed);
  kind = sniffed.kind;
  if (kind !== "audio" && kind !== "video") return fail({ code: "unsupported", reason: `${request.path} reads as ${kind}, not audio or a video` });
  const allowed = setup.allow?.({ path: request.path, kind, tool: VISION_TRANSCRIBE.name }) ?? true;
  if (allowed !== true) return fail({ code: "refused", reason: allowed });

  const at = record("");
  // When this call's request began; none when the answer is read back.
  let startedAt: number | undefined;
  const ask = async (): Promise<Heard> => {
    // Nothing runs between a paid answer and its keeping: the length is found before the request.
    const probed = heard.usdPerMinute === undefined ? undefined : await durationOf(env, request.path, call.signal);
    startedAt = Date.now();
    const t = await heard.transcribe({ bytes: read.value, mimeType: sniffed.mimeType ?? "application/octet-stream", name: request.path.split("/").pop()! }, request.language ? { language: request.language } : {}, call.signal);
    const seconds = t.durationS ?? probed;
    const costUsd = heard.usdPerMinute === undefined || seconds === undefined ? null : Math.round((seconds / 60) * heard.usdPerMinute * 1e6) / 1e6;
    // A word is one line with no tab: the receipt's rows, and a transcript an agent writes, are split on both.
    const words = t.words.flatMap(({ text, start, end }) => { const one = text.replace(/\s+/g, " ").trim(); return one ? [{ text: one, start, end }] : []; });
    return { words, text: t.text, provider: heard.provider, model: t.model ?? heard.model, costUsd };
  };
  const { value: { answer, readBack, receipt }, shared } = await once(call, at.facts.key, async () => {
    let answer: Heard, readBack: boolean;
    try {
      ({ answer, readBack } = await keptAnswer<Heard>(call.memo, at.facts.key, ask));
    } catch (error) {
      if (call.signal?.aborted) throw error;
      if (error instanceof ProviderMiss) return fail({ code: error.code, reason: error.message, model });
      // A request that threw may still have been billed: its price is not known, so none is filed.
      return fail({ code: "look_failed", reason: `${heard.provider} failed: ${firstLine(error)}`, model }, lookTiming(call, startedAt));
    }
    if (answer.words.length === 0 && answer.text.trim() !== "") {
      const spent = { cost_usd: answer.costUsd, ...(readBack ? { kept: true as const } : {}), ...lookTiming(call, startedAt) };
      return fail({ code: "unsupported", reason: `${answer.provider} ${answer.model} answered without word times; vision.transcribe never gives words without their seconds, so name a model that times its words`, model: answer.model }, spent);
    }
    const filed = { ...at, args: { ...at.args, model: answer.model }, body: rows(answer.words), facts: { ...at.facts, cost_usd: answer.costUsd, ...(readBack ? { kept: true as const } : {}), ...lookTiming(call, startedAt) } };
    const receipt = await fileTold(call.memo, at.facts.key, filing, (to, told) => fileLook(to, VISION_TRANSCRIBE.name, filed, { usage: null, costUsd: answer.costUsd, ...(told ? { kept: true } : {}) }));
    return { answer, readBack, receipt };
  });
  return { words: answer.words, text: answer.text, provider: answer.provider, model: answer.model, costUsd: answer.costUsd, receipts: receipt ? [receipt] : [], ...(readBack || shared ? { kept: true } : {}) };
}
