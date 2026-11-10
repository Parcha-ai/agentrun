// One run's stored commits as the events the door's GET /events sends (what serve's runs.ts and the console read today:
// the page's "not changing: what a person sees"). Each commit is translated from its own records only (journal
// .commitsAfter), never from another commit's, so commits stored together in one storage call stream as their own
// commits, in their own order.
//
// The events come from the records that keep their order: the input submission and the pi.generation tasks for the run
// and its turns, pi.tool tasks (a pi run) or the kernel's call entries (a CLI run, runner/journal-kinds.ts) for the calls,
// entries for the messages. pi.live, pi.inbox and pi.usage keep no history; they give only inbox_update and usage_changed
// (and the snapshot), never a run, turn or call event. What pi holds before it stores it (a running tool, a partial
// answer) is not here: it reaches the stream from the run's run_live row (live/stream.ts), beside these events.
//
// Every event comes from one commit's own writes or entries (journal.commitsAfter returns each commit's own task,
// submission and document writes, pi_commit_writes), never inferred: a call's start is the commit where its task runs, a
// submission's placement the commit that placed it. A call that never ran ends with no start, as the door says it.
import type { JsonValue } from "@earendil-works/chord";
import { AgentDoc, type EntryRecord, type SubmissionRecord, UsageDoc } from "@earendil-works/pi-durable";
import { HOST_PHASE, RUN_RESUMED } from "@parcha/pi-durable-agent/timeline";
import { REFLECT_LABEL, reflectFrom } from "../runner/end-of-run.js";
import { type CallEndData, type CallStartData, type EndData, KINDS, type MessageData, type SessionKeyData } from "../runner/journal-kinds.js";
import { PI_STOP } from "../runner/pi-stop.js";
import type { JournalCommit } from "../store/journal/storage.js";

export type LiveEvent = { readonly type: string } & Record<string, unknown>;

type Task = JournalCommit["tasks"][number];
type InputSubmission = Extract<SubmissionRecord, { type: "input" }>;

/** What the stream knows of the run after the commits it has read. */
export interface LiveState {
  /** The run's root conversation (the input's, or the CLI entries'): only its records are streamed. */
  root?: number;
  /** Conversations that hold a CLI session's resume log: never streamed. */
  readonly sessions: Set<number>;
  /** Events begin with the first commit that carries an input or a kernel entry; earlier ones (the root's set-up) fold
   *  into the snapshot. */
  started: boolean;
  readonly entries: EntryRecord[];
  readonly tasks: Map<number, Task>;
  readonly submissions: Map<number, SubmissionRecord>;
  /** Each conversation's documents by kind, as last written. */
  readonly docs: Map<number, Map<string, JsonValue | undefined>>;
  /** The run in progress: the inputs it answers. */
  run?: { inputs: number[] };
  /** Generation tasks whose turn started, and those whose turn ended. */
  readonly turns: Set<number>;
  readonly turnsEnded: Set<number>;
  /** Calls whose start, and whose end, the stream has said (a held start counts). */
  readonly started_calls: Set<string>;
  readonly ended_calls: Set<string>;
  /** The call names and arguments the assistant's stored tool calls give, by call id. */
  readonly calls: Map<string, { name: string; args?: unknown }>;
  /** An answer streamed as a partial (held): its stored message is only its end. */
  partial: boolean;
  /** Where the run's end-of-run turn began (end-of-run.ts reflectFrom), once its input is placed: its messages from there
   *  on carry the learning label, a tag the reader puts on (the run writes nothing for it). */
  reflectFrom?: number;
}

export function emptyState(): LiveState {
  return {
    sessions: new Set(),
    started: false,
    entries: [],
    tasks: new Map(),
    submissions: new Map(),
    docs: new Map(),
    turns: new Set(),
    turnsEnded: new Set(),
    started_calls: new Set(),
    ended_calls: new Set(),
    calls: new Map(),
    partial: false,
  };
}

const KERNEL = new Set<string>(Object.values(KINDS));
const PI_TOOL = "pi.tool";
const PI_GENERATION = "pi.generation";
const ROLE: Record<string, string> = { person: "user", steer: "user", model: "assistant" };

const dataOf = <T>(entry: EntryRecord): T => entry.data as unknown as T;
const modelOf = (entry: EntryRecord) => (entry as { model?: { role?: string; content?: unknown; toolCallId?: string }[] }).model?.[0];

/** The one row a person's stop gives, the same on every harness: from the loop's end entry, stopped. */
export const STOPPED_BY_YOU = "Stopped by you";
/** What a call a person's stop cut says, in its result. */
export const CUT_BY_YOU = "stopped by you";

/** The message of a result that is only pi's diagnostics block (`<harness>`, then `[error] …` lines, then `</harness>`
 *  and nothing after it): its first error's, else its first line's, without the severity or the markup. Undefined for any
 *  other text, a tool's own output after such a block included: that is kept whole. */
function diagnosticOf(text: string): string | undefined {
  const lines = text.trim().split("\n").map((line) => line.trim());
  if (lines[0] !== "<harness>") return undefined;
  const end = lines.indexOf("</harness>");
  if (end !== lines.length - 1) return undefined;
  const inner = lines.slice(1, end).filter(Boolean);
  const said = inner.map((line) => /^\[(\w+)\]\s*(.*)$/.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  const first = said.find((match) => match[1] === "error") ?? said[0];
  return first ? (first[2] ?? "") : (inner[0] ?? "");
}

/** A tool result as a person reads it. One an abort cut says CUT_BY_YOU: on the kernel's journal only a person's stop
 *  writes one (a lost claim or a shutdown seals the journal before its abort). One that is only pi's diagnostics block
 *  says that block's message. Neither ever shows the block's markup. Any other entry as it is. */
function shownResult(entry: EntryRecord): EntryRecord {
  const message = modelOf(entry);
  if (message?.role !== "toolResult") return entry;
  const diagnostics = (entry.data as { diagnostics?: unknown } | undefined)?.diagnostics;
  const aborted = Array.isArray(diagnostics) && diagnostics.some((diagnostic) => (diagnostic as { code?: unknown } | null)?.code === PI_STOP.aborted);
  const blocks = Array.isArray(message.content) ? (message.content as { type?: string; text?: unknown }[]) : [];
  const text = typeof message.content === "string" ? message.content : blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("\n");
  const said = aborted ? CUT_BY_YOU : diagnosticOf(text);
  if (said === undefined) return entry;
  const model = (entry as unknown as { model: unknown[] }).model;
  return { ...entry, model: [{ ...message, content: [{ type: "text", text: said }] }, ...model.slice(1)] } as unknown as EntryRecord;
}
const doc = (state: LiveState, kind: string) => (state.root === undefined ? undefined : state.docs.get(state.root)?.get(kind));

/** The run as the snapshot gives it: the entries so far, the calls running now and the documents' values. */
export function snapshotOf(state: LiveState): LiveEvent {
  const inbox = doc(state, "pi.inbox") as { items?: { id: number; mode: string }[] } | undefined;
  // The calls started and not ended in the commits read so far, as the door's snapshot lists pi.live's running tool
  // slots: a stream opened while one runs shows it (its held start is skipped after, since its start is folded here).
  const running = [...state.started_calls].filter((callId) => !state.ended_calls.has(callId)).map((callId) => ({ callId, name: state.calls.get(callId)?.name ?? "", status: "running" }));
  return {
    type: "snapshot",
    entries: state.entries,
    ...(state.run ? { run: { inputs: state.run.inputs } } : {}),
    tools: running,
    compactions: [],
    inbox: (inbox?.items ?? []).map((item) => ({ id: item.id, mode: item.mode })),
    agent: (doc(state, "pi.agent") as JsonValue | undefined) ?? AgentDoc.definition.initial(),
    usage: (doc(state, "pi.usage") as JsonValue | undefined) ?? UsageDoc.definition.initial(),
    // The end-of-run turn under way: where it began, as the server's Reflect names it (`after`, the entry before its input).
    ...(state.reflectFrom !== undefined ? { reflect: { after: state.reflectFrom - 1 } } : {}),
  };
}

/** The events one commit causes, from its own records; `state` moves to after it. */
export function translate(state: LiveState, commit: JournalCommit): LiveEvent[] {
  for (const entry of commit.entries) if (entry.kind === KINDS.sessionKey) state.sessions.add(Number(dataOf<SessionKeyData>(entry).conversation));
  const own = <T extends { conversationId?: unknown }>(record: T) => !state.sessions.has(Number(record.conversationId));
  const input = commit.submissions.find((record) => record.type === "input" && own(record));
  // A run record the kernel writes: a call, a message, a takeover's note or the loop's end. A run taken over, or stopped,
  // before its first call or message has no other record yet (a stop waiting when the loop could not open writes its end
  // first), and neither is root set-up to fold into the snapshot.
  const kernelEntry = commit.entries.find((entry) => own(entry) && (entry.kind === KINDS.callStart || entry.kind === KINDS.callEnd || entry.kind === KINDS.message || entry.kind === RUN_RESUMED || entry.kind === KINDS.end));
  state.root ??= input ? Number(input.conversationId) : kernelEntry ? Number(kernelEntry.conversationId) : undefined;
  const mine = <T extends { conversationId?: unknown }>(record: T) => own(record) && state.root !== undefined && Number(record.conversationId) === state.root;

  // Documents: each conversation's newest value of each kind this commit wrote.
  const docsBefore = new Map([...["pi.inbox", "pi.agent", "pi.usage"]].map((kind) => [kind, doc(state, kind)]));
  for (const document of commit.documents) {
    if (document.conversationId === undefined) continue;
    const of = state.docs.get(Number(document.conversationId)) ?? new Map<string, JsonValue | undefined>();
    of.set(document.kind, document.retired ? undefined : (document.value as JsonValue));
    state.docs.set(Number(document.conversationId), of);
  }
  const entries = commit.entries.filter(mine);
  const tasks = commit.tasks.filter(mine);
  const submissions = commit.submissions.filter(mine);
  // The end-of-run turn's input placed in this commit: its messages from there on are the turn's.
  state.reflectFrom ??= reflectFrom(submissions);
  const tag = (entry: EntryRecord) => (state.reflectFrom !== undefined && Number(entry.id) >= state.reflectFrom ? { agent_label: REFLECT_LABEL } : {});
  for (const entry of entries) {
    const message = modelOf(entry);
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
        if (block.type === "toolCall" && block.id) state.calls.set(block.id, { name: block.name ?? "", ...(block.arguments !== undefined ? { args: block.arguments } : {}) });
      }
    }
    if (entry.kind === KINDS.callStart) {
      const start = dataOf<CallStartData>(entry);
      state.calls.set(start.callId, { name: start.tool, args: start.input });
    }
  }

  const begins = !state.started && (input !== undefined || kernelEntry !== undefined);
  if (!state.started && !begins) {
    // The root's set-up, before the run: into the snapshot, no events.
    state.entries.push(...entries.filter((entry) => !KERNEL.has(entry.kind)));
    for (const task of tasks) state.tasks.set(Number(task.id), task);
    for (const record of submissions) state.submissions.set(Number(record.id), record);
    return [];
  }
  state.started = true;

  const events: LiveEvent[] = [];
  const callName = (callId: string) => state.calls.get(callId)?.name ?? "";
  const startCall = (callId: string) => {
    if (state.started_calls.has(callId)) return;
    state.started_calls.add(callId);
    const call = state.calls.get(callId);
    events.push({ type: "tool_execution_start", toolCallId: callId, toolName: callName(callId), ...(call?.args !== undefined ? { args: call.args } : {}) });
  };
  // A call that never ran (blocked, denied, never offered) ends with no start, as the door's stream says it.
  const endCall = (callId: string, entry?: EntryRecord) => {
    if (state.ended_calls.has(callId)) return;
    state.ended_calls.add(callId);
    events.push({ type: "tool_execution_end", toolCallId: callId, toolName: callName(callId), ...(entry ? { entry } : {}) });
  };
  const toolCallId = (task: Task) => String((task.input as { callId?: unknown } | undefined)?.callId ?? "");

  // Calls running now: pi's tool tasks whose intent this commit stored (the execute checkpoint pi writes before it runs
  // the tool). A task merely started is not a call that runs: the gate may still block it, and it never runs.
  for (const task of tasks) {
    if (task.kind !== PI_TOOL) continue;
    const taskState = task.state as { status?: string; checkpoint?: { phase?: string } };
    if (taskState.status === "running" && taskState.checkpoint?.phase === "execute") startCall(toolCallId(task));
  }

  // Entries in order, each call's end before the message that carries its result.
  for (const entry of entries) {
    if (entry.kind === KINDS.callStart) {
      startCall(dataOf<CallStartData>(entry).callId);
      continue;
    }
    if (entry.kind === KINDS.callEnd) {
      endCall(dataOf<CallEndData>(entry).callId);
      continue;
    }
    if (entry.kind === KINDS.message) {
      const said = dataOf<MessageData>(entry);
      const message = { role: ROLE[said.role] ?? "user", content: said.role === "model" ? [{ type: "text", text: said.text }] : said.text, ...(typeof said.at === "number" ? { timestamp: said.at } : {}) };
      const synthetic = { ...entry, model: [message] } as unknown as EntryRecord;
      state.entries.push(synthetic);
      events.push({ type: "message_start", message, ...tag(entry) }, { type: "message_end", entry: synthetic, ...tag(entry) });
      continue;
    }
    if (entry.kind === KINDS.end) {
      // A person's stop (the only stop a loop ends a run on: a lost claim or a shutdown writes no end): one phase row,
      // worded the same on every harness, from the loop's own end entry.
      if (dataOf<EndData>(entry).state === "stopped") {
        const stopped = { ...entry, kind: HOST_PHASE, data: { summary: STOPPED_BY_YOU } } as unknown as EntryRecord;
        state.entries.push(stopped);
        events.push({ type: "entry_appended", entry: stopped });
      }
      continue;
    }
    if (KERNEL.has(entry.kind)) continue;
    const shown = shownResult(entry);
    state.entries.push(shown);
    const message = modelOf(shown);
    if (message === undefined) {
      events.push({ type: "entry_appended", entry: shown });
      continue;
    }
    if (message.role === "toolResult" && message.toolCallId) endCall(message.toolCallId, shown);
    const streamed = message.role === "assistant" && state.partial;
    if (message.role === "assistant") state.partial = false;
    if (!streamed) events.push({ type: "message_start", message, ...tag(entry) });
    events.push({ type: "message_end", entry: shown, ...tag(entry) });
  }

  // Calls that ended without a result entry (aborted, cut off): their end.
  for (const task of tasks) {
    if (task.kind !== PI_TOOL || (task.state as { status?: string }).status !== "terminal") continue;
    endCall(toolCallId(task));
  }

  // Turns that ended, and the tasks that failed.
  let turnEnded = false;
  for (const task of tasks) {
    const taskState = task.state as { status?: string; outcome?: { status?: string; error?: { message?: string }; reason?: string } };
    const id = Number(task.id);
    if (task.kind === PI_GENERATION && (taskState.status === "completing" || taskState.status === "terminal") && !state.turnsEnded.has(id)) {
      state.turnsEnded.add(id);
      turnEnded = true;
    }
    const outcome = taskState.outcome;
    if (taskState.status === "terminal" && (outcome?.status === "faulted" || outcome?.status === "orphaned")) {
      events.push({ type: "task_failed", taskId: id, kind: task.kind, message: outcome.status === "faulted" ? outcome.error?.message : outcome.reason });
    }
  }
  if (turnEnded) events.push({ type: "turn_end" });

  // The run's end: its inputs settled.
  const settling: InputSubmission[] = [];
  for (const record of submissions) {
    const settled = record.status === "done" || record.status === "unanswered";
    if (record.type === "input" && settled && state.run?.inputs.includes(Number(record.id))) settling.push(record as InputSubmission);
  }
  if (state.run && settling.length > 0 && state.run.inputs.every((id) => settling.some((record) => Number(record.id) === id) || isSettled(state.submissions.get(id)))) {
    events.push({ type: "run_end", inputs: state.run.inputs });
    state.run = undefined;
  }

  // Submissions this commit wrote, each in the state it wrote.
  const placed: InputSubmission[] = [];
  for (const record of [...submissions].sort((a, b) => Number(a.id) - Number(b.id))) {
    const before = state.submissions.get(Number(record.id));
    events.push({ type: "submission", record });
    state.submissions.set(Number(record.id), record);
    if (record.type === "input" && before === undefined) placed.push(record as InputSubmission);
  }

  // The documents that keep no history: only their own changes.
  const inbox = doc(state, "pi.inbox");
  if (inbox !== docsBefore.get("pi.inbox")) events.push({ type: "inbox_update", items: ((inbox as { items?: { id: number; mode: string }[] } | undefined)?.items ?? []).map((item) => ({ id: item.id, mode: item.mode })) });
  const agent = doc(state, "pi.agent");
  if (agent !== docsBefore.get("pi.agent")) events.push({ type: "agent_changed", agent: agent ?? AgentDoc.definition.initial() });
  const usage = doc(state, "pi.usage");
  if (usage !== docsBefore.get("pi.usage")) events.push({ type: "usage_changed", usage: usage ?? UsageDoc.definition.initial() });

  // The run's start, with the inputs placed in it, then its first turn; a later turn's start.
  if (!state.run && placed.length > 0) {
    state.run = { inputs: placed.map((record) => Number(record.id)) };
    events.push({ type: "run_start", inputs: state.run.inputs });
  }
  for (const task of tasks) {
    const id = Number(task.id);
    if (task.kind !== PI_GENERATION || state.turns.has(id)) continue;
    state.turns.add(id);
    events.push({ type: "turn_start" });
  }
  for (const task of tasks) state.tasks.set(Number(task.id), task);
  return events;
}

const isSettled = (record: SubmissionRecord | undefined) => record !== undefined && (record.status === "done" || record.status === "unanswered");
