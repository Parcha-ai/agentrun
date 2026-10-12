// A provider turns a source into what a plan needs: text, page renders, cells, frames, a clip, a faithful office render.
// It declares what it can do and detects, once per environment, whether it can run there. Zero-install providers are
// always there; a binary's provider (poppler, ffmpeg, LibreOffice) runs it through the environment the agent's shell
// runs in. Every result names the provider and version that made it, and a derivation's cache key includes them.

import type { VisionEnv } from "./env.js";
import { firstLine } from "./misses.js";
import type { ImageProcessor } from "./image.js";
import type { Kind } from "./kinds.js";

export const CAPABILITIES = Object.freeze(["text", "positions", "render", "office", "cells", "frames", "clip", "fit", "ocr"] as const);
export type Capability = (typeof CAPABILITIES)[number];

/** The method that serves each capability. `positions` and `ocr` have none in this release, so no provider may declare
 *  them yet. */
export const CAPABILITY_METHODS: Readonly<Record<Capability, keyof Provider | null>> = Object.freeze({
  text: "text", positions: null, render: "render", office: "office", cells: "cells", frames: "frames", clip: "clip", fit: "prepare", ocr: null,
});

/** Whether a provider runs in an environment: its version when it does, what it needs and why when it does not. */
export type Detection =
  | { readonly available: true; readonly version: string }
  | { readonly available: false; readonly needs: string; readonly reason: string };

/** Who made a result. */
export type MadeBy = { readonly provider: string; readonly version: string };

/** A source in the environment, as a provider reads it. */
export type ProviderSource = { readonly path: string; readonly kind: Kind; readonly bytes: number; readonly sha256: string };

/** The call a provider works in: the environment, the call's cancellation, and a directory there it may write in. */
export type ProviderCall = { readonly env: VisionEnv; readonly signal: AbortSignal | undefined; readonly tempDir: string };

/** An encoded image and its pixels. */
export type RenderedImage = { readonly data: Uint8Array; readonly mimeType: string; readonly width: number; readonly height: number };

/** One cell: its value as stored (an integer too long for a double stays a string), its formula, and whether a formula
 *  had a stored result. */
export type Cell = { readonly ref: string; readonly value: string | number | boolean | null; readonly formula?: string; readonly cached?: boolean };

export type Provider = {
  readonly name: string;
  readonly capabilities: readonly Capability[];
  readonly kinds: readonly Kind[];
  /** Never throws: a failure to detect is `available: false`. Use `detectOnce` to run it once per environment. */
  detect(env: VisionEnv, signal?: AbortSignal): Promise<Detection>;
  /** `text`: the text layer, one entry per page (one entry for a format without pages). */
  text?(source: ProviderSource, request: { readonly pages?: { readonly from: number; readonly to: number } }, call: ProviderCall): Promise<{ readonly madeBy: MadeBy; readonly pages: readonly { readonly page: number; readonly text: string }[] }>;
  /** `render`: one page at a dpi. */
  render?(source: ProviderSource, request: { readonly page: number; readonly dpi: number }, call: ProviderCall): Promise<{ readonly madeBy: MadeBy; readonly image: RenderedImage }>;
  /** `cells`: every sheet, or the one named. */
  cells?(source: ProviderSource, request: { readonly sheet?: string }, call: ProviderCall): Promise<{ readonly madeBy: MadeBy; readonly sheets: readonly { readonly name: string; readonly cells: readonly Cell[] }[] }>;
  /** `frames`: one frame at each time, its long edge at most `maxEdge`. */
  frames?(source: ProviderSource, request: { readonly atS: readonly number[]; readonly maxEdge: number }, call: ProviderCall): Promise<{ readonly madeBy: MadeBy; readonly frames: readonly (RenderedImage & { readonly atS: number })[] }>;
  /** `clip`: the window as a file of at most `maxBytes`, written in the environment. */
  clip?(source: ProviderSource, request: { readonly fromS: number; readonly toS: number; readonly maxBytes: number }, call: ProviderCall): Promise<{ readonly madeBy: MadeBy; readonly path: string; readonly mimeType: string; readonly fromS: number; readonly toS: number }>;
  /** `office`: the document rendered to a PDF in the environment, then read as one. */
  office?(source: ProviderSource, request: Record<string, never>, call: ProviderCall): Promise<{ readonly madeBy: MadeBy; readonly path: string }>;
  /** `fit`: an image processor's own method. */
  prepare?: ImageProcessor["prepare"];
};

const detections = new WeakMap<Provider, Map<string, Promise<Detection>>>();

/** A provider's detection in an environment, run once per provider and environment id and remembered by every caller;
 *  a detect that throws or rejects is `available: false` with its message. The shared detection runs with no caller's
 *  signal, so one caller's cancellation never decides another's answer; a provider bounds its own probe. */
export function detectOnce(provider: Provider, env: VisionEnv): Promise<Detection> {
  let byEnv = detections.get(provider);
  if (!byEnv) detections.set(provider, (byEnv = new Map()));
  let detection = byEnv.get(env.id);
  if (!detection) {
    detection = (async () => provider.detect(env))().catch((error: unknown): Detection =>
      ({ available: false, needs: provider.name, reason: `detect failed: ${firstLine(error)}` }));
    byEnv.set(env.id, detection);
  }
  return detection;
}
