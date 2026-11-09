// The CLI adapters' sessions (run-adapters' SessionStore) on the run's journal: the resume log of Claude Code, Codex and
// OpenCode, kept in the one store as pi's own records are. The run's loop opens one Harness per claim on
// store.journal(claim) and binds this to it. Each session key is a conversation of that Harness, named by an
// `agentrun.session.key` entry on the root conversation (journal-kinds.ts); each record is an entry of it, appended
// through the Harness's commit, so it is fenced by the run's claim like every journal write. The reader skips every
// entry of a session's conversation: a run's visible record (its calls and messages) is the loop's, never this.
//
// Two fences hold a session to one writer. Across claims, the store's: a commit under a claim the run moved past is
// refused (Fenced, or the runner's ClaimLost before it reaches the store), and from then on this store refuses every
// append at once, whatever its key, as it does once the claim's signal (the loop's Context) is aborted: a fenced CLI
// stops writing, never retrying into a Harness the claim no longer holds. Within a process, the newest `open` of a key,
// checked inside the commit that appends. A port of serve/src/sessions.ts (the per-run store's, until the cutover).
import type { Context } from "@earendil-works/chord";
import { type ConversationId, type Cursor, type Harness, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { SessionFenced, type SessionRecord, type SessionStore, type SessionWriter } from "@parcha/agentrun-kernel";
import { Fenced, type Store } from "../store/store.js";
import { KINDS, type SessionKeyData } from "./journal-kinds.js";
import { ClaimLost } from "./runner.js";

const PAGE = 500;

type EntryLike = { kind: string; data?: unknown };

/** Whether `error`, or any cause under it, is the claim's fence refusing a write (not a newer open of one key). */
const fenced = (error: unknown): boolean => {
  for (let at: unknown = error; at; at = (at as { cause?: unknown }).cause) if (at instanceof Fenced || at instanceof ClaimLost) return true;
  return false;
};

/** The sessions of the run whose one Harness is `harness` (on store.journal(claim)); `context`: the loop's, whose signal is
 *  the claim's; `store`: its flush makes every record appended so far survive a lost box (sync). */
export function journalSessions(harness: Harness, context: Context, store: Pick<Store, "flush">): SessionStore & { keys(): Promise<string[]> } {
  const holders = new Map<string, number>();
  const known = new Map<string, ConversationId>();
  // One creation per key at a time: two first opens at once share it, so a key names one conversation.
  const creating = new Map<string, Promise<ConversationId>>();
  // Once the claim's fence refused a commit, or its signal aborted: every later append is refused, never retried.
  let dead = false;
  const alive = (key: string) => {
    if (context.abortSignal?.aborted) dead = true;
    if (dead) throw new SessionFenced(key);
  };

  const scan = async (id: ConversationId, each: (entry: EntryLike) => void) => {
    const conversation = await harness.conversation(id, context);
    if (!conversation) return;
    for (let cursor: Cursor | undefined; ; ) {
      const page = await conversation.entries({ order: "ascending" }, PAGE, cursor, context);
      for (const entry of page.items) each(entry as EntryLike);
      if (page.next === undefined) return;
      cursor = page.next;
    }
  };

  /** Every key the root names, read once: from then on this store's own opens add theirs (the claim fences any other
   *  writer of the run's journal while it holds). */
  let scanned = false;
  const scanKeys = async () => {
    await scan(ROOT_CONVERSATION_ID, (entry) => {
      const data = entry.data as Partial<SessionKeyData> | undefined;
      // The first entry of a key names its conversation.
      if (entry.kind === KINDS.sessionKey && typeof data?.key === "string" && data.conversation != null && !known.has(data.key)) known.set(data.key, data.conversation as unknown as ConversationId);
    });
    scanned = true;
  };

  const find = async (key: string): Promise<ConversationId | undefined> => {
    if (!known.has(key)) await scanKeys();
    return known.get(key);
  };

  const read = async (key: string): Promise<SessionRecord[]> => {
    const id = await find(key);
    const out: SessionRecord[] = [];
    if (id) await scan(id, (entry) => out.push({ kind: entry.kind, data: (entry.data ?? null) as SessionRecord["data"] }));
    return out;
  };

  /** One commit through the run's Harness: refused SessionFenced once the claim's fence refuses it, and for good. */
  const commit = async <T>(key: string, change: (tx: Tx) => Promise<T>): Promise<T> => {
    alive(key);
    try {
      return await harness.commit(change, context);
    } catch (error) {
      if (fenced(error)) {
        dead = true;
        throw new SessionFenced(key);
      }
      // A newer open of this key fenced this one writer only: the store goes on for the others.
      for (let at: unknown = error; at; at = (at as { cause?: unknown }).cause) if (at instanceof SessionFenced) throw new SessionFenced(key);
      throw error;
    }
  };

  const create = (key: string): Promise<ConversationId> => {
    let made = creating.get(key);
    if (!made) {
      made = (async () => {
        // The root holds the key's entry; a run's agent made it already, and one that has none gets it here.
        await harness.root(context);
        const id = await commit(key, async (tx) => {
          // Read again in the commit: a key another holder named meanwhile keeps its conversation.
          for (let cursor: Cursor | undefined; ; ) {
            const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, PAGE, cursor);
            const named = page.items.find((entry) => entry.kind === KINDS.sessionKey && (entry.data as Partial<SessionKeyData> | undefined)?.key === key);
            if (named) return (named.data as unknown as { conversation: ConversationId }).conversation;
            if (page.next === undefined) break;
            cursor = page.next;
          }
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          const data: SessionKeyData = { key, conversation: conversation.id as unknown as SessionKeyData["conversation"] };
          await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: KINDS.sessionKey, data: data as never });
          return conversation.id;
        });
        known.set(key, id);
        return id;
      })().finally(() => creating.delete(key));
      creating.set(key, made);
    }
    return made;
  };

  return {
    read,
    /** Every session key of the run: the run's one booking sums their spend (runBooking). */
    async keys() {
      if (!scanned) await scanKeys();
      return [...known.keys()];
    },
    async open(key) {
      alive(key);
      const holder = (holders.get(key) ?? 0) + 1;
      holders.set(key, holder);
      const conversation = (await find(key)) ?? (await create(key));
      const writer: SessionWriter = {
        key,
        read: () => read(key),
        // Every record appended so far is durable when this resolves: the kernel calls it after an effect's start record
        // and before the effect runs (drive.ts), so a lost box never runs it twice. One FULL commit of the store.
        sync: () => store.flush(),
        async append(records) {
          await commit(key, async (tx) => {
            // Checked in the commit: an open that resolved before it fences this writer, whatever its own timing.
            if (holders.get(key) !== holder) throw new SessionFenced(key);
            for (const record of records) await tx.appendEntry(conversation, { kind: record.kind, data: record.data as never });
          });
        },
      };
      return writer;
    },
  };
}
