/** One image a request carries: PNG or JPEG file bytes and their type. */
export type JevImage = { readonly bytes: Uint8Array; readonly mime: "image/png" | "image/jpeg" };

/** Jev's answer to one request as the port gives it: the typed answers, the model, its tokens, and its price, null when
 *  the port does not know it. */
export type JevResult = { readonly answers: unknown; readonly model?: string | null; readonly usage?: { readonly input_tokens: number; readonly output_tokens: number } | null; readonly cost_usd?: number | null };

/** Jev as the host reaches it: `judge` is the port `@parcha/agentrun-jev`'s `createJevRunner` returns, which owns the
 *  transport, the images header and the price; `assets` maps each reference written in the state or a question to its
 *  image. `model` is the one to ask (default `JEV_MODEL`). */
export type JevPort = {
  judge(params: { readonly label: string; readonly kind: string; readonly state: unknown; readonly questions: Readonly<Record<string, unknown>>; readonly assets?: Readonly<Record<string, JevImage>>; readonly model?: string; readonly signal?: AbortSignal }): Promise<JevResult>;
  readonly model?: string;
};

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
