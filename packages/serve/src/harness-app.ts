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
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type Cursor, ROOT_CONVERSATION_ID, ToolResultEntry, type Tx, UserEntry } from "@earendil-works/pi-durable";
import { type AdapterEvent, type AdapterSession, type AgentAdapter, type ModelPortEvent, type ModelUsage, modelPortFor, RUNNER_RECORDS, type SessionSpec } from "@parcha/agentrun-adapters";
import type { DoorContext, DoorEvent, DoorHook, DurableRun } from "@parcha/pi-durable-disk";
import { durableSessions } from "./sessions.js";

/** The root's marker of a paid request already written as a pi.assistant entry. */
export const BOOKED = "adapter.request";

type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type Pending = { request: number; usage: ModelUsage };

const now = () => Date.now();
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join("") : "";

/** One request as pi's own assistant message: its content, and its usage with the cost when it is known. */
function assistantMessage(harness: string, request: Pending | undefined, text: string, calls: ToolCall[]) {
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

/** The door and the open of a run whose session is `spec` on `adapter`. `budgetUsd`: the run's spend cap. */
export function adapterRun(adapter: AgentAdapter, spec: SessionSpec, context: Context, budgetUsd?: number): AdapterRun {
  let run: DurableRun | undefined;
  let session: AdapterSession | undefined;
  let opened: Promise<void> | undefined;
  let openedDone: () => void = () => {};
  opened = new Promise((resolve) => (openedDone = resolve));
  let turn: Promise<void> | undefined;
  let emit: ((event: DoorEvent) => void) | undefined;
  const queue: string[] = [];
  const stop = new AbortController();
  // The current request's content, and the requests whose cost is in but whose entry is not written yet.
  let text = "";
  let calls: ToolCall[] = [];
  const costed: Pending[] = [];
  const written = new Set<number>();
  // Writes in order, one at a time: the entries keep the order their events came in.
  let writing = Promise.resolve();
  const later = (work: () => Promise<void>) => (writing = writing.then(work, work));

  const commit = <T>(change: (tx: Tx) => Promise<T>) => run!.harness.commit(change, context);

  /** Writes what the current request has: its entry with the content so far and the oldest cost not yet written.
   *  Content with no cost yet waits for one, but at a turn's end (`final`) it is written as a request of unknown cost. */
  const flush = (final = false): Promise<void> =>
    later(async () => {
      if (!text && !calls.length && !costed.length) return;
      if (!costed.length && !final) return;
      const request = costed.shift();
      const content = { text, calls };
      text = "";
      calls = [];
      if (request && written.has(request.request)) return;
      await commit(async (tx) => {
        await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [assistantMessage(adapter.id, request, content.text, content.calls) as never] });
        if (request) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BOOKED, data: { key: spec.key, request: request.request } });
      });
      if (request) written.add(request.request);
      // More costs than content: each later one still gets its own entry, cost only.
      while (costed.length) {
        const next = costed.shift()!;
        if (written.has(next.request)) continue;
        await commit(async (tx) => {
          await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [assistantMessage(adapter.id, next, "", []) as never] });
          await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BOOKED, data: { key: spec.key, request: next.request } });
        });
        written.add(next.request);
      }
    });

  const onModel = (event: ModelPortEvent) => {
    if (event.type === "request_start") void flush();
    else costed.push({ request: event.turn, usage: event.usage });
  };

  const onEvent = (event: AdapterEvent) => {
    if (event.type === "text") text += event.delta;
    else if (event.type === "tool_start") calls.push({ type: "toolCall", id: event.callId, name: event.name, arguments: (event.args ?? {}) as Record<string, unknown> });
    else if (event.type === "tool_end") {
      void flush();
      later(() =>
        commit(async (tx) => {
          await tx.appendEntry(ToolResultEntry, ROOT_CONVERSATION_ID, {
            model: [{ role: "toolResult", toolCallId: event.callId, toolName: event.name, content: [{ type: "text", text: event.isError ? "The tool failed." : "Done." }], isError: event.isError, timestamp: now() } as never],
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
      const data = (record.data ?? {}) as { turn?: number; usd?: number | null; cut?: boolean };
      if (record.kind === RUNNER_RECORDS.request) admitted = typeof data.turn === "number" ? data.turn : admitted + 1;
      else if (record.kind === RUNNER_RECORDS.turn) {
        const request = typeof data.turn === "number" ? data.turn : admitted;
        out.set(request, { input: 0, output: 0, usd: typeof data.usd === "number" ? data.usd : null, estimated: data.usd === null || data.cut === true });
      }
    }
    return out;
  };

  /** The person's message: its entry on the root, then the session's new turn. */
  const sendOf = (content: string) => async () => {
    await commit(async (tx) => void (await tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, { model: [{ role: "user", content: [{ type: "text", text: content }], timestamp: now() } as never] })));
    await session!.send(content);
  };

  /** Turns until nothing waits: each with its start and end on the door, then the next waiting message. Busy throughout,
   *  so a message that arrives meanwhile waits its place. */
  const runTurns = (first: () => Promise<void>) => {
    turn = (async () => {
      for (let start: (() => Promise<void>) | undefined = first; start; ) {
        emit?.({ type: "run_start" });
        try {
          await start();
          await session!.turnEnd();
        } catch {
          // The turn's end is in the session's records; the door's run_end follows either way.
        } finally {
          await flush(true);
          await writing;
          emit?.({ type: "run_end" });
        }
        const next = queue.shift();
        start = next === undefined ? undefined : sendOf(next);
      }
      turn = undefined;
    })();
  };

  const door: DoorHook = {
    async submit(input, ctx: DoorContext) {
      emit = ctx.emit;
      await opened;
      const content = textOf(input.content);
      if (turn) {
        if (input.whenBusy === "reject") return { accepted: false, reason: "busy" };
        queue.push(content);
        return { accepted: true };
      }
      runTurns(sendOf(content));
      return { accepted: true };
    },
    async abort(ctx: DoorContext) {
      emit = ctx.emit;
      queue.length = 0;
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
      // The requests already written on the root, from any earlier process.
      const root = await durable.harness.conversation(ROOT_CONVERSATION_ID, context);
      for (let cursor: Cursor | undefined; root; ) {
        const page = await root.entries({ order: "ascending" }, 500, cursor, context);
        for (const entry of page.items) {
          const data = entry.data as { key?: unknown; request?: unknown } | undefined;
          if (entry.kind === BOOKED && data?.key === spec.key && typeof data.request === "number") written.add(data.request);
        }
        if (page.next === undefined) break;
        cursor = page.next;
      }
      const writer = await sessions.open(spec.key);
      const booking = await modelPortFor(writer, { key: spec.key, ...(budgetUsd !== undefined ? { budgetUsd } : {}), onEvent: onModel });
      // A request a crash cut off is booked once, unknown, before anything is sent.
      await booking.bookCut();
      // Each request the session booked and the root has no entry for: its cost, with no content.
      for (const [request, usage] of await bookedInSession(await writer.read())) if (!written.has(request)) costed.push({ request, usage });
      await flush();
      session = await adapter.open(spec, { writer, models: booking.models, signal: stop.signal, onEvent });
      openedDone();
      if (session.state === "open_turn") runTurns(() => session!.recover());
    },
  };
}
