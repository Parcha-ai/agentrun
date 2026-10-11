// The default image processor: Photon (WASM, the processor pi uses), in a worker thread, when the host has installed
// `@silvia-odwyer/photon-node`.
import type { ImageProcessor } from "../core/image.js";
import type { Provider } from "../core/provider.js";
import { notBuilt } from "../core/not-built.js";

export function photonImages(): ImageProcessor & Provider {
  return notBuilt("photonImages");
}
