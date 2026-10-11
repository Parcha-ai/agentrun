// Images: the fit of one image to a route's limits (decode, orient, resize, re-encode as the smaller of PNG and JPEG),
// tiles in reading order for a tall or wide one, and the sentence that says the original and shown sizes. The pixels are
// moved by an `ImageProcessor`: pi-durable's `prepare` door, which a processor written for pi-durable fills as it is, and
// the operations (`raster`, `encode`, optionally `probe`) this package's processors add, which cut tiles. Every rule is
// here, once, so two processors differ in pixels only: Photon (WASM) by default, sharp when the host passes it.

import type { MissCode } from "./contract.js";
import { exceedsDecodeGuard, imageHeader, SNIFF_BYTES } from "./kinds.js";
import { DECODE_GUARD_PIXELS, DEFAULT_JPEG_QUALITY, FLOOR_EDGE, IMAGES_PER_CALL, TILE_ASPECT, TILE_KEEP_BELOW, TILE_MAX_EDGE, TILE_OVERLAP, type ImageLimits } from "./limits.js";

/** An image the model can take: a supported format, within the limits, as base64. pi-durable's `PreparedImage`. */
export type PreparedImage = {
  readonly data: string;
  readonly mimeType: string;
  /** Set when the image was resized: its size before and after, so coordinates can be mapped back. */
  readonly resized?: {
    readonly from: { readonly width: number; readonly height: number };
    readonly to: { readonly width: number; readonly height: number };
  };
  /** The original format, when it differs from `mimeType`. */
  readonly convertedFrom?: string;
};

export type PixelSize = { readonly width: number; readonly height: number };
export type PixelRect = PixelSize & { readonly left: number; readonly top: number };
/** Decoded pixels: 8 bits a channel, rows from the top with no padding, opaque (3 channels) or with alpha (4). */
export type Raster = PixelSize & { readonly channels: 3 | 4; readonly data: Uint8Array };

/** pi-durable's `ImageProcessor`: decodes, orients, resizes and re-encodes one image to fit `limits`, or gives
 *  `undefined` when it cannot. A processor pi-durable accepts is accepted here, and the other way round. The members
 *  after `prepare` are this package's: a processor that has `raster` and `encode` is asked for tiles and for the reasons
 *  a fit fails; one that has only `prepare` is asked for one image and nothing else. */
export type ImageProcessor = {
  prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined>;
  /** The MIME types it decodes. Absent: not stated, so every one is tried. */
  readonly decodes?: readonly string[];
  /** The stored size and EXIF orientation of an image whose header this package cannot read, without decoding it. */
  probe?(bytes: Uint8Array): Promise<(PixelSize & { readonly orientation: number }) | undefined>;
  /** The image turned upright by its EXIF orientation and, when `size` is given, scaled to exactly that size (the
   *  upright one). Rejects with the decoder's reason; never opens an image over `maxPixels`. */
  raster?(bytes: Uint8Array, request: { readonly size?: PixelSize; readonly maxPixels: number }): Promise<Raster>;
  /** A PNG, or a JPEG at `jpegQuality` (transparency flattened onto white), of the raster. */
  encode?(raster: Raster, jpegQuality?: number): Promise<Uint8Array>;
};

/** An image block as the model receives it, with the pixels it holds. */
export type ImageBlock = PixelSize & { readonly data: string; readonly mimeType: string };

/** The limits one fit is held to: pi-durable's `ImageLimits`, the JPEG quality to start at and how many tiles one call
 *  may carry. A route's `Limits.image` and `Limits.imagesPerCall`, side by side. */
export type FitLimits = ImageLimits & { readonly jpegQuality?: number; readonly imagesPerCall?: number };

/** An image as the model receives it: its own bytes, one re-encoded block, or tiles in reading order; or why it cannot
 *  be shown, as a miss code, the limit it broke and the reason, in the words of the text that stands in for it. `original`
 *  is the size upright, after the EXIF orientation. */
export type ImageFit =
  | { readonly fit: "as_is"; readonly original: PixelSize; readonly blocks: readonly [ImageBlock] }
  | { readonly fit: "resized"; readonly original: PixelSize; readonly blocks: readonly [ImageBlock]; readonly turned: boolean; readonly convertedFrom?: string }
  | { readonly fit: "tiled"; readonly original: PixelSize; readonly blocks: readonly ImageBlock[]; readonly scaled: PixelSize; readonly tile: PixelSize; readonly starts: readonly number[]; readonly vertical: boolean; readonly turned: boolean }
  | { readonly fit: "refused"; readonly code: MissCode; readonly limit: string; readonly why: string };

/** The formats a model takes as they are; any other is decoded and re-encoded. */
const INLINE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** JPEG qualities tried, each smaller than the last, once the limits' own quality gives a file over the byte limit. */
const JPEG_LADDER: readonly number[] = Object.freeze([70, 55, 40]);
/** What a `needs` miss says reads a format the processor does not. Measured 2026-10-11 on synthetic images with sharp
 *  0.35.5, Photon 0.3.4 and ffmpeg 6.1.1: each reads what is named here and no reader was found for HEIC (a HEVC image
 *  does not decode in sharp's prebuilt binaries, though an AV1 image in the same container does; ffmpeg 6.1.1 does not
 *  open it). */
const READERS: Readonly<Record<string, string>> = Object.freeze({
  "image/avif": "sharp reads it, and so does ffmpeg 6.1 (ffmpeg -i in.avif out.png)",
  "image/bmp": "Photon reads it, and so does ffmpeg 6.1 (ffmpeg -i in.bmp out.png)",
  "image/tiff": "sharp reads it, and Photon reads one not compressed with JPEG or WebP",
  "image/heic": "no decoder here reads it: not sharp's prebuilt binaries, Photon or ffmpeg 6.1",
});

const grouped = (n: number): string => n.toLocaleString("en-US");
const base64Chars = (rawBytes: number): number => Math.ceil(rawBytes / 3) * 4;
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const firstLine = (error: unknown): string => String((error as Error)?.message || error).split("\n")[0]!.slice(0, 200);
const upright = (size: PixelSize & { readonly orientation: number }): PixelSize => (size.orientation >= 5 ? { width: size.height, height: size.width } : { width: size.width, height: size.height });
const withinEdges = (size: PixelSize, limits: FitLimits): boolean => size.width <= limits.maxWidth && size.height <= limits.maxHeight;
const edgeText = (limits: FitLimits): string => `${limits.maxWidth === limits.maxHeight ? grouped(limits.maxWidth) : `${grouped(limits.maxWidth)}x${grouped(limits.maxHeight)}`} px`;

/** The limit an image breaks, with what was measured. */
function brokenLimit(size: PixelSize | null, chars: number, mime: string, limits: FitLimits): string {
  const parts: string[] = [];
  if (size && !withinEdges(size, limits)) parts.push(`it is ${size.width}x${size.height}, over ${edgeText(limits)} a side`);
  if (chars > limits.maxBytes) parts.push(`it is ${grouped(chars)} base64 characters, over ${grouped(limits.maxBytes)}`);
  if (!INLINE_TYPES.has(mime)) parts.push(`${mime} is not a format a model takes as it is`);
  return parts.join(" and ") || (size ? "it must be decoded to be shown" : "its pixel size cannot be read from its header");
}

/** Where an image's blocks are cut: the raster they come from (the image upright and scaled so a fit, or the most tiles a
 *  call carries, covers it) and each tile on it, top to bottom or left to right; no tiles means one block holds the whole
 *  raster. An image is tiled when its long side is over `TILE_ASPECT` times its short side and fitting it whole would
 *  keep less than `TILE_KEEP_BELOW` of it. A tile has the full short side and at most `TILE_MAX_EDGE` along the long one,
 *  overlaps the one before by `TILE_OVERLAP`, and the last ends at the edge, so every tile has the full length. Pure: no
 *  decoding; `tiles: false` never tiles. */
export function imageLayout(original: PixelSize, limits: FitLimits, tiles = true): { readonly scaled: PixelSize; readonly tiles: readonly PixelRect[] } {
  const { width, height } = original;
  const vertical = height >= width;
  const perCall = limits.imagesPerCall ?? IMAGES_PER_CALL;
  const tileLong = Math.min(TILE_MAX_EDGE, vertical ? limits.maxHeight : limits.maxWidth);
  const step = tileLong - TILE_OVERLAP;
  const keeps = Math.min(1, limits.maxWidth / width, limits.maxHeight / height);
  const tiling = tiles && Math.max(width, height) > TILE_ASPECT * Math.min(width, height) && keeps < TILE_KEEP_BELOW && step > TILE_OVERLAP && perCall > 1;
  const cover = tileLong + (perCall - 1) * step;
  const cap = tiling ? (vertical ? { width: limits.maxWidth, height: cover } : { width: cover, height: limits.maxHeight }) : { width: limits.maxWidth, height: limits.maxHeight };
  const scale = Math.min(1, cap.width / width, cap.height / height);
  // Each side is rounded, then held to its cap, so the side that sets the scale lands on its cap exactly.
  const side = (n: number, limit: number) => Math.min(limit, Math.max(1, Math.round(n * scale)));
  const scaled = { width: side(width, cap.width), height: side(height, cap.height) };
  const span = vertical ? scaled.height : scaled.width;
  const length = Math.min(tileLong, span);
  const count = tiling ? Math.ceil((span - length) / (length - TILE_OVERLAP)) + 1 : 1;
  if (count < 2) return { scaled, tiles: [] };
  return {
    scaled,
    tiles: Array.from({ length: count }, (_, index) => {
      const at = Math.min(index * (length - TILE_OVERLAP), span - length);
      return vertical ? { left: 0, top: at, width: scaled.width, height: length } : { left: at, top: 0, width: length, height: scaled.height };
    }),
  };
}

function crop(raster: Raster, rect: PixelRect): Raster {
  const row = rect.width * raster.channels;
  const data = new Uint8Array(row * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.top + y) * raster.width + rect.left) * raster.channels;
    data.set(raster.data.subarray(from, from + row), y * row);
  }
  return { width: rect.width, height: rect.height, channels: raster.channels, data };
}

/** The smaller of the PNG and the JPEG of a raster at the limits' quality; when that is over the byte limit, the JPEG at
 *  each lower quality in turn. Null when no encoding fits. */
async function encodeWithin(encode: NonNullable<ImageProcessor["encode"]>, raster: Raster, limits: FitLimits): Promise<ImageBlock | null> {
  const quality = limits.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const block = (data: Uint8Array, mimeType: string): ImageBlock | null => (base64Chars(data.length) <= limits.maxBytes ? { data: base64(data), mimeType, width: raster.width, height: raster.height } : null);
  const [png, jpeg] = await Promise.all([encode(raster), encode(raster, quality)]);
  const first = png.length <= jpeg.length ? block(png, "image/png") : block(jpeg, "image/jpeg");
  if (first) return first;
  for (const lower of JPEG_LADDER.filter((q) => q < quality)) {
    const next = block(await encode(raster, lower), "image/jpeg");
    if (next) return next;
  }
  return null;
}

/** An image fitted to the limits of one block. Within them by its header, its own bytes come back and nothing is
 *  decoded. Over a limit, or a format a model does not take, it is decoded, turned upright by its EXIF orientation and
 *  either re-encoded at the size that fits inside the edge limits or, when it is tall or wide and a fit would shrink it
 *  past reading, cut into overlapping tiles (`imageLayout`). Its bytes never go out unfitted: a processor that is missing
 *  or fails, a header over the decode guard, a fit under the floor, an image no encoding of which fits, and a format the
 *  processor does not decode are all `refused`, each with its miss code. A header that states no size is asked of the
 *  processor's `probe`; with none, the image is refused, never passed on its bytes alone. `tiles: false` fits the image
 *  whole whatever its shape, as pi-durable's `prepare` does. */
export async function fitImage(processor: ImageProcessor, bytes: Uint8Array, mimeType: string, limits: FitLimits, options: { readonly tiles?: boolean } = {}): Promise<ImageFit> {
  const header = imageHeader(bytes);
  const mime = header?.mimeType ?? mimeType;
  const chars = base64Chars(bytes.length);
  const refuse = (code: MissCode, size: PixelSize | null, why: string): ImageFit => ({ fit: "refused", code, limit: brokenLimit(size, chars, mime, limits), why });
  const stored = header ?? (processor.probe ? await processor.probe(bytes).catch(() => undefined) : undefined);
  const original = stored && upright(stored);
  if (original && exceedsDecodeGuard(original)) return refuse("over_budget", original, `its ${grouped(original.width * original.height)} pixels are over the ${grouped(DECODE_GUARD_PIXELS)} this package decodes`);
  if (stored && original && stored.orientation === 1 && INLINE_TYPES.has(mime) && withinEdges(original, limits) && chars <= limits.maxBytes) {
    return { fit: "as_is", original, blocks: [{ data: base64(bytes), mimeType: mime, ...original }] };
  }
  const { raster, encode } = processor;
  if (!raster || !encode) return prepared(processor, bytes, mime, limits, original, refuse);
  if (processor.decodes && !processor.decodes.includes(mime)) return refuse("needs", original ?? null, `this image processor does not decode ${mime}${READERS[mime] ? `; ${READERS[mime]}` : ""}`);
  if (!stored || !original) return refuse("unreadable", null, "its size is not in its header and this processor cannot read it without decoding");
  const layout = imageLayout(original, limits, options.tiles);
  const shrunk = layout.scaled.width < original.width || layout.scaled.height < original.height;
  const shown = layout.tiles[0] ?? layout.scaled;
  if (shrunk && Math.max(shown.width, shown.height) < FLOOR_EDGE) {
    return refuse("over_budget", original, `fitting it inside ${edgeText(limits)} leaves ${layout.tiles.length ? "tiles of " : ""}${shown.width}x${shown.height}, under the ${grouped(FLOOR_EDGE)} px below which it cannot be read`);
  }
  let pixels: Raster;
  try {
    pixels = await raster(bytes, { size: layout.scaled, maxPixels: DECODE_GUARD_PIXELS });
  } catch (error) {
    // A processor that cannot run here says so with `code: "needs"`; any other failure is the image's.
    return (error as { code?: unknown } | null)?.code === "needs" ? refuse("needs", original, firstLine(error)) : refuse("unreadable", original, `the image could not be decoded (${firstLine(error)})`);
  }
  if (pixels.width !== layout.scaled.width || pixels.height !== layout.scaled.height) return refuse("unreadable", original, "it decoded to a size its header does not state");
  const turned = stored.orientation !== 1;
  const convertedFrom = INLINE_TYPES.has(mime) ? undefined : mime;
  try {
    const rects = layout.tiles.length ? layout.tiles : [{ left: 0, top: 0, ...layout.scaled }];
    const blocks: ImageBlock[] = [];
    for (const [index, rect] of rects.entries()) {
      const block = await encodeWithin(encode, layout.tiles.length ? crop(pixels, rect) : pixels, limits);
      if (!block) return refuse("over_budget", original, `no encoding of ${layout.tiles.length ? `tile ${index + 1} of ${rects.length}` : "it"} fits in ${grouped(limits.maxBytes)} base64 characters`);
      blocks.push(block);
    }
    if (!layout.tiles.length) return { fit: "resized", original, blocks: [blocks[0]!], turned, ...(convertedFrom ? { convertedFrom } : {}) };
    const vertical = original.height >= original.width;
    return { fit: "tiled", original, blocks, scaled: layout.scaled, tile: { width: rects[0]!.width, height: rects[0]!.height }, starts: rects.map((rect) => (vertical ? rect.top : rect.left)), vertical, turned };
  } catch (error) {
    return refuse("unreadable", original, `the image could not be encoded (${firstLine(error)})`);
  }
}

/** A processor with only `prepare` (pi-durable's own): one image, as it decides, and its size read back from the bytes. */
async function prepared(processor: ImageProcessor, bytes: Uint8Array, mime: string, limits: FitLimits, original: PixelSize | undefined, refuse: (code: MissCode, size: PixelSize | null, why: string) => ImageFit): Promise<ImageFit> {
  const out = await processor.prepare(bytes, mime, limits).catch(() => undefined);
  if (!out) return refuse("unreadable", original ?? null, "the image processor could not decode it or fit it to the limits");
  const shown = out.resized?.to ?? imageHeader(Buffer.from(out.data.slice(0, Math.ceil(SNIFF_BYTES / 3) * 4), "base64"));
  if (!shown) return refuse("unreadable", original ?? null, "the image processor returned an image whose size cannot be read");
  const block = { data: out.data, mimeType: out.mimeType, width: shown.width, height: shown.height };
  if (!out.resized) return { fit: "as_is", original: original ?? block, blocks: [block] };
  return { fit: "resized", original: out.resized.from, blocks: [block], turned: false, ...(INLINE_TYPES.has(mime) ? {} : { convertedFrom: mime }) };
}

/** How many times larger the original is than the picture shown, to the third decimal. */
const factorOf = (original: PixelSize, shown: PixelSize): string => String(Number((Math.max(original.width, original.height) / Math.max(shown.width, shown.height)).toFixed(3)));

/** The one sentence that says what the model was shown in place of the file, so coordinates read off it map back to the
 *  file; empty for an image shown as it is. */
export function fitSentence(fit: ImageFit, limits: Pick<FitLimits, "maxBytes">): string {
  if (fit.fit === "resized") {
    const [{ width, height, mimeType }] = fit.blocks;
    const scaled = width !== fit.original.width || height !== fit.original.height;
    const did = [fit.turned ? "turned upright by its EXIF orientation" : "", fit.convertedFrom ? `converted from ${fit.convertedFrom} to ${mimeType}` : "", scaled ? `resized from ${fit.original.width}x${fit.original.height} to ${width}x${height}` : ""].filter(Boolean);
    if (scaled) return `Shown ${did.join(" and ")}: multiply coordinates read off it by ${factorOf(fit.original, { width, height })} for the original.`;
    return `Shown ${did.length ? did.join(" and ") : `re-encoded to fit ${grouped(limits.maxBytes)} base64 characters`}; its ${width}x${height} pixels are unchanged.`;
  }
  if (fit.fit === "tiled") {
    const { original, scaled, tile } = fit;
    const rescaled = scaled.width !== original.width || scaled.height !== original.height;
    const whole = rescaled ? ` of the whole image scaled from ${original.width}x${original.height} to ${scaled.width}x${scaled.height}` : "";
    const back = rescaled ? `, then multiply by ${factorOf(original, scaled)}` : "";
    return `The ${fit.vertical ? "tall" : "wide"} image ${original.width}x${original.height} is shown as ${fit.blocks.length} tiles of ${tile.width}x${tile.height}${whole}, ${fit.vertical ? "top to bottom" : "left to right"}${fit.turned ? ", turned upright by its EXIF orientation" : ""}, each overlapping the one before it by at least ${TILE_OVERLAP} px: to find a point in the original, add the tile's start to the ${fit.vertical ? "y" : "x"} coordinate read off the tile${back} (tile starts: ${fit.starts.join(", ")}).`;
  }
  return "";
}

/** An `ImageProcessor` built from its operations: `prepare` is `fitImage` with `tiles: false`, pi-durable's contract of
 *  one image or none. */
export function imageProcessor<T extends Omit<ImageProcessor, "prepare"> & Required<Pick<ImageProcessor, "raster" | "encode">>>(operations: T): T & ImageProcessor {
  const processor: T & ImageProcessor = {
    ...operations,
    async prepare(bytes, mimeType, limits: FitLimits) {
      const fit = await fitImage(processor, bytes, mimeType, limits, { tiles: false });
      if (fit.fit === "refused" || fit.fit === "tiled") return undefined;
      const [block] = fit.blocks;
      const scaled = block.width !== fit.original.width || block.height !== fit.original.height;
      return { data: block.data, mimeType: block.mimeType, ...(scaled ? { resized: { from: fit.original, to: { width: block.width, height: block.height } } } : {}), ...(block.mimeType !== mimeType ? { convertedFrom: mimeType } : {}) };
    },
  };
  return processor;
}
