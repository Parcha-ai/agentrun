// The kernel's one reader of a run's journal (kernel page: "the journal and the epoch connect every edge"): what a run
// did, its tool calls and its messages, read the same way for every harness, so no harness grades itself. Two sources,
// one output: a pi run's own records (its pi.tool tasks and its pi.user / pi.assistant entries), and a CLI run's
// agentrun.* entries (runner/journal-kinds.ts). A run's stop reason is on its run row (its end commit's summary).
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ConversationRecord, EntryRecord, TaskRecord } from "@earendil-works/pi-durable";
import { type CallEndData, type CallStartData, KINDS, type MessageData, type MessageRole, type SessionKeyData } from "./journal-kinds.js";
import type { Journal } from "./loop-contract.js";

export interface CallRecord {
  readonly callId: string;
  readonly tool: string;
  /** Whether it may run again after a crash: the call's own flag (a pi tool says so only while it runs). */
  readonly replaySafe?: boolean;
  /** pending: started, not ended (a crash between them, until recovery ends it). */
  readonly status: CallEndData["status"] | "pending";
  readonly startEntry: number;
  readonly endEntry?: number;
}

export interface MessageRecord {
  readonly role: MessageRole;
  readonly text: string;
  readonly entry: number;
}

/** What the reader reads: every entry and every task of the run. */
export interface JournalRecords {
  readonly entries: readonly EntryRecord[];
  readonly tasks: readonly TaskRecord<unknown, unknown, unknown>[];
}

const PAGE = 500;
/** pi's kinds, as pi 1.5 writes them. */
const PI = { tool: "pi.tool", user: "pi.user", assistant: "pi.assistant" } as const;
/** The diagnostic code pi's recovery puts on the result of a call it interrupted (not run again). */
const INTERRUPTED = "interrupted";

async function scanAll<T>(scan: (cursor: unknown) => Promise<{ items: readonly T[]; next?: unknown }>): Promise<T[]> {
  const items: T[] = [];
  for (let cursor: unknown = undefined; ; ) {
    const page = await scan(cursor);
    items.push(...page.items);
    if (page.next === undefined) return items;
    cursor = page.next;
  }
}

/** Every entry and task of the run: conversations in id order, each one's entries oldest first; tasks in id order. */
export async function journalRecords(journal: Journal, context: Context): Promise<JournalRecords> {
  const conversations = await scanAll<ConversationRecord>((cursor) => journal.scanConversations({ order: "ascending" } as never, PAGE, cursor as never, context));
  const entries: EntryRecord[] = [];
  for (const conversation of conversations) {
    entries.push(...(await scanAll<EntryRecord>((cursor) => journal.scanEntries({ conversationId: conversation.id as ConversationId, order: "ascending" }, PAGE, cursor as never, context))));
  }
  const tasks = await scanAll<TaskRecord<unknown, unknown, unknown>>((cursor) => journal.scanTasks({ order: "ascending" } as never, PAGE, cursor as never, context) as never);
  return { entries, tasks };
}

/** Every entry of the run (the CLI record and pi's entries alike). */
export async function journalEntries(journal: Journal, context: Context): Promise<EntryRecord[]> {
  return [...(await journalRecords(journal, context)).entries];
}

const entryNumber = (entry: EntryRecord): number => Number(entry.id);
const dataOf = <T>(entry: EntryRecord): T => entry.data as unknown as T;
const asRecords = (from: readonly EntryRecord[] | JournalRecords): JournalRecords => (Array.isArray(from) ? { entries: from, tasks: [] } : (from as JournalRecords));

/** The run's own record: every entry but those inside a CLI session's conversation (its resume log), whatever their kind. */
export function recordOf(entries: readonly EntryRecord[]): EntryRecord[] {
  const sessions = new Set(entries.filter((entry) => entry.kind === KINDS.sessionKey).map((entry) => String(dataOf<SessionKeyData>(entry).conversation)));
  return entries.filter((entry) => !sessions.has(String(entry.conversationId)));
}

type PiToolInput = { kind?: string; assistant?: number; callId?: string };
type PiToolState =
  | { status: "terminal"; outcome: { status: "completed" | "failed" | "aborted"; result?: { entryId?: number } } }
  | { status: string; checkpoint?: { replay?: "safe" | "unsafe" } };
type ModelBlock = { type?: string; id?: string; name?: string; text?: string };

/** A pi tool task as a call: its name from the assistant entry's tool call, its status from the task's state. */
function piCall(task: TaskRecord<unknown, unknown, unknown>, byId: ReadonlyMap<string, EntryRecord>): CallRecord | undefined {
  const input = task.input as PiToolInput;
  if (input?.callId === undefined || input.assistant === undefined) return undefined;
  const assistant = byId.get(String(input.assistant));
  const block = (assistant?.model?.[0] as { content?: ModelBlock[] } | undefined)?.content?.find((part) => part.type === "toolCall" && part.id === input.callId);
  const state = task.state as unknown as PiToolState;
  const start = { callId: input.callId, tool: block?.name ?? "unknown", startEntry: input.assistant };
  if (state.status !== "terminal" || !("outcome" in state)) {
    const replay = "checkpoint" in state ? state.checkpoint?.replay : undefined;
    return { ...start, status: "pending", ...(replay ? { replaySafe: replay === "safe" } : {}) };
  }
  const endId = state.outcome.result?.entryId;
  const result = endId === undefined ? undefined : byId.get(String(endId));
  const interrupted = ((result?.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? []).some((each) => each.code === INTERRUPTED);
  const status: CallRecord["status"] = state.outcome.status === "completed" ? "done" : interrupted || state.outcome.status === "aborted" ? "interrupted" : "failed";
  return { ...start, status, ...(endId === undefined ? {} : { endEntry: endId }) };
}

/** The run's tool calls, in the order they started: pi's tool tasks and the CLI record's call starts. */
export function callsOf(from: readonly EntryRecord[] | JournalRecords): CallRecord[] {
  const { entries: all, tasks } = asRecords(from);
  const entries = recordOf(all);
  const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
  const ends = new Map<string, EntryRecord>();
  for (const entry of entries) if (entry.kind === KINDS.callEnd) ends.set(dataOf<CallEndData>(entry).callId, entry);
  const cli = entries
    .filter((entry) => entry.kind === KINDS.callStart)
    .map((entry): CallRecord => {
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
  const pi = tasks.filter((task) => task.kind === PI.tool).flatMap((task) => piCall(task, byId) ?? []);
  return [...pi, ...cli].sort((a, b) => a.startEntry - b.startEntry);
}

/** The text of a pi message: a string, or its text blocks joined. */
function piText(entry: EntryRecord): string {
  const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? (content as ModelBlock[]).filter((part) => part.type === "text").map((part) => part.text ?? "").join("") : "";
}

/** The run's messages, oldest first: the CLI record's, and pi's (a pi.user entry a running generation placed is a steer;
 *  a pi.assistant entry with no text, only tool calls, is no message). */
export function messagesOf(from: readonly EntryRecord[] | JournalRecords): MessageRecord[] {
  const out: MessageRecord[] = [];
  for (const entry of recordOf(asRecords(from).entries)) {
    if (entry.kind === KINDS.message) out.push({ ...dataOf<MessageData>(entry), entry: entryNumber(entry) });
    else if (entry.kind === PI.user) out.push({ role: entry.byTaskId === undefined ? "person" : "steer", text: piText(entry), entry: entryNumber(entry) });
    else if (entry.kind === PI.assistant) {
      const text = piText(entry);
      if (text !== "") out.push({ role: "model", text, entry: entryNumber(entry) });
    }
  }
  return out.sort((a, b) => a.entry - b.entry);
}

export async function calls(journal: Journal, context: Context): Promise<CallRecord[]> {
  return callsOf(await journalRecords(journal, context));
}

export async function messages(journal: Journal, context: Context): Promise<MessageRecord[]> {
  return messagesOf(await journalRecords(journal, context));
}
