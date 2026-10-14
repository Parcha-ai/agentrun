// Tool images are stored verbatim and resent on every later request, and routes reject oversize ones: a capture is held
// to a long edge and a base64 size.

export const SCREENSHOT_MAX_EDGE_PX = 2_000;
export const SCREENSHOT_MAX_BASE64_BYTES = 900_000;

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

/** `scale: "css"` takes one image pixel per CSS pixel, so a high-density display does not double the size. */
export type ScreenshotOptions = { fullPage?: boolean; type?: "png" | "jpeg"; quality?: number; scale?: "css" | "device" };
export type Capture = (options: ScreenshotOptions) => Promise<{ data: string; mimeType: string }>;
export type BudgetedScreenshot = {
  data: string;
  mimeType: string;
  size: ImageSize;
  options: ScreenshotOptions;
  adjusted: { why: "long_edge" | "base64_bytes"; first: ImageSize | null } | null;
};

export class ScreenshotBudgetError extends Error {
  override name = "ScreenshotBudgetError";
}

/** Over budget, retakes as a viewport JPEG at CSS scale, quality 40, 25, 10; throws ScreenshotBudgetError. */
export async function captureWithinBudget(capture: Capture, requested: ScreenshotOptions, budget = { maxEdgePx: SCREENSHOT_MAX_EDGE_PX, maxBase64Bytes: SCREENSHOT_MAX_BASE64_BYTES }): Promise<BudgetedScreenshot> {
  const ceiling = requested.type === "png" ? 40 : (requested.quality ?? 40);
  const ladder: ScreenshotOptions[] = [
    { fullPage: requested.fullPage ?? false, type: requested.type ?? "jpeg", ...(requested.type === "png" ? {} : { quality: requested.quality ?? 40 }), ...(requested.scale ? { scale: requested.scale } : {}) },
    ...[40, 25, 10].map((quality) => ({ fullPage: false, type: "jpeg" as const, quality: Math.min(ceiling, quality), scale: "css" as const })),
  ];
  const key = (o: ScreenshotOptions) => `${o.fullPage}:${o.type}:${o.quality}:${o.scale}`;
  const attempts = ladder.filter((o, i) => ladder.findIndex((other) => key(other) === key(o)) === i);
  let adjusted: BudgetedScreenshot["adjusted"] = null;
  for (const options of attempts) {
    const image = await capture(options);
    const size = imageSize(Buffer.from(image.data, "base64"));
    const why = size === null || Math.max(size.width, size.height) > budget.maxEdgePx ? "long_edge" as const
      : Buffer.byteLength(image.data, "utf8") > budget.maxBase64Bytes ? "base64_bytes" as const : null;
    if (why === null && size) return { data: image.data, mimeType: image.mimeType, size, options, adjusted };
    adjusted ??= { why: why ?? "long_edge", first: size };
  }
  throw new ScreenshotBudgetError(`The screenshot stays over ${budget.maxEdgePx} px on its long edge or ${budget.maxBase64Bytes} base64 bytes after viewport JPEG retakes at CSS scale and quality 40, 25 and 10.`);
}
