// The kernel's one reader of a run's journal (kernel page: "the journal and the epoch connect every edge"): what a run
// did, its tool calls and its messages, read the same way for every harness, so no harness grades itself. The kinds are
// runner/journal-kinds.ts. A run's stop reason is on its run row (its end commit's summary), never in the journal.
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ConversationRecord, EntryRecord } from "@earendil-works/pi-durable";
import { type CallEndData, type CallStartData, KINDS, type MessageData, type MessageRole } from "./journal-kinds.js";
import type { Journal } from "./loop-contract.js";

export interface CallRecord {
  readonly callId: string;
  readonly tool: string;
  readonly replaySafe: boolean;
  /** pending: a start with no end yet (a crash between them, until recovery writes one). */
  readonly status: CallEndData["status"] | "pending";
  readonly startEntry: number;
  readonly endEntry?: number;
}

export interface MessageRecord {
  readonly role: MessageRole;
  readonly text: string;
  readonly entry: number;
}

const PAGE = 500;

/** Every entry of every conversation of the run, conversations in id order, each conversation's entries oldest first. */
export async function journalEntries(journal: Journal, context: Context): Promise<EntryRecord[]> {
  const conversations: ConversationRecord[] = [];
  for (let cursor: unknown = undefined; ; ) {
    const page = await journal.scanConversations({ order: "ascending" } as never, PAGE, cursor as never, context);
    conversations.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  const entries: EntryRecord[] = [];
  for (const conversation of conversations) {
    for (let cursor: unknown = undefined; ; ) {
      const page = await journal.scanEntries({ conversationId: conversation.id as ConversationId, order: "ascending" }, PAGE, cursor as never, context);
      entries.push(...page.items);
      if (page.next === undefined) break;
      cursor = page.next;
    }
  }
  return entries;
}

const entryNumber = (entry: EntryRecord): number => Number(entry.id);
const dataOf = <T>(entry: EntryRecord): T => entry.data as unknown as T;

/** The run's tool calls, in the order they started. */
export function callsOf(entries: readonly EntryRecord[]): CallRecord[] {
  const ends = new Map<string, EntryRecord>();
  for (const entry of entries) if (entry.kind === KINDS.callEnd) ends.set(dataOf<CallEndData>(entry).callId, entry);
  return entries
    .filter((entry) => entry.kind === KINDS.callStart)
    .map((entry) => {
      const start = dataOf<CallStartData>(entry);
      const end = ends.get(start.callId);
      return {
        callId: start.callId,
        tool: start.tool,
        replaySafe: start.replaySafe,
        status: end ? dataOf<CallEndData>(end).status : "pending",
        startEntry: entryNumber(entry),
        ...(end ? { endEntry: entryNumber(end) } : {}),
      };
    });
}

/** The run's messages, oldest first. */
export function messagesOf(entries: readonly EntryRecord[]): MessageRecord[] {
  return entries.filter((entry) => entry.kind === KINDS.message).map((entry) => ({ ...dataOf<MessageData>(entry), entry: entryNumber(entry) }));
}

export async function calls(journal: Journal, context: Context): Promise<CallRecord[]> {
  return callsOf(await journalEntries(journal, context));
}

export async function messages(journal: Journal, context: Context): Promise<MessageRecord[]> {
  return messagesOf(await journalEntries(journal, context));
}
