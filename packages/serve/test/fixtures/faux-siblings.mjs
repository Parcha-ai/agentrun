// A faux model that makes several tool calls in one answer: the run's first message is `Siblings <json>`, a JSON list of
// [tool, args] pairs, all called at once. Once every call is answered (a tool result that is not the gate's waiting
// words, or the tool gate's resume of an approved or denied call, a user message starting "[tool approval]") it says
// "Seen: " and each tool result the conversation holds, as `<tool>=<text>` joined by " | ", then each resume's words.
// Asked while a call still waits, it says "Waiting.".
import { noteRequest } from "./faux-requests.mjs";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
const WAITING = /waits for a person's approval/;

export default function reply(context, faux) {
  noteRequest(context);
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const listed = /^Siblings (\[.*\])$/s.exec(first);
  if (!listed) return faux.message("Answered.");
  const made = context.messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "toolCall"));
  if (!made) return faux.message(JSON.parse(listed[1]).map(([tool, args]) => faux.toolCall(tool, args)), { stopReason: "toolUse" });
  const results = context.messages.filter((m) => m.role === "toolResult");
  const resumes = context.messages.filter((m) => m.role === "user" && textOf(m).startsWith("[tool approval]"));
  if (results.some((m) => WAITING.test(textOf(m))) && resumes.length === 0) return faux.message("Waiting.");
  const seen = results.filter((m) => !WAITING.test(textOf(m))).map((m) => `${m.toolName}=${textOf(m)}`);
  return faux.message(`Seen: ${[...seen, ...resumes.map(textOf)].join(" | ")}`);
}
