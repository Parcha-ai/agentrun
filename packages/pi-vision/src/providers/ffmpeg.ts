// Video through ffmpeg and ffprobe in the environment: the probe, frames by seek, a window by stream copy or one
// re-encode. A host may pass its own mediabunny module for the probe and stream-copy windows; the package never
// resolves mediabunny itself, so its MPL-2.0 code comes with the host's install.
import type { Provider } from "../core/provider.js";
import { notBuilt } from "../core/not-built.js";

/** The host's mediabunny module, as its namespace import gives it. */
export type MediabunnyModule = Readonly<Record<string, unknown>>;

export function ffmpegProvider(options: { mediabunny?: MediabunnyModule } = {}): Provider {
  return notBuilt("ffmpegProvider");
}
