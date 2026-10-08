// The provenance every citable read carries beyond what the page said: the SHA-256 of the bytes filed, the session
// the read happened in and where in that session's recording it happened, so a claim can be traced to its bytes and
// to the frame where the agent saw them. Pure functions of the session record and a clock.
import { createHash } from "node:crypto";
import type { EvidenceRecord } from "./evidence.js";
import type { SessionRecord } from "./host.js";

type Facts = EvidenceRecord["facts"];
export type ReceiptFacts = Pick<Facts, "sha256" | "session" | "recording_at_s">;

/** The part of a custody record a read needs: the provider's id for the session and when custody created it. A
 *  `SessionRecord` is one, so a reader passes the session it ran on as it is. */
export type ReadSession = Pick<SessionRecord, "resourceId" | "createdAt">;

export const sha256Hex = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Seconds, to a tenth, from the session's creation to `at`; never negative (a clock behind the record reads 0); null
 *  when either time is not a date. The recording starts a moment after custody created the session, so a frame sits
 *  slightly before its offset. */
export function recordingOffsetS(createdAt: string, at: number | Date): number | null {
  const start = Date.parse(createdAt);
  const end = typeof at === "number" ? at : at.getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) / 100) / 10) : null;
}

/** The facts for one read: the hash of `body` (the bytes as filed), the provider's session id, and the recording
 *  offset when the provider records sessions (`recorded`) and the session is known. A fact that does not apply is
 *  absent, never null, so a receipt header has no line for it. */
export function receiptFacts(read: { body: string | Uint8Array; session?: ReadSession | null; recorded: boolean; at?: number | Date }): ReceiptFacts {
  const id = read.session?.resourceId ?? null;
  const offset = id && read.recorded && read.session ? recordingOffsetS(read.session.createdAt, read.at ?? Date.now()) : null;
  return { sha256: sha256Hex(read.body), ...(id ? { session: id } : {}), ...(offset !== null ? { recording_at_s: offset } : {}) };
}

/** The order a receipt header lists its facts: what was asked and where it landed, then the bytes, then the trace. */
const FACT_ORDER = ["requested_url", "final_url", "title", "status_code", "content_type", "sha256", "extractor", "via", "session", "recording_at_s", "page_guard"] as const satisfies ReadonlyArray<keyof Facts>;

/** `facts` with its keys in header order and no undefined values; a sink that renders one line per fact in object
 *  order then writes every receipt the same way. A key the order does not list follows the listed ones, so a fact added
 *  to the record can never go missing from a receipt. */
export function orderFacts(facts: Facts): Facts {
  const listed = new Set<string>(FACT_ORDER);
  const keys = [...FACT_ORDER, ...Object.keys(facts).filter((key) => !listed.has(key))] as Array<keyof Facts>;
  return Object.fromEntries(keys.flatMap((key) => (facts[key] === undefined ? [] : [[key, facts[key]]]))) as Facts;
}
