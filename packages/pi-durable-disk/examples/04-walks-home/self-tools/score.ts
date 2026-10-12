// The numbers for scored runs (drive.ts --brain local): success by code check, valid calls, steps, tokens, and why the
// failures failed. Every category is decided in code from the run record, first match wins:
//
//   error          the driver or the server failed
//   malformed      a call that did not parse (bad JSON, not closed): free decoding only, in practice
//   looped         the call limit or the time limit ended the run
//   wrong-tool     a call to a tool that does not exist, or the run never used a tool the teacher used in at least 80% of
//                  its passing runs of that template (e.g. edit to "rename" a file, where the teacher ran mv)
//   stopped-early  fewer calls than the teacher's fewest for that template (e.g. answered without running the script)
//   bad-args       the right tools, but a call failed (missing file, oldText not found, a script exiting non-zero) or
//                  ran and did the wrong thing (wrong line edited, wrong script written)
//   wrong-answer   the right tools and no tool error, but the value the answer states is wrong (counting, reading)
//
//   node score.ts --teacher teacher-runs.jsonl[,more.jsonl] runs.jsonl [more.jsonl ...]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { checksAnswer } from "./tasks.ts";
import { parseModelTurn } from "../../03-tab-to-cloud/tab/tool-format.ts";

/** A turn's call problem, parsed again from its raw text (so a parser fix applies to old runs too). */
const problemOf = (t: any): string | null => parseModelTurn(t.raw).problem?.kind ?? null;

const callsOf = (r: any): any[] => (r.messages ?? []).filter((m: any) => m.role === "assistant").flatMap((m: any) => m.content.filter((b: any) => b.type === "toolCall"));

export interface TeacherProfile { tools: Set<string>; minCalls: number }

/** Per template: the tools in at least 80% of the teacher's passing runs, and its fewest calls. */
export function teacherProfiles(runs: any[]): Map<string, TeacherProfile> {
  const by = new Map<string, any[]>();
  for (const r of runs.filter((x) => x.ok)) by.set(r.template, [...(by.get(r.template) ?? []), r]);
  const out = new Map<string, TeacherProfile>();
  for (const [t, rs] of by) {
    const count = new Map<string, number>();
    for (const r of rs) for (const name of new Set(callsOf(r).map((c) => c.name))) count.set(name, (count.get(name) ?? 0) + 1);
    out.set(t, { tools: new Set([...count].filter(([, n]) => n >= 0.8 * rs.length).map(([k]) => k)), minCalls: Math.min(...rs.map((r) => callsOf(r).length)) });
  }
  return out;
}

export function category(r: any, teacher: Map<string, TeacherProfile>): string {
  if (r.ended === "driver-error" || r.ended === "error") return "error";
  const turns: any[] = r.turns ?? [];
  if (turns.some((t) => ["bad-json", "no-close", "not-an-object"].includes(problemOf(t) ?? ""))) return "malformed";
  if (r.ended === "max-calls" || r.ended === "timeout") return "looped";
  const calls = callsOf(r);
  const used = new Set(calls.map((c) => c.name));
  const prof = teacher.get(r.template);
  if (turns.some((t) => problemOf(t) === "unknown-tool") || [...used].some((n) => !["read", "write", "edit", "bash"].includes(n))) return "wrong-tool";
  if (prof && [...prof.tools].some((t) => !used.has(t))) return "wrong-tool";
  if (prof && calls.length < prof.minCalls) return "stopped-early";
  if ((r.messages ?? []).some((m: any) => m.role === "toolResult" && m.isError)) return "bad-args";
  return checksAnswer(r.template) ? "wrong-answer" : "bad-args";
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(rows: any[], teacher: Map<string, TeacherProfile> = new Map()) {
  const n = rows.length;
  const ok = rows.filter((r) => r.ok).length;
  const turns = rows.flatMap((r) => r.turns ?? []);
  const attempts = turns.filter((t) => t.raw.includes("<tool_call>"));
  const valid = attempts.filter((t) => !problemOf(t));
  const calls = rows.map((r) => r.calls ?? 0);
  const gen = rows.map((r) => (r.turns ?? []).reduce((a: number, t: any) => a + t.outputTokens, 0));
  // Prompt tokens per task, over tasks whose every turn reported its count (a capped stream may not).
  const prompt = rows.filter((r) => (r.turns ?? []).every((t: any) => t.promptKnown !== false)).map((r) => (r.turns ?? []).reduce((a: number, t: any) => a + t.promptTokens, 0));
  const think = turns.filter((t) => t.thinkTokens >= 0).map((t) => t.thinkTokens);
  const fails: Record<string, string[]> = {};
  for (const r of rows.filter((x) => !x.ok)) (fails[category(r, teacher)] ??= []).push(r.id);
  return {
    n, ok, success: pct(ok, n), validCalls: `${valid.length}/${attempts.length} (${pct(valid.length, attempts.length)})`,
    callsPerTask: +mean(calls).toFixed(2), turnsPerTask: +(turns.length / n).toFixed(2),
    generatedTokensPerTask: Math.round(mean(gen)), promptTokensPerTask: Math.round(mean(prompt)),
    thinkTokensPerTurn: think.length ? +mean(think).toFixed(1) : null, thinkingCut: turns.filter((t) => t.thinkingCut).length,
    wallPerTask: +mean(rows.map((r) => r.wall_s ?? 0)).toFixed(1),
    failures: Object.fromEntries(Object.entries(fails).map(([k, v]) => [k, v.length])), failureIds: fails,
  };
}

if (process.argv[1]?.endsWith("score.ts")) {
  const { values, positionals } = parseArgs({ options: { teacher: { type: "string" } }, allowPositionals: true });
  const read = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const teacher = teacherProfiles((values.teacher ?? "").split(",").filter(Boolean).flatMap(read));
  for (const f of positionals) {
    const { failureIds, ...s } = summarize(read(f), teacher);
    console.log(JSON.stringify({ file: f.split("/").pop(), ...s }));
  }
}
