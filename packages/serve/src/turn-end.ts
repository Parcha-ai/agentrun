// The end of a claude-agent or codex turn on a run's root conversation (harness-app.ts writes it; runs.ts reads it). A data
// entry: no model, so the timeline shows no row for it and the meters do not count it.

/** `{ kind: TURN_END, data: { key, status } }`: a turn of the session `key` is over, with the session's own outcome. */
export const TURN_END = "adapter.turn_end";

/** The root's record of a message a claude-agent or codex run's door accepted, `{ key, id, content }`, and of its end,
 *  `{ key, id, sent }`: sent to the session, or dropped by a stop (harness-app.ts writes both; runs.ts reads them). One
 *  with no end yet still waits for its turn, whatever a server that started after it was accepted counts. */
export const MESSAGE = "adapter.message";
export const MESSAGE_END = "adapter.message_end";

/** The `api` of every assistant message serve's bridge writes for a claude-agent or codex request (harness-app.ts): its
 *  stop reason says nothing of the turn's end (a cost, a cut, an interruption and an answer read alike). */
export const ADAPTER_API = "agentrun-adapter";
