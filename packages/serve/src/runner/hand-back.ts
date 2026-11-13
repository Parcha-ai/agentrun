// A person's answer to the agent's browser hand-over (a browser_hand_back row, its body { ask, outcome }), decided on the
// run's journal: the first answer for an ask is its answer. The ask is the run's browser host's hand-over entry
// (KINDS.handover, waiting); an answer is a hand-over entry too, the person's at their own time (the row's), or the
// ask's expiry at the expiry's time. The loop (adapter-loop.ts) commits what this decides.
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { type HandoverAnswered, type HandoverAsked, type HandoverOutcome, KINDS } from "./journal-kinds.js";

/** The command kind for a person's answer to a browser hand-over. */
export const HAND_BACK = "browser_hand_back";

/** A hand-back the run cannot take, in the server's words for the same answers (browser-commands.ts). */
export const HAND_BACK_REFUSED = {
  unknown: "This run's agent has not asked for you in its browser.",
  answered: (outcome: HandoverOutcome) => (outcome === "expired" ? HAND_BACK_REFUSED.expired : `The agent's hand-over was already answered ${outcome}.`),
  expired: "The agent's hand-over expired before this answer.",
} as const;

const OUTCOMES: readonly string[] = ["done", "cancelled", "expired"];

/** The ask `id` as its waiting entry has it, or undefined. */
export function askedIn(entries: readonly { kind: string; data?: unknown }[], id: string): HandoverAsked | undefined {
  for (const entry of entries) {
    const data = entry.data as Partial<HandoverAsked> | null;
    if (entry.kind === KINDS.handover && data?.state === "waiting" && data.id === id && typeof data.expires_at === "string") return data as HandoverAsked;
  }
  return undefined;
}

/** Ask `id`'s answer: the first answered entry for it, or undefined. */
export function answerIn(entries: readonly { kind: string; data?: unknown }[], id: string): HandoverAnswered | undefined {
  for (const entry of entries) {
    const data = entry.data as Partial<HandoverAnswered> | null;
    if (entry.kind === KINDS.handover && data?.id === id && OUTCOMES.includes(String(data.state)) && typeof data.at === "string") return data as HandoverAnswered;
  }
  return undefined;
}

/** What a hand-back row does on a journal holding `entries`: the answered entry to write (`write`), and why the row is
 *  refused (`refused`). The person's answer is written, at `atMs` (the row's own time), when the ask is open then; an ask
 *  that had lapsed by then is answered by its expiry, at the expiry's time, and the row refused; an ask answered already,
 *  or never made, refuses it and writes nothing. */
export function handBackOf(entries: readonly { kind: string; data?: unknown }[], body: unknown, atMs: number): { write?: HandoverAnswered; refused?: string } {
  const { ask, outcome } = (body ?? {}) as { ask?: unknown; outcome?: unknown };
  const asked = typeof ask === "string" ? askedIn(entries, ask) : undefined;
  if (!asked || (outcome !== "done" && outcome !== "cancelled")) return { refused: HAND_BACK_REFUSED.unknown };
  const answered = answerIn(entries, asked.id);
  if (answered) return { refused: HAND_BACK_REFUSED.answered(answered.state) };
  const expiresAt = Date.parse(asked.expires_at);
  if (!(atMs < expiresAt)) return { write: { state: "expired", id: asked.id, session: asked.session, at: asked.expires_at }, refused: HAND_BACK_REFUSED.expired };
  return { write: { state: outcome, id: asked.id, session: asked.session, at: new Date(atMs).toISOString() } };
}

/** A run's commit through its Harness (Harness.commit): commits run one at a time, on the session's line. */
export type JournalCommit = <T>(change: (tx: Tx) => Promise<T>) => Promise<T>;

/** Every entry of conversation `conversationId`, as the transaction reads it. */
async function entriesIn(tx: Tx, conversationId: ConversationId): Promise<{ kind: string; data?: unknown }[]> {
  const entries: { kind: string; data?: unknown }[] = [];
  for (let cursor: Parameters<Tx["scanEntries"]>[2] | undefined; ; ) {
    const page = await tx.scanEntries({ conversationId, order: "ascending" }, 200, cursor);
    for (const item of page.items) entries.push({ kind: item.kind, data: item.data });
    if (page.next === undefined) return entries;
    cursor = page.next;
  }
}

/** A hand-over answer decided and written in one commit: `decide` reads the conversation's entries as the commit sees
 *  them, and its `write`, if any, is appended in that same commit. Commits run one at a time, so no other writer's
 *  answer lands between the read and the write: an ask gets exactly one answered entry, whoever writes it (the loop's
 *  hand-back row, the browser host's give or expiry). What `decide` returned comes back. */
export function answerOnce<V extends { write?: HandoverAnswered }>(commit: JournalCommit, conversationId: ConversationId, decide: (entries: readonly { kind: string; data?: unknown }[]) => V): Promise<V> {
  return commit(async (tx) => {
    const verdict = decide(await entriesIn(tx, conversationId));
    if (verdict.write) await tx.appendEntry(conversationId, { kind: KINDS.handover, data: verdict.write as unknown as JsonValue });
    return verdict;
  });
}
