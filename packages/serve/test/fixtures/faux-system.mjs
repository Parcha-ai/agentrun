// A faux model and a faux harness that answer with the system prompt they were given: what a run's instructions came to.
const textOf = (value) => (typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");

/** As a faux model: pi-ai's system prompt and every system message's text and sections, as the model would see them. */
export default function reply(context, faux) {
  const system = [context.systemPrompt, ...context.messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).map(textOf)])];
  return faux.message(system.filter(Boolean).join("\n"));
}

/** As a faux harness: each turn says the session's system prompt, then ends. */
export const script = (spec) => Array.from({ length: 10 }, () => [{ say: spec.system.join("\n"), usd: 0.001 }, { end: true, usd: 0.001 }]).flat();
