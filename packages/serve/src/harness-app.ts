// A run on a harness other than pi. The run's process holds one AdapterSession of that harness, durable in the run's own
// store (durableSessions), behind the door hook of pi-durable-disk: the person's message goes to the session's `send`,
// and a message that arrives while a turn runs is sent when it ends, in order. A stop interrupts the turn.
//
// Money has one path. The runner's booking (modelPortFor) records every paid request in the session as the runner does
// for a workflow node; each request then becomes one pi.assistant entry on the root conversation, with its text, its tool
// calls and its cost, beside a marker of the request (session key, request number), so it is written once whatever
// happens. pi's timeline counts a request per pi.assistant entry and sums their cost, and serve's costOf reads that row,
// as for a pi run. A request's cost and its content arrive in either order (a harness may stream before its usage is
// reported), so an entry is written at the next boundary that has both: the next request, a tool's end, the turn's end.
// A request the session booked but the root has no entry for (the process died before the boundary) gets one at the
// next open, with its cost and no content.
//
// A message the door accepts is on the root before the door says so, and its end (sent to the session, or dropped by a
// stop) after: one that waited for a turn's end when the process died is sent at the next open. Its end is written once
// the session has it, so a process that dies between the two sends it again rather than never.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type Cursor, ROOT_CONVERSATION_ID, ToolResultEntry, type Tx, UserEntry } from "@earendil-works/pi-durable";
import { type AdapterEvent, type AdapterSession, type AgentAdapter, type ModelPortEvent, type ModelUsage, modelPortFor, RUNNER_RECORDS, type SessionSpec } from "@parcha/agentrun-adapters";
import type { DoorContext, DoorEvent, DoorHook, DurableRun } from "@parcha/pi-durable-disk";
import { type ConfineChild, confineOf } from "./adapters.js";
import { fileTools, type ToolResults } from "./host-tools.js";
import type { CapGuard } from "./cap.js";
import { durableSessions } from "./sessions.js";
import { REQUEST_COST_LATE, REQUEST_COST_PENDING } from "@parcha/pi-durable-agent/timeline";

/** The root's marker of a paid request already written as a pi.assistant entry. */
export const BOOKED = "adapter.request";
/** The cost of a request whose answer was written at unknown cost, written once it came in: the timeline adds it to the
 *  run's cost without counting a request, and a later open reads it as that request's cost being in. */
export const PRICED_LATE = REQUEST_COST_LATE;
/** How long a turn's end waits for its requests' costs, booked once the proxy has answered the harness. */
export const BOOKING_WAIT_MS = 2_000;
/** The root's record of a message the door accepted, and of its end: `sent` to the session, or dropped by a stop. */
export const MESSAGE = "adapter.message";
export const MESSAGE_END = "adapter.message_end";

type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type Pending = { request: number; usage: ModelUsage };
/** An accepted message: `recorded` once its record is on the root. */
type Message = { id: string; content: string; recorded: Promise<unknown> };

const now = () => Date.now();
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join("") : "";

/** One request as pi's own assistant message: its content, and its usage with the cost when it is known. `error`: a
 *  turn that ended on an error, as pi's own reads (the cap's refusal is spend_cap_reached), at $0. */
function assistantMessage(harness: string, request: Pending | undefined, text: string, calls: ToolCall[], error?: string) {
  if (error !== undefined) {
    return { role: "assistant", content: [], api: "agentrun-adapter", provider: harness, model: harness, stopReason: "error", errorMessage: error, timestamp: now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }
  const usage = request?.usage;
  const known = usage !== undefined && usage.usd !== null && usage.usd !== undefined;
  return {
    role: "assistant",
    content: [...(text ? [{ type: "text", text }] : []), ...calls],
    api: "agentrun-adapter",
    provider: harness,
    model: harness,
    usage: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      totalTokens: (usage?.input ?? 0) + (usage?.output ?? 0),
      // No total when the price is unknown: the timeline's sum is then unknown, never this request at 0.
      cost: known ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage!.usd as number } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    stopReason: calls.length ? "toolUse" : "stop",
    timestamp: now(),
  };
}

export interface AdapterRun {
  readonly door: DoorHook;
  onOpen(run: DurableRun): Promise<void>;
}

/** The door and the open of a run whose session is `spec` on `adapter`, with the file tools `tools` names (built at the
 *  open, over the run's environment). `budgetUsd`: the run's spend cap. `cancelled`: whether the run was cancelled
 *  (request-start.ts `cancelledIn`): once it says so, no model request leaves, as on pi. */
export function adapterRun(
  make: (confine?: ConfineChild) => Promise<AgentAdapter>,
  harness: string,
  spec: Omit<SessionSpec, "tools">,
  context: Context,
  budgetUsd?: number,
  tools: readonly string[] = [],
  dir?: string,
  cap?: CapGuard,
  cancelled: () => boolean = () => false,
): AdapterRun {
  // The run's cap, or its cancel, refused a request: the turn ends on it, and its refusal is written as pi's is.
  let refused: string | undefined;
  const CANCELLED = "the run was cancelled: the model request was not sent";
  const guard = (request: { spentUsd: number | null; inFlight: readonly unknown[] }) => {
    const answer = cancelled() ? { refuse: CANCELLED } : cap?.beforeRequest(request);
    if (answer) refused = answer.refuse;
    return answer;
  };
  /** The cancel, as the booking's stop: read again after this check and after the request's record is written, so a
   *  cancel that lands between them still keeps the request from leaving. */
  const cancelStop = (): Error | undefined => {
    if (!cancelled()) return undefined;
    refused ??= CANCELLED;
    return new Error(CANCELLED);
  };
  // A paid request whose cost could not be written: the booking admits no request after it, and the turn stops on it.
  let halted: Error | undefined;
  const results: ToolResults = new Map();
  let run: DurableRun | undefined;
  let session: AdapterSession | undefined;
  let opened: Promise<void> | undefined;
  let openedDone: () => void = () => {};
  opened = new Promise((resolve) => (openedDone = resolve));
  let turn: Promise<void> | undefined;
  // The door's emit, from attach as the door opens: a recovered turn, started by no submit, reports through it too.
  let emit: ((event: DoorEvent) => void) | undefined;
  let attached = false;
  const queue: Message[] = [];
  const stop = new AbortController();
  // The current request's content, and the requests whose cost is in but whose entry is not written yet.
  let text = "";
  let calls: ToolCall[] = [];
  const costed: Pending[] = [];
  const written = new Set<number>();
  // Requests written at unknown cost (their cost not in when their turn ended), and those whose cost is written.
  const unpriced = new Set<number>();
  const priced = new Set<number>();
  // Requests admitted and not yet booked, by turn: the proxy answers the harness before it books a response, so a turn
  // can end with its last request's cost still on its way.
  const open = new Set<number>();
  let booked: () => void = () => {};
  /** Until every admitted request is booked, or `ms` pass. */
  const bookings = async (ms: number) => {
    for (const deadline = Date.now() + ms; open.size && Date.now() < deadline; ) {
      await new Promise<void>((resolve) => {
        booked = resolve;
        setTimeout(resolve, Math.max(0, deadline - Date.now())).unref();
      });
    }
  };
  // Writes in order, one at a time: the entries keep the order their events came in.
  let writing = Promise.resolve();
  const later = (work: () => Promise<void>) => (writing = writing.then(work, work));

  const commit = <T>(change: (tx: Tx) => Promise<T>) => run!.harness.commit(change, context);

  /** Writes what the current request has: its entry with the content so far and the oldest cost not yet written.
   *  Content with no cost yet waits for one, but at a turn's end (`final`) it is written as a request of unknown cost. */
  const flush = (final = false): Promise<void> =>
    later(async () => {
      // A cost for a request already written: one written at unknown cost (below) gets its cost now, as an entry of its
      // own, so the run's spend and its cap count it; any other is a duplicate.
      while (costed.length && written.has(costed[0]!.request)) {
        const late = costed.shift()!;
        if (!unpriced.has(late.request) || priced.has(late.request)) continue;
        await commit(async (tx) => {
          await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: PRICED_LATE, data: { key: spec.key, request: late.request, usd: late.usage.usd ?? null } });
        });
        priced.add(late.request);
      }
      if (!text && !calls.length && !costed.length) return;
      if (!costed.length && !final) return;
      const request = costed.shift();
      const content = { text, calls };
      text = "";
      calls = [];
      // At a turn's end with no cost in: the request still unbooked is the one this content answers. It is written at
      // unknown cost and marked booked, so a later open never writes it again.
      const unbooked = !request && final && open.size ? Math.min(...open) : undefined;
      if (unbooked !== undefined) open.delete(unbooked);
      const marked = request?.request ?? unbooked;
      await commit(async (tx) => {
        await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [assistantMessage(harness, request, content.text, content.calls) as never] });
        // Its cost still to come: the timeline reads it pending, not a cost no one will ever know.
        if (unbooked !== undefined) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: REQUEST_COST_PENDING, data: { key: spec.key, request: unbooked } });
        if (marked !== undefined) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BOOKED, data: { key: spec.key, request: marked, ...(request ? {} : { unpriced: true }) } });
      });
      if (marked !== undefined) written.add(marked);
      if (request) priced.add(request.request);
      else if (marked !== undefined) unpriced.add(marked);
      // More costs than content: each later one still gets its own entry, cost only.
      while (costed.length) {
        const next = costed.shift()!;
        if (written.has(next.request)) continue;
        await commit(async (tx) => {
          await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [assistantMessage(harness, next, "", []) as never] });
          await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BOOKED, data: { key: spec.key, request: next.request } });
        });
        written.add(next.request);
        priced.add(next.request);
      }
    });

  const onModel = (event: ModelPortEvent) => {
    if (event.type === "request_start") {
      open.add(event.turn);
      void flush();
    } else {
      open.delete(event.turn);
      costed.push({ request: event.turn, usage: event.usage });
      booked();
      // A cost that came in after its answer was written goes in now, not at some later flush. If that write fails, the
      // next open writes it from the session's booking, once.
      if (written.has(event.turn)) flush().catch(() => undefined);
    }
  };

  const onEvent = (event: AdapterEvent) => {
    if (event.type === "text") text += event.delta;
    else if (event.type === "tool_start") calls.push({ type: "toolCall", id: event.callId, name: event.name, arguments: (event.args ?? {}) as Record<string, unknown> });
    else if (event.type === "tool_end") {
      void flush();
      later(() =>
        commit(async (tx) => {
          await tx.appendEntry(ToolResultEntry, ROOT_CONVERSATION_ID, {
            model: [{ role: "toolResult", toolCallId: event.callId, toolName: event.name, content: [{ type: "text", text: results.get(event.callId)?.text ?? (event.isError ? "The tool failed." : "Done.") }], isError: event.isError, timestamp: now() } as never],
            data: { diagnostics: [] },
          });
        }).then(() => undefined),
      );
    }
  };

  /** The requests the session booked, from its runner records, by number. */
  const bookedInSession = async (records: readonly { kind: string; data: unknown }[]) => {
    const out = new Map<number, ModelUsage>();
    let admitted = 0;
    for (const record of records) {
      const data = (record.data ?? {}) as { turn?: number; usd?: number | null; cut?: boolean; unsent?: boolean };
      if (record.kind === RUNNER_RECORDS.request) admitted = typeof data.turn === "number" ? data.turn : admitted + 1;
      // A request withdrawn as its record was written (a stop came then) never left: it is no request of the run's.
      else if (record.kind === RUNNER_RECORDS.turn && data.unsent !== true) {
        const request = typeof data.turn === "number" ? data.turn : admitted;
        out.set(request, { input: 0, output: 0, usd: typeof data.usd === "number" ? data.usd : null, estimated: data.usd === null || data.cut === true });
      }
    }
    return out;
  };

  /** The person's message: the session's new turn, then its entry and its end on the root. */
  const sendOf = (message: Message) => async () => {
    await message.recorded;
    await session!.send(message.content);
    await later(() =>
      commit(async (tx) => {
        await tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, { model: [{ role: "user", content: [{ type: "text", text: message.content }], timestamp: now() } as never] });
        await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: MESSAGE_END, data: { key: spec.key, id: message.id, sent: true } });
      }).then(() => undefined),
    );
  };

  /** Turns until nothing waits: the turn, then each message that waited for it, as one busy period on the door (as a pi
   *  run's follow-ups are), so the server never reads the run idle, and done, while an accepted message is unanswered. A
   *  message that arrives meanwhile waits its place. */
  const runTurns = (first: () => Promise<void>) => {
    turn = (async () => {
      emit?.({ type: "run_start" });
      for (let start: (() => Promise<void>) | undefined = first; start; ) {
        let failed: string | undefined;
        try {
          await start();
          const end = await session!.turnEnd();
          if (end.status === "failed") failed = end.error ?? "the turn failed";
        } catch (error) {
          failed = String((error as Error)?.message ?? error);
        } finally {
          // The last request's cost, booked once the proxy has answered: waited for, so the answer is written with it.
          await bookings(BOOKING_WAIT_MS);
          await flush(true);
          await writing;
          // A turn that failed ends the run on its error, as a pi run's does: the cap's refusal, a cost the booking could
          // not write, or the harness's own failure.
          const why = refused ?? halted?.message ?? (failed === undefined ? undefined : `${harness}: ${failed}`);
          refused = undefined;
          if (why !== undefined) await commit(async (tx) => void (await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [assistantMessage(harness, undefined, "", [], why) as never] })));
        }
        const next = queue.shift();
        start = next === undefined ? undefined : sendOf(next);
      }
      turn = undefined;
      emit?.({ type: "run_end" });
    })();
  };

  const door: DoorHook = {
    attach(given) {
      emit = given;
      attached = true;
    },
    async submit(input, ctx: DoorContext) {
      if (!attached) emit = ctx.emit;
      await opened;
      if (turn && input.whenBusy === "reject") return { accepted: false, reason: "busy" };
      const id = randomUUID();
      const content = textOf(input.content);
      const message: Message = { id, content, recorded: commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: MESSAGE, data: { key: spec.key, id, content } }))) };
      if (turn) queue.push(message);
      else runTurns(sendOf(message));
      await message.recorded;
      return { accepted: true };
    },
    async abort(ctx: DoorContext) {
      if (!attached) emit = ctx.emit;
      const dropped = queue.splice(0);
      if (dropped.length) {
        await Promise.all(dropped.map((message) => message.recorded));
        await commit(async (tx) => {
          for (const message of dropped) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: MESSAGE_END, data: { key: spec.key, id: message.id, sent: false } });
        });
      }
      if (!turn) return "idle";
      await session?.interrupt();
      return "aborted";
    },
    busy: () => turn !== undefined,
  };

  return {
    door,
    async onOpen(durable) {
      run = durable;
      const sessions = durableSessions(durable.harness, context);
      // The requests already written on the root, and the messages accepted and never sent, from any earlier process.
      const root = await durable.harness.conversation(ROOT_CONVERSATION_ID, context);
      const accepted = new Map<string, Message>();
      for (let cursor: Cursor | undefined; root; ) {
        const page = await root.entries({ order: "ascending" }, 500, cursor, context);
        for (const entry of page.items) {
          const data = entry.data as { key?: unknown; request?: unknown; unpriced?: unknown; id?: unknown; content?: unknown } | undefined;
          if (data?.key !== spec.key) continue;
          if (entry.kind === BOOKED && typeof data.request === "number") {
            written.add(data.request);
            (data.unpriced === true ? unpriced : priced).add(data.request);
          } else if (entry.kind === PRICED_LATE && typeof data.request === "number") priced.add(data.request);
          else if (entry.kind === MESSAGE && typeof data.id === "string") accepted.set(data.id, { id: data.id, content: String(data.content ?? ""), recorded: Promise.resolve() });
          else if (entry.kind === MESSAGE_END && typeof data.id === "string") accepted.delete(data.id);
        }
        if (page.next === undefined) break;
        cursor = page.next;
      }
      // The prefix pi's commands start under in this run, from pi-durable-disk's own builder: the harness's process too.
      const env = (await durable.env({ conversationId: ROOT_CONVERSATION_ID, read: undefined as never }, context)) as unknown as { confinePrefix?(): string[] };
      if (typeof env.confinePrefix !== "function") throw new Error("the run's environment gives no confinement for the harness's process");
      const adapter = await make(confineOf(env.confinePrefix()));
      const writer = await sessions.open(spec.key);
      const booking = await modelPortFor(writer, {
        key: spec.key,
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        beforeRequest: guard as never,
        onEvent: onModel,
        stopped: () => halted ?? cancelStop(),
        stop: (reason, message) => {
          const error = new Error(message ?? reason);
          if (reason === "model_error" && !halted) {
            halted = error;
            void session?.interrupt();
          }
          return error;
        },
      });
      // A request a crash cut off is booked once, unknown, before anything is sent.
      await booking.bookCut();
      // Each request the session booked and the root has no entry for: its cost, with no content.
      // Each request the session booked and the root does not have, or has at unknown cost only: written now, once.
      for (const [request, usage] of await bookedInSession(await writer.read())) if (!written.has(request) || (unpriced.has(request) && !priced.has(request))) costed.push({ request, usage });
      await flush();
      session = await adapter.open({ ...spec, tools: fileTools(durable, tools, context, results) }, { writer, models: booking.models, signal: stop.signal, onEvent, ...(dir ? { dir } : {}) });
      queue.push(...accepted.values());
      openedDone();
      if (session.state === "open_turn") runTurns(() => session!.recover());
      else if (queue.length) runTurns(sendOf(queue.shift()!));
    },
  };
}
