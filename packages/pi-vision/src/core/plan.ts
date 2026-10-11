// The planner: one function from a source's facts, the selector the caller asked for, the route's limits and a mode
// (`show` for the lead, `ask` for the eyes) to the parts to send, each with the fragment of the source it covers, and
// what was reduced to fit, with the numbers. No plan exceeds the limits it was given; what cannot fit even at the floor
// is a refusal, never an illegible success.

import type { MissCode } from "./contract.js";
import type { Fragment, PageSpan, Region } from "./fragments.js";
import type { Kind } from "./kinds.js";
import type { Limits } from "./limits.js";
import { notBuilt } from "./not-built.js";

/** What is known of a source for free: no render, no decode beyond a header. */
export type SourceFacts = {
  readonly kind: Kind;
  readonly bytes: number;
  readonly sha256: string;
  readonly mimeType?: string;
  /** Pixels of an image. */
  readonly width?: number;
  readonly height?: number;
  /** A document's pages, their sizes in points, and which carry a text layer. */
  readonly pages?: number;
  readonly pageSizes?: readonly { readonly width: number; readonly height: number }[];
  readonly textPages?: readonly number[];
  readonly durationS?: number;
};

/** What the caller asked for, from `read`'s or `look`'s arguments. */
export type Selector = { readonly pages?: PageSpan; readonly fromS?: number; readonly toS?: number; readonly region?: Region };

export type PlanMode = "show" | "ask";

export type Reduction = "as_is" | "downscaled" | "tiled" | "sampled" | "windowed" | "text_only" | "refused";

/** What a plan did to fit, with the numbers a receipt and the model's first line carry. */
export type Fit = {
  readonly reduction: Reduction;
  readonly original?: { readonly width?: number; readonly height?: number; readonly pages?: number; readonly durationS?: number; readonly bytes?: number };
  readonly shown?: { readonly width?: number; readonly height?: number; readonly pages?: number; readonly frames?: number; readonly tiles?: number; readonly dpi?: number; readonly bytes?: number };
  /** Set when `reduction` is `refused`. */
  readonly refusal?: { readonly code: MissCode; readonly detail: string };
};

/** One part to derive and send: which piece of the source it is and the target it is derived to. */
export type PlannedPart = {
  readonly fragment: Fragment;
  readonly derive: "as_is" | "image" | "tile" | "page" | "frame" | "clip" | "text";
  readonly width?: number;
  readonly height?: number;
  readonly dpi?: number;
  readonly atS?: number;
};

export type Plan = { readonly parts: readonly PlannedPart[]; readonly fit: Fit };

/** A derived part, ready for a model. `data` is base64. `fragment` is the citation form of where it came from. */
export type Part =
  | { readonly type: "text"; readonly text: string; readonly fragment?: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string; readonly width: number; readonly height: number; readonly fragment: string }
  | { readonly type: "video"; readonly data: string; readonly mimeType: string; readonly fragment: string };

export function plan(facts: SourceFacts, selector: Selector, limits: Limits, mode: PlanMode): Plan {
  return notBuilt("plan");
}
