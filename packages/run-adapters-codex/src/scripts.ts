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
import { parseLine } from "./rollout.js";

/** The id Codex gives a host tool called from a code-mode script. */
export const NESTED_CALL = /^exec-[0-9a-f-]{36}$/;

/** What the session is told when the proxy could not watch an answer to its end: the answer may carry an `exec` it did not see, so
 *  no script can be told from it. It counts as a script of its own, one that is never in the log. */
export const UNWATCHED = "(unwatched answer)";

/** What to do with a nested call: run it under `exec`; hold it until `exec`'s line is in the rollout; refuse it, as two scripts
 *  are live; or hold it, as no script is known yet. */
export type Tie = { kind: "tied"; exec: string } | { kind: "held"; exec: string } | { kind: "ambiguous"; live: string[] } | { kind: "none" };

const textOf = (output: unknown): string =>
  typeof output === "string" ? output : Array.isArray(output) ? output.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";

export class Scripts {
  private readonly open: { exec: string; cell?: string }[] = [];
  /** The `exec` calls whose script finished. */
  private readonly done = new Set<string>();
  /** The cell each `wait` call in the rollout resumes. */
  private readonly waitsOn = new Map<string, string>();

  /** Reads one rollout line. */
  note(line: string): void {
    if (!line.includes("call_id")) return;
    const p = parseLine(line)?.payload;
    if (!p || typeof p.call_id !== "string") return;
    const id: string = p.call_id;
    const running = /Script running with cell ID (\S+)/.exec(textOf(p.output));
    if (p.type === "custom_tool_call" && p.name === "exec") {
      if (!this.open.some((x) => x.exec === id)) this.open.push({ exec: id });
    } else if (p.type === "custom_tool_call_output") {
      const at = this.open.findIndex((x) => x.exec === id);
      if (at < 0) return;
      if (running) this.open[at]!.cell = running[1]!;
      else this.done.add(this.open.splice(at, 1)[0]!.exec);
    } else if (p.type === "function_call" && p.name === "wait") {
      try {
        const cell = (JSON.parse(String(p.arguments)) as { cell_id?: unknown }).cell_id;
        if (cell !== undefined) this.waitsOn.set(id, String(cell));
      } catch {}
    } else if (p.type === "function_call_output" && this.waitsOn.has(id) && !running) {
      const at = this.open.findIndex((x) => x.cell === this.waitsOn.get(id));
      if (at >= 0) this.done.add(this.open.splice(at, 1)[0]!.exec);
    }
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
  store?: { status: "completed" | "failed" | "started"; text?: string; interrupted?: boolean };
  rollout?: RolloutNested;
}

export type Settled = { kind: "completed"; text: string } | { kind: "failed"; text: string } | { kind: "interrupted" };

/** What a nested call came to. The store's record first, the rollout's completion second: both complete and agreeing, or
 *  one of them, is that outcome; both complete and disagreeing, or a call that started and has no end in either, is
 *  interrupted (its effect is unknown), and a failure the store marks interrupted is interrupted. */
export function settle(fact: NestedFact): Settled {
  const { store, rollout } = fact;
  const stored = store?.status === "completed" ? ({ kind: "completed", text: store.text ?? "" } as const) : store?.status === "failed" && !store.interrupted ? ({ kind: "failed", text: store.text ?? "" } as const) : undefined;
  const rolled = rollout ? ({ kind: rollout.ok ? "completed" : "failed", text: rollout.text } as const) : undefined;
  if (stored && rolled) return stored.kind === rolled.kind && stored.text === rolled.text ? stored : { kind: "interrupted" };
  return stored ?? rolled ?? { kind: "interrupted" };
}

const quoted = (text: string) => JSON.stringify(text.length > 2000 ? `${text.slice(0, 2000)}… [${text.length - 2000} more characters]` : text);

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

const describeCall = (fact: NestedFact, label: string): string => {
  const settled = settle(fact);
  if (settled.kind === "completed") return `${label} completed: ${quoted(settled.text)}. Its effect is done; it was not run again.`;
  if (settled.kind === "failed") return `${label} failed: ${quoted(settled.text)}. It was not run again.`;
  return `${label} was started and did not report a result, so it may have taken effect: check before calling it again. It was not run again.`;
};

/** The output a cut-off `exec` is answered with: its nested calls, in order, each with what it came to, and that nothing was run
 *  again. A completed call's effect is done, a never tool's included; a call with no end is interrupted. `loose`: calls of this turn
 *  whose script could not be told (given to the last cut-off exec only), listed apart under their own heading. */
export function execRecoveryOutput(facts: readonly NestedFact[], loose: readonly NestedFact[] = []): string {
  const apart = loose.length
    ? `\n${loose.length} ${loose.length === 1 ? "call" : "calls"} ran whose script could not be told (an answer of the model's could not be read to its end):\n${loose.map((fact, i) => describeCall(fact, `${i + 1}. ${fact.tool}`)).join("\n")}`
    : "";
  if (facts.length === 0 && loose.length > 0) return `The exec was cut short, and no call of its own was recorded; the calls below ran, though which script made them could not be told, so do not run it again to find out.${apart}`;
  if (facts.length === 0) return `The exec was cut short before any tool call of it was recorded; it ran none. Run it again if it is still needed.`;
  const lines = facts.map((fact, i) => describeCall(fact, `${i + 1}. ${fact.tool}`));
  return `The exec was cut short after these calls (the session stopped), and nothing was run again. Their outcomes, in order:\n${lines.join("\n")}${apart}`;
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
