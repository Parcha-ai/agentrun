import type { MissCode } from "./contract.js";
import type { VisionEnv } from "./env.js";
import type { ImageSize, MediaDetails } from "./guard.js";
import type { ImageContent, TextContent } from "./host.js";
import type { ImageProcessor } from "./image.js";
import type { Kind } from "./kinds.js";
import type { Limits } from "./limits.js";
import type { Fit } from "./plan.js";
import type { Provider, ProviderSource } from "./provider.js";

/** A source's kind from its first bytes and its name (`sniffKind`'s answer, kinds.ts), or why the two disagree. */
export type SniffOutcome =
  | { readonly ok: true; readonly kind: Kind; readonly mimeType: string | null; readonly signature?: string }
  | { readonly ok: false; readonly code: "unsupported"; readonly reason: string };

/** What a kind's reader is asked: the source in the environment, the path as the model wrote it, and the arguments.
 *  `source.path` is a private copy of the bytes that were hashed, and `data` those bytes, for a source the process
 *  holds; a larger source is read where it is. A reader never opens the model's own path. */
export type KindRequest = {
  readonly source: ProviderSource; readonly data?: Uint8Array; readonly name: string; readonly mimeType: string; readonly width?: number; readonly height?: number;
  readonly ask?: string; readonly page?: number; readonly fromS?: number; readonly toS?: number;
};
/** What a kind's reader works with: the environment; the limits its images must meet (the lead's, with the eyes' image
 *  limits when the lead takes no images, and the eyes' video limits for a video when the eyes take video and the lead
 *  does not); where kept derivations go, named by the source's hash and their parameters
 *  (absent: nothing is kept); a directory removed when the read ends; and the image processor and providers. */
export type KindContext = {
  readonly env: VisionEnv; readonly signal: AbortSignal | undefined; readonly limits: Limits; readonly deriveDir?: string; readonly tempDir: string;
  readonly images?: ImageProcessor; readonly providers: readonly Provider[];
};
/** A kind's answer: what the model reads (a document's whole `text`, page-marked, is paged here after the first text
 *  block), a miss with its cause and any text that still came back, or a refusal of the arguments in one line. */
export type KindResult =
  | { readonly content: readonly (TextContent | ImageContent)[]; readonly text?: string; readonly media?: MediaDetails; readonly fit?: Fit;
      /** What a document read as text says of itself in the result's `details.document`: where its text is kept, who extracted it, its page or pages. */
      readonly document?: Readonly<Record<string, unknown>> }
  | { readonly miss: MissCode; readonly reason: string; readonly text?: string }
  | { readonly refusal: string };
/** The reader of one kind: a request in, the content or the miss out. */
export type KindReader = (request: KindRequest, context: KindContext) => Promise<KindResult>;

/** The package's own kind wiring: the kind of a file's first bytes, an image header's pixels, and a reader per kind. */
export type ReadKinds = {
  readonly sniff: (head: Uint8Array, path: string) => SniffOutcome;
  readonly sizeOf: ImageSize;
  readonly readers: Readonly<Partial<Record<Kind, KindReader>>>;
};

