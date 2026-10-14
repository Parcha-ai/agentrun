// Every look is filed through the host's sink as one record: the source, its SHA-256, the fragment looked at, the
// question, the answer, the model and its price, what was shown and the derived files. The sink has pi-browser's shape,
// so a host that files the browser's receipts files these the same way. A look's events carry the same facts to the
// host's own rows and spend. Filing never fails the call it serves: a sink or a hook that throws is a look with no
// receipt, never a lost result.

import { createHash } from "node:crypto";
import { CONTRACT_VERSION } from "./contract.js";
import type { Kind } from "./kinds.js";
import type { MissEvent } from "./misses.js";
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
    /** The source's pixels (`<w>x<h>`) when its header says. */
    readonly original?: string;
    /** The largest block shown or looked at (`<w>x<h>`), how many blocks, and the base64 characters of the largest. */
    readonly shown?: string; readonly shown_blocks?: number; readonly shown_bytes?: number;
    readonly sha256: string; readonly kind: Kind; readonly fragment: string; readonly fit?: Fit;
    /** The look's memo key: SHA-256 of the source hash, selector, question, eyes model, contract version and plan. */
    readonly key: string;
    readonly tokens_in?: number; readonly tokens_out?: number;
    /** Null when the price is not known, never 0; 0 when another service billed the look (see `via`). */
    readonly cost_usd?: number | null;
    readonly provider?: string;
    readonly derived?: readonly string[];
    /** Set when the result's unit ids did not match its image blocks and every block was looked at on its own. */
    readonly units_dropped?: string;
  };
  /** The answer, "shown to the model natively", or the miss. */
  readonly body: string;
};

export type EvidenceSink = {
  /** File `record` under the conversation's `label`. `path` is what the model is told to cite. Null when the host files nothing. */
  file(label: string, record: LookRecord): Promise<{ readonly path: string } | null>;
};

/** One look that happened, for the host's rows and spend: a look the eyes made, and one the lead made natively (no
 *  usage, `record.args.native` true). */
export type LookEvent = {
  readonly conversationId: string;
  /** `read` or `look`, or the tool whose result held the image (`CallContext.tool`). */
  readonly tool: string;
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

/** Where a conversation's looks go: the host's sink under its label, and its hooks. */
export type Filing = {
  readonly conversationId: string;
  readonly label: string;
  readonly evidence: EvidenceSink;
  readonly onLook?: (look: LookEvent) => void | Promise<void>;
  readonly onMiss?: (miss: MissEvent) => void | Promise<void>;
};

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** The memo key of a look: the same source, selector, question, eyes and plan under this contract give the same key. */
export function lookKey(input: { readonly sha256: string; readonly fragment: string; readonly ask?: string; readonly model: string; readonly plan?: unknown }): string {
  return sha256(JSON.stringify([CONTRACT_VERSION, input.sha256, input.fragment, input.ask ?? null, input.model, input.plan ?? null]));
}

/** The SHA-256 of the bytes a set of base64 blocks carries, in order: what a look at blocks with no source file saw. */
export const blocksSha256 = (blocks: readonly { readonly data: string }[]): string => {
  const hash = createHash("sha256");
  for (const block of blocks) hash.update(Buffer.from(block.data, "base64"));
  return hash.digest("hex");
};

/** The record's facts as receipt header lines, in a fixed order, each a string or a number; absent facts are left out
 *  and a price nobody knows is written `unknown`. `fit` is its reduction; its numbers are `original` and `shown`. */
export function receiptFacts(record: LookRecord): Record<string, string | number> {
  const f = record.facts;
  const lines: [string, string | number | undefined][] = [
    ["original", f.original], ["shown", f.shown], ["shown_blocks", f.shown_blocks], ["shown_bytes", f.shown_bytes],
    ["sha256", f.sha256], ["kind", f.kind], ["fragment", f.fragment], ["fit", f.fit?.reduction], ["key", f.key],
    ["tokens_in", f.tokens_in], ["tokens_out", f.tokens_out], ["cost_usd", f.cost_usd === null ? "unknown" : f.cost_usd],
    ["provider", f.provider], ["derived", f.derived?.join(", ")], ["units_dropped", f.units_dropped],
  ];
  return Object.fromEntries(lines.filter((line): line is [string, string | number] => line[1] !== undefined && line[1] !== ""));
}

/** Calls a host hook; a throw or a rejection is the host's and never fails the call. */
export async function quietly<T>(hook: ((value: T) => void | Promise<void>) | undefined, value: T): Promise<void> {
  try { await hook?.(value); } catch { /* the host's own failure */ }
}

/** File one look and tell the host: the receipt path, or null when the sink filed nothing or failed. */
export async function fileLook(filing: Filing, tool: string, record: LookRecord, answer?: { readonly usage: Usage | null; readonly costUsd: number | null; readonly billedBy?: string }): Promise<string | null> {
  let receipt: string | null = null;
  try { receipt = (await filing.evidence.file(filing.label, record))?.path ?? null; } catch { /* a receipt never fails the call it files */ }
  if (record.status === "ok") {
    await quietly(filing.onLook, {
      conversationId: filing.conversationId, tool, source: record.args.path, ...(record.args.ask ? { ask: record.args.ask } : {}),
      fragment: record.facts.fragment, model: record.args.model, usage: answer?.usage ?? null, costUsd: answer?.costUsd ?? null,
      ...(answer?.billedBy ? { billedBy: answer.billedBy } : {}), receipt, record,
    });
  }
  return receipt;
}
