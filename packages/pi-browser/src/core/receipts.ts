import { createHash } from "node:crypto";
import type { EvidenceRecord } from "./evidence.js";
import type { SessionRecord } from "./host.js";

type Facts = EvidenceRecord["facts"];
export type ReceiptFacts = Pick<Facts, "sha256" | "session" | "recording_at_s">;

export type ReadSession = Pick<SessionRecord, "resourceId" | "createdAt">;

export const sha256Hex = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** To a tenth; never negative; null for a bad date. A frame sits slightly before its offset. */
export function recordingOffsetS(createdAt: string, at: number | Date): number | null {
  const start = Date.parse(createdAt);
  const end = typeof at === "number" ? at : at.getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 100) / 10) : null;
}

/** A fact that does not apply is absent, never null, so a receipt header has no line for it. */
export function receiptFacts(read: { body: string | Uint8Array; session?: ReadSession | null; recorded: boolean; at?: number | Date }): ReceiptFacts {
  const id = read.session?.resourceId ?? null;
  const offset = id && read.recorded && read.session ? recordingOffsetS(read.session.createdAt, read.at ?? Date.now()) : null;
  return { sha256: sha256Hex(read.body), ...(id ? { session: id } : {}), ...(offset !== null ? { recording_at_s: offset } : {}) };
}

const FACT_ORDER = ["requested_url", "final_url", "title", "status_code", "content_type", "sha256", "extractor", "via", "session", "recording_at_s", "page_guard"] as const satisfies ReadonlyArray<keyof Facts>;

/** A key the order does not list follows the listed ones, so a fact added to the record never goes missing from a
 *  receipt. */
export function orderFacts(facts: Facts): Facts {
  const listed = new Set<string>(FACT_ORDER);
  const keys = [...FACT_ORDER, ...Object.keys(facts).filter((key) => !listed.has(key))] as Array<keyof Facts>;
  return Object.fromEntries(keys.flatMap((key) => (facts[key] === undefined ? [] : [[key, facts[key]]]))) as Facts;
}
