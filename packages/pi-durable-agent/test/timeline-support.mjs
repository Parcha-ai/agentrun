import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The run viewer's recordings and test fixtures, read only. */
const VIEWER = fileURLToPath(new URL("../../../apps/viewer/", import.meta.url));

/** The lines of the recording at `path` under apps/viewer ("recordings/reference-job"). */
export function lines(path) {
  return readFileSync(`${VIEWER}/${path}/events.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

/** The stored entries a recording's durable lines hold. */
export const entriesOf = (recording) =>
  recording.filter((l) => l.channel === "durable" && l.source === "pi" && Array.isArray(l.data?.model)).map((l) => l.data);

/** The agent events a recording's live pi lines hold, as `GET /events` serves them. */
export const eventsOf = (recording) => recording.filter((l) => l.channel === "live" && l.source === "pi").map((l) => l.data);

let next = 100;
const base = { conversationId: 1 };
const at = (timestamp) => ({ timestamp: Date.UTC(2026, 9, 15, 20, 14, 0) + timestamp * 1000 });

export const user = (text, t = 0, extra = {}) => ({ kind: "pi.user", id: next++, ...base, ...extra, model: [{ role: "user", content: text, ...at(t) }] });
export const assistant = (blocks, t = 0, extra = {}) => ({
  kind: "pi.assistant", id: next++, ...base,
  model: [{ role: "assistant", content: blocks, stopReason: blocks.some((b) => b.type === "toolCall") ? "toolUse" : "stop", usage: { cost: { total: 0.01 } }, ...at(t), ...extra }],
});
export const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
export const result = (callId, name, text, t = 0, extra = {}) => ({
  kind: "pi.tool-result", id: next++, ...base,
  model: [{ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, ...at(t), ...extra }],
});
export const custom = (kind, data, extra = {}) => ({ kind, id: next++, ...base, data, ...extra });

export const inConv = (entry, conversationId) => ({ ...entry, conversationId });
