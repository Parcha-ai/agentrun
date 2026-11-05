// The end of a claude-agent or codex turn on a run's root conversation (harness-app.ts writes it; turns.ts reads it), and
// the root's records of the messages the turns take. Data entries: no model, so the timeline shows no row for them and
// the meters do not count them.

/** `{ kind: TURN_END, data: TurnEndData }`: a turn of the session `key` is over. Written in the same commit as the turn's
 *  last entries. #1424's first form held only `key` and `status`, and closes the message sent last before it. The
 *  timeline reads it too (the next message is not a steer), so the kind is the timeline's. */
export { TURN_END } from "@parcha/pi-durable-agent/timeline";

/** The root's record of a message the door accepted (`{ key, id, content }`), and of its end (`{ key, id, sent }`):
 *  `sent` to the session, or dropped by a stop. The bridge writes a TURN_END naming the message once its turn is over;
 *  for a message an older bridge sent and wrote no end for, the run's next process writes it as it opens. */
export const MESSAGE = "adapter.message";
export const MESSAGE_END = "adapter.message_end";

/** What a turn's end says: the message it took (the MESSAGE id), the session's own outcome (`failed` too when the bridge
 *  wrote the turn's error, in `error`), the entry of the turn's answer (its last request with text and no call; null
 *  when the turn showed no text), and whether a request it made is still unbooked (its cost then comes later, as a
 *  PRICED_LATE entry). */
export type TurnEndData = { key: string; message?: string; status: "completed" | "interrupted" | "failed"; answer?: number | null; error?: string; cost?: "booked" | "pending" };

/** The `api` of every assistant message serve's bridge writes for a claude-agent or codex request (harness-app.ts): its
 *  stop reason says nothing of the turn's end (a cost, a cut, an interruption and an answer read alike). */
export const ADAPTER_API = "agentrun-adapter";
