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

/** An image block; a video is one with a video MIME type. */
export type ImageContent = { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** A tool result as the core builds it; an adapter turns it into its host's shape. */
export type ToolResult = {
  readonly content: readonly (TextContent | ImageContent)[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  /** Set when the result paid for a model request: the sum of its requests. */
  readonly usage?: Usage;
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
  /** The id of the tool call this call serves, as the host's timeline names it. Every look made under it files it as
   *  `parentToolCallId`, so a timeline draws the look under that call. A look made under `vision.see`, `vision.judge` or
   *  `vision.transcribe` in a script is under the tool call that ran the script. Absent: a look files none. */
  readonly toolCallId?: string;
  readonly model: unknown;
  readonly signal: AbortSignal | undefined;
  /** The value kept under `key`, else `compute`'s, kept before it is returned: a call cut by a crash and run again, or
   *  a later call that asks the same, gets the kept value without computing it. A paid request goes through it, so its
   *  answer is kept before the result that reports it. The pi-durable adapter keeps a tool call's on its conversation, so
   *  a new call finds what a cut one paid for, and a hook's on its task. Absent: computed every time. */
  readonly memo?: <T extends Json>(key: string, compute: () => Promise<T>) => Promise<T>;
};
