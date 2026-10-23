// The effect journal of the pi-durable adapter: an effectful action is journaled before it runs, and an entry an earlier process
// wrote and never settled is a cut, which the next call tells the model about once. These read and settle the journal; custody
// (durable.ts) writes it.
import { ToolResultEntry, type ConversationDocToken, type ConversationId, type EntryId, type Tx } from "@earendil-works/pi-durable";
import type { PendingEffect, SessionsState } from "../core/host.js";

/** What the journal reads of custody: the conversation's sessions and this process's incarnation. */
type Journal = { Sessions: ConversationDocToken<SessionsState>; incarnation: string };
/** What the journal reads of a tool call: its conversation and plane, and a commit. */
type JournalScope = { cid: ConversationId; plane: string; commit<T>(change: (tx: Tx) => Promise<T>): Promise<T> };

export const journalOf = (state: SessionsState, plane: string) => [...state.sessions].reverse().find((r) => r.plane === plane && r.pendingEffect !== null)?.pendingEffect ?? null;
/** The entry with this call's id in a journal chain: the entry itself or one it carries as `prior`. */
export const inChain = (entry: PendingEffect | null | undefined, callId: string): PendingEffect | undefined => {
  for (let e = entry; e; e = e.prior) if (e.callId === callId) return e;
  return undefined;
};
/** Settles one entry of a journal chain; the entries it carried stay. */
export const clearJournal = (c: Journal, scope: JournalScope, callId: string) =>
  scope.commit(async (tx) => {
    const state = await tx.doc(c.Sessions, scope.cid);
    for (const record of state.sessions) {
      if (record.plane !== scope.plane || !record.pendingEffect) continue;
      if (record.pendingEffect.callId === callId) { record.pendingEffect = record.pendingEffect.prior ?? null; continue; }
      for (let e = record.pendingEffect; e.prior; e = e.prior) {
        if (e.prior.callId !== callId) continue;
        if (e.prior.prior) e.prior = e.prior.prior; else delete e.prior;
        break;
      }
    }
  });

/** The entries of a journal chain whose warning is still owed, as a chain: each an earlier process wrote that is a cut (not
 *  finished with a saved answer) and has not been told by a saved answer. An entry of this process is never a cut, and a told
 *  one whose telling answer was saved was delivered. */
export async function owed(c: Journal, scope: JournalScope, entry: PendingEffect | null | undefined): Promise<PendingEffect | null> {
  if (!entry) return null;
  const rest = await owed(c, scope, entry.prior);
  const { prior: _carried, ...own } = entry;
  const delivered = entry.incarnation === c.incarnation
    || (entry.told === true && (await toldSaved(scope, entry)))
    || (entry.finished === true && !entry.told && (await answered(scope, entry)));
  return delivered ? rest : { ...own, ...(rest ? { prior: rest } : {}) };
}

/** A journaled action's own answer as pi committed it: true for a success, false for an error, null for none yet. */
export async function answerOf(scope: JournalScope, pending: PendingEffect): Promise<boolean | null> {
  const message = await savedAnswer(scope, pending.after, pending.callId);
  return message === null ? null : message.isError !== true;
}

/** Whether the call that told a cut had its answer saved, carrying the cut's facts. One killed between the told mark and pi's
 *  commit told nobody, and the cut is told again. */
async function toldSaved(scope: JournalScope, pending: PendingEffect): Promise<boolean> {
  if (!pending.toldBy) return false;
  const message = await savedAnswer(scope, pending.after, pending.toldBy);
  return (message?.details as { pendingEffect?: { callId?: unknown } } | undefined)?.pendingEffect?.callId === pending.callId;
}

/** A call's saved tool result, found by pi's typed tool-result entry. The scan covers only the cut's conversation from where
 *  it was journaled on, never the whole history. */
async function savedAnswer(scope: JournalScope, after: number | undefined, callId: string) {
  if (after === undefined) return null;
  return scope.commit(async (tx) => {
    let cursor: Parameters<Tx["scanEntries"]>[2];
    do {
      const page = await tx.scanEntries({ conversationId: scope.cid, minEntryId: after as EntryId, order: "ascending" }, 100, cursor);
      for (const entry of page.items) {
        const message = ToolResultEntry.is(entry) ? entry.model?.[0] : undefined;
        if (message?.role === "toolResult" && message.toolCallId === callId) return message;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return null;
  });
}

/** Whether a journaled action's own answer was committed as a success. */
const answered = async (scope: JournalScope, pending: PendingEffect) => (await answerOf(scope, pending)) === true;

/** One journal entry as a cut. In this process an entry is in flight or answered, never cut; one an earlier process wrote is
 *  a cut unless its action finished and pi committed its answer, which only then is looked up. It counts as told only once
 *  the telling call's answer, carrying its facts, was saved. */
async function oneCut(c: Journal, scope: JournalScope, entry: PendingEffect): Promise<PendingEffect | null> {
  if (entry.incarnation === c.incarnation) return null;
  const { prior: _carried, ...own } = entry;
  const pending: PendingEffect = own.told && !(await toldSaved(scope, own)) ? { ...own, told: false } : own;
  if (!pending.finished || pending.told || !(await answered(scope, pending))) return pending;
  await clearJournal(c, scope, pending.callId);
  return null;
}

/** Every cut in a journal chain, oldest first. An entry a later action replaced counts only while its warning is still owed:
 *  once a saved answer told it, the later action replaced it, as it would have with no chain. */
export async function cutsOf(c: Journal, scope: JournalScope, entry: PendingEffect | null | undefined, newest = true): Promise<PendingEffect[]> {
  if (!entry) return [];
  const older = await cutsOf(c, scope, entry.prior, false);
  const own = await oneCut(c, scope, entry);
  return own && (newest || !own.told) ? [...older, own] : older;
}

/** The cut a call answers for: the oldest whose warning is still owed (an entry a later action replaced before the telling
 *  of it was saved comes first), else the newest. */
export const cutOf = (cuts: PendingEffect[]): PendingEffect | null => cuts.find((cut) => !cut.told) ?? cuts.at(-1) ?? null;
