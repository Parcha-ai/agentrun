// The kernel's one reader of a run's journal (kernel page: "the journal and the epoch connect every edge"). Every harness
// writes its tool calls and messages through the kernel, as the entry kinds below; every reader (the conformance suite,
// the runner, the server's views at the cutover) reads them here, never a harness's own format.
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ConversationRecord, EntryRecord } from "@earendil-works/pi-durable";
import type { Journal } from "./loop-contract.js";

/** The entry kinds the kernel writes. Data shapes: see IntentData, ResultData, MessageData, AskData, AnswerData. */
export const KERNEL_ENTRY = {
  /** Written before a tool runs (and before the flush that precedes a side effect). */
  intent: "agentrun.intent",
  /** Written after it ran; or, on recovery, for an intent whose call cannot run again (interrupted). */
  result: "agentrun.result",
  /** A message: the person's, a steer, the model's, or why the run stopped. */
  message: "agentrun.message",
  /** A tool call the gate asked a person about: the run parks on it. */
  ask: "agentrun.ask",
  /** The person's answer to an ask (approve or deny), written by the commit that takes the command row. */
  answer: "agentrun.answer",
} as const;

export interface IntentData {
  readonly callId: string;
  readonly tool: string;
  /** A call that may run again after a crash (it changes nothing outside the run). */
  readonly replaySafe: boolean;
}
export interface ResultData {
  readonly callId: string;
  /** done: it ran and this is its result. interrupted: a crash or a stop cut it, and it is not run again. */
  readonly status: "done" | "interrupted";
  readonly output?: unknown;
}
export type MessageRole = "person" | "steer" | "model" | "stop";
export interface MessageData {
  readonly role: MessageRole;
  readonly text: string;
}
export interface AskData {
  readonly callId: string;
  readonly tool: string;
}
export interface AnswerData {
  readonly callId: string;
  readonly approved: boolean;
}

export interface CallRecord {
  readonly callId: string;
  readonly tool: string;
  readonly replaySafe: boolean;
  /** pending: an intent with no result yet (a crash between them, until recovery writes one). */
  readonly status: "done" | "interrupted" | "pending";
  readonly intentEntry: number;
  readonly resultEntry?: number;
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

/** The run's tool calls, in the order their intents were written. */
export function callsOf(entries: readonly EntryRecord[]): CallRecord[] {
  const results = new Map<string, EntryRecord>();
  for (const entry of entries) if (entry.kind === KERNEL_ENTRY.result) results.set(dataOf<ResultData>(entry).callId, entry);
  return entries
    .filter((entry) => entry.kind === KERNEL_ENTRY.intent)
    .map((entry) => {
      const intent = dataOf<IntentData>(entry);
      const result = results.get(intent.callId);
      return {
        callId: intent.callId,
        tool: intent.tool,
        replaySafe: intent.replaySafe,
        status: result ? dataOf<ResultData>(result).status : "pending",
        intentEntry: entryNumber(entry),
        ...(result ? { resultEntry: entryNumber(result) } : {}),
      };
    });
}

/** The run's messages, oldest first. */
export function messagesOf(entries: readonly EntryRecord[]): MessageRecord[] {
  return entries
    .filter((entry) => entry.kind === KERNEL_ENTRY.message)
    .map((entry) => ({ ...dataOf<MessageData>(entry), entry: entryNumber(entry) }));
}

export async function calls(journal: Journal, context: Context): Promise<CallRecord[]> {
  return callsOf(await journalEntries(journal, context));
}

export async function messages(journal: Journal, context: Context): Promise<MessageRecord[]> {
  return messagesOf(await journalEntries(journal, context));
}
