// What the generated operations (operations.generated.ts) and the hand-written runtime share.

/** Options every method takes. */
export interface RequestOptions {
  /** Aborts the request; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** How long one try may take, its answer read included, in milliseconds (default: the client's `timeoutMs`). */
  timeoutMs?: number;
}

/** Options of an operation whose body may be bytes or text as well as JSON. */
export interface BodyOptions extends RequestOptions {
  /** The type of a body given as bytes or text (default: the operation's first type that is not JSON). */
  contentType?: string;
}

/** Options of a download: with `stream: true` the method resolves to the `Response`, its body unread. */
export interface DownloadOptions<S extends boolean = false> extends RequestOptions {
  stream?: S;
}

/** A body sent as it is, not as JSON. */
export type RawBody = Uint8Array | ArrayBuffer | Blob | string;

/** What an operation's answer is, by its media types: JSON, text, bytes, a mix decided by the answer's type, or nothing. */
export type AnswerKind = "none" | "json" | "text" | "bytes" | "json+text" | "json+bytes" | "text+bytes" | "json+text+bytes";

/** One operation, as the runtime sends it. */
export interface Operation {
  readonly method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly pathParams: readonly string[];
  /** The path parameters that are file paths: their slashes are kept. Every other one is encoded whole. */
  readonly multiSegment: readonly string[];
  readonly query: readonly string[];
  readonly headers: readonly string[];
  readonly body: null | { readonly required: boolean; readonly types: readonly string[] };
  readonly answer: AnswerKind;
  /** The body carries secrets: each copy is cut from the answer, and a refusal keeps only its code. */
  readonly secret: boolean;
  /** A secret body's string fields that are no secret, by their full path. */
  readonly publicFields: readonly string[];
}

/** How a generated method sends its operation. */
export type Call = (
  operationId: string,
  args: readonly string[],
  body: unknown,
  params: object | undefined,
  options: (RequestOptions & { contentType?: string; stream?: boolean }) | undefined,
) => Promise<any>; // each generated method declares its own result type
