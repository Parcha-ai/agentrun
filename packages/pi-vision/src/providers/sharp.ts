// The fast image processor: the host's own `sharp` module, passed in. The package never resolves sharp itself, so
// its native libraries come with the host's install and stay out of this package's dependency graph.
import type { ImageProcessor } from "../core/image.js";
import type { Provider } from "../core/provider.js";
import { notBuilt } from "../core/not-built.js";

/** The parts of sharp's default export the processor calls. */
export type SharpModule = (input?: Uint8Array, options?: Record<string, unknown>) => unknown;

export function sharpImages(sharp: SharpModule): ImageProcessor & Provider {
  return notBuilt("sharpImages");
}
