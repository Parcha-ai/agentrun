// A faux model for the template eval runner's tests (template-eval.test.mjs): it answers both the package's agent and
// the eval's grader agent, no key and no network.
//
// The package's agent follows its run's input, one step a request:
// - `Call <tool> with <json>`, one line each: that call, in order (an MCP tool by its wire name, mcp__<server>__<tool>);
// - `Write <path>: <text>`: the write tool, making that file in the run's work folder;
// - `Page through the filed answer`: as a model that follows the words it is given would, the read tool on the file the
//   last result says the whole answer is filed at (`in the run's files at <path>`), from the line that result names
//   (`offset=<n>`), then again from each `offset=<n>` the read answers, until a read names none;
// - `Answer:` and the lines after it: the final answer, with `{{last-result}}` the text of the last tool result,
//   `{{tools}}` the names of the tools the run was given, `{{learned:<text>}}` yes or no for whether its instructions hold <text> (a seeded note's, under # Learned), and
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

/** The names of the tools the run was given: the context's, else those its messages added. */
const toolsOf = (context) => [...new Set([...(context.tools ?? []), ...context.messages.flatMap((m) => m.toolsAdded ?? [])].map((tool) => tool.name))];

/** Where the last result says the whole answer is filed, and the line it says to go on from. */
const FILED = /in the run's files at (\S+?)(?=[\]:;,\s]|$)/;
const OFFSET = /offset=(\d+)/;

/** The input's next call, given the text of each result so far, or undefined once every step has its result. */
function nextCall(input, said) {
  let at = 0;
  for (const line of input.split("\n")) {
    const call = /^Call (\S+) with (\{.*\})$/.exec(line);
    const write = /^Write (\S+): (.*)$/.exec(line);
    if (call || write) {
      if (at < said.length) {
        at++;
        continue;
      }
      return call ? [call[1], JSON.parse(call[2])] : ["write", { path: write[1], content: `${write[2]}\n` }];
    }
    if (line !== "Page through the filed answer") continue;
    const path = FILED.exec(said[at - 1] ?? "")?.[1];
    if (!path) continue;
    let offset = OFFSET.exec(said[at - 1])?.[1];
    for (;;) {
      if (at === said.length) return ["read", { path, ...(offset ? { offset: Number(offset) } : {}) }];
      offset = OFFSET.exec(said[at++])?.[1];
      if (!offset) break;
    }
  }
  return undefined;
}

export default function reply(context, faux) {
  const system = systemOf(context);
  if (system.includes("You grade one run of an AI agent against one rubric.")) return grade(context, faux);
  const users = context.messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const last = users.at(-1) ?? "";
  if (last.startsWith("The task is done. Before the run ends")) return faux.message("No notes.");
  const input = users[0] ?? "";
  const results = context.messages.filter((m) => m.role === "toolResult");
  const next = nextCall(input, results.map((result) => textOf(result.content)));
  if (next) return faux.message(faux.toolCall(...next), { stopReason: "toolUse" });
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
    .replaceAll("{{tools}}", toolsOf(context).join(", "))
    .replace(/\{\{learned:([^}]+)\}\}/g, (_, text) => (system.includes(text) ? "yes" : "no"))
    .replace(/\{\{flaky:([^|}]*)\|([^}]*)\}\}/g, (_, a, b) => flaky(a, b)));
}
