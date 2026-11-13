// OpenCode's transcript rewrite for a resumed run. OpenCode's transcript is the session's sync events, mirrored into the
// session's records and given back to OpenCode with /sync/replay when its process starts again. A call OpenCode started
// and never ended (its tool part still pending or running) is a dangling call. The resume's shared decision settles each
// one through the kernel's tool bridge first, under the call's own id: a call with no intent goes gate, intent, run,
// result; a call with an intent is never run again. This file only writes the outcome the bridge answered into the
// transcript, as OpenCode records a call's end itself: the tool part's state completed with its output (or an error with
// its words), then its message completed. Each is a new event after the last; nothing before it changes. OpenCode then
// starts again on the rewritten transcript, and the call reads as ended.
import { createHash } from "node:crypto";

/** One of the session's sync events, as /sync/history gives it and /sync/replay takes it back. */
export type SyncEvent = { readonly id: string; readonly aggregate_id: string; readonly seq: number; readonly type: string; readonly data: Record<string, unknown> };

/** A call OpenCode started and never ended: its own call id, the host's tool name and the arguments the model gave. */
export type DanglingCall = { readonly callId: string; readonly tool: string; readonly args: unknown };

/** The bridge's answer for a call: its text, and whether it failed (or was interrupted). */
export type CallOutcome = { readonly text: string; readonly isError: boolean };

/** OpenCode names the host's tools by its one MCP server's name: `hands_<tool>`. */
const PREFIX = "hands_";
const PART = "message.part.updated.1";
const MESSAGE = "message.updated.1";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
type ToolPart = Record<string, unknown> & { callID: string; tool: string; messageID: string; state: Record<string, unknown> };
const toolPartOf = (event: SyncEvent): ToolPart | undefined => {
  const part = event.type === PART ? event.data.part : undefined;
  return isPlain(part) && part.type === "tool" && typeof part.callID === "string" && isPlain(part.state) ? (part as ToolPart) : undefined;
};

/** Each tool part's newest state, by call id, in the order the calls were first seen. */
function lastParts(events: readonly SyncEvent[]): Map<string, { readonly part: ToolPart; readonly event: SyncEvent }> {
  const parts = new Map<string, { part: ToolPart; event: SyncEvent }>();
  for (const event of events) {
    const part = toolPartOf(event);
    if (part) parts.set(part.callID, { part, event });
  }
  return parts;
}

const ended = (part: ToolPart) => part.state.status === "completed" || part.state.status === "error";

/** The calls OpenCode started and never ended, in the order it started them. */
export function danglingCalls(events: readonly SyncEvent[]): DanglingCall[] {
  return [...lastParts(events).values()]
    .filter(({ part }) => !ended(part))
    .map(({ part }) => ({ callId: part.callID, tool: part.tool.startsWith(PREFIX) ? part.tool.slice(PREFIX.length) : part.tool, args: part.state.input ?? {} }));
}

/** An event id in OpenCode's own format (`evt_` + 12 hex of the time + 14 base62), its random part from `seed`. */
function eventId(seed: string, now: number): string {
  const hex = (BigInt(now) * 0x1000n & 0xffffffffffffn).toString(16).padStart(12, "0");
  const bytes = createHash("sha256").update(seed).digest();
  let tail = "";
  for (let i = 0; i < 14; i++) tail += BASE62[bytes[i]! % 62];
  return `evt_${hex}${tail}`;
}

/** `events` with the dangling call `callId` given `outcome`: its tool part ended (completed with the output, or an error
 *  with the words), then its message completed, as two new events after the last. Throws when the call does not
 *  dangle: an ended call is never rewritten. */
export function settleCall(events: readonly SyncEvent[], callId: string, outcome: CallOutcome, now = Date.now()): SyncEvent[] {
  const found = lastParts(events).get(callId);
  if (!found || ended(found.part)) throw new Error(`OpenCode's transcript has no call ${callId} that it started and never ended`);
  const { part, event } = found;
  const sid = event.aggregate_id;
  const seq = Math.max(...events.filter((e) => e.aggregate_id === sid).map((e) => e.seq)) + 1;
  const start = isPlain(part.state.time) ? part.state.time.start : now;
  const input = part.state.input ?? {};
  const state = outcome.isError
    ? { status: "error", input, error: outcome.text, time: { start, end: now } }
    : { status: "completed", input, output: outcome.text, title: "", metadata: {}, time: { start, end: now } };
  const settledPart: SyncEvent = {
    id: eventId(`${sid}:${callId}:part`, now),
    aggregate_id: sid,
    seq,
    type: PART,
    data: { ...event.data, part: { ...part, state }, time: now },
  };
  // Its message, as OpenCode last recorded it, completed: a message that ended on a call ends with tool-calls.
  const message = [...events].reverse().find((e) => e.type === MESSAGE && isPlain(e.data.info) && e.data.info.id === part.messageID);
  if (!message || !isPlain(message.data.info)) return [...events, settledPart];
  const info = message.data.info;
  const settledMessage: SyncEvent = {
    id: eventId(`${sid}:${callId}:message`, now),
    aggregate_id: sid,
    seq: seq + 1,
    type: MESSAGE,
    data: { ...message.data, info: { ...info, time: { ...(isPlain(info.time) ? info.time : {}), completed: now }, finish: "tool-calls" } },
  };
  return [...events, settledPart, settledMessage];
}
