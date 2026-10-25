// A faux model that makes the tool calls a run's input lists, one per turn, then answers: the confinement probes' agent.
// An agentic run's first message is `{"probe": [...]}`; a workflow node's input is `{"question": "{\"probe\": [...]}"}`.
// A step is `{tool, args}`, or `{wait: <absolute path>}`, which holds the next call until the test has made that file.
import { access } from "node:fs/promises";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));

function planOf(text) {
  try {
    const value = JSON.parse(text.split("\n")[0]);
    return value.probe ?? JSON.parse(value.question).probe ?? [];
  } catch {
    return [];
  }
}

const until = async (file) => {
  while (!(await access(file).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
};

export default async function reply(context, faux) {
  const plan = planOf(textOf(context.messages.find((m) => m.role === "user")));
  const calls = plan.filter((step) => step.tool);
  const done = context.messages.filter((m) => m.role === "toolResult").length;
  const node = context.messages.some((m) => m.role === "system" && m.toolsAdded?.some((tool) => tool.name === "submit"));
  if (done === 0) for (const step of plan) if (step.wait) await until(step.wait);
  if (done < calls.length) return faux.message(faux.toolCall(calls[done].tool, calls[done].args), { stopReason: "toolUse" });
  if (node && done === calls.length) return faux.message(faux.toolCall("submit", { answer: 42 }), { stopReason: "toolUse" });
  return faux.message("Probed.");
}
