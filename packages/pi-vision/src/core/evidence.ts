// Every look is filed through the host's sink as one record: the source, its SHA-256, the fragment looked at, the
// question, the answer, the model and its price, what was shown and the derived files. The sink has pi-browser's shape,
// so a host that files the browser's receipts files these the same way. A look's events carry the same facts to the
// host's own rows and spend. Filing never fails the call it serves: a sink or a hook that throws is a look with no
// receipt, never a lost result.

import { createHash } from "node:crypto";
import { CONTRACT_VERSION } from "./contract.js";
import { sha256Hex } from "./primitives.js";
import type { CallContext, Json, Usage } from "./call.js";
import type { EvidenceSink, Filing, LookEvent, LookRecord } from "./records.js";

export type { EvidenceSink, Filing, LookEvent, LookRecord } from "./records.js";





/** The memo key of a look: the same source, selector, question, eyes and plan under this contract give the same key. */
export function lookKey(input: { readonly sha256: string; readonly fragment: string; readonly ask?: string; readonly model: string; readonly plan?: unknown }): string {
  return sha256Hex(JSON.stringify([CONTRACT_VERSION, input.sha256, input.fragment, input.ask ?? null, input.model, input.plan ?? null]));
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
    ["provider", f.provider], ["derived", f.derived?.join(", ")], ["units_dropped", f.units_dropped], ["kept", f.kept ? "true" : undefined],
    ["startedAt", f.startedAt], ["parentToolCallId", f.parentToolCallId],
  ];
  return Object.fromEntries(lines.filter((line): line is [string, string | number] => line[1] !== undefined && line[1] !== ""));
}

/** Calls a host hook; a throw or a rejection is the host's and never fails the call. */
export async function quietly<T>(hook: ((value: T) => void | Promise<void>) | undefined, value: T): Promise<void> {
  try { await hook?.(value); } catch { /* the host's own failure */ }
}

/** File one look and tell the host: the receipt path, or null when the sink filed nothing or failed. */
export async function fileLook(filing: Filing, tool: string, record: LookRecord, answer?: { readonly usage: Usage | null; readonly costUsd: number | null; readonly billedBy?: string; readonly kept?: true }): Promise<string | null> {
  let receipt: string | null = null;
  try { receipt = (await filing.evidence.file(filing.label, record))?.path ?? null; } catch { /* a receipt never fails the call it files */ }
  if (record.status === "ok") {
    await quietly(filing.onLook, {
      conversationId: filing.conversationId, tool, source: record.args.path, ...(record.args.ask ? { ask: record.args.ask } : {}),
      fragment: record.facts.fragment, model: record.args.model, usage: answer?.usage ?? null, costUsd: answer?.costUsd ?? null,
      ...(answer?.billedBy ? { billedBy: answer.billedBy } : {}), ...(answer?.kept ? { kept: true } : {}),
      ...(record.facts.startedAt !== undefined ? { startedAt: record.facts.startedAt } : {}), ...(record.facts.parentToolCallId ? { parentToolCallId: record.facts.parentToolCallId } : {}), receipt, record,
    });
  }
  return receipt;
}

/** `ask`'s answer kept as the call's memo `vision:look:<key>` before anything reports it, and whether it was read back:
 *  an earlier attempt of the call asked and paid, and this one asked nothing. */
export async function keptAnswer<T>(memo: CallContext["memo"], key: string, ask: () => Promise<T>): Promise<{ readonly answer: T; readonly readBack: boolean }> {
  let asked = false;
  const now = async () => { asked = true; return ask(); };
  const answer = memo ? await memo(`vision:look:${key}`, async () => (await now()) as unknown as Json) as unknown as T : await now();
  return { answer, readBack: !asked };
}

/** Thrown inside the told memo's compute so that a look whose host's `onLook` threw keeps no memo. */
const UNHEARD = new Error("the host's onLook did not return");

/** A look filed and told through `file`, then kept as the call's memo `vision:told:<key>` once the host's `onLook` has
 *  returned; a call run again that finds it files and tells the look as told before (`file(filing, true)`). A hook that
 *  throws leaves no memo, so a rerun tells the host again. */
export async function fileTold(memo: CallContext["memo"], key: string, filing: Filing, file: (filing: Filing, told: boolean) => Promise<string | null>): Promise<string | null> {
  const hook = filing.onLook;
  let heard = !hook, now = false, receipt: string | null = null;
  const tracked: Filing = hook ? { ...filing, onLook: async (look) => { await hook(look); heard = true; } } : filing;
  const tell = async () => { now = true; receipt = await file(tracked, false); if (!heard) throw UNHEARD; return receipt; };
  try {
    const kept = memo ? await memo(`vision:told:${key}`, tell) : await tell();
    return now ? kept : file(filing, true);
  } catch (error) {
    if (error !== UNHEARD) throw error;
    return receipt;
  }
}
