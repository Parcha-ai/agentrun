// A faux model and a faux harness for learning's tests, no key and no network. A run answers "Job answer." (or, when
// its instructions say "Say your prompt.", the system prompt it was given), and its end-of-run turn answers with the
// notes its instructions plan, one ```note block each (reflectPrompt's format), then "Reflected.", and calls no tool.
// The instructions plan with one line:
// - `Learn: <JSON>`: an array of [file, text] pairs, each a note of the answer;
// - `Learn once: <JSON>`: the same, less the files the run's `# Learned` names already, in the index or a note's heading
//   (a later run of the agent adds none);
// - `Answer: <JSON>`: the turn's whole answer, as given (a string), in place of the planned notes.
// On pi, "Fail the job." has the job's turn fail (the model's error), and the end-of-run turn is answered all the same.
// A user message "Remember for next time: <text>" is what a person asks the agent to keep: on pi the job turn writes it
// to `.learning/notes.txt` first and says it saved it (what models do), and the end-of-run turn, which reads the whole
// conversation, answers it as a note, `remembered.md`. A job turn whose instructions say `Scribble: <JSON>` ([file, text]
// pairs) writes each into `.learning/` before it answers, one write a request.
// A line `Read: <JSON>` (an array of paths) has the job read each path first, one read a request, then answer: on pi with
// pi's own read tool, on the faux harness with the host's.
// On pi the instructions can also say "Answer once <file> exists." (the job's answer holds until the test makes that
// file), "Reflect once <file> exists." (the turn holds until the test makes that file) or "Reflect slowly." (the turn
// answers after a minute, or when it is aborted). A later message `Write: <JSON>` ([file, text] pairs) writes each file
// into `.learning/`, one write a request, then says "Written.": a follow-up that changes the run's copy.
// The server's grader is answered here too, on the agent's own model, by what the instructions say: "Grade: drop." keeps
// no note, "Grade: drop <file>." keeps every note but that one and merges none, "Grade: pending <file>." keeps that one
// to wait for its owner's OK (decision pending, origin you) and the rest (a <file> is a note's, a skill's SKILL.md or a
// draft's workflow.json), "Grade: risky <file>." keeps that one as the
// run's own (decision keep, origin run) and names it Risky, and the rest, "Grade: you <file>." keeps that one as what
// the user asked in their own words (decision keep, origin you), and the rest, "Grade: shop <file>." drops that one on
// General with the user's origin (a weak grader's call on a shop's policy) and merges none, "Grade: sly." says merge and keeps
// none, "Grade: garbage." is no JSON, "Grade: garbage once." no JSON to a prompt's first ask alone, "Grade: garbage saying <text>." no JSON with <text> in it (each _ a space), "Grade: fail." fails the call, "Grade: drop at length." keeps no note for a reason
// and a why whose first sentence runs past 140 characters, "Grade: drop saying <text>." keeps no note for a reason and a
// why that name <text>, "Grade: omit <file>." gives that file no item; anything else keeps every note. "Grade once <file> exists." holds the answer until the test makes that file
// (or the call is aborted). With
// AGENTRUN_TEST_FAUX_GRADE_HOLD set (in the server's environment), the grader answers only once it is aborted; set to
// `never`, it never answers at all, aborted or not. Each grader call is filed as a line in the file
// AGENTRUN_TEST_FAUX_CALLS names, with the model it ran on and the user's messages its prompt holds.
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
  if (once) return JSON.parse(once).filter(([file]) => !system.includes(`(${file})`));
  const always = /^Learn: (\[.*\])$/m.exec(system)?.[1];
  return always ? JSON.parse(always) : [];
}

/** A note's file, as an end-of-run turn gives one. */
export const note = (name, description, body = `${description}.\n`, extra = "") => `---\nname: ${name}\ndescription: ${description}\ntype: reference\n${extra}---\n${body}`;

/** The end-of-run turn's answer for `notes` ([file, text] pairs): one ```note block each, then "Reflected.". */
export const answerWith = (notes) => [...notes.map(([file, text]) => `\`\`\`note ${file}\n${text}${text.endsWith("\n") ? "" : "\n"}\`\`\``), "Reflected."].join("\n\n");

/** What a person asked the agent to keep, in `users` (the user messages' texts): the note the end-of-run turn gives for it. */
const remembered = (users) => {
  const said = users.map((text) => /Remember for next time: (.+)/.exec(text)?.[1]).filter(Boolean);
  return said.length ? [["remembered.md", `---\nname: What the user asked to keep\ndescription: The user's standing request\ntype: user\n---\n${said.join("\n")}\n`]] : [];
};
/** The end-of-run turn's whole answer, from the instructions in `system` and the conversation's user messages. */
const reflection = (system, users) => /^Answer: (".*")$/m.exec(system)?.[1] ? JSON.parse(/^Answer: (".*")$/m.exec(system)[1]) : answerWith([...planned(system), ...remembered(users)]);

const answerOf = (system) => (/Say your prompt\./.test(system) ? system : "Job answer.");
/** The paths the instructions in `system` have the job read before it answers. */
const readsOf = (system) => JSON.parse(/^Read: (\[.*\])$/m.exec(system)?.[1] ?? "[]");

/** Resolves after `ms`, or as an aborted reply as soon as the turn is stopped. */
const slow = (faux, ms, text) =>
  new Promise((resolve) => {
    if (faux.signal?.aborted) return resolve(faux.message("", { stopReason: "aborted" }));
    const timer = setTimeout(() => resolve(faux.message(text)), ms);
    faux.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(faux.message("", { stopReason: "aborted" }))), { once: true });
  });

/** The grader's answer to `prompt`, by the agent's instructions fenced in it. */
function grade(prompt, faux) {
  // What the user said, as the prompt fences it: one entry a message.
  const said = /----- begin (\w+): the user's messages -----\n([\s\S]*?)\n----- end \1 -----/.exec(prompt)?.[2];
  if (process.env.AGENTRUN_TEST_FAUX_CALLS) appendFileSync(process.env.AGENTRUN_TEST_FAUX_CALLS, `${JSON.stringify({ kind: "grade", model: faux.model, asked: said === undefined ? [] : said.split("\n\n") })}\n`);
  const rules = /----- begin (\w+): the agent's standing instructions -----\n([\s\S]*?)----- end \1 -----/.exec(prompt)?.[2] ?? "";
  const files = /^Give one item for each of these files, each once, and for no other: (.*)\.$/m.exec(prompt)?.[1].split(", ") ?? [];
  if (process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD === "never") return new Promise(() => {});
  if (process.env.AGENTRUN_TEST_FAUX_GRADE_HOLD) return slow(faux, 600_000, "");
  // "Grade: garbage once.": no JSON to the first ask of a prompt alone; the host's one more ask is answered as any other.
  const asked = (ASKS.get(prompt) ?? 0) + 1;
  ASKS.set(prompt, asked);
  if (rules.includes("Grade: garbage once.") && asked === 1) return faux.message("Looks fine to me, once.");
  const gate = /Grade once (\S+) exists\./.exec(rules)?.[1];
  if (gate) {
    return (async () => {
      while (!(await access(gate).then(() => true, () => false))) {
        if (faux.signal?.aborted) return faux.message("", { stopReason: "aborted" });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return verdictOf(rules, files, faux);
    })();
  }
  return verdictOf(rules, files, faux);
}

/** How many times the grader was asked each prompt (the host asks again, with the same prompt, an answer it could not read). */
const ASKS = new Map();

/** The grader's verdict on `files`, by the agent's instructions `rules`. */
function verdictOf(rules, files, faux) {
  if (rules.includes("Grade: fail.")) return faux.message("", { stopReason: "error", errorMessage: "the faux grader failed on purpose" });
  if (rules.includes("Grade: garbage.")) return faux.message("Looks fine to me.");
  // "Grade: garbage saying <text>.": no JSON, with <text> in it, each _ a space, to every ask.
  const babble = /Grade: garbage saying (\S+)\./.exec(rules)?.[1];
  if (babble) return faux.message(`Looks fine to me. ${babble.replaceAll("_", " ")}`);
  const long = rules.includes("Grade: drop at length.");
  const saying = /Grade: drop saying (\S+)\./.exec(rules)?.[1];
  const keep = !rules.includes("Grade: drop.") && !rules.includes("Grade: sly.") && !long && !saying;
  const dropped = /Grade: drop (\S+\.(?:md|json))\./.exec(rules)?.[1];
  // "Grade: pending <file>.": that note is a risky rule the user asked for, kept to wait for their OK.
  const waits = /Grade: pending (\S+\.(?:md|json))\./.exec(rules)?.[1];
  // "Grade: risky <file>.": a risky rule the run worked out itself, which the grader keeps and names Risky.
  const risky = /Grade: risky (\S+\.md)\./.exec(rules)?.[1];
  // "Grade: you <file>.": a note that keeps what the user asked, kept active with the user's origin.
  const theirs = /Grade: you (\S+\.md)\./.exec(rules)?.[1];
  // "Grade: shop <file>.": what the user asked to remember, dropped on General as one shop's policy, as a weak grader
  // does; the verdict then merges nothing.
  const shop = /Grade: shop (\S+\.md)\./.exec(rules)?.[1];
  if (shop) return faux.message(JSON.stringify({ merge: false, reason: "The note records a policy specific to this shop, so it is not general enough to keep.", items: files.map((file) => (file === shop ? { file, decision: "drop", origin: "you", question: "General", why: "It records a shop-specific refund policy rather than a general rule." } : { file, decision: "keep", origin: "run", why: "It holds as a general rule." })) }));
  const kept = (file) => keep && file !== dropped;
  // "Grade: omit <file>.": an answer that gives that file no item, which the host refuses (parseVerdict).
  const omitted = /Grade: omit (\S+\.(?:md|json))\./.exec(rules)?.[1];
  if (omitted) return faux.message(JSON.stringify({ merge: true, reason: "Each note is general and new.", items: files.filter((file) => file !== omitted).map((file) => ({ file, decision: "keep", why: "It holds." })) }));
  return faux.message(JSON.stringify({
    merge: (keep && !dropped) || rules.includes("Grade: sly."),
    reason: keep && !dropped ? "Each note is general and new." : saying ? `A note is about ${saying} alone, which no later run can use. Drop it.` : long ? `A note is about the one case it came from, and it holds nothing a later run of this agent could use on another shop, so it is not kept. Drop it.` : "A note is about the one case it came from.",
    items: files.map((file) => (file === waits && kept(file) ? { file, decision: "pending", origin: "you", question: "Risky", why: "The user asked for a rule that widens trust." } : file === risky && kept(file) ? { file, decision: "keep", origin: "run", question: "Risky", why: "The run's own rule widens trust in a seller." } : file === theirs && kept(file) ? { file, decision: "keep", origin: "you", why: "The user asked to keep it." } : { file, keep: kept(file), ...(kept(file) ? {} : { question: "General" }), why: kept(file) ? "It holds as a general rule." : saying ? `It is about ${saying} alone, which no later run can use. Drop it.` : long ? "It is about the one case it came from, and it holds nothing a later run of this agent could use on another shop, so it is not kept. Drop it." : "It is about one case." })),
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
  // The runner's one re-ask of an answer its parser refused (learn/reflect.ts reflectAgain) is the end-of-run turn too:
  // answered as the turn was.
  const again = /^Your answer could not be read: /.test(last);
  const done = context.messages.slice(context.messages.findLastIndex((m) => m.role === "user")).filter((m) => m.role === "toolResult").length;
  const writes = /^Write: (\[.*\])$/m.exec(last)?.[1];
  if (writes) {
    const files = JSON.parse(writes);
    if (done >= files.length) return faux.message("Written.");
    return faux.message(faux.toolCall("write", { path: `.learning/${files[done][0]}`, content: files[done][1] }), { stopReason: "toolUse" });
  }
  // The job's own turn: a person's "remember" written down first, then any scribbles, then its answer.
  if (!asked && !again) {
    const said = /Remember for next time: (.+)/.exec(last)?.[1];
    const notes = [...(said ? [["notes.txt", `${said}\n`]] : []), ...JSON.parse(/^Scribble: (\[.*\])$/m.exec(system)?.[1] ?? "[]")];
    if (done < notes.length) return faux.message(faux.toolCall("write", { path: `.learning/${notes[done][0]}`, content: notes[done][1] }), { stopReason: "toolUse" });
    if (said) return faux.message("Got it: I saved that in .learning/notes.txt.");
  }
  if (!asked && !again && /Fail the job\./.test(system)) return faux.message("", { stopReason: "error", errorMessage: "the faux job failed on purpose" });
  const held = /Answer once (\S+) exists\./.exec(system)?.[1];
  if (!asked && !again && held) {
    return (async () => {
      while (!(await access(held).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
      return faux.message(answerOf(system));
    })();
  }
  const reads = readsOf(system);
  if (!asked && !again && done < reads.length) return faux.message(faux.toolCall("read", { path: reads[done] }), { stopReason: "toolUse" });
  if (!asked && !again) return faux.message(answerOf(system));
  return (async () => {
    const gate = /Reflect once (\S+) exists\./.exec(system)?.[1];
    while (gate && !(await access(gate).then(() => true, () => false))) await new Promise((resolve) => setTimeout(resolve, 20));
    if (/Reflect slowly\./.test(system)) return slow(faux, 60_000, "Too late.");
    // "Reflect by writing first.": the end-of-run turn tries to write a note as a file first, then answers.
    if (/Reflect by writing first\./.test(system) && done === 0) return faux.message(faux.toolCall("write", { path: ".learning/written.md", content: "A note as a file.\n" }), { stopReason: "toolUse" });
    return faux.message(reflection(system, users));
  })();
}

/** As a faux harness (claude-agent and codex): the job's answer, then the end-of-run turn's answer, its notes in it. */
export function script(spec) {
  const system = spec.system.join("\n");
  const reads = readsOf(system).map((path) => ({ call: "read", args: { path }, usd: 0.001 }));
  return [...reads, { say: answerOf(system), usd: 0.001 }, { end: true, usd: 0.001 }, { say: reflection(system, []), usd: 0.001 }, { end: true, usd: 0.001 }];
}
