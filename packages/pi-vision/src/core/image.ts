// Images: the fit of one image to a route's limits (decode, orient, resize, re-encode as the smaller of PNG and JPEG),
// tiles in reading order for a tall or wide one, and the line that says the original and shown sizes. The pixels are
// moved by an `ImageProcessor`, pi-durable's interface: Photon (WASM) by default, sharp when the host passes it.

import type { ImageLimits } from "./limits.js";

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

/** pi-durable's `ImageProcessor`: decodes, orients, resizes and re-encodes one image to fit `limits`, or gives
 *  `undefined` when it cannot. A processor pi-durable accepts is accepted here, and the other way round. */
export type ImageProcessor = {
  prepare(bytes: Uint8Array, mimeType: string, limits: ImageLimits): Promise<PreparedImage | undefined>;
};
