// Kept trajectories to training text. A run is kept only when its code check passed; then every teacher turn must have
// the format's shape (short thinking, then exactly one call or the final answer), or the run is left out with the reason.
// The teacher's own reasoning is dropped; its visible <thinking> sentence becomes the thinking block.
//
//   node export.ts --runs train-runs.jsonl[,more.jsonl] --out train-text.jsonl [--split train] [--cap 12]
//
// --cap keeps at most that many runs per template (in file order), so no template dominates.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { THINK_MAX_WORDS, TOOLS, renderTranscript, type Msg } from "./tool-format.ts";

const { values: a } = parseArgs({ options: { runs: { type: "string" }, out: { type: "string" }, split: { type: "string", default: "train" }, "max-chars": { type: "string", default: "12000" }, cap: { type: "string", default: "0" } } });

const plain = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** The teacher's messages in the format's canonical form, or why the run cannot teach. */
export function canonical(messages: any[]): { messages: Msg[] } | { reject: string } {
  const out: Msg[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") } as Msg);
    } else if (m.role === "toolResult") {
      out.push({ role: "toolResult", toolCallId: m.toolCallId, toolName: m.toolName, content: m.content.filter((b: any) => b.type === "text"), isError: m.isError } as Msg);
    } else if (m.role === "assistant") {
      const text = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const calls = m.content.filter((b: any) => b.type === "toolCall");
      const t = /^\s*<thinking>([\s\S]*?)<\/thinking>\s*([\s\S]*)$/.exec(text);
      if (!t) return { reject: calls.length ? "call without thinking" : "answer without thinking" };
      const thinking = plain(t[1]!), rest = plain(t[2]!);
      if (!thinking) return { reject: "empty thinking" };
      if (words(thinking) > THINK_MAX_WORDS) return { reject: "thinking too long" };
      if (/<\/?thinking>|<tool_call>|to=functions/.test(rest) || /<\/?thinking>/.test(thinking)) return { reject: "format leaked into text" };
      if (calls.length > 1) return { reject: "several calls in one turn" };
      if (calls.length === 1) {
        if (rest) return { reject: "text beside a call" };
        const c = calls[0];
        out.push({ role: "assistant", content: [{ type: "thinking", thinking }, { type: "toolCall", id: c.id, name: c.name, arguments: c.arguments }] } as Msg);
      } else {
        if (!rest) return { reject: "empty answer" };
        out.push({ role: "assistant", content: [{ type: "thinking", thinking }, { type: "text", text: rest }] } as Msg);
      }
    }
  }
  const last = out[out.length - 1] as any;
  if (!last || last.role !== "assistant" || last.content.some((b: any) => b.type === "toolCall")) return { reject: "does not end with an answer" };
  return { messages: out };
}

if (process.argv[1]?.endsWith("export.ts")) {
  const runs = a.runs!.split(",").flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.split === a.split);
  const rejected: Record<string, number> = {};
  const rows: string[] = [];
  const perTemplate: Record<string, number> = {};
  let chars = 0, calls = 0, thinkWords = 0, turns = 0;
  for (const r of runs) {
    let why: string | undefined;
    let text = "", train: [number, number][] = [];
    if (!r.ok) why = "check failed";
    else {
      const c = canonical(r.messages);
      if ("reject" in c) why = c.reject;
      else {
        ({ text, train } = renderTranscript(TOOLS, c.messages));
        if (text.length > Number(a["max-chars"])) why = "too long";
        else {
        }
      }
    }
    if (!why && Number(a.cap) && (perTemplate[r.template] ?? 0) >= Number(a.cap)) why = "over the cap";
    if (why) { rejected[why] = (rejected[why] ?? 0) + 1; continue; }
    for (const m of (canonical(r.messages) as { messages: any[] }).messages) {
      if (m.role === "assistant") { turns++; thinkWords += words(m.content[0].thinking); calls += m.content[1].type === "toolCall" ? 1 : 0; }
    }
    rows.push(JSON.stringify({ id: r.id, template: r.template, text, train }));
    perTemplate[r.template] = (perTemplate[r.template] ?? 0) + 1;
    chars += text.length;
  }
  writeFileSync(a.out!, rows.join("\n") + "\n");
  const counts = Object.values(perTemplate);
  console.log(JSON.stringify({
    event: "export", runs: runs.length, kept: rows.length, rejected, templates: counts.length,
    per_template_min: Math.min(...counts), per_template_max: Math.max(...counts),
    calls_per_run: +(calls / rows.length).toFixed(2), thinking_words_per_turn: +(thinkWords / turns).toFixed(1), chars_per_run: Math.round(chars / rows.length),
  }));
}
