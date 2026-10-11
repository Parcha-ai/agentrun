// The budgets every plan is held to. A model's own `inputLimits` (pi-ai's registry) come first, what the host declares
// for its route (a gateway's body cap, native video) over them, these defaults under both. Each constant names where its
// number comes from and when that was read or measured; "measured" means on synthetic fixtures, never a real document.

const MiB = 1024 * 1024;

/** Image edges in pixels and base64 bytes: pi-ai 1.0.4's registry resize profile for its Anthropic, OpenAI and Google models (read 2026-10-09). */
export const DEFAULT_IMAGE_MAX_EDGE = 2000;
export const DEFAULT_IMAGE_MAX_BYTES = 4_718_592;
/** JPEG quality of a re-encoded image: the same registry profile (read 2026-10-09). */
export const DEFAULT_JPEG_QUALITY = 80;
/** An image whose header claims more pixels is refused before any decode, a guard against decompression bombs (2026-10-09). */
export const DECODE_GUARD_PIXELS = 100_000_000;
/** Tile when the long edge is over this many short edges: fitted whole, a 1288x8319 screenshot is 243 px wide (measured 2026-10-09). */
export const TILE_ASPECT = 2;
/** ... and fitting whole would keep less than this share of the long edge (a shrink of more than 40%) (2026-10-09). */
export const TILE_KEEP_BELOW = 0.6;
/** A tile's long edge: Anthropic's vision guide sends images up to 1,568 px on the long edge unscaled (read 2026-10-09). */
export const TILE_MAX_EDGE = 1568;
/** Pixels two neighbouring tiles share, so a line of text cut by one edge is whole in the other (2026-10-09). */
export const TILE_OVERLAP = 64;
/** A fitted page or tile with a shorter long edge is refused, never sent: provisional, from legibility on synthetic scans (measured 2026-10-09). */
export const FLOOR_EDGE = 768;
/** Images in one result: the eight video frames hosts already show; Anthropic tightens its image limit above 20 in a request (read 2026-10-09). */
export const IMAGES_PER_CALL = 8;
/** One result's image bytes are at most this share of the request budget: eight images at the per-image limit make 36 MiB (2026-10-09). */
export const RESULT_BYTES_SHARE = 0.25;
/** Pages one `read` shows: a rendered page is about 3,000 input tokens on current OpenAI models (read 2026-10-09). */
export const PAGES_PER_READ = 4;
/** A page renders at `min(PDF_MAX_DPI, floor(POINTS_PER_INCH * maxEdge / long edge in points))`: 110 dpi lost identifier characters 200 dpi kept (measured 2026-10-09). */
export const PDF_MAX_DPI = 200;
export const POINTS_PER_INCH = 72;
/** Characters of a page's text layer shown beside its render: the cap hosts already apply (read 2026-10-09). */
export const PAGE_TEXT_CHARS = 8000;
/** Frames one video `read` shows, each found by seek: eight seeks take 1.9 s on a 30 minute file, an fps filter 12.8 s (measured 2026-10-09). */
export const VIDEO_FRAMES_PER_READ = 8;
/** A window that does not fit by stream copy is re-encoded once, to this long edge and frame rate; never the whole file (measured 2026-10-09). */
export const VIDEO_REENCODE_EDGE = 1280;
export const VIDEO_REENCODE_FPS = 6;
/** Inline video is at most this share of the request budget, in raw bytes after base64's 4/3 growth (2026-10-09). */
export const VIDEO_INLINE_SHARE = 0.6;
/** Raw inline video bytes when no request cap is known: the budget hosts already apply (read 2026-10-09). */
export const DEFAULT_VIDEO_INLINE_BYTES = 12_000_000;
/** Taken off the smallest known request cap for the request's text and framing (2026-10-09). */
export const REQUEST_HEADROOM_BYTES = 1 * MiB;
/** The request budget when neither the model nor the host names a cap: under the smallest cap in pi-ai 1.0.4's registry, 20 MiB (read 2026-10-09). */
export const DEFAULT_REQUEST_BYTES = 16 * MiB;
/** `look`: pages in one eyes request and in one call; the call cap bounds cost (2026-10-09). */
export const LOOK_PAGES_PER_REQUEST = 10;
export const LOOK_PAGES_PER_CALL = 200;
/** `look`: video frames in one eyes request and in one call (2026-10-09). */
export const LOOK_FRAMES_PER_REQUEST = 20;
export const LOOK_FRAMES_PER_CALL = 120;
/** `look`: eyes requests in flight at once (2026-10-09). */
export const LOOK_CONCURRENCY = 4;
/** A look is priced before its first request at this many input tokens a part, the bound measured for a page on current OpenAI models (read 2026-10-09). */
export const LOOK_TOKENS_PER_PART = 3000;
/** A look priced over this many dollars is refused with the estimate, unless the host sets its own cap (2026-10-09). */
export const LOOK_MAX_USD = 0.25;
/** One request to the eyes is cut after this long (2026-10-09). */
export const SEE_TIMEOUT_MS = 120_000;
/** Source bytes read into this process; a larger file needs a provider that works on it in its environment: pdf.js held 455 MB for a 200 page file (measured 2026-10-09). */
export const SOURCE_BYTES_IN_PROCESS = 64 * MiB;

/** pi-durable's image limits: what an `ImageProcessor` fits to. */
export type ImageLimits = { readonly maxWidth: number; readonly maxHeight: number; readonly maxBytes: number };

/** The budgets a plan is held to, resolved for one route. */
export type Limits = {
  readonly image: ImageLimits & { readonly jpegQuality: number };
  /** Images in one result, never over the model's own `maxPerMessage`. */
  readonly imagesPerCall: number;
  readonly pagesPerRead: number;
  /** One request body: the smallest known cap less `REQUEST_HEADROOM_BYTES`, or `DEFAULT_REQUEST_BYTES`. */
  readonly requestBytes: number;
  readonly video: { readonly native: boolean; readonly inlineBytes: number };
};

/** What a host declares for its route over the model's limits. Each value replaces the model's, except
 *  `requestBytes`, the route's own cap on a request body: the smaller of it and the model's cap wins, since both bound
 *  the same request. */
export type LimitsOverride = {
  readonly image?: Partial<Limits["image"]>;
  readonly imagesPerCall?: number;
  readonly pagesPerRead?: number;
  readonly requestBytes?: number;
  readonly video?: Partial<Limits["video"]>;
};

export const DEFAULT_LIMITS: Limits = Object.freeze({
  image: Object.freeze({ maxWidth: DEFAULT_IMAGE_MAX_EDGE, maxHeight: DEFAULT_IMAGE_MAX_EDGE, maxBytes: DEFAULT_IMAGE_MAX_BYTES, jpegQuality: DEFAULT_JPEG_QUALITY }),
  imagesPerCall: IMAGES_PER_CALL,
  pagesPerRead: PAGES_PER_READ,
  requestBytes: DEFAULT_REQUEST_BYTES,
  video: Object.freeze({ native: false, inlineBytes: DEFAULT_VIDEO_INLINE_BYTES }),
});

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);
const defined = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

/** The limits a pi-ai `Model` declares in `inputLimits`, as an override. Read structurally, so the core imports no pi
 *  package; a missing, zero or malformed value is absent, never a limit of zero. */
export function limitsFromModel(model: unknown): LimitsOverride {
  const limits = record(record(model)?.inputLimits);
  const images = record(limits?.images);
  const resize = record(images?.resize);
  const image = defined({ maxWidth: positive(resize?.maxWidth), maxHeight: positive(resize?.maxHeight), maxBytes: positive(resize?.maxBytes), jpegQuality: positive(resize?.jpegQuality) });
  return defined({
    image: Object.keys(image).length ? image : undefined,
    imagesPerCall: positive(images?.maxPerMessage),
    requestBytes: positive(limits?.maxRequestBytes),
  });
}

/** The budgets for one route: the defaults, then the model's own limits, then the host's. */
export function resolveLimits(model: unknown, host: LimitsOverride = {}): Limits {
  const own = limitsFromModel(model);
  const caps = [own.requestBytes, positive(host.requestBytes)].filter((cap): cap is number => cap !== undefined);
  const requestBytes = caps.length ? Math.max(0, Math.min(...caps) - REQUEST_HEADROOM_BYTES) : DEFAULT_REQUEST_BYTES;
  const perMessage = own.imagesPerCall ?? Infinity;
  const pick = (value: unknown, fallback: number) => positive(value) ?? fallback;
  return {
    image: {
      maxWidth: pick(host.image?.maxWidth, own.image?.maxWidth ?? DEFAULT_IMAGE_MAX_EDGE),
      maxHeight: pick(host.image?.maxHeight, own.image?.maxHeight ?? DEFAULT_IMAGE_MAX_EDGE),
      maxBytes: pick(host.image?.maxBytes, own.image?.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES),
      jpegQuality: pick(host.image?.jpegQuality, own.image?.jpegQuality ?? DEFAULT_JPEG_QUALITY),
    },
    imagesPerCall: Math.min(pick(host.imagesPerCall, IMAGES_PER_CALL), perMessage),
    pagesPerRead: pick(host.pagesPerRead, PAGES_PER_READ),
    requestBytes,
    video: {
      native: host.video?.native === true,
      inlineBytes: pick(host.video?.inlineBytes, caps.length ? Math.floor(requestBytes * VIDEO_INLINE_SHARE * 3 / 4) : DEFAULT_VIDEO_INLINE_BYTES),
    },
  };
}
