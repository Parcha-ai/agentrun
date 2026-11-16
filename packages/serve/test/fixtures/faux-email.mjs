// pi's faux model for the email tools' tests: a line `Email calls: <json>` anywhere in the run's first message (an agent's
// input, or a trigger's, whose payload follows it) is a JSON list of [tool, args] pairs. Each request makes the next call
// of the list, counting each call already answered (a tool result, or the tool gate's resume of an approved or denied
// call: a user message starting "[tool approval]"); once every call is answered it says "Saw: " and a JSON list of every
// answer's text, in order, so a test reads what each call was handed back. A line `Describe: <tool>` says that tool's
// description as the model was handed it. With neither it says "Nothing to do.".
const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

export default function reply(context, faux) {
  // `Describe: <tool>`: the description the model was handed for that tool, as JSON (null when it has no such tool).
  const described = /^Describe: (\w+)$/m.exec(textOf(context.messages.find((m) => m.role === "user")))?.[1];
  if (described) return faux.message(`Described: ${JSON.stringify([...(context.tools ?? []), ...context.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : []))].find((tool) => tool.name === described)?.description ?? null)}`);
  const listed = /^Email calls: (\[.*\])$/m.exec(textOf(context.messages.find((m) => m.role === "user")));
  if (!listed) return faux.message("Nothing to do.");
  const calls = JSON.parse(listed[1]);
  // A parked call's result is the gate's waiting words: its answer is the resume that follows, never that result.
  const answers = context.messages.filter((m) => (m.role === "toolResult" && !/waits for a person's approval/.test(textOf(m))) || (m.role === "user" && textOf(m).startsWith("[tool approval]")));
  if (answers.length >= calls.length) return faux.message(`Saw: ${JSON.stringify(answers.map(textOf))}`);
  const [tool, args] = calls[answers.length];
  return faux.message(faux.toolCall(tool, args), { stopReason: "toolUse" });
}
