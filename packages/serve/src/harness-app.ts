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
// A harness reports each call as it runs it, so an answer that asks for several tools is written at its first call's end;
// a later call of that answer is written then as its continuation (REQUEST_CONTINUED), before its result, never as part
// of the next request's entry.
// A request the session booked but the root has no entry for (the process died before the boundary) gets one at the
// next open, with its cost and no content.
//
// A paid host tool's charge (monid.run's) is written on the root by the tool (monid.ts), as a TOOL_COST the timeline
// adds to the run's cost. Under a cap it joins what the cap reads as spent: the session's booked requests, plus the
// charges written by earlier processes (read at the open) and this one's.
//
// A message the door accepts is on the root before the door says so, and its end (sent to the session, or dropped by a
// stop) after: one that waited for a turn's end when the process died is sent at the next open. Its end is written once
// the session has it, so a process that dies between the two sends it again rather than never.
//
// A host tool call the tool gate parks for a person's approval (tool-gate.ts) ends its turn: no model request leaves
// after it, and the turn is interrupted once its result is in, then settled as a stopped one is, its end interrupted.
// The answer's resume is a message of its own, sent as a person's is; a turn the park ended is not resumed at the next
// open while the call still waits.
import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type Cursor, type JsonObject, ROOT_CONVERSATION_ID, type ToolRegistration, ToolResultEntry, type Tx, UserEntry } from "@earendil-works/pi-durable";
import { type AdapterEvent, type AdapterSession, type AgentAdapter, type ModelPortEvent, type ModelUsage, modelPortFor, RUNNER_RECORDS, type SessionSpec, type TurnStatus } from "@parcha/agentrun-kernel";
import type { DoorContext, DoorEvent, DoorHook, DurableRun } from "@parcha/pi-durable-disk";
import { type ConfineChild, confineOf } from "./adapters.js";
import { hostTools, type ToolResults } from "./host-tools.js";
import { endsTurn, type Park, type ParkedCall, type Resume, type RunGate } from "./tool-gate.js";
import { CAP_REFUSAL_CODE, CAP_REFUSED_FIELD, type CapGuard, capToolSpend, holdsInFlight, type RefusalFigures, type RunSpend, takePaidRefusal, useSpend } from "./cap.js";
import { durableSessions } from "./sessions.js";
import { handsParallel, planeOf } from "./tool-plane.js";
import { parallelOf } from "./web-fetch.js";
import { WEB_SEARCH_TOOL } from "./web-search.js";
import { ADAPTER_API, MESSAGE, MESSAGE_END, TURN_END, type TurnEndData } from "./turn-end.js";
import { originOf, REQUEST_CONTINUED, REQUEST_COST_LATE, REQUEST_COST_PENDING, REQUEST_STARTED, TOOL_COST, TOOL_STARTED } from "@parcha/pi-durable-agent/timeline";

/** The root's marker of a paid request already written as a pi.assistant entry. */
export const BOOKED = "adapter.request";
/** The cost of a request whose answer was written at unknown cost, and its tokens, written once it came in: the timeline
 *  adds it to the run's cost without counting a request, and a later open reads it as that request's cost being in. */
export const PRICED_LATE = REQUEST_COST_LATE;
/** How long a turn's end waits for its requests' costs, booked once the proxy has answered the harness. */
export const BOOKING_WAIT_MS = 2_000;
/** The root's record of a message the door accepted, and of its end: `sent` to the session, or dropped by a stop. */
export { MESSAGE, MESSAGE_END } from "./turn-end.js";
/** A turn's end on the root (turn-end.ts): the message it took, the session's own outcome (`completed`, `interrupted`,
 *  `failed`) and the turn's answer, in the commit of the turn's last entries (its answer, its costs, any error). The only
 *  record that a turn which took the person's message is over: a request without content is written alike whether it
 *  ended the turn or not. */
export { TURN_END } from "./turn-end.js";

type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type Pending = { request: number; usage: ModelUsage };
/** An accepted message: `recorded` once its record is on the root. */
/** A message the session takes: the person's, or the server's (`origin`, written on its user entry for the Timeline). */
type Message = { id: string; content: string; origin?: JsonObject; recorded: Promise<unknown> };
/** The run's stop record as serve keeps it (serve.json, runs.ts stopTurn, saved before the stop's abort): the person's
 *  newest message when they stopped the turn, by its row id (`<conversation>:<entry>`), or, from an older server, how many
 *  messages they had sent then. */
export type StopRecord = { stopped_at?: string; stopped_after?: number };
/** A row id's place in the store: its entry's id. */
const placeOf = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1));

const now = () => Date.now();
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join("") : "";

/** A request's tokens as pi counts them (`input` excludes cached tokens), the `usage` a cost entry carries; undefined
 *  when it has no input or output count, or no token at all (a usage that was not read is zeros, never a count). */
function tokensOf(usage: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
  const [input, output] = [count(u.input), count(u.output)];
  if (input === undefined || output === undefined) return undefined;
  const tokens = { input, output, cacheRead: count(u.cacheRead) ?? 0, cacheWrite: count(u.cacheWrite) ?? 0 };
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0 ? tokens : undefined;
}

/** One request as pi's own assistant message: its content, the model it asked for (the harness's id when that is not
 *  known), and its usage with the cost when it is known. Tokens not known are 0, which pi's timeline reads as unknown.
 *  `error`: a turn that ended on an error, as pi's own reads (the cap's refusal is spend_cap_reached), at $0. */
function assistantMessage(harness: string, model: string | undefined, request: Pending | undefined, text: string, calls: ToolCall[], error?: string) {
  if (error !== undefined) {
    return { role: "assistant", content: [], api: ADAPTER_API, provider: harness, model: harness, stopReason: "error", errorMessage: error, timestamp: now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }
  const usage = request?.usage;
  const known = usage !== undefined && usage.usd !== null && usage.usd !== undefined;
  const tokens = { input: usage?.input ?? 0, output: usage?.output ?? 0, cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0 };
  return {
    role: "assistant",
    content: [...(text ? [{ type: "text", text }] : []), ...calls],
    api: ADAPTER_API,
    provider: harness,
    model: model ?? harness,
    usage: {
      ...tokens,
      totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
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

/** The door and the open of a run whose session is `spec` on `adapter`, with the host tools `tools` names (built at the
 *  open, over the run's environment; its coding tools from `coding`, the run's coding source, host-tools.ts).
 *  `budgetUsd`: the run's spend cap. `cancelled`: whether the run was cancelled (request-start.ts `cancelledIn`): once it
 *  says so, no model request leaves, as on pi. `cwd`: the run's workspace, the directory its file tools confine to, where
 *  the harness works too (the adapter's io.cwd), so a path the model builds from its working directory is one the tools
 *  take (in a box, coding-tools.ts names it at the box's work dir). `gate`: the run's tool gate, which each host tool
 *  call passes. */
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
  cwd?: string,
  coding?: readonly ToolRegistration[],
  stopRecord?: StopRecord,
  gate?: RunGate,
): AdapterRun {
  const plane = planeOf(process.env);
  // The web tools' Parallel key, when one resolves to Parallel, read as the run's app loads, before its process starts
  // one of its own (web-fetch.ts).
  if (handsParallel(plane)) parallelOf(process.env);
  // web_search resolved native is the harness's own search (adapters.ts turns it on, with its input allowance): no host
  // tool of the name.
  if (plane.web_search === "native") tools = tools.filter((name) => name !== WEB_SEARCH_TOOL);
  // The run's cap, or its cancel, refused a request: the turn ends on it, and its refusal is written as pi's is.
  let refused: string | undefined;
  // That `refused` is the cap's, not the cancel's: its error entry gets a start mark of its own first, as pi's does, so the
  // run's usage counts no request for it.
  let capRefused = false;
  // A refusal for room's figures, for its start mark (cap.ts RefusalFigures).
  let refusedFigures: RefusalFigures | undefined;
  const CANCELLED = "the run was cancelled: the model request was not sent";
  // What the run's paid tools charged, in earlier processes (read at the open) and this one: null once one is unknown.
  let charged: number | null = 0;
  // Each admitted request's worst case until its cost is booked: the booking's spend counts it only then.
  const inFlight = holdsInFlight();
  // The run's spend as a paid tool's check reads it (useSpend, set at the open): a paid call refused under it pauses the
  // run at this run's next request (guard).
  let spend: RunSpend | undefined;
  const plus = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
  const guard = (request: Parameters<CapGuard["beforeRequest"]>[0]) => {
    const byCancel = cancelled();
    // A paid call the cap just refused for room (cap.ts takePaidRefusal): this request is refused in its words, so the
    // turn ends there and the run waits on a raise, as at a model request's refusal. A refusal no cap fixes comes first.
    const paid = byCancel || !cap || request.spentUsd === null ? undefined : takePaidRefusal(spend);
    const answer = byCancel ? { refuse: CANCELLED } : paid ? { refuse: `${CAP_REFUSAL_CODE}${paid.words}`, spentUsd: paid.figures.spentUsd, needsUsd: paid.figures.needsUsd, leastCapUsd: paid.figures.leastCapUsd } : cap?.beforeRequest({ ...request, spentUsd: plus(request.spentUsd, charged) });
    if (answer && "refuse" in answer) {
      refused = answer.refuse;
      capRefused = !byCancel;
      refusedFigures = !byCancel && "needsUsd" in answer && typeof answer.needsUsd === "number" && typeof answer.spentUsd === "number" && typeof answer.leastCapUsd === "number" ? { spentUsd: answer.spentUsd, needsUsd: answer.needsUsd, leastCapUsd: answer.leastCapUsd } : undefined;
      return answer;
    }
    // Admitted, limited to the output what is left of the cap buys (which the runner hands the model proxy, and holds it
    // at): the worst case the cap holds for it, which the runner records, and counts it at if its cost never comes in.
    const limit = answer?.outputTokensMax;
    const admitted = { ...request, ...(limit === undefined ? {} : { outputTokensMax: limit }) };
    const hold = cap?.worstOf?.(admitted);
    inFlight.admitted(hold);
    if (hold === undefined && limit === undefined) return undefined;
    // Stopped part way by its client, it counts by what streamed (cap.ts stoppedOf), never more than its hold (the runner).
    const stoppedOf = cap?.stoppedOf;
    const stopped = hold !== undefined && stoppedOf ? { stoppedUsd: (streamed: number) => stoppedOf(admitted, streamed) ?? hold } : {};
    return { ...(hold === undefined ? {} : { holdUsd: hold }), ...(limit === undefined ? {} : { outputTokensMax: limit }), ...stopped };
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
  // The call the gate parked, until the next message starts a turn: no request leaves meanwhile, and the turn is
  // interrupted once the call's result is in. Not a failure: the turn ends as the person's answer will resume it.
  let parked: ParkedCall | undefined;
  const PARKED = new Error("the turn ended: a tool call waits for a person's approval");
  // Each call's arguments, by its id, for a park named by tool and arguments (endsTurn).
  const argsOf = new Map<string, unknown>();
  const results: ToolResults = new Map();
  let run: DurableRun | undefined;
  let session: AdapterSession | undefined;
  let opened: Promise<void> | undefined;
  let openedDone: () => void = () => {};
  opened = new Promise((resolve) => (openedDone = resolve));
  let turn: Promise<void> | undefined;
  // A person's stop of the turn in flight: its interrupt, which the turn's end waits for before it settles the turn.
  let stopping: Promise<void> | undefined;
  // The door's emit, from attach as the door opens: a recovered turn, started by no submit, reports through it too.
  let emit: ((event: DoorEvent) => void) | undefined;
  let attached = false;
  const queue: Message[] = [];
  const stop = new AbortController();
  // The current request's content, and the requests whose cost is in but whose entry is not written yet.
  let text = "";
  let calls: ToolCall[] = [];
  // The turn's answer entry so far (its last request with text and no call), the MESSAGE its turn took, and whether the
  // instance is stopping (a drain, a fence, a park: no one's stop, so the turn it cuts gets no end, and the next open
  // resumes it if the session still holds it open, or restores its end, as onOpen's `restored`, if the session ended it).
  let answer: number | undefined;
  let taking: string | undefined;
  let draining = false;
  const costed: Pending[] = [];
  const written = new Set<number>();
  // The request the harness asked last, and the requests whose answer has an entry (taken as its write begins).
  let current: number | undefined;
  const answered = new Set<number>();
  // Requests written at unknown cost (their cost not in when their turn ended), and those whose cost is written.
  const unpriced = new Set<number>();
  const priced = new Set<number>();
  // Requests admitted and not yet booked, by turn: the proxy answers the harness before it books a response, so a turn
  // can end with its last request's cost still on its way.
  const open = new Set<number>();
  // The model each request asked for, by number: its entry names it.
  const models = new Map<number, string>();
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

  /** A cost for a request already written: one written at unknown cost (below) gets its cost now, as an entry of its
   *  own (one of `writes`, the flush's commit), so the run's spend counts it, once; any other is a duplicate. */
  const priceLate = (late: Pending, writes: ((tx: Tx) => Promise<unknown>)[]) => {
    if (!unpriced.has(late.request) || priced.has(late.request)) return;
    const tokens = tokensOf(late.usage);
    writes.push((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: PRICED_LATE, data: { key: spec.key, request: late.request, usd: late.usage.usd ?? null, ...(tokens ? { usage: tokens } : {}) } }));
    priced.add(late.request);
  };
  const writtenAt = () => costed.findIndex((c) => written.has(c.request));

  /** Writes what the current request has: its entry with the content so far and the oldest cost not yet written.
   *  Content with no cost yet waits for one, but at a turn's end (`final`) it is written as a request of unknown cost.
   *  Everything a flush writes is one commit, and `end` (a turn's end: its error and TURN_END) is the last of it, so a
   *  turn's end is in the commit of its last entries. The bookkeeping goes first: a commit the store refuses ends the
   *  process, and the next open reads the root again. */
  const flush = (final = false, end?: (tx: Tx) => Promise<unknown>): Promise<void> =>
    later(async () => {
      const writes: ((tx: Tx) => Promise<unknown>)[] = [];
      const commitAll = async () => {
        if (end) writes.push(end);
        if (writes.length) await commit(async (tx) => { for (const write of writes) await write(tx); });
      };
      // Each cost for a request already written, wherever it sits: a response is booked when its stream closes, so a
      // late cost can come in after a later request's.
      for (let at = writtenAt(); at >= 0; at = writtenAt()) priceLate(costed.splice(at, 1)[0]!, writes);
      if ((!text && !calls.length && !costed.length) || (!costed.length && !final)) return commitAll();
      const request = costed.shift();
      const content = { text, calls };
      text = "";
      calls = [];
      // At a turn's end with no cost in: the request still unbooked is the one this content answers. It is written at
      // unknown cost and marked booked, so a later open never writes it again.
      const unbooked = !request && final && open.size ? Math.min(...open) : undefined;
      if (unbooked !== undefined) open.delete(unbooked);
      const marked = request?.request ?? unbooked;
      if (marked !== undefined) answered.add(marked);
      writes.push(async (tx) => {
        const entry = await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [assistantMessage(harness, marked === undefined ? undefined : models.get(marked), request, content.text, content.calls) as never] });
        // The turn's answer so far: its last request with text and no call.
        if (content.text && !content.calls.length) answer = entry.id as number;
        // Its cost still to come: the timeline reads it pending, not a cost no one will ever know.
        if (unbooked !== undefined) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: REQUEST_COST_PENDING, data: { key: spec.key, request: unbooked } });
        if (marked !== undefined) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BOOKED, data: { key: spec.key, request: marked, ...(request ? {} : { unpriced: true }) } });
      });
      if (marked !== undefined) written.add(marked);
      if (request) priced.add(request.request);
      else if (marked !== undefined) unpriced.add(marked);
      // More costs than content: each later one still gets its own entry, cost only. One that came in meanwhile for a
      // request already written is a late cost, or a duplicate.
      while (costed.length) {
        const next = costed.shift()!;
        if (written.has(next.request)) {
          priceLate(next, writes);
          continue;
        }
        answered.add(next.request);
        writes.push(async (tx) => {
          await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [assistantMessage(harness, models.get(next.request), next, "", []) as never] });
          await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: BOOKED, data: { key: spec.key, request: next.request } });
        });
        written.add(next.request);
        priced.add(next.request);
      }
      await commitAll();
    });

  const onModel = (event: ModelPortEvent) => {
    if (event.type === "request_start") {
      inFlight.started(event.turn);
      current = event.turn;
      open.add(event.turn);
      models.set(event.turn, event.model);
      void flush();
      // Marked on the root as it leaves, as a pi run's request is (request-start.ts): one never answered, a run that ends
      // without opening again (cancelled, or failed) reads as cut, its cost unknown, never as the sum without it.
      // A store that refuses it has refused a write already, and the process ends on that.
      later(() => commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: REQUEST_STARTED, data: { key: spec.key, request: event.turn } })))).catch(() => undefined);
    } else {
      open.delete(event.turn);
      inFlight.ended(event.turn);
      costed.push({ request: event.turn, usage: event.usage });
      booked();
      // A cost that came in after its answer was written goes in now, not at some later flush, and so does one that came
      // in with no turn running, which no turn's flush would write. If that write fails, the next open writes it from
      // the session's booking, once.
      if (written.has(event.turn) || turn === undefined) flush().catch(() => undefined);
    }
  };

  const onEvent = (event: AdapterEvent) => {
    if (event.type === "text") text += event.delta;
    else if (event.type === "tool_start") {
      const call: ToolCall = { type: "toolCall", id: event.callId, name: event.name, arguments: (event.args ?? {}) as Record<string, unknown> };
      argsOf.set(event.callId, event.args ?? {});
      // A call of the current request's answer after that answer's entry was written (at its first call's end): written
      // now as the answer's continuation, so its result never comes before it and the next answer never holds it.
      const request = current;
      if (text || calls.length || request === undefined || !answered.has(request)) calls.push(call);
      else {
        later(() =>
          commit(async (tx) => {
            await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: REQUEST_CONTINUED, data: { key: spec.key, request } });
            await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [assistantMessage(harness, models.get(request), undefined, "", [call]) as never] });
          }).then(() => undefined),
        );
      }
    }
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
      // The parked call's result is in: its turn ends here, settled once the interrupt is done (runTurns).
      if (endsTurn(parked, { callId: event.callId, tool: event.name, args: argsOf.get(event.callId) }) && !stopping) stopping = session?.interrupt();
    }
  };

  /** The session's requests, from its runner records, by number: the model each asked for, and the usage of each it
   *  booked. A booking written before runner.turn kept tokens has none: its entry's zeros read as unknown. */
  const inSession = (records: readonly { kind: string; data: unknown }[]) => {
    const asked = new Map<number, string>();
    const booked = new Map<number, ModelUsage>();
    let admitted = 0;
    for (const record of records) {
      const data = (record.data ?? {}) as { turn?: number; model?: unknown; usd?: number | null; cut?: boolean; unsent?: boolean; usage?: unknown };
      if (record.kind === RUNNER_RECORDS.request) {
        admitted = typeof data.turn === "number" ? data.turn : admitted + 1;
        if (typeof data.model === "string") asked.set(admitted, data.model);
      }
      // A request withdrawn as its record was written (a stop came then) never left: it is no request of the run's.
      else if (record.kind === RUNNER_RECORDS.turn && data.unsent !== true) {
        const request = typeof data.turn === "number" ? data.turn : admitted;
        booked.set(request, { ...(tokensOf(data.usage) ?? { input: 0, output: 0 }), usd: typeof data.usd === "number" ? data.usd : null, estimated: data.usd === null || data.cut === true });
      }
    }
    return { asked, booked };
  };

  /** The person's message: the session's new turn, then its entry and its end on the root. */
  const sendOf = (message: Message) => async () => {
    parked = undefined;
    argsOf.clear();
    await message.recorded;
    taking = message.id;
    await session!.send(message.content);
    await later(() =>
      commit(async (tx) => {
        await tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, { model: [{ role: "user", content: [{ type: "text", text: message.content }], timestamp: now() } as never], ...(message.origin ? { data: { origin: message.origin } } : {}) } as never);
        await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: MESSAGE_END, data: { key: spec.key, id: message.id, sent: true } });
      }).then(() => undefined),
    );
  };

  /** Turns until nothing waits: the turn, then each message that waited for it, as one busy period on the door (as a pi
   *  run's follow-ups are), so the server never reads the run idle, and done, while an accepted message is unanswered. A
   *  message that arrives meanwhile waits its place. `carried`: the first turn's answer so far, when it is a turn an
   *  earlier process left open and this one recovers (its answer already on the root); a new message's turn starts with
   *  none. */
  const runTurns = (first: () => Promise<void>, carried?: number) => {
    turn = (async () => {
      emit?.({ type: "run_start" });
      for (let start: (() => Promise<void>) | undefined = first, carry = carried; start; carry = undefined) {
        let failed: string | undefined;
        let status: TurnStatus = "failed";
        answer = carry;
        // A turn of its own: a paid call's refusal a stop left pending (its turn stopped before its next request) is
        // let go, so this turn's first request is judged as any other, never paused for a call the person moved on from.
        if (spend) takePaidRefusal(spend);
        try {
          await start();
          const end = await session!.turnEnd();
          status = end.status;
          if (end.status === "failed") failed = end.error ?? "the turn failed";
        } catch (error) {
          failed = String((error as Error)?.message ?? error);
        } finally {
          // A turn the person stopped can still be open in the session (an interrupt writes no end there, and a prompt it
          // stopped before the harness placed it is still pending). It is settled once the interrupt is done, before the
          // turn's end and any next message, so nothing of it goes on or is sent again. An adapter without the settle is
          // left as before. A settle that fails leaves the turn to the next open, which settles it from the stop record.
          if (stopping) {
            await stopping.catch(() => undefined);
            stopping = undefined;
            if (session?.state === "open_turn" && typeof session.settleOpenTurn === "function") await session.settleOpenTurn().catch(() => undefined);
          }
          // The last request's cost, booked once the proxy has answered: waited for, so the answer is written with it.
          await bookings(BOOKING_WAIT_MS);
          // A turn that failed (the cap's refusal, a cost the booking could not write, or the harness's own failure) writes
          // its error and ends failed. The run's status is its last turn's end (turns.ts): with no message waiting, the run
          // fails on this error, as a pi run does; a message waiting behind it is still sent, and when that turn completes,
          // the run completes with its answer, this failure kept in the timeline.
          // A turn the gate parked ends interrupted, never failed on the request its park refused.
          const why = refused ?? halted?.message ?? (failed === undefined || parked !== undefined ? undefined : `${harness}: ${failed}`);
          if (parked !== undefined && why === undefined) status = "interrupted";
          // A test's seam, unset in a server (AGENTRUN_SERVE_TEST_CRASH_AFTER_ANSWER, a file that marks it once): a parked
          // turn holds its end until the answer's message is recorded, then the process goes by a signal, as a crash
          // between the two would leave the run.
          if (CRASH_SEAM && parked !== undefined && !existsSync(CRASH_SEAM)) {
            await answerIn;
            writeFileSync(CRASH_SEAM, "");
            process.kill(process.pid, "SIGKILL");
          }
          const unsent = refused !== undefined && capRefused;
          const figures = unsent ? refusedFigures : undefined;
          refusedFigures = undefined;
          refused = undefined;
          capRefused = false;
          const pending = open.size > 0;
          // The turn's end, in the commit of its last entries (flush's one commit): the run's end is read from it alone
          // (turns.ts). A turn the instance's own stop cut gets none: the next open resumes it while the session holds it
          // open, or restores its end from the root (completed with its answer) when the session had ended it.
          const cut = draining && why === undefined && status === "interrupted";
          await flush(true, cut ? undefined : async (tx) => {
            if (why !== undefined) {
              // A refusal of the cap's: a start mark of its own first, as pi's is, so the run's usage counts no request for it.
              if (unsent) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: REQUEST_STARTED, data: { [CAP_REFUSED_FIELD]: true, ...(figures ? { spentUsd: figures.spentUsd, needsUsd: figures.needsUsd, leastCapUsd: figures.leastCapUsd } : {}) } });
              await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, { model: [assistantMessage(harness, undefined, undefined, "", [], why) as never] });
            }
            const data: TurnEndData = {
              key: spec.key, ...(taking === undefined ? {} : { message: taking }), status: why === undefined ? status : "failed",
              answer: why === undefined && status === "completed" ? (answer ?? null) : null, ...(why === undefined ? {} : { error: why }), cost: pending ? "pending" : "booked",
            };
            await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: TURN_END, data });
          });
          await writing;
          // A cost that came in while this turn ended, after its flush: written now, while the run still reads busy, so a
          // message that comes in meanwhile waits its place below and goes on as the next turn of this busy period.
          if (costed.length) await flush().catch(() => undefined);
        }
        // Stopping: the messages still waiting are sent by the next open, which finds them with no end.
        const next = draining ? undefined : queue.shift();
        start = next === undefined ? undefined : sendOf(next);
      }
      // Nothing from here to run_end waits: a message that comes in once the run reads idle starts the next busy period,
      // after this run_end. A cost that comes in from now on is written as it comes in (onModel).
      turn = undefined;
      // A stop that came after this busy period's last turn had ended stopped nothing: it is not the next one's.
      stopping = undefined;
      emit?.({ type: "run_end" });
    })();
  };

  /** The gate's resume (tool-gate.ts): the answer as a message of its own, recorded with the gate's mark in one commit,
   *  then sent as a person's is. */
  const CRASH_SEAM = process.env.AGENTRUN_SERVE_TEST_CRASH_AFTER_ANSWER;
  let answerRecorded: (() => void) | undefined;
  const answerIn = new Promise<void>((resolve) => (answerRecorded = resolve));
  const resume: Resume = async (id, content, mark) => {
    await opened;
    const message: Message = { id: `approval-${id}`, content, recorded: commit(async (tx) => {
      await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: MESSAGE, data: { key: spec.key, id: `approval-${id}`, content } });
      await mark(tx);
    }) };
    await message.recorded;
    answerRecorded?.();
    if (turn) queue.push(message);
    else runTurns(sendOf(message));
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
      const origin = input.origin;
      const message: Message = { id, content, ...(origin ? { origin } : {}), recorded: commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: MESSAGE, data: { key: spec.key, id, content, ...(origin ? { origin } : {}) } }))) };
      if (turn) queue.push(message);
      else runTurns(sendOf(message));
      await message.recorded;
      return { accepted: true };
    },
    async abort(ctx: DoorContext) {
      if (!attached) emit = ctx.emit;
      // The instance stopping (a drain, a fence, a park) is no one's stop: the turn it cuts gets no end, the next open
      // resumes it (or restores its end, when the session had ended it), and the messages waiting stay, for it to send.
      if (ctx.reason === "stop") {
        draining = true;
        if (!turn) return "idle";
        await session?.interrupt();
        return "aborted";
      }
      const dropped = queue.splice(0);
      if (dropped.length) {
        await Promise.all(dropped.map((message) => message.recorded));
        await commit(async (tx) => {
          for (const message of dropped) await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: MESSAGE_END, data: { key: spec.key, id: message.id, sent: false } });
        });
      }
      if (!turn) return "idle";
      stopping = session?.interrupt();
      await stopping;
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
      const paid: { kind: string; data?: unknown }[] = [];
      // The turn that took the last message sent, while the root has no end for it (a process died before the commit of
      // its last entries, or its own stop cut it): the message, whether the bridge wrote that turn's error, and its answer
      // so far (its newest request with text and no call).
      let unended: { message: string; failed: boolean; answer: number | null } | undefined;
      // The person's messages on the root: the newest one's entry id, and how many, for the run's stop record.
      let lastUser: number | undefined;
      let users = 0;
      for (let cursor: Cursor | undefined; root; ) {
        const page = await root.entries({ order: "ascending" }, 500, cursor, context);
        for (const entry of page.items) {
          const data = entry.data as { key?: unknown; request?: unknown; unpriced?: unknown; id?: unknown; content?: unknown; sent?: unknown; origin?: unknown } | undefined;
          if (entry.kind === TOOL_COST || entry.kind === TOOL_STARTED) paid.push(entry);
          const message = (entry as { model?: { api?: unknown; stopReason?: unknown; role?: unknown }[] }).model?.[0];
          if (unended && message?.api === ADAPTER_API && message.stopReason === "error") unended.failed = true;
          if (unended && message?.api === ADAPTER_API && message.stopReason === "stop" && textOf((message as { content?: unknown }).content)) unended.answer = entry.id as number;
          if (message?.role === "user") {
            users += 1;
            lastUser = Number(entry.id);
          }
          if (data?.key !== spec.key) continue;
          if (entry.kind === BOOKED && typeof data.request === "number") {
            written.add(data.request);
            (data.unpriced === true ? unpriced : priced).add(data.request);
          } else if (entry.kind === PRICED_LATE && typeof data.request === "number") priced.add(data.request);
          else if (entry.kind === MESSAGE && typeof data.id === "string") accepted.set(data.id, { id: data.id, content: String(data.content ?? ""), ...(originOf(data.origin) ? { origin: data.origin as JsonObject } : {}), recorded: Promise.resolve() });
          else if (entry.kind === MESSAGE_END && typeof data.id === "string") {
            accepted.delete(data.id);
            if (data.sent === true) unended = { message: data.id, failed: false, answer: null };
          } else if (entry.kind === TURN_END) unended = undefined;
        }
        if (page.next === undefined) break;
        cursor = page.next;
      }
      // What the paid tools charged in earlier processes, as the cap counts it: a call a crash cut at its held figure.
      charged = capToolSpend(paid);
      // The prefix pi's commands start under in this run, from pi-durable-disk's own builder: the harness's process too.
      const env = (await durable.env({ conversationId: ROOT_CONVERSATION_ID, read: undefined as never }, context)) as unknown as { confinePrefix?(): string[] };
      if (typeof env.confinePrefix !== "function") throw new Error("the run's environment gives no confinement for the harness's process");
      const adapter = await make(confineOf(env.confinePrefix()));
      const writer = await sessions.open(spec.key);
      const records = await writer.read();
      // Before the cut requests are booked, which may write their entries.
      for (const [request, model] of inSession(records).asked) models.set(request, model);
      const booking = await modelPortFor(writer, {
        records,
        key: spec.key,
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        beforeRequest: guard as never,
        onEvent: onModel,
        stopped: () => halted ?? cancelStop() ?? (parked === undefined ? undefined : PARKED),
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
      // A paid tool's check before it spends: the session's requests, each booked once the proxy has answered (waited
      // for, as at a turn's end), one still in flight at the worst case the cap held for it (as pi's spend counts it),
      // with the run's charges; its charge joins them.
      if (budgetUsd !== undefined) {
        spend = {
          cap: budgetUsd,
          spent: async () => (await bookings(BOOKING_WAIT_MS), plus(booking.spentUsd(), charged)),
          held: () => inFlight.total(),
          add: (usd) => void (charged = plus(charged, usd)),
        };
        useSpend(spend);
      }
      // Each request the session booked and the root has no entry for: its cost, with no content.
      // Each request the session booked and the root does not have, or has at unknown cost only: written now, once.
      for (const [request, usage] of inSession(await writer.read()).booked) if (!written.has(request) || (unpriced.has(request) && !priced.has(request))) costed.push({ request, usage });
      await flush();
      // The calls that wait for a person's approval, read before any turn goes on.
      await gate?.load(durable, context, coding);
      // The park every gated call of the run's takes, built once: the host tools' here, and the MCP gateway's, which takes
      // the same object beside them (`{ gate, park }`). A call parked by its id or by its tool and arguments ends its turn.
      const park: Park = { commit: (change) => commit(change as never) as never, parked: (callId) => void (parked = { callId }), parkedBy: (match) => void (parked = match), turn: () => taking };
      session = await adapter.open({ ...spec, tools: hostTools(durable, tools, context, results, coding, gate ? { gate, park } : undefined) }, { writer, models: booking.models, signal: stop.signal, onEvent, ...(dir ? { dir } : {}), ...(cwd ? { cwd } : {}) });
      // A turn the person stopped is still open in the session (an interrupt writes no end there), and it is not resumed.
      // The run's stop record names the person's newest message when they stopped: with no message on the root newer than
      // it, the open turn is the stopped one. The session settles it, ended interrupted, and the next message is a turn of
      // its own. A turn a crash or a drain cut has no stop record newer than the newest message, and is resumed as before.
      // A turn the gate parked is settled as a stopped one: its call waits for its answer, which resumes the run. So is
      // one whose parked call was answered before a process went: its request names the turn (gate.parkedIn), so the
      // answer's message, queued, follows it, and the turn is never run again.
      const stopped = (stopRecord?.stopped_at !== undefined
        ? lastUser !== undefined && lastUser <= placeOf(stopRecord.stopped_at)
        : stopRecord?.stopped_after !== undefined && stopRecord.stopped_after === users) || gate?.waiting() === true || gate?.parkedIn(unended?.message) === true;
      // An adapter written before settleOpenTurn has none: its stopped turn is recovered, as before.
      if (session.state === "open_turn" && stopped && typeof session.settleOpenTurn === "function") await session.settleOpenTurn();
      // That turn is over in the session, and an earlier process died before it wrote the turn's end: written now, after
      // what this open wrote and before any new turn. A turn the person stopped reads interrupted, from the stop record:
      // settled by this open, or by an earlier one that died before it wrote this end. Otherwise the session says only that
      // the turn is over; how it ended is what the root holds of it: failed when the bridge wrote its error, completed when
      // its answer (a request with text and no call) is there. With neither, the turn is not known to have completed: it
      // ends interrupted, and the run waits for the person (turns.ts), never answered "". The end names the message the
      // turn took, as every turn end does.
      const restored: TurnStatus | undefined = session.state === "idle" && unended ? (stopped ? "interrupted" : unended.failed ? "failed" : unended.answer !== null ? "completed" : "interrupted") : undefined;
      const restore = (status: TurnStatus) => later(() => commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: TURN_END, data: { key: spec.key, message: unended!.message, status, answer: status === "completed" ? unended!.answer : null } satisfies TurnEndData }))));
      // A turn the session holds open is the last message's, resumed now.
      if (session.state === "open_turn" && unended) taking = unended.message;
      queue.push(...accepted.values());
      // With nothing waiting, that end is the run's: written while the door is idle. A message accepted and never sent
      // still waits, and a server started anew counts none: the door is busy (run_start) before that end goes out, and
      // the message's turn follows in the same busy period, so no server reads the run done before it answers.
      if (restored && !queue.length) await restore(restored);
      openedDone();
      // Its answer so far is the root's, which a recovery that streams no new text keeps as the turn's.
      if (session.state === "open_turn" && !gate?.waiting()) runTurns(() => session!.recover(), unended?.answer ?? undefined);
      else if (queue.length) {
        const next = sendOf(queue.shift()!);
        runTurns(restored ? async () => (await restore(restored), await next()) : next);
      }
      // The answers from now on: each resumes the session with one message of its own.
      gate?.start(resume);
    },
  };
}
