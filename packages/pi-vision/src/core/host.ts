// The host contract: everything here is a value or a function the host builds. The host names the model that looks
// and its price, files the receipts, keeps its rows, guards paths before the core sees them and decides which handles
// a run owns. No credential is ever written into a result, a detail, a receipt, a derived name or a memo.

import type { EvidenceSink, LookEvent } from "./evidence.js";
import type { VisionEnv } from "./env.js";
import type { ImageProcessor } from "./image.js";
import type { JevPort } from "./judge.js";
import type { Kind } from "./kinds.js";
import type { Limits, LimitsOverride } from "./limits.js";
import type { MissEvent } from "./misses.js";
import type { Part } from "./plan.js";
import type { Provider } from "./provider.js";
import type { Transcriber } from "./transcribe.js";

/** Tokens and price of one model request, in pi-ai's `Usage` shape, so a host passes pi-ai's through unchanged. */
export type Usage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly total: number };
};

/** pi-ai's text and image content blocks. A video goes as an image block with a video MIME type. */
export type TextContent = { readonly type: "text"; readonly text: string };
export type ImageContent = { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** A tool result as the core builds it; an adapter turns it into its host's shape. */
export type ToolResult = {
  readonly content: readonly (TextContent | ImageContent)[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  /** Set when the result paid for a model request: the sum of its requests. */
  readonly usage?: Usage;
};

/** `read`'s arguments; a strict route's zero values are treated as absent. */
export type ReadArgs = {
  readonly path: string; readonly offset?: number; readonly limit?: number; readonly char_offset?: number;
  readonly ask?: string; readonly from_s?: number; readonly to_s?: number; readonly page?: number;
};

/** A JSON value: what a memo keeps. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The call a read, a fit or a look serves: whose conversation, which call, the lead's model (its limits and what it
 *  takes), the call's cancellation, and its memos. */
export type CallContext = {
  readonly conversationId: string;
  readonly callId: string;
  /** The tool the model called, as the guard's looks and misses name it in rows and receipts. Absent: `read`. */
  readonly tool?: string;
  readonly model: unknown;
  readonly signal: AbortSignal | undefined;
  /** The value kept under `key`, else `compute`'s, kept before it is returned: a call cut by a crash and run again, or
   *  a later call that asks the same, gets the kept value without computing it. A paid request goes through it, so its
   *  answer is kept before the result that reports it. The pi-durable adapter keeps a tool call's on its conversation, so
   *  a new call finds what a cut one paid for, and a hook's on its task. Absent: computed every time. */
  readonly memo?: <T extends Json>(key: string, compute: () => Promise<T>) => Promise<T>;
};

/** Who looks: one request to a model with eyes, on the tier the host names. */
export type Eyes = {
  /** Named in receipts. */
  readonly model: string;
  readonly accepts: { readonly image: boolean; readonly video: boolean; readonly pdf: boolean };
  readonly limits: Limits;
  see(request: { readonly parts: readonly Part[]; readonly ask: string; readonly context?: string }, signal: AbortSignal): Promise<EyesAnswer>;
};

export type EyesAnswer = {
  readonly text: string;
  readonly model: string;
  readonly usage: Usage;
  /** Null when the price is not known, never 0; 0 when `billedBy` names the service that billed it. */
  readonly costUsd: number | null;
  readonly billedBy?: string;
};

/** Things that are not files, read by handle (`session:<id>`): a service that looks for us, or the bytes as a file. */
export type SourceProvider = {
  readonly via: string;
  /** True when the conversation owns the handle; otherwise the refusal the model reads. */
  owns?(id: string, target: { readonly conversationId: string }): Promise<true | string>;
  look?(request: { readonly id: string; readonly ask: string; readonly fromS?: number; readonly toS?: number; readonly context?: string }, signal: AbortSignal):
    Promise<{ readonly text: string; readonly model: string; readonly costUsd: number; readonly billedBy?: string }>;
  open?(id: string, env: VisionEnv, signal: AbortSignal): Promise<{ readonly path: string } | { readonly notReady: string }>;
};

export type VisionOptions = {
  /** Default "vision". */
  readonly name?: string;
  /** Who looks. Absent on pi 1.1 or later: `api.models` with `eyesModel`. Absent otherwise: no eyes, and every look is a typed miss. */
  readonly eyes?: Eyes | ((target: { readonly conversationId: string }) => Eyes | undefined);
  readonly eyesModel?: { readonly provider: string; readonly modelId: string; readonly thinking?: string };
  /** What the lead's route takes over the model's own `inputLimits`: a gateway's body cap, native video. */
  readonly limits?: (target: { readonly conversationId: string; readonly model: unknown }) => LimitsOverride;
  /** Where every look is filed. */
  readonly evidence: EvidenceSink;
  /** The conversation's receipt label and the directory derivations are written to. `conversationId` is the host's id
   *  as a string (pi-durable's is `String(api.conversationId)`); the pi-durable adapter passes pi's own id second. In
   *  that adapter a throw here, in `eyes` or in `limits` is a `look_failed` miss for a media `read`, never the error. */
  readonly scope: (conversationId: string) => { readonly label: string; readonly deriveDir: string } | Promise<{ readonly label: string; readonly deriveDir: string }>;
  /** Default: Photon, when it is installed. */
  readonly images?: ImageProcessor;
  /** More converters: LibreOffice, a hosted reader. */
  readonly providers?: readonly Provider[];
  /** Handles by scheme: "session" for browser recordings. */
  readonly sources?: Readonly<Record<string, SourceProvider>>;
  /** Host policy: true, or the refusal the model reads. Absent: everything is allowed. */
  readonly allow?: (request: { readonly path: string; readonly kind: Kind; readonly tool: "read" | "vision.see" | "vision.judge" | "vision.transcribe" }) => true | string;
  /** Jev, for `vision.judge`: the port `@parcha/agentrun-jev`'s `createJevRunner` returns. Absent: every judgment is a
   *  `no_vision_route` miss. */
  readonly jev?: JevPort;
  /** The speech-to-text model for `vision.transcribe`, from `@parcha/pi-vision/transcribers` (fal, ElevenLabs, OpenAI);
   *  it holds its own key. Absent: every transcription is a `no_vision_route` miss. */
  readonly transcriber?: Transcriber;
  /** The host's rows and spend. A throw here never fails a call. */
  readonly onLook?: (look: LookEvent) => void | Promise<void>;
  readonly onMiss?: (miss: MissEvent) => void | Promise<void>;
  readonly section?: { readonly addendum?: string };
  readonly install?: { readonly read?: "wrap" | "off"; readonly guard?: boolean };
};

/** What the adapter resolved from `VisionOptions` for one call: the route's limits, who looks, where derivations and
 *  receipts go, the host's converters, handles and policy, and its rows. `onMiss` never throws; `onLook` is the host's
 *  own, which the core calls so that a throw never fails a call and the look is told again if the call runs again. */
export type CallSetup = {
  readonly limits: Limits;
  readonly eyes: Eyes | undefined;
  readonly scope: { readonly label: string; readonly deriveDir: string };
  readonly evidence: EvidenceSink;
  readonly images?: ImageProcessor;
  /** The host's converters, beside the package's own. */
  readonly providers: readonly Provider[];
  readonly sources: Readonly<Record<string, SourceProvider>>;
  readonly allow?: VisionOptions["allow"];
  readonly jev?: JevPort;
  readonly transcriber?: Transcriber;
  readonly onLook?: (look: LookEvent) => void | Promise<void>;
  readonly onMiss?: (miss: MissEvent) => void | Promise<void>;
};
