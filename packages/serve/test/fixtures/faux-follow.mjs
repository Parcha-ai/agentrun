// A faux model and a faux harness that follow what their instructions say, no key and no network: a run answers a shop's
// refund page as a table when its system prompt holds "a small table with" (what the user's note says in its body, never
// in its index line), and in one line otherwise. Its end-of-run turn answers "No notes.", and it calls no tool.
const textOf = (value) => (typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");
/** pi-ai's system prompt and every system message's text and sections, as the model would see them. */
const systemOf = (context) => [context.systemPrompt, ...context.messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).map(textOf)])].filter(Boolean).join("\n");

export const TABLE = "| URL | Return window | Who pays return shipping |\n|---|---|---|\n| https://shop.example/policies/refund-policy | 30 days | The customer |";
export const LINE = "https://shop.example/policies/refund-policy — returns within 30 days; the customer pays return shipping.";
/** The job's answer, as instructions holding `system` would have it. */
export const answerOf = (system) => (/a small table with/.test(system) ? TABLE : LINE);

/** As a faux model (pi). */
export default function reply(context, faux) {
  const last = textOf(context.messages.filter((m) => m.role === "user").at(-1)?.content);
  return faux.message(last.startsWith("The task is done.") ? "No notes." : answerOf(systemOf(context)));
}

/** As a faux harness (claude-agent and codex): the job's answer, then the end-of-run turn's. */
export const script = (spec) => [{ say: answerOf(spec.system.join("\n")), usd: 0.001 }, { end: true, usd: 0.001 }, { say: "No notes.", usd: 0.001 }, { end: true, usd: 0.001 }];
