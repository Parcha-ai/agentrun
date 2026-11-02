// A faux model and a faux harness for learning's tests, no key and no network. A run answers "Job answer." (or, when
// its instructions say "Say your prompt.", the system prompt it was given), and its end-of-run turn writes the notes its
// instructions plan, one write a request, then says "Reflected.". The instructions plan with one line:
// - `Learn: <JSON>`: an array of [file, text] pairs, each written into the run's copy of the folder;
// - `Learn once: <JSON>`: the same, less the files the run's index names already (a later run of the agent adds none).
// On pi the instructions can also say "Answer once <file> exists." (the job's answer holds until the test makes that
// file), "Reflect once <file> exists." (the turn holds until the test makes that file) or "Reflect slowly." (the turn
// answers after a minute, or when it is aborted). A later message `Write: <JSON>` ([file, text] pairs) writes each file
// into `.learning/`, one write a request, then says "Written.": a follow-up that changes the run's copy.
// The server's grader is answered here too, on the agent's own model, by what the instructions say: "Grade: drop." keeps
// no note, "Grade: sly." says merge and keeps none, "Grade: garbage." is no JSON, "Grade: fail." fails the call;
// anything else keeps every note. With AGENTRUN_TEST_FAUX_GRADE_HOLD set (in the server's environment), the grader
// answers only once it is aborted; set to `never`, it never answers at all, aborted or not. Each grader call is filed
// as a line in the file AGENTRUN_TEST_FAUX_CALLS names.
import { access } from "node:fs/promises";
import { appendFileSync } from "node:fs";

/** A small price, so a run's and a grade's costs are known and above zero: $1 per million tokens each way. */
export const cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

const textOf = (value) => (typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");
/** pi-ai's system prompt and every system message's text and sections, as the model would see them. */
const systemOf = (context) => [context.systemPrompt, ...context.messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).map(textOf)])].filter(Boolean).join("\n");

/** The notes the instructions in `system` plan, as [file, text] pairs. */
export function planned(system) {
  const once = /^Learn once: (\[.*\])$/m.exec(system)?.[1];
  if (once) return JSON.parse(once).filter(([file]) => !system.includes(`](${file})`));
  const always = /^Learn: (\[.*\])$/m.exec(system)?.[1];
  return always ? JSON.parse(always) : [];
}

/** A note's file, as an end-of-run turn writes one. */
export const note = (name, description, body = `${description}.\n`, extra = "") => `---\nname: ${name}\ndescription: ${description}\ntype: reference\n${extra}---\n${body}`;

const answerOf = (system) => (/Say your prompt\./.test(system) ? system : "Job answer.");

/** Resolves after `ms`, or as an aborted reply as soon as the turn is stopped. */
const slow = (faux, ms, text) =>
  new Promise((resolve) => {
    if (faux.signal?.aborted) return resolve(faux.message("", { stopReason: "aborted" }));
    const timer = setTimeout(() => resolve(faux.message(text)), ms);
    faux.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(faux.message("", { stopReason: "aborted" }))), { once: true });
  });

/** The grader's answer to `prompt`, by the agent's instructions fenced in it. */
function grade(prompt, faux) {
  if (process.env.AGENTRUN_TEST_FAUX_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_CALLS, `${JSON.stringify({ kind: "grade" })}\n`);
  const rules = /----- begin (\w+): the agent's standing instructions -----\n([\s\S]*?)----- end \1 -----/.exec(prompt)?.[2] ?? "";
  const files = /^Give one item for each of these files, each once, and for no other: (.*)\.$/m.exec(prompt)?.[1].split(", ") ?? [];
  if (process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD === "never") return new Promise(() => {});
  if (process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD) return slow(faux, 600_000, "");
  if (rules.includes("Grade: fail.")) return faux.message("", { stopReason: "error", errorMessage: "the faux grader failed on purpose" });
  if (rules.includes("Grade: garbage.")) return faux.message("Looks fine to me.");
  const keep = !rules.includes("Grade: drop.") && !rules.includes("Grade: sly.");
  return faux.message(JSON.stringify({
    merge: keep || rules.includes("Grade: sly."),
    reason: keep ? "Each note is general and new." : "A note is about the one case it came from.",
    items: files.map((file) => ({ file, keep, ...(keep ? {} : { question: "General" }), why: keep ? "It holds as a general rule." : "It is about one case." })),
  }));
}

/** As a faux model (pi, and the server's grader). */
export default function reply(context, faux) {
  const users = context.messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const [first = "", last = ""] = [users[0], users.at(-1)];
  if (first.startsWith("You grade what an agent proposes to remember.")) return grade(first, faux);
  const system = systemOf(context);
  // The folder as the prompt names it, relative to the run's workspace, where pi's file tools resolve it.
  const asked = /^The task is done\.[\s\S]*?Your notes from earlier runs are in `([^`]+)`/.exec(last);
  const done = context.messages.slice(context.messages.findLastIndex((m) => m.role === "user")).filter((m) => m.role === "toolResult").length;
  const writes = /^Write: (\[.*\])$/m.exec(last)?.[1];
  if (writes) {
    const files = JSON.parse(writes);
    if (done >= files.length) return faux.message("Written.");
    return faux.message(faux.toolCall("write", { path: `.learning/${files[done][0]}`, content: files[done][1] }), { stopReason: "toolUse" });
  }
  const held = /Answer once (\S+) exists\./.exec(system)?.[1];
  if (!asked && held) {
    return (async () => {
      while (!(await access(held).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
      return faux.message(answerOf(system));
    })();
  }
  if (!asked) return faux.message(answerOf(system));
  const plan = planned(system);
  return (async () => {
    const gate = /Reflect once (\S+) exists\./.exec(system)?.[1];
    while (gate && done === 0 && !(await access(gate).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
    if (/Reflect slowly\./.test(system)) return slow(faux, 60_000, "Too late.");
    if (done >= plan.length) return faux.message("Reflected.");
    const [file, content] = plan[done];
    return faux.message(faux.toolCall("write", { path: `${asked[1]}${file}`, content }), { stopReason: "toolUse" });
  })();
}

/** As a faux harness (claude-agent and codex): the job's answer, then the end-of-run turn's writes, each a request. */
export function script(spec) {
  const system = spec.system.join("\n");
  const writes = planned(system).map(([file, content]) => ({ call: "write", args: { path: `.learning/${file}`, content }, usd: 0.001 }));
  return [{ say: answerOf(system), usd: 0.001 }, { end: true, usd: 0.001 }, ...writes, { say: "Reflected.", usd: 0.001 }, { end: true, usd: 0.001 }];
}
