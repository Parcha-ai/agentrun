// A faux model for the subagent tests (runner/subagent.ts). The run's own conversation reads its person's first line:
// "Delegate <json array>" makes one subagent call per item in one turn (pi runs them at once), then answers with every
// result, "Results: <one> | <two> ..."; "Call <tool> with <json>" makes that one call, then answers "Results: <result>".
// A child (its system prompt says it is a subagent) reads its prompt: "Say <text>" answers it; "Wait <ms> then say
// <text>" answers it after a wait; "Call <tool> with <json>" makes that call once, then answers "Tool said: <result>";
// "Read forever <path>" reads the file on every turn and never answers (a test's cap ends it); "Tools?" answers the
// names of the tools it was offered; "Cut <text>" answers <text> cut at its output limit; "Hold <text>" answers <text> once the file $FAUX_SUBAGENT_RELEASE exists, holding
// its request open until then (a stop or a cancel aborts it, noted as `aborted`). Each request is one JSON line in
// $FAUX_SUBAGENT_LOG (its model, whether a child asked, the tools offered, the first line it was asked, and when a wait
// ran or a hold began), when a test names that file.
//
// Every request is priced at a fixed usage (`usage`, `cost`): 1,000 input and 100 output tokens at $1 and $10 a
// million, $0.002 a request, so a test reads what a run spent from how many requests it made.
import { appendFileSync, existsSync } from "node:fs";

export const cost = { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 };
export const maxTokens = 1000;
export const usage = () => ({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
export const LOG_ENV = "FAUX_SUBAGENT_LOG";
export const RELEASE_ENV = "FAUX_SUBAGENT_RELEASE";

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join(""));
const note = (line) => {
  const file = process.env[LOG_ENV];
  if (file) appendFileSync(file, `${JSON.stringify(line)}\n`);
};
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

export default async function reply(context, faux) {
  // pi-ai's context: its system text and tools, as fields or as system messages that add tools (toolsAdded).
  const systems = context.messages.filter((m) => m.role === "system");
  const system = [context.systemPrompt ?? "", ...systems.map((m) => textOf(m))].join("\n");
  const child = system.includes("You are a subagent.");
  const tools = [...new Set([...(context.tools ?? []), ...systems.flatMap((m) => m.toolsAdded ?? [])].map((tool) => tool.name))];
  const asker = context.messages.findIndex((m) => m.role === "user");
  const asked = textOf(context.messages[asker]).split("\n")[0];
  note({ model: faux.model, child, tools, asked });
  const results = context.messages.slice(asker + 1).filter((m) => m.role === "toolResult");
  if (!child) {
    if (results.length) return faux.message(`Results: ${results.map((m) => textOf(m)).join(" | ")}`);
    const delegate = /^Delegate (\[.*\])$/.exec(asked);
    if (delegate) return faux.message(JSON.parse(delegate[1]).map((args) => faux.toolCall("subagent", args)), { stopReason: "toolUse" });
    const call = /^Call (\S+) with (\{.*\})$/.exec(asked);
    if (call) return faux.message(faux.toolCall(call[1], JSON.parse(call[2])), { stopReason: "toolUse" });
    return faux.message("Answered.");
  }
  if (asked === "Tools?") return faux.message(`Offered: ${tools.join(",")}`);
  const say = /^Say (.*)$/.exec(asked);
  if (say) return faux.message(say[1]);
  const wait = /^Wait (\d+) then say (.*)$/.exec(asked);
  if (wait) {
    const from = Date.now();
    await sleep(Number(wait[1]), faux.signal);
    note({ wait: wait[2], from, until: Date.now() });
    return faux.message(wait[2]);
  }
  // "Cut <text>": an answer its provider cut at the output limit.
  const cut = /^Cut (.*)$/.exec(asked);
  if (cut) return faux.message(cut[1], { stopReason: "length" });
  const hold = /^Hold (.*)$/.exec(asked);
  if (hold) {
    note({ held: hold[1] });
    const release = process.env[RELEASE_ENV];
    while (!(release && existsSync(release))) {
      if (faux.signal?.aborted) {
        note({ aborted: hold[1] });
        return faux.message("(aborted)");
      }
      await sleep(25, faux.signal);
    }
    return faux.message(hold[1]);
  }
  const forever = /^Read forever (\S+)$/.exec(asked);
  if (forever) return faux.message(faux.toolCall("read", { path: forever[1] }), { stopReason: "toolUse" });
  const call = /^Call (\S+) with (\{.*\})$/.exec(asked);
  if (call) {
    if (results.length) return faux.message(`Tool said: ${textOf(results.at(-1))}`);
    return faux.message(faux.toolCall(call[1], JSON.parse(call[2])), { stopReason: "toolUse" });
  }
  return faux.message("Child answered.");
}
