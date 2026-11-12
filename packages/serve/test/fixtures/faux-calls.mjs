// A faux model that makes a list of tool calls in one run, one after another: the run's first message is
// `Calls <json>`, a JSON list of [tool, args] pairs. Each request makes the next call of the list, counting each call
// already answered in the conversation (a tool result, or the tool gate's resume of an approved or denied call, a user
// message starting "[tool approval]"); once every call is answered it says "Done: <the last answer>".
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  const first = textOf(context.messages.find((m) => m.role === "user"));
  const listed = /^Calls (\[.*\])$/s.exec(first);
  if (!listed) return faux.message("Answered.");
  const calls = JSON.parse(listed[1]);
  // A parked call's result is the gate's waiting words: its answer is the resume that follows, never that result.
  const answers = context.messages.filter((m) => (m.role === "toolResult" && !/waits for a person's approval/.test(textOf(m))) || (m.role === "user" && textOf(m).startsWith("[tool approval]")));
  if (answers.length >= calls.length) return faux.message(`Done: ${textOf(answers.at(-1))}`);
  const [tool, args] = calls[answers.length];
  return faux.message(faux.toolCall(tool, args), { stopReason: "toolUse" });
}
