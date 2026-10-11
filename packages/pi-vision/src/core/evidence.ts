// Every look is filed through the host's sink as one record: the source, its SHA-256, the fragment looked at, the
// question, the answer, the model and its price, what was shown and the derived files. The sink has pi-browser's shape,
// so a host that files the browser's receipts files these the same way. A look's events carry the same facts to the
// host's own rows and spend.

import type { Kind } from "./kinds.js";
import type { Fit } from "./plan.js";
import type { Usage } from "./host.js";

export type LookRecord = {
  readonly tool: "look";
  /** The call as the receipt header's `args:` line shows it. `native` is true when the lead saw the media itself. */
  readonly args: {
    readonly path: string; readonly ask?: string; readonly page?: number; readonly pages?: string;
    readonly from_s?: number; readonly to_s?: number; readonly region?: string;
    readonly model: string; readonly native: boolean; readonly via?: string;
  };
  readonly status: "ok" | "failed";
  readonly facts: {
    readonly sha256: string; readonly kind: Kind; readonly fragment: string; readonly shown: string; readonly fit: Fit;
    /** The look's memo key: SHA-256 of the source hash, selector, question, eyes model, contract version and plan. */
    readonly key: string;
    readonly tokens_in?: number; readonly tokens_out?: number;
    /** Null when the price is not known, never 0; 0 when another service billed the look (see `via`). */
    readonly cost_usd?: number | null;
    readonly provider?: string;
    readonly derived?: readonly string[];
  };
  /** The answer, "shown to the model natively", or the miss. */
  readonly body: string;
};

export type EvidenceSink = {
  /** File `record` under the conversation's `label`. `path` is what the model is told to cite. Null when the host files nothing. */
  file(label: string, record: LookRecord): Promise<{ readonly path: string } | null>;
};

/** One look that happened, for the host's rows and spend. */
export type LookEvent = {
  readonly conversationId: string;
  readonly tool: "read" | "look";
  readonly source: string;
  readonly ask?: string;
  readonly fragment: string;
  readonly model: string;
  readonly usage: Usage | null;
  /** Null when the price is not known; 0 when `billedBy` names another service. */
  readonly costUsd: number | null;
  readonly billedBy?: string;
  /** Where the record was filed, or null when the sink filed nothing. */
  readonly receipt: string | null;
  readonly record: LookRecord;
};
