// Which code-mode script a host tool's nested call belongs to. Written for AgentRun.
//
// A host tool a code-mode model's script calls arrives on the app-server's stream as a call under an id of Codex's own
// (`exec-<uuid>`) that carries no parent, no cell and no `exec` id, and the rollout holds no line for it until after it is
// answered. So the call is tied to the one script that can be running, and that is read from two places that cannot be
// ahead of Codex:
//  - the rollout: an `exec` call line opens a script, and it stays open until an output says it finished: its own, or, when
//    that says "Script running with cell ID N" (it yielded and went on), the output of the `wait` that finishes cell N;
//  - the model proxy: the `exec` the latest answer carried, which it read before Codex had that part of the answer, so
//    before the `exec`'s line could be in the rollout.
// The proxy offers no `exec` while a cell runs and no parallel calls, so one script is live at a time. A model that writes an
// `exec` anyway makes two live, and then a nested call cannot be told from the other's.
import { HOST_RESULT_MAX_CHARS } from "@parcha/agentrun-kernel";
import type { DriveContext } from "@parcha/agentrun-kernel/kernel";
import { boundResult } from "./host/process.js";
import { parseLine } from "./rollout.js";

/** The id Codex gives a host tool called from a code-mode script. */
export const NESTED_CALL = /^exec-[0-9a-f-]{36}$/;

/** What the session is told when the proxy could not watch an answer to its end: the answer may carry an `exec` it did not see, so
 *  no script can be told from it. It counts as a script of its own, one that is never in the log. */
export const UNWATCHED = "(unwatched answer)";

/** What to do with a nested call: run it under `exec`; hold it until `exec`'s line is in the rollout; refuse it, as two scripts
 *  are live; or hold it, as no script is known yet. */
export type Tie = { kind: "tied"; exec: string } | { kind: "held"; exec: string } | { kind: "ambiguous"; live: string[] } | { kind: "none" };

/** What a rollout line says of a script: its `exec` line opened it (`input`, the script), or an output finished it (`output`,
 *  that output's text; `failed`, the script failed, as its status header says). */
export type ScriptEvent = { kind: "opened"; exec: string; input: string } | { kind: "finished"; exec: string; output: string; failed: boolean };

/** Codex's status header of an exec's or a wait's output: the text it starts with (its first part), never what the script printed after it. */
const statusOf = (output: unknown): string =>
  typeof output === "string" ? output : Array.isArray(output) && typeof (output[0] as { text?: unknown } | undefined)?.text === "string" ? (output[0] as { text: string }).text : "";
/** A cell that yielded and still runs, as its status header says. */
const RUNNING = /^Script running with cell ID (\S+)/;
/** A script that failed (it threw, or its cell was gone), as its status header says. The rollout's output line has no
 *  status field of its own: this header is the only place Codex says how a script ended. */
const FAILED = /^Script failed\b/;

const textOf = (output: unknown): string =>
  typeof output === "string" ? output : Array.isArray(output) ? output.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";

export class Scripts {
  private readonly open: { exec: string; cell?: string; input: string }[] = [];
  /** The `exec` calls whose script finished. */
  private readonly done = new Set<string>();
  /** The cell each `wait` call in the rollout resumes. */
  private readonly waitsOn = new Map<string, string>();

  /** Reads one rollout line: what it says of a script, if anything. A script opened (its `exec` line, with its input, the
   *  script) or finished (the output that ended it: its own, or the `wait`'s on its cell). */
  note(line: string): ScriptEvent | undefined {
    if (!line.includes("call_id")) return undefined;
    const p = parseLine(line)?.payload;
    if (!p || typeof p.call_id !== "string") return undefined;
    const id: string = p.call_id;
    const running = RUNNING.exec(statusOf(p.output));
    if (p.type === "custom_tool_call" && p.name === "exec") {
      if (this.open.some((x) => x.exec === id)) return undefined;
      const input = typeof p.input === "string" ? p.input : "";
      this.open.push({ exec: id, input });
      return { kind: "opened", exec: id, input };
    } else if (p.type === "custom_tool_call_output") {
      const at = this.open.findIndex((x) => x.exec === id);
      if (at < 0) return undefined;
      if (running) this.open[at]!.cell = running[1]!;
      else return this.finish(at, p.output);
    } else if (p.type === "function_call" && p.name === "wait") {
      try {
        const cell = (JSON.parse(String(p.arguments)) as { cell_id?: unknown }).cell_id;
        if (cell !== undefined) this.waitsOn.set(id, String(cell));
      } catch {}
    } else if (p.type === "function_call_output" && this.waitsOn.has(id) && !running) {
      const at = this.open.findIndex((x) => x.cell === this.waitsOn.get(id));
      if (at >= 0) return this.finish(at, p.output);
    }
    return undefined;
  }

  private finish(at: number, output: unknown): ScriptEvent {
    const exec = this.open.splice(at, 1)[0]!.exec;
    this.done.add(exec);
    return { kind: "finished", exec, output: textOf(output), failed: FAILED.test(statusOf(output)) };
  }

  /** The script of an unfinished `exec` whose line the rollout holds; none for any other. */
  inputOf(exec: string): string | undefined {
    return this.open.find((x) => x.exec === exec)?.input;
  }

  /** The scripts that may call a host tool now: the rollout's unfinished ones, and the `exec` the proxy's latest answer carried
   *  if it is not among them and has not finished (its line may not be in the rollout yet). */
  live(announced?: string): string[] {
    const live = this.open.map((x) => x.exec);
    if (announced && !this.done.has(announced) && !live.includes(announced)) live.push(announced);
    return live;
  }

  /** What to do with a nested call now, given the exec the proxy announced and whether a call id is in the rollout. */
  tie(announced: string | undefined, logged: (callId: string) => boolean): Tie {
    const live = this.live(announced);
    if (live.length > 1) return { kind: "ambiguous", live };
    if (live.length === 0) return { kind: "none" };
    return logged(live[0]!) ? { kind: "tied", exec: live[0]! } : { kind: "held", exec: live[0]! };
  }
}

/** What the rollout's `item_completed` line says of a nested call: Codex writes it after the call was answered, so a crash
 *  before it leaves none. */
export interface RolloutNested {
  tool: string;
  ok: boolean;
  text: string;
}

/** The nested calls the rollout's lines hold a completion for, by their `exec-<uuid>` id. */
export function completedNested(lines: readonly string[]): Map<string, RolloutNested> {
  const out = new Map<string, RolloutNested>();
  for (const raw of lines) {
    if (!raw.includes("DynamicToolCall")) continue;
    const line = parseLine(raw);
    const p = line?.payload as { type?: unknown; item?: { type?: unknown; id?: unknown; tool?: unknown; status?: unknown; success?: unknown; content_items?: unknown } } | undefined;
    const item = p?.item;
    if (line?.type !== "event_msg" || p?.type !== "item_completed" || item?.type !== "DynamicToolCall" || typeof item.id !== "string") continue;
    if (item.status !== "completed" && item.status !== "failed") continue;
    out.set(item.id, { tool: String(item.tool ?? ""), ok: item.success !== false && item.status === "completed", text: textOf(item.content_items) });
  }
  return out;
}

/** One nested call of a cut-off `exec`, as the two sources have it. */
export interface NestedFact {
  callId: string;
  tool: string;
  /** The session's own record (the effect of `tool:<id>`): none when the call never started. */
  store?: { status: "completed" | "failed" | "started"; text?: string; interrupted?: boolean; /** What a script's nested call was sent for a tool with a value (scriptAnswer: the value as JSON, its images' data in it), which the rollout holds instead of `text`. */ sent?: string };
  /** What the harness's recovery note of the same turn calls it (the kernel's one rule, process/recovery.ts): `retryable` is a
   *  safe tool's call that a crash cut off, which the note tells the model is safe to repeat. */
  told?: "completed" | "failed" | "interrupted" | "retryable" | "running";
  rollout?: RolloutNested;
  /** The host parked the call for a person's approval (`parkedKey`'s record): it did not run, whatever its record says. */
  parked?: true;
  /** Asked again on this resume (code-mode.ts recoverItems): it never reached its intent before, as a park at the host's gate
   *  leaves a call, and went through the gate now, the person's answer on it: what it answered, and whether it ran (a refusal
   *  never does). */
  resumed?: { text: string; isError: boolean; ran: boolean };
}

export type Settled = { kind: "completed"; text: string } | { kind: "failed"; text: string } | { kind: "interrupted" } | { kind: "parked" };

/** The session's record that the host parked the call `callId` for a person's approval, so it did not run: what the call
 *  was answered (the host's waiting text) reads as its outcome, and is none. */
export const parkedKey = (callId: string): string => `parked:${callId}`;

/** Records that the host parked `callId` (a host tool's or a remote MCP server's), before its answer is recorded: a parked
 *  call is never told as completed, after a crash either. */
export const markParked = (ctx: DriveContext, callId: string): Promise<unknown> => ctx.effect(parkedKey(callId), { name: "parked", replay: "safe", input: null }, async () => true);

/** What a nested call came to. A call the host parked is `parked`, whatever else holds: it never ran. Else the store's record first, the rollout's completion second: both complete and agreeing, or
 *  one of them, is that outcome; both complete and disagreeing, or a call that started and has no end in either, is
 *  interrupted (its effect is unknown), and a failure the store marks interrupted is interrupted. They agree when the
 *  rollout holds what the bridge handed Codex for the stored text: the store's text held to the host's bound
 *  (`boundResult`), since the store keeps a result whole and Codex got its cut; or the stored text itself, as a session
 *  written before that bound holds it in both records. */
export function settle(fact: NestedFact): Settled {
  if (fact.parked) return { kind: "parked" };
  const { store, rollout } = fact;
  const stored = store?.status === "completed" ? ({ kind: "completed", text: store.text ?? "" } as const) : store?.status === "failed" && !store.interrupted ? ({ kind: "failed", text: store.text ?? "" } as const) : undefined;
  const rolled = rollout ? ({ kind: rollout.ok ? "completed" : "failed", text: rollout.text } as const) : undefined;
  if (stored && rolled) return stored.kind === rolled.kind && (rolled.text === stored.text || rolled.text === boundResult(stored.text).text || (store?.sent !== undefined && rolled.text === store.sent)) ? stored : { kind: "interrupted" };
  return stored ?? rolled ?? { kind: "interrupted" };
}

/** The most a recovered script's output holds (a cut-off `exec`'s, or the `wait` on its cell): one result at the host's bound, as
 *  the script was handed it, and the words that tell each call's outcome around it. It stands in for the script's own output,
 *  which the model reads as one tool result. Past it, every result it quotes is cut to the same share, each keeping its start
 *  and its last line (a filed answer's says where the whole is) and saying where it was cut (`cut`): never silently, and every
 *  call's outcome is still told. Only when the lines alone pass it is the output itself cut, with its note: the calls past
 *  the cut are not in it, and the recovery note does not say they are (`Recovered.shown`). */
export const EXEC_RECOVERY_MAX_CHARS = HOST_RESULT_MAX_CHARS + 2_000;

/** A last line longer than this is not kept when a result is cut: it is the result's own text, not a pointer to the rest. */
const LAST_LINE_MAX = 1_000;

/** `text` within `cap` characters: whole when it fits; else its start, a line saying where it was cut (as `boundResult`'s
 *  does), and its last line when that is short (a filed answer's, which says where the whole is), never splitting a
 *  character written as a surrogate pair. Whole, too, when the cut would be no shorter (a short result is never swapped
 *  for a longer line saying it was cut). `kept`: how much of the start of `text` is there. */
function cut(text: string, cap: number): { text: string; kept: number } {
  if (text.length <= cap) return { text, kept: text.length };
  const at = text.lastIndexOf("\n");
  const last = at >= 0 && text.length - at <= LAST_LINE_MAX ? text.slice(at) : "";
  const note = (kept: number) => `\n[cut at ${kept} of ${text.length} characters]`;
  let kept = Math.max(0, cap - note(cap).length - last.length);
  if (kept > 0 && (text.charCodeAt(kept - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(kept) & 0xfc00) === 0xdc00) kept -= 1;
  const short = `${text.slice(0, kept)}${note(kept)}${last}`;
  return short.length < text.length ? { text: short, kept } : { text, kept: text.length };
}

/** One call's line in a recovered output: its words, and the result or error it quotes (`text`, as JSON) between them.
 *  `callId` and `shows`: the call, and whether the line tells its outcome (`outcomeShown`). */
type Told = { head: string; text?: string; tail: string; callId?: string; shows?: boolean };

/** A told call's line, the text it quotes held to `cap`. */
const lineOf = (told: Told, cap: number): string => (told.text === undefined ? `${told.head}${told.tail}` : `${told.head}${JSON.stringify(cut(told.text, cap).text)}${told.tail}`);

/** A recovered output, and the calls whose outcome it tells (`shown`): each whose line is whole in it and quotes some of its
 *  result or error (all of it, or its start with the line saying where it was cut). */
export interface Recovered {
  output: string;
  shown: string[];
}

/** A recovered output built by `build` from its calls' lines (`told`, in the order `build` writes them) at a cap on each
 *  quoted text: whole when it fits in EXEC_RECOVERY_MAX_CHARS; else at the largest cap that fits (the same for every quoted
 *  text); else, the lines alone passing the bound, the output cut to the bound with its note, and the calls past the cut
 *  not in it. */
function fitted(told: readonly Told[], build: (cap: number) => string): Recovered {
  const at = (cap: number, output: string, limit = output.length): Recovered => {
    const shown: string[] = [];
    let from = 0;
    for (const t of told) {
      const line = lineOf(t, cap);
      const pos = output.indexOf(line, from);
      if (pos < 0 || pos + line.length > limit) break;
      from = pos + line.length;
      if (t.shows && t.callId !== undefined && (t.text === undefined || t.text === "" || cut(t.text, cap).kept > 0)) shown.push(t.callId);
    }
    return { output, shown };
  };
  const whole = build(Number.POSITIVE_INFINITY);
  if (whole.length <= EXEC_RECOVERY_MAX_CHARS) return at(Number.POSITIVE_INFINITY, whole);
  const least = build(0);
  if (least.length > EXEC_RECOVERY_MAX_CHARS) {
    const { text, kept } = cut(least, EXEC_RECOVERY_MAX_CHARS);
    return at(0, text, kept);
  }
  let lo = 0;
  let hi = whole.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(mid).length <= EXEC_RECOVERY_MAX_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return at(lo, build(lo));
}

/** A tie record of a nested call: the `exec` it ran under (none when the answer that wrote the script could not be read to its end,
 *  so which script it was cannot be told) and the turn it ran in. */
export interface NestedTie {
  callId: string;
  exec: string | null;
  since?: number;
}

/** The nested calls to list for each cut-off `exec` of the interrupted turn `since`: its own, in order; and the calls whose
 *  script could not be told, which ran in that turn, under the LAST cut-off exec only, apart from its own, so each is listed once. */
export function recoveryFacts<T>(execs: readonly string[], ties: readonly NestedTie[], since: number, factOf: (tie: NestedTie) => T): Map<string, { own: T[]; loose: T[] }> {
  const out = new Map<string, { own: T[]; loose: T[] }>();
  const last = execs.at(-1);
  const loose = ties.filter((t) => t.exec === null && t.since === since).map(factOf);
  for (const exec of execs) out.set(exec, { own: ties.filter((t) => t.exec === exec).map(factOf), loose: exec === last ? loose : [] });
  return out;
}

/** What a call of a recovered script came to, as its line tells it. A result or an error it quotes is the one the script was
 *  handed live: held to the host's bound as the bridge holds it (`boundResult`); the session's record keeps it whole. */
const describeCall = (fact: NestedFact, label: string): Told => {
  const settled = settle(fact);
  const shows = outcomeShown(fact);
  const told = (head: string, text: string, tail: string): Told => ({ head, text: boundResult(text).text, tail, callId: fact.callId, shows });
  if (settled.kind === "parked") return { head: `${label} was waiting for a person's approval and did not run; it was not run again.`, tail: "" };
  const again = fact.resumed;
  if (again && !again.ran) return told(`${label} waited for a person's approval, then: `, again.text, ". It did not run.");
  if (again && again.isError) return told(`${label} waited for a person's approval, then ran and failed: `, again.text, ". It was not run again.");
  if (again) return told(`${label} waited for a person's approval, then ran: `, again.text, ". Its effect is done; it was not run again.");
  if (settled.kind === "completed") return told(`${label} completed: `, settled.text, ". Its effect is done; it was not run again.");
  if (settled.kind === "failed") return told(`${label} failed: `, settled.text, ". It was not run again.");
  // Told as the recovery note of the same turn tells it, which reaches the model with this output: a safe tool's call a crash cut off.
  if (fact.told === "retryable") return { head: `${label} was started and did not report a result. It is safe to repeat. It was not run again.`, tail: "" };
  return { head: `${label} was started and did not report a result, so it may have taken effect: check before calling it again. It was not run again.`, tail: "" };
};

/** Whether a recovered script's output tells what the call came to, its result or its error (a call that waited for a person's
 *  approval, then was answered, included): the recovery note then says the outcome is there, not that it is not shown. */
export function outcomeShown(fact: NestedFact): boolean {
  if (fact.resumed) return true;
  const kind = settle(fact).kind;
  return kind === "completed" || kind === "failed";
}

/** The output a cut-off `exec` is answered with: its nested calls, in order, each with what it came to, and that nothing was run
 *  again. A completed call's effect is done, a never tool's included; a call with no end is interrupted. `loose`: calls of this turn
 *  whose script could not be told (given to the last cut-off exec only), listed apart under their own heading. */
/** What a dangling `wait` on a yielded exec's cell is told when calls of that script that waited for a person's approval
 *  were answered on this resume (code-mode.ts recoverItems): each call's outcome, in order. */
export function waitResumedText(cell: string, resumed: readonly NestedFact[]): string {
  return waitResumed(cell, resumed).output;
}

/** waitResumedText, and the calls whose outcome it tells. */
export function waitResumed(cell: string, resumed: readonly NestedFact[]): Recovered {
  const told = resumed.map((fact, i) => describeCall(fact, `${i + 1}. ${fact.tool}`));
  return fitted(told, (cap) => `The session stopped while waiting on cell ${cell}; that cell's script was cut off. Its calls that waited for a person's approval were answered since, each once:\n${told.map((t) => lineOf(t, cap)).join("\n")}\nNothing else of the script was run again. Check the actual state before relying on it.`);
}

export function execRecoveryOutput(facts: readonly NestedFact[], loose: readonly NestedFact[] = []): string {
  return execRecovery(facts, loose).output;
}

/** execRecoveryOutput, and the calls whose outcome it tells: only those the recovery note may say are above. */
export function execRecovery(facts: readonly NestedFact[], loose: readonly NestedFact[] = []): Recovered {
  if (facts.length === 0 && loose.length === 0) return { output: `The exec was cut short before any tool call of it was recorded; it ran none. Run it again if it is still needed.`, shown: [] };
  const own = facts.map((fact, i) => describeCall(fact, `${i + 1}. ${fact.tool}`));
  const others = loose.map((fact, i) => describeCall(fact, `${i + 1}. ${fact.tool}`));
  return fitted([...own, ...others], (cap) => {
    const apart = others.length
      ? `\n${others.length} ${others.length === 1 ? "call" : "calls"} ran whose script could not be told (an answer of the model's could not be read to its end):\n${others.map((t) => lineOf(t, cap)).join("\n")}`
      : "";
    if (own.length === 0) return `The exec was cut short, and no call of its own was recorded; the calls below ran, though which script made them could not be told, so do not run it again to find out.${apart}`;
    return `The exec was cut short after these calls (the session stopped), and nothing was run again. Their outcomes, in order:\n${own.map((t) => lineOf(t, cap)).join("\n")}${apart}`;
  });
}

/** The text of a tool's recorded output (a string, or `{ text }` with images). */
export function outputTextOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && typeof (output as { text?: unknown }).text === "string") return (output as { text: string }).text;
  return JSON.stringify(output ?? null);
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)])) : value;

/** A call by its tool and arguments, whatever the order of the arguments' keys: what a `never` tool's call is matched on. */
export const callKey = (tool: string, args: unknown): string => `${tool}\0${JSON.stringify(canonical(args ?? {}))}`;
