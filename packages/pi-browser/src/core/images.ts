// Tool images are stored verbatim and resent on every later request, and routes reject oversize ones: a capture is held
// to a long edge and a base64 size, by shrinking its pixels and then its JPEG quality, never by failing while a capture
// can be made.

export const SCREENSHOT_MAX_EDGE_PX = 2_000;
export const SCREENSHOT_MAX_BASE64_BYTES = 900_000;
/** A full page shrunk to the long edge that would be narrower than this (its short edge) is unreadable: the viewport is
 *  taken in its place. */
export const SCREENSHOT_MIN_SHORT_EDGE_PX = 600;

export type ImageSize = { type: "png" | "jpeg"; width: number; height: number };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** JPEG start-of-frame markers; C4 (DHT), C8 (JPG) and CC (DAC) are not frames. */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function imageSize(bytes: Uint8Array): ImageSize | null {
  const u16 = (at: number) => (bytes[at] << 8) | bytes[at + 1];
  const u32 = (at: number) => ((bytes[at] << 24) >>> 0) + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
  if (bytes.length >= 24 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte) && String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR") {
    return { type: "png", width: u32(16), height: u32(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (JPEG_SOF.has(marker)) return at + 8 < bytes.length ? { type: "jpeg", height: u16(at + 5), width: u16(at + 7) } : null;
    at += 2 + u16(at + 2);
  }
  return null;
}

/** A region of the page in CSS pixels, from the viewport's top-left corner. */
export type Clip = { x: number; y: number; width: number; height: number };
/** `clip` captures that region alone, `fullPage` the whole document. `scale` is the image's size as a share of the
 *  browser's own capture of the same region (its device pixels): 0.5 is half as wide and half as high; absent, 1. */
export type ScreenshotOptions = { fullPage?: boolean; type?: "png" | "jpeg"; quality?: number; scale?: number; clip?: Clip };
export type Capture = (options: ScreenshotOptions) => Promise<{ data: string; mimeType: string }>;
export type BudgetedScreenshot = {
  data: string;
  mimeType: string;
  size: ImageSize;
  options: ScreenshotOptions;
  adjusted: { why: "long_edge" | "base64_bytes" | "unreadable"; first: ImageSize | null } | null;
};

/** What CDP's Page.getLayoutMetrics says of a page, in CSS pixels: where the viewport is scrolled to and its size, and
 *  the whole document's size. */
export type Layout = {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  cssContentSize: { width: number; height: number };
};

/** CDP's Page.captureScreenshot parameters for `options` on a page laid out as `layout`. Chrome scales a clip alone, its
 *  image `clip.scale` times its device pixels: a clip (from the viewport) is moved to the document, a full page is the
 *  document's clip captured beyond the viewport, and a scaled viewport is the viewport's own clip. */
export function captureParams(options: ScreenshotOptions, layout: Layout): Record<string, unknown> {
  const format = options.type ?? "png";
  const scale = options.scale ?? 1;
  const view = layout.cssVisualViewport;
  const region = options.clip ? { ...options.clip, x: options.clip.x + view.pageX, y: options.clip.y + view.pageY }
    : options.fullPage ? { x: 0, y: 0, width: Math.ceil(layout.cssContentSize.width), height: Math.ceil(layout.cssContentSize.height) }
    : scale !== 1 ? { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight }
    : null;
  return {
    format,
    // CDP takes a quality for jpeg only, and only as an integer.
    ...(format === "jpeg" && options.quality !== undefined ? { quality: Math.round(options.quality) } : {}),
    ...(options.fullPage && !options.clip ? { captureBeyondViewport: true } : {}),
    ...(region ? { clip: { ...region, scale } } : {}),
  };
}

export class ScreenshotBudgetError extends Error {
  override name = "ScreenshotBudgetError";
}

/** The most captures one screenshot takes before it gives up. */
const MAX_CAPTURES = 12;
const QUALITIES = [40, 25, 10];

/**
 * A capture as requested, held to the budget. Over the long edge, the same region is retaken scaled to fit it (a full
 * page that would come out narrower than SCREENSHOT_MIN_SHORT_EDGE_PX is the viewport instead, itself scaled to fit);
 * over the byte budget, as a JPEG at quality 40, 25 and 10 (at most the requested quality), then smaller still. A capture
 * whose size cannot be read is retaken once as a viewport JPEG. Throws ScreenshotBudgetError only when no capture it can
 * measure is made, or none fits within MAX_CAPTURES.
 */
export async function captureWithinBudget(capture: Capture, requested: ScreenshotOptions, budget = { maxEdgePx: SCREENSHOT_MAX_EDGE_PX, maxBase64Bytes: SCREENSHOT_MAX_BASE64_BYTES }): Promise<BudgetedScreenshot> {
  const ceiling = requested.type === "png" ? 40 : (requested.quality ?? 40);
  // The clip and the scale asked are kept on every capture; a retake only scales further down.
  const clip = { ...(requested.clip ? { clip: requested.clip } : {}), ...(requested.scale === undefined ? {} : { scale: requested.scale }) };
  let taken = 0;
  const take = async (options: ScreenshotOptions) => {
    taken += 1;
    const image = await capture(options);
    const size = imageSize(Buffer.from(image.data, "base64"));
    const why = size === null ? "unreadable" as const
      : Math.max(size.width, size.height) > budget.maxEdgePx ? "long_edge" as const
      : Buffer.byteLength(image.data, "utf8") > budget.maxBase64Bytes ? "base64_bytes" as const : null;
    return { image, size, why, options };
  };
  const fit = (size: ImageSize) => budget.maxEdgePx / Math.max(size.width, size.height);
  const viewport = (options: ScreenshotOptions): ScreenshotOptions => ({ fullPage: false, type: "jpeg", quality: Math.min(ceiling, options.type === "jpeg" ? options.quality ?? 40 : 40), ...clip });

  let shot = await take({ fullPage: requested.fullPage ?? false, type: requested.type ?? "jpeg", ...(requested.type === "png" ? {} : { quality: ceiling }), ...clip });
  const adjusted: BudgetedScreenshot["adjusted"] = shot.why === null ? null : { why: shot.why, first: shot.size };
  if (shot.why === "unreadable") shot = await take(viewport(shot.options));
  // A full page that fits only narrower than a page can be read: the viewport, which the steps below fit.
  if (shot.why === "long_edge" && shot.options.fullPage && shot.size && Math.min(shot.size.width, shot.size.height) * fit(shot.size) < SCREENSHOT_MIN_SHORT_EDGE_PX) {
    shot = await take(viewport(shot.options));
  }
  while (shot.why !== null) {
    if (shot.why === "unreadable" || !shot.size) throw new ScreenshotBudgetError("The browser's capture is not a PNG or JPEG whose size can be read, and a viewport JPEG retake is not either.");
    if (taken >= MAX_CAPTURES) throw new ScreenshotBudgetError(`No capture fits ${budget.maxEdgePx} px on its long edge and ${budget.maxBase64Bytes} base64 bytes after ${taken} captures; the last was ${shot.size.width}x${shot.size.height}.`);
    const { options, size } = shot;
    const scale = options.scale ?? 1;
    let next: ScreenshotOptions;
    if (shot.why === "long_edge") {
      next = { ...options, scale: scale * fit(size) };
    } else {
      const quality = options.type === "png" ? undefined : options.quality ?? 40;
      const lower = QUALITIES.map((q) => Math.min(ceiling, q)).find((q) => quality === undefined || q < quality);
      // Its bytes go roughly with its area: a scale that takes them to nine tenths of the budget.
      const smaller = scale * Math.min(0.9, 0.9 * Math.sqrt(budget.maxBase64Bytes / Buffer.byteLength(shot.image.data, "utf8")));
      next = lower !== undefined ? { ...options, type: "jpeg", quality: lower } : { ...options, scale: smaller };
    }
    shot = await take(next);
    // A driver that does not take the scale asked (Stagehand's, past one image pixel per CSS pixel): a full page is the
    // viewport instead, and anything else is as small as this browser makes it.
    if ((next.scale ?? 1) < scale && shot.size && Math.max(shot.size.width, shot.size.height) >= Math.max(size.width, size.height)) {
      if (!options.fullPage) throw new ScreenshotBudgetError(`The browser does not take this capture smaller than ${shot.size.width}x${shot.size.height}, which is over ${budget.maxEdgePx} px on its long edge or ${budget.maxBase64Bytes} base64 bytes.`);
      shot = await take(viewport(options));
    }
  }
  return { data: shot.image.data, mimeType: shot.image.mimeType, size: shot.size!, options: shot.options, adjusted };
}
