// The pi-durable adapter: `createVisionExtension` installs the `read` wrap (for hosts whose `read` is pi's), the
// guard over every tool's images, `look`, and the eyes on `api.models` where pi has it; and gives a host whose `read`
// is its own the media half of `read`, the fit of any result's images and a PDF's text as functions. It is the only
// module that touches pi-durable, and it builds every result through one function, for pi 1.0 and the next release.
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { VisionEnv } from "./core/env.js";
import type { CallContext, ReadArgs, ToolResult, VisionOptions } from "./core/host.js";
import { notBuilt } from "./core/not-built.js";

export type VisionHandle = {
  /** Install once per Harness; select per conversation. */
  readonly extension: Extension;
  /** `look`, for `wrapTool` and a conversation's tool filter. */
  readonly tools: readonly ToolRegistration[];
  /** The media half of `read`, for a host whose `read` is its own. Null when the path reads as plain text. */
  read(env: VisionEnv, args: ReadArgs, call: CallContext): Promise<ToolResult | null>;
  /** One tool result's image blocks fitted to the call's route, for a host that shapes results itself. */
  fit(result: ToolResult, call: CallContext): Promise<ToolResult>;
  /** The text of a PDF held in memory; null when it has none. */
  pdfText(bytes: Uint8Array, signal?: AbortSignal): Promise<string | null>;
};

export function createVisionExtension(options: VisionOptions): VisionHandle {
  return notBuilt("createVisionExtension");
}
