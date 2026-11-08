// A faux model for the template eval runner's tests (template-eval.test.mjs): it answers both the package's agent and
// the eval's grader agent, no key and no network.
//
// The package's agent follows its run's input, one step a request:
// - `Call <tool> with <json>`, one line each: that call, in order (an MCP tool by its wire name, mcp__<server>__<tool>);
// - `Write <path>: <text>`: the write tool, making that file in the run's work folder;
// - `Answer:` and the lines after it: the final answer, with `{{last-result}}` the text of the last tool result,
//   `{{learned:<text>}}` yes or no for whether its instructions hold <text> (a seeded note's, under # Learned), and
//   `{{flaky:<a>|<b>}}` <a> the first time any run of this server answers it and <b> after (a count kept in the file
//   AGENTRUN_TEST_EVAL_COUNTER names).
// - `Hold until stopped.`: with AGENTRUN_TEST_EVAL_HOLD set, the run writes that file once it holds, so a test knows the
//   run is in its turn, then holds until the turn is stopped; unset, it answers at once.
// The end-of-run learning turn is answered "No notes.".
//
// The grader agent (its instructions are template-eval.ts GRADER_INSTRUCTIONS) passes a run when every line of its
// rubric that says `Pass if the answer contains "<text>".` holds of the <answer> it was given (or of the <target>, when it
// was given one), and answers one fenced json block, {pass, reason}. Each grader input is appended to the file
// AGENTRUN_TEST_EVAL_GRADER_LOG names, as a line of JSON, so a test reads what the grader saw.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

/** A small price, so each run's and each grade's cost is known and above zero: $1 per million tokens each way. */
export const cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

const textOf = (value) => (typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");
const systemOf = (context) => [context.systemPrompt, ...context.messages.filter((m) => m.role === "system").flatMap((m) => [textOf(m.content), ...Object.values(m.sections ?? {}).map(textOf)])].filter(Boolean).join("\n");
const between = (text, open, close) => {
  const start = text.indexOf(open);
  if (start < 0) return undefined;
  const end = text.indexOf(close, start + open.length);
  return end < 0 ? undefined : text.slice(start + open.length, end);
};

function grade(context, faux) {
  const asked = textOf(context.messages.find((m) => m.role === "user")?.content);
  if (process.env.AGENTRUN_TEST_EVAL_GRADER_LOG) appendFileSync(process.env.AGENTRUN_TEST_EVAL_GRADER_LOG, `${JSON.stringify(asked)}\n`);
  const rubric = between(asked, "<rubric>\n", "\n</rubric>") ?? "";
  const target = /<target field="[^"]*" untrusted>\n/.exec(asked);
  const subject = target ? between(asked.slice(target.index), target[0], "\n</target>") : between(asked, "<answer untrusted>\n", "\n</answer>");
  const wanted = [...rubric.matchAll(/^Pass if the answer contains "([^"]+)"\.$/gm)].map((m) => m[1]);
  const missing = wanted.filter((text) => !(subject ?? "").includes(text));
  const verdict = missing.length ? { pass: false, reason: `the answer lacks ${missing.map((m) => JSON.stringify(m)).join(", ")}` } : { pass: true, reason: `the answer holds ${wanted.map((m) => JSON.stringify(m)).join(", ") || "what the rubric asks"}` };
  return faux.message(`I read the rubric and the answer.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``);
}

function flaky(first, later) {
  const file = process.env.AGENTRUN_TEST_EVAL_COUNTER;
  if (!file) return first;
  appendFileSync(file, "x\n");
  return readFileSync(file, "utf8").trim().split("\n").length === 1 ? first : later;
}

export default function reply(context, faux) {
  const system = systemOf(context);
  if (system.includes("You grade one run of an AI agent against one rubric.")) return grade(context, faux);
  const users = context.messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const last = users.at(-1) ?? "";
  if (last.startsWith("The task is done. Before the run ends")) return faux.message("No notes.");
  const input = users[0] ?? "";
  const steps = input.split("\n").flatMap((line) => {
    const call = /^Call (\S+) with (\{.*\})$/.exec(line);
    if (call) return [[call[1], JSON.parse(call[2])]];
    const write = /^Write (\S+): (.*)$/.exec(line);
    return write ? [["write", { path: write[1], content: `${write[2]}\n` }]] : [];
  });
  const results = context.messages.filter((m) => m.role === "toolResult");
  if (results.length < steps.length) return faux.message(faux.toolCall(...steps[results.length]), { stopReason: "toolUse" });
  const hold = process.env.AGENTRUN_TEST_EVAL_HOLD;
  if (input.includes("Hold until stopped.") && hold) {
    return new Promise((resolve) => {
      faux.signal?.addEventListener("abort", () => resolve(faux.message("", { stopReason: "aborted" })), { once: true });
      writeFileSync(hold, "");
    });
  }
  const at = input.indexOf("Answer:\n");
  const answer = at < 0 ? "Done." : input.slice(at + "Answer:\n".length);
  return faux.message(answer
    .replaceAll("{{last-result}}", textOf(results.at(-1)?.content ?? ""))
    .replace(/\{\{learned:([^}]+)\}\}/g, (_, text) => (system.includes(text) ? "yes" : "no"))
    .replace(/\{\{flaky:([^|}]*)\|([^}]*)\}\}/g, (_, a, b) => flaky(a, b)));
}
