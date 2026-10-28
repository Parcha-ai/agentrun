// A run's harness sessions (the run adapters' SessionStore) kept in the run's own durable store, so a run on any harness
// resumes from what its process left there. Each session key is a conversation of the run's Harness, named by a
// `session.key` entry on the root conversation; each record is an entry of it, appended through the Harness's commit.
// Two fences hold a session to one writer: across processes the run's lease (a process whose lease lapsed has its
// commit refused, FencedError), and within one the newest `open` of a key, checked inside the commit that appends.
import type { Context } from "@earendil-works/chord";
import { type ConversationId, type Cursor, type Harness, ROOT_CONVERSATION_ID, type Tx } from "@earendil-works/pi-durable";
import { SessionFenced, type SessionRecord, type SessionStore, type SessionWriter } from "@parcha/agentrun-adapters";
import { FencedError } from "@parcha/pi-durable-disk";

const SESSION_KEY = "session.key";
const PAGE = 500;

type EntryLike = { kind: string; data?: unknown };

export function durableSessions(harness: Harness, context: Context): SessionStore {
  const holders = new Map<string, number>();
  const known = new Map<string, ConversationId>();

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

  const find = async (key: string): Promise<ConversationId | undefined> => {
    if (!known.has(key)) {
      await scan(ROOT_CONVERSATION_ID, (entry) => {
        const data = entry.data as { key?: unknown; conversation?: unknown } | undefined;
        if (entry.kind === SESSION_KEY && typeof data?.key === "string" && data.conversation != null) known.set(data.key, data.conversation as ConversationId);
      });
    }
    return known.get(key);
  };

  const read = async (key: string): Promise<SessionRecord[]> => {
    const id = await find(key);
    const out: SessionRecord[] = [];
    if (id) await scan(id, (entry) => out.push({ kind: entry.kind, data: (entry.data ?? null) as SessionRecord["data"] }));
    return out;
  };

  /** One commit, refused as SessionFenced when the run's lease is gone. */
  const commit = async <T>(key: string, change: (tx: Tx) => Promise<T>): Promise<T> => {
    try {
      return await harness.commit(change, context);
    } catch (error) {
      if (error instanceof FencedError || error instanceof SessionFenced) throw new SessionFenced(key);
      throw error;
    }
  };

  return {
    read,
    async open(key) {
      const holder = (holders.get(key) ?? 0) + 1;
      holders.set(key, holder);
      let id = await find(key);
      if (!id) {
        // The root holds the key's entry; a run's agent made it already, and one that has none gets it here.
        await harness.root(context);
        id = await commit(key, async (tx) => {
          const made = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: SESSION_KEY, data: { key, conversation: made.id } });
          return made.id;
        });
        known.set(key, id);
      }
      const conversation = id;
      const writer: SessionWriter = {
        key,
        read: () => read(key),
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
