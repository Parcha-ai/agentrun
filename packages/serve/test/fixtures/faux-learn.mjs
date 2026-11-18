// A faux model and a faux harness for learning's tests, no key and no network. A run answers "Job answer." (or, when
// its instructions say "Say your prompt.", the system prompt it was given). Its compile turn (learn/compile.ts, asked
// when the agent's job is due to be compiled) answers with the workflow block a `Compile: <JSON string>` line of the
// instructions gives, as given, else COMPILED, a one-node workflow the checks and the dry run pass; a re-ask the checks
// sent back is answered the same way.
// A line `Read: <JSON>` (an array of paths) has the job read each path first, one read a request, then answer: on pi with
// pi's own read tool, on the faux harness with the host's.
// On pi the instructions can also say "Answer once <file> exists." (the job's answer holds until the test makes that
// file) or "Reflect once <file> exists." (the compile turn holds until the test makes that file, or until it is aborted).
import { access } from "node:fs/promises";
import { askedForCompile } from "../../dist/learn/compile.js";

/** A small price, so a run's costs are known and above zero: $1 per million tokens each way. */
export const cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

/** A compile answer whose draft the checks and the dry run pass: the job as one model node. */
export const COMPILED = `\`\`\`\`workflow answer\n---\ndescription: Answers a question; use when asked\nexample: {"content":"What is six times seven?"}\n---\n${JSON.stringify({
  v: 2, name: "answer",
  schemas: { In: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }, Answer: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "extract", label: "answer", instructions: "Answer the question.", out: "Answer", as: "answer" },
})}\n\`\`\`\``;

const textOf = (value) => (typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");
/** pi-ai's system prompt and every system message's text and sections, as the model would see them. */
const systemOf = (context) => [context.systemPrompt, ...context.messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).map(textOf)])].filter(Boolean).join("\n");

const answerOf = (system) => (/Say your prompt\./.test(system) ? system : "Job answer.");
/** The compile turn's answer, by the instructions in `system`. */
const compiledOf = (system) => {
  const given = /^Compile: (".*")$/m.exec(system)?.[1];
  return given ? JSON.parse(given) : COMPILED;
};
/** The paths the instructions in `system` have the job read before it answers. */
const readsOf = (system) => JSON.parse(/^Read: (\[.*\])$/m.exec(system)?.[1] ?? "[]");

/** Resolves once `file` exists: true, or false as soon as the turn is stopped. */
const until = async (file, faux) => {
  while (!(await access(file).then(() => true, () => false))) {
    if (faux.signal?.aborted) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};

/** As a faux model (pi). */
export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const last = users.at(-1) ?? "";
  const system = systemOf(context);
  const done = context.messages.slice(context.messages.findLastIndex((m) => m.role === "user")).filter((m) => m.role === "toolResult").length;
  // The compile turn, and the checks' re-ask of it.
  if (askedForCompile(last)) {
    const gate = /Reflect once (\S+) exists\./.exec(system)?.[1];
    if (!gate) return faux.message(compiledOf(system));
    return (async () => ((await until(gate, faux)) ? faux.message(compiledOf(system)) : faux.message("", { stopReason: "aborted" })))();
  }
  const held = /Answer once (\S+) exists\./.exec(system)?.[1];
  if (held) {
    return (async () => {
      while (!(await access(held).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
      return faux.message(answerOf(system));
    })();
  }
  const reads = readsOf(system);
  if (done < reads.length) return faux.message(faux.toolCall("read", { path: reads[done] }), { stopReason: "toolUse" });
  return faux.message(answerOf(system));
}

/** As a faux harness (claude-agent and codex): the job's answer, then the compile turn's, when one is asked. */
export function script(spec) {
  const system = spec.system.join("\n");
  const reads = readsOf(system).map((path) => ({ call: "read", args: { path }, usd: 0.001 }));
  return [...reads, { say: answerOf(system), usd: 0.001 }, { end: true, usd: 0.001 }, { say: compiledOf(system), usd: 0.001 }, { end: true, usd: 0.001 }];
}
