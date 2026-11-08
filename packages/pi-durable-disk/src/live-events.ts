// One conversation's agent events, as the door's GET /events and a recording's live lines read them: the stream pi-durable
// 1.1 gave as `watchEvents` (its harness/events.js, spec §9.4), which pi 1.5 removed. This adapter rebuilds it on 1.5:
// the stored commits (Session.observeCommits) drive it, each translated from the conversation's state before and after
// it, as 1.1 translated each publication. Held branch pi/family-1.5 until P5 moves the readers to conversation.watch with
// ConversationTranscript and pi.live and deletes this (scripts/watch-events-p5.test.mjs lists the two callers).
//
// The snapshot: the conversation's documents (pi.live, pi.inbox, pi.agent, pi.usage) are each followed by a document
// observer (Session.observeDoc), attached atomically on the Session line: its value includes every commit before it and
// it hears every later one, synchronously as each is published, a microtask before the commit observers (pi-durable 1.5.0
// dist/session/session.js: followCommits listeners at :1083 and :1186-1236, observeCommits dispatch at :1109). So the
// snapshot's documents miss no commit that lands while it is taken. Its entries are the view a watch acquires
// (`Conversation.watch`), every entry; an entry the snapshot already holds is not appended again (by its ID).
// After the snapshot, the documents move in steps: each observer call (a stored commit's change, or a held one pi shows
// only to its own observers: a tool slot's `running` status, its output, a streaming partial, session.js #hold :920-955)
// is queued as a step, its value and operations, in the order pi made them. pi stores held changes later as one change
// per document at its latest value (#storeHolds :959), so the stored commits alone skip states the stream must show.
// Each stored commit, when observeCommits dispatches it, takes the steps queued so far (`upTo`); translated, it gives the
// events of each step in turn, its own entries, tasks and submissions with its last. Steps no commit takes (a held change
// with no stored commit yet) are translated a microtask later on their own, so the stream shows them as pi does.
// Steps queued before the snapshot was set are in it. A commit held before `start()` keeps its own steps, never the
// documents as they are later. In a group commit (two stored in one storage call, published back to back) the first
// commit's dispatch already finds the second's steps: their document events come out a little ahead of the second
// commit's entries; every event arrives, in step order. A document absent when the stream attaches has no observer:
// every change to it in a stored commit is applied.
import type { Context, JsonValue } from "@earendil-works/chord";
import { AgentDoc, InboxDoc, LiveDoc, UsageDoc } from "@earendil-works/pi-durable";
import type { CommitPublication, ConversationId, EntryRecord, Harness, JsonObject, Observation, SubmissionRecord, TaskRecord } from "@earendil-works/pi-durable";

type Op = readonly [string, ...unknown[]];
type Live = {
  run?: { taskId: number; inputs: number[] };
  generation?: { attempt: number; message?: { content: { type: string; text?: string; thinking?: string }[]; usage?: unknown }; retry?: { at: number; error: string }; deferred?: { pollAt: number } };
  tools?: { callId: string; name: string; status: string; taskId?: number; entry?: number; output?: string; details?: unknown; diagnostics?: unknown }[];
  compactions?: { taskId: number; reason: string; blocking?: boolean }[];
};
type State = { entries: EntryRecord[]; docs: Record<string, JsonObject | undefined> };
export type LiveEvent = { readonly type: string } & Record<string, unknown>;
export type LiveEnd = { readonly reason: "stopped" | "aborted" | "ended" | "failed" };
export type LiveEvents = {
  readonly snapshot: LiveEvent;
  start(listener: (events: LiveEvent[], context: Context) => Promise<void>): void;
  stop(): Promise<LiveEnd>;
  readonly closed: Promise<LiveEnd>;
};

// The documents the translation reads, exactly 1.1's set, each with the token its observer follows. A kind the
// translation reads later is added here, so it is followed too: a document read but not followed can miss a change
// made while the snapshot is acquired. Order (pi-durable 1.5.0 dist/session/session.js): document observers are
// Session.followCommits listeners, run synchronously at publication (:1083), while observeCommits observers are
// dispatched a microtask later (#notifyHosts, :1109).
const FOLLOWED = { "pi.live": LiveDoc, "pi.inbox": InboxDoc, "pi.agent": AgentDoc, "pi.usage": UsageDoc } as const;
const DOCS = Object.keys(FOLLOWED) as (keyof typeof FOLLOWED)[];
const live = (state: State): Live => (state.docs["pi.live"] ?? {}) as unknown as Live;
const queued = (inbox: JsonObject | undefined) => ((inbox?.items ?? []) as { id: number; mode: string }[]).map((item) => ({ id: item.id, mode: item.mode }));

function snapshotOf(state: State): LiveEvent {
  const now = live(state);
  return {
    type: "snapshot",
    entries: state.entries,
    ...(now.run === undefined ? {} : { run: { inputs: now.run.inputs } }),
    ...(now.generation === undefined ? {} : { generation: now.generation }),
    tools: now.tools ?? [],
    compactions: now.compactions ?? [],
    inbox: queued(state.docs["pi.inbox"]),
    agent: state.docs["pi.agent"] ?? AgentDoc.definition.initial(),
    usage: state.docs["pi.usage"] ?? UsageDoc.definition.initial(),
  };
}

/** Attach to one conversation's agent events. `context` governs the stream's lifetime, as a watch's does. */
export async function watchEvents(harness: Harness, conversationId: ConversationId, context: Context): Promise<LiveEvents> {
  const conversation = await harness.conversation(conversationId, context);
  if (!conversation) throw new Error(`conversation ${conversationId} does not exist`);
  let ended: LiveEnd | undefined;
  let endIt!: (end: LiveEnd) => void;
  const closed = new Promise<LiveEnd>((resolve) => (endIt = (end) => { if (!ended) { ended = end; resolve(end); } }));
  // Held until the snapshot is taken, then until a listener starts; each translated in order, one delivery at a time. A
  // commit published before the snapshot was taken is marked not fresh.
  const held: { publication: CommitPublication; fresh: boolean; upTo: number }[] = [];
  let listener: ((events: LiveEvent[], context: Context) => Promise<void>) | undefined;
  let state: State | undefined;
  let snapshotNewest = -1;
  const completing = new Set<number>();
  let delivering = Promise.resolve();
  // Each followed document's newest value, as its observer heard it: the snapshot's documents.
  const docs: Followed = { now: {}, observed: new Set() };
  // The document steps not yet translated, and how many were ever queued (`queued`) and taken (`taken`): a step's place
  // is absolute, so a commit's `upTo` stays right as the queue is drained.
  const steps: Step[] = [];
  let queuedSteps = 0;
  let takenSteps = 0;
  const take = (upTo: number): Step[] => {
    const taken = steps.splice(0, Math.max(0, upTo - takenSteps));
    takenSteps = Math.max(takenSteps, upTo);
    return taken;
  };
  const deliver = (events: LiveEvent[]) => {
    if (!events.length || !listener) return;
    const to = listener;
    delivering = delivering.then(() => (ended ? undefined : to(events, context))).catch((error) => {
      detachAll();
      endIt({ reason: "failed" });
      void error;
    });
  };
  const flush = () => {
    if (!state || !listener || ended) return;
    while (held.length) {
      const { publication, fresh, upTo } = held.shift()!;
      deliver(translate(conversationId, publication, state, completing, snapshotNewest, fresh, docs, take(upTo)));
    }
  };
  // Steps no stored commit took: held changes pi has shown and not stored yet. A stored commit's own steps are taken by
  // its dispatch first: observeCommits queues it before the observers that queue its steps run (session.js :1079, :1083).
  let pending = false;
  const flushSteps = () => {
    pending = false;
    if (!state || !listener || ended || held.length || queuedSteps === takenSteps) return;
    deliver(translate(conversationId, NO_CHANGES, state, completing, snapshotNewest, true, docs, take(queuedSteps)));
  };
  const observation = harness.observeCommits({
    // Never throws out to pi (a throw would detach it for good): a commit it cannot translate ends the stream, failed.
    advance: (publication) => {
      try {
        held.push({ publication, fresh: state !== undefined, upTo: queuedSteps });
        flush();
      } catch {
        endIt({ reason: "failed" });
      }
    },
    // A close of the Session is pi's `failed` "session closed"; the door ends its stream either way.
    end: (end) => endIt({ reason: end.kind === "failed" || end.kind === "listener_error" ? "failed" : "ended" }),
  });
  const followed: Observation<unknown>[] = [];
  const detachAll = () => {
    observation.detach();
    for (const each of followed) each.detach();
  };
  try {
    for (const kind of DOCS) {
      const token = FOLLOWED[kind];
      const attached = await harness.observeDoc(token as never, conversationId, {
        // pi 1.5 detaches a document observer whose advance throws, for good, and the stream would go on with this
        // document stale, silently: a change it cannot follow ends the stream failed instead, as a commit's does.
        advance: (call: { kind: string; value?: JsonObject; ops?: readonly Op[]; retired?: boolean }) => {
          try {
            if (call.kind !== "value") return;
            const value = call.retired ? undefined : call.value;
            docs.now[kind] = value;
            steps.push({ kind, value, ops: call.retired ? [] : call.ops ?? [] });
            queuedSteps += 1;
            if (!pending) {
              pending = true;
              queueMicrotask(() => {
                try {
                  flushSteps();
                } catch {
                  detachAll();
                  endIt({ reason: "failed" });
                }
              });
            }
          } catch {
            detachAll();
            endIt({ reason: "failed" });
          }
        },
        end: () => undefined,
      } as never, context) as Observation<JsonObject> | undefined;
      if (attached) {
        followed.push(attached);
        docs.observed.add(kind);
        docs.now[kind] = attached.value;
      }
    }
    const watch = await conversation.watch(context, { min: 1_000_000 });
    const view = watch.value;
    await watch.stop();
    // The followed documents as they are now (every commit so far); one absent at the attachment, as the view has it.
    state = { entries: [...view.entries], docs: Object.fromEntries(DOCS.map((kind) => [kind, docs.observed.has(kind) ? docs.now[kind] : view.docs[kind]])) };
    // Every step queued so far is in the snapshot's documents.
    take(queuedSteps);
    snapshotNewest = view.entries.reduce((max, entry) => Math.max(max, Number(entry.id)), -1);
    for (const record of await scanCompleting(harness, conversationId, context)) completing.add(Number(record.id));
  } catch (error) {
    detachAll();
    throw error;
  }
  const signal = context.abortSignal;
  const abort = () => { detachAll(); endIt({ reason: "aborted" }); };
  if (signal?.aborted) {
    abort();
    throw signal.reason;
  }
  signal?.addEventListener("abort", abort, { once: true });
  return {
    snapshot: snapshotOf(state),
    start: (given) => {
      listener = given;
      flush();
      // Held changes shown before the start, which no stored commit has taken yet.
      flushSteps();
    },
    stop: async () => {
      detachAll();
      endIt({ reason: "stopped" });
      await delivering;
      return ended!;
    },
    closed,
  };
}

/** Generations whose held outcome already ended their turn. */
async function scanCompleting(harness: Harness, conversationId: ConversationId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]> {
  return harness.commit(async (tx) => {
    const out: TaskRecord<JsonValue, JsonValue, JsonValue>[] = [];
    let cursor: Awaited<ReturnType<typeof tx.scanTasks>>["next"];
    do {
      const page = await tx.scanTasks({ conversationId, kind: "pi.generation", status: "completing" }, 100, cursor);
      out.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return out;
  }, context);
}

/** Every event one stored commit causes for the conversation, in the order of spec §9.4; `state` moves to after it. A
 *  commit held while the snapshot was taken (`fresh` false) appends no entry the snapshot holds and leaves its documents. */
/** The followed documents: each one's newest value from its observer (the snapshot's), and which kinds have one. */
type Followed = { now: Record<string, JsonObject | undefined>; observed: Set<string> };
/** One change of a followed document, as its observer heard it: its value (undefined once retired) and operations. */
type Step = { kind: string; value: JsonObject | undefined; ops: readonly Op[] };
const NO_CHANGES = { seq: 0, changes: [] } as unknown as CommitPublication;

/** A commit and the document steps it took: the events of each step in turn, the commit's own changes with its last. */
function translate(conversationId: ConversationId, publication: CommitPublication, state: State, completing: Set<number>, snapshotNewest: number, fresh: boolean, followed: Followed, steps: readonly Step[]): LiveEvent[] {
  if (steps.length <= 1) return translateOne(conversationId, publication, state, completing, snapshotNewest, fresh, followed, steps[0]);
  const events: LiveEvent[] = [];
  for (const [at, step] of steps.entries()) events.push(...translateOne(conversationId, at === steps.length - 1 ? publication : NO_CHANGES, state, completing, snapshotNewest, fresh, followed, step));
  return events;
}

function translateOne(conversationId: ConversationId, publication: CommitPublication, state: State, completing: Set<number>, snapshotNewest: number, fresh: boolean, followed: Followed, step: Step | undefined): LiveEvent[] {
  const entries: EntryRecord[] = [];
  const tasks = new Map<number, TaskRecord<JsonValue, JsonValue, JsonValue>>();
  const submissions: SubmissionRecord[] = [];
  const docOps: Op[] = [];
  const before: State = { entries: state.entries, docs: { ...state.docs } };
  for (const change of publication.changes) {
    if (change.type === "entry" && change.value.conversationId === conversationId && (fresh || Number(change.value.id) > snapshotNewest)) entries.push(change.value);
    else if (change.type === "task" && change.value.conversationId === conversationId) tasks.set(Number(change.value.id), change.value);
    else if (change.type === "submission" && change.value.conversationId === conversationId) submissions.push(change.value as SubmissionRecord);
    else if (change.type === "document" && change.conversationId === conversationId && (DOCS as readonly string[]).includes(change.record.kind) && change.record.key === undefined) {
      const kind = change.record.kind;
      // A followed document moves by its observer's steps, held changes included; only an unfollowed one by its commits.
      if (followed.observed.has(kind)) continue;
      if (change.kind === "change") {
        state.docs[kind] = change.value;
        if (kind === "pi.live") for (const op of change.ops as unknown as Op[]) docOps.push([op[0], ["docs", kind, ...((op[1] as unknown[]) ?? [])], ...op.slice(2)] as unknown as Op);
      } else state.docs[kind] = undefined;
    }
  }
  if (step) {
    state.docs[step.kind] = step.value;
    if (step.kind === "pi.live") for (const op of step.ops) docOps.push([op[0], ["docs", step.kind, ...((op[1] as unknown[]) ?? [])], ...op.slice(2)] as unknown as Op);
  }
  if (docOps.length === 0 && entries.length === 0 && tasks.size === 0 && submissions.length === 0 && !docsMoved(before, state)) return [];
  state.entries = entries.length ? [...state.entries, ...entries] : state.entries;
  submissions.sort((a, b) => Number(a.id) - Number(b.id));
  const was = live(before);
  const now = live(state);
  const events: LiveEvent[] = [];
  const slotsBefore = new Map((was.tools ?? []).map((slot) => [slot.callId, slot]));
  const slots = now.tools ?? [];
  for (const slot of slots) {
    if (slot.status !== "running" || slotsBefore.get(slot.callId)?.status === "running") continue;
    const checkpoint = slot.taskId === undefined ? undefined : (tasks.get(slot.taskId)?.state as { checkpoint?: { arguments?: unknown } } | undefined)?.checkpoint;
    events.push({ type: "tool_execution_start", toolCallId: slot.callId, toolName: slot.name, args: checkpoint?.arguments ?? {} });
  }
  const partialBefore = was.generation?.message;
  const partial = now.generation?.message;
  if (partial !== undefined && partialBefore === undefined) events.push({ type: "message_start", message: partial });
  else if (partial !== undefined && partial !== partialBefore) events.push({ type: "message_update", usage: partial.usage, changes: messageChanges(docOps, partial) });
  for (const [index, slot] of slots.entries()) {
    const previous = slotsBefore.get(slot.callId);
    if (slot.status !== "running" || previous?.status !== "running") continue;
    const update = toolUpdate(docOps, index, slot, previous);
    if (update) events.push({ type: "tool_execution_update", toolCallId: slot.callId, toolName: slot.name, ...update });
  }
  const generation = now.generation;
  const generationBefore = was.generation;
  if (generation?.retry !== undefined && generationBefore?.retry === undefined) events.push({ type: "auto_retry_start", attempt: generation.attempt, at: generation.retry.at, errorMessage: generation.retry.error });
  if (generationBefore?.retry !== undefined && generation?.retry === undefined) events.push({ type: "auto_retry_end", attempt: generationBefore.attempt });
  if (generation?.deferred !== undefined && generation.deferred.pollAt !== generationBefore?.deferred?.pollAt) events.push({ type: "deferred_poll", pollAt: generation.deferred.pollAt });
  const toolEnds: (LiveEvent & { entry?: EntryRecord })[] = [];
  const endTool = (callId: string, name: string, entryId: number | undefined) => {
    const entry = entries.find((candidate) => Number(candidate.id) === entryId);
    toolEnds.push({ type: "tool_execution_end", toolCallId: callId, toolName: name, ...(entry === undefined ? {} : { entry }) });
  };
  for (const previous of slotsBefore.values()) {
    if (previous.status === "done") continue;
    const slot = slots.find((candidate) => candidate.callId === previous.callId);
    if (slot?.status === "done") endTool(previous.callId, previous.name, slot.entry);
    else if (slot === undefined) endTool(previous.callId, previous.name, resultOf(entries, previous.callId)?.id as number | undefined);
  }
  for (const slot of slots) if (slot.status === "done" && !slotsBefore.has(slot.callId)) endTool(slot.callId, slot.name, slot.entry);
  let assistantAppended = false;
  for (const entry of entries) {
    events.push(...toolEnds.filter((end) => end.entry === entry));
    const message = (entry as { model?: { role?: string }[] }).model?.[0];
    if (message === undefined) {
      events.push({ type: "entry_appended", entry });
      continue;
    }
    const streamed = message.role === "assistant" && partialBefore !== undefined && !assistantAppended;
    if (message.role === "assistant") assistantAppended = true;
    if (!streamed) events.push({ type: "message_start", message });
    events.push({ type: "message_end", entry });
  }
  events.push(...toolEnds.filter((end) => end.entry === undefined));
  const compactionsBefore = was.compactions ?? [];
  const compactions = now.compactions ?? [];
  for (const { taskId, reason } of compactionsBefore) if (!compactions.some((status) => status.taskId === taskId)) events.push({ type: "compaction_end", taskId, reason });
  let turnEnded = false;
  for (const task of tasks.values()) {
    const taskState = task.state as { status: string; outcome?: { status: string; error?: { message: string }; reason?: string } };
    const id = Number(task.id);
    if (task.kind === "pi.generation" && taskState.status === "completing" && !completing.has(id)) {
      completing.add(id);
      turnEnded = true;
    }
    if (taskState.status !== "terminal") continue;
    if (task.kind === "pi.generation" && !completing.delete(id)) turnEnded = true;
    const outcome = taskState.outcome;
    if (outcome?.status === "faulted" || outcome?.status === "orphaned") events.push({ type: "task_failed", taskId: id, kind: task.kind, message: outcome.status === "faulted" ? outcome.error?.message : outcome.reason });
  }
  if (turnEnded) events.push({ type: "turn_end" });
  const run = now.run;
  const runBefore = was.run;
  const runChanged = run?.inputs[0] !== runBefore?.inputs[0];
  if (runBefore !== undefined && runChanged) events.push({ type: "run_end", inputs: runBefore.inputs });
  for (const record of submissions) events.push({ type: "submission", record });
  if (state.docs["pi.inbox"] !== before.docs["pi.inbox"]) events.push({ type: "inbox_update", items: queued(state.docs["pi.inbox"]) });
  if (state.docs["pi.agent"] !== before.docs["pi.agent"]) events.push({ type: "agent_changed", agent: state.docs["pi.agent"] ?? AgentDoc.definition.initial() });
  if (state.docs["pi.usage"] !== before.docs["pi.usage"]) events.push({ type: "usage_changed", usage: state.docs["pi.usage"] ?? UsageDoc.definition.initial() });
  for (const { taskId, reason, blocking } of compactions) if (!compactionsBefore.some((status) => status.taskId === taskId)) events.push({ type: "compaction_start", taskId, reason, blocking });
  if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs });
  if (run !== undefined && run.taskId !== runBefore?.taskId && tasks.get(run.taskId)?.kind === "pi.generation") events.push({ type: "turn_start" });
  return events;
}

const docsMoved = (before: State, after: State) => DOCS.some((kind) => before.docs[kind] !== after.docs[kind]);

/** The tool result for `callId` among `entries`. */
function resultOf(entries: readonly EntryRecord[], callId: string): EntryRecord | undefined {
  return entries.find((entry) => {
    const message = (entry as { model?: { role?: string; toolCallId?: string }[] }).model?.[0];
    return message?.role === "toolResult" && message.toolCallId === callId;
  });
}

const PARTIAL_PATH = ["docs", "pi.live", "generation", "message"];
const startsWith = (path: readonly unknown[], prefix: readonly unknown[]) => prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

/** The operations on the in-flight message as message changes (spec §9.4). */
function messageChanges(ops: readonly Op[], message: NonNullable<NonNullable<Live["generation"]>["message"]>): LiveEvent[] {
  const changes: LiveEvent[] = [];
  const whole = new Set<number>();
  for (const op of ops) {
    const path = op[1] as unknown[];
    if (!startsWith(path, PARTIAL_PATH)) {
      if (startsWith(PARTIAL_PATH, path)) return [{ type: "message", message }];
      continue;
    }
    const rest = path.slice(PARTIAL_PATH.length);
    if (rest[0] === "usage") continue;
    if (rest[0] !== "content") return [{ type: "message", message }];
    if (rest.length === 1) {
      if (op[0] !== "p" || op[3] !== 0) return [{ type: "message", message }];
      for (const [offset, block] of (op[4] as { type: string }[]).entries()) {
        const type = block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start";
        changes.push({ type, contentIndex: (op[2] as number) + offset, block });
      }
      continue;
    }
    const contentIndex = rest[1] as number;
    const field = rest[2];
    if (whole.has(contentIndex)) continue;
    if (op[0] === "a" && rest.length === 3 && (field === "text" || field === "thinking")) changes.push({ type: field === "text" ? "text_delta" : "thinking_delta", contentIndex, delta: op[2] });
    else if (op[0] === "a" && field === "arguments") changes.push({ type: "toolcall_delta", contentIndex, path: rest.slice(3), delta: op[2] });
    else {
      whole.add(contentIndex);
      changes.push({ type: "block", contentIndex, block: message.content[contentIndex] });
    }
  }
  return changes;
}

/** Output, details and diagnostics changes of a running slot, from the operations on it. */
function toolUpdate(ops: readonly Op[], index: number, slot: NonNullable<Live["tools"]>[number], previous: NonNullable<Live["tools"]>[number]): Record<string, unknown> | undefined {
  const outputPath = ["docs", "pi.live", "tools", index, "output"];
  let trimStart = 0;
  let append = "";
  let set = false;
  for (const op of ops) {
    if (!startsWith(op[1] as unknown[], outputPath)) continue;
    if (op[0] === "t") trimStart += op[2] as number;
    else if (op[0] === "a") append += op[2] as string;
    else set = true;
  }
  let output: Record<string, unknown> | undefined;
  if (set || (slot.output !== previous.output && trimStart === 0 && append === "")) output = { set: slot.output ?? "" };
  else if (trimStart > 0 || append !== "") output = { ...(trimStart > 0 ? { trimStart } : {}), ...(append === "" ? {} : { append }) };
  const update = {
    ...(output === undefined ? {} : { output }),
    ...(slot.details === previous.details ? {} : { details: slot.details ?? null }),
    ...(slot.diagnostics === previous.diagnostics ? {} : { diagnostics: slot.diagnostics ?? [] }),
  };
  return Object.keys(update).length === 0 ? undefined : update;
}
