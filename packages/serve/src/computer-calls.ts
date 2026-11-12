// A computer protocol call as a run's record keeps it: its method, whether it answered, how long it took, its error's
// code, and for ui.act each step's kind, the route it ran by and whether a readback showed it took. Never a param's value
// and never an answer's bytes: no screenshot is in it, and no text a step set or typed (a secure field's included).
//
// The record has two homes. The owner's calls (the computer call channel, computer-channel.ts) are `computer.call`
// entries on the run's journal. The agent's calls are the `computer_calls` of the tool call that made them, on its
// tool_result row (timeline/timeline.ts): the adapter loop runs each tool call inside recordingCalls, and the run's
// computer client (recordedClient, made at the claim) records each call made inside one.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ComputerClient } from "@parcha/agentrun-computer";

/** One step of a ui.act call: its kind (press, set, click, type, key, ...), and how it ran (its route, and whether a
 *  readback showed it took) or the kind of error that refused it. */
export type ComputerStepRecord = { readonly do: string; readonly route?: string; readonly verified?: boolean; readonly error?: string };

/** One computer call, as a run's record keeps it. */
export type ComputerCallRecord = {
  readonly method: string;
  readonly ok: boolean;
  readonly ms: number;
  /** The error's code, when the call failed. */
  readonly code?: string;
  /** ui.act: its steps, in order. */
  readonly steps?: readonly ComputerStepRecord[];
  /** ui.act: whether its expect held. */
  readonly expect?: "met" | "unmet";
};

/** The most calls one tool call's record keeps (a code-mode script may make many); past it, `dropped` counts the rest. */
export const MAX_RECORDED_CALLS = 200;

/** The journal entry kind of one tool call's computer calls, kept beside the call on the run's root: `{ call, calls,
 *  dropped? }`, `call` the tool call's id. */
export const COMPUTER_CALLS = "computer.calls";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : undefined);

/** A record as an entry kept it, or undefined when it is not one (an entry another build wrote). */
function recordOf(value: unknown): ComputerCallRecord | undefined {
  const one = obj(value);
  if (!one || typeof one.method !== "string" || typeof one.ok !== "boolean" || typeof one.ms !== "number") return undefined;
  const steps = Array.isArray(one.steps) ? one.steps.flatMap((step) => {
    const s = obj(step);
    if (!s || typeof s.do !== "string") return [];
    return [{ do: s.do, ...(typeof s.route === "string" ? { route: s.route } : {}), ...(typeof s.verified === "boolean" ? { verified: s.verified } : {}), ...(typeof s.error === "string" ? { error: s.error } : {}) }];
  }) : undefined;
  return {
    method: one.method, ok: one.ok, ms: one.ms,
    ...(typeof one.code === "string" ? { code: one.code } : {}),
    ...(steps ? { steps } : {}),
    ...(one.expect === "met" || one.expect === "unmet" ? { expect: one.expect } : {}),
  };
}

/** Each tool call's computer calls, by the call's id, from a run's COMPUTER_CALLS entries: its records, and how many it
 *  dropped. */
export function computerCallsOf(entries: readonly { readonly kind: string; readonly data?: unknown }[]): Map<string, { readonly calls: readonly ComputerCallRecord[]; readonly dropped: number }> {
  const out = new Map<string, { calls: readonly ComputerCallRecord[]; dropped: number }>();
  for (const entry of entries) {
    if (entry.kind !== COMPUTER_CALLS) continue;
    const data = obj(entry.data);
    if (typeof data?.call !== "string" || !Array.isArray(data.calls)) continue;
    const calls = data.calls.flatMap((call) => recordOf(call) ?? []);
    out.set(data.call, { calls, dropped: typeof data.dropped === "number" ? data.dropped : 0 });
  }
  return out;
}

/** The step kinds a ui.act step may name (the protocol's UiStep keys). */
const STEP_KINDS = ["press", "set", "perform", "click", "type", "key", "nav", "scroll", "drag"] as const;

/** A ui.act step's record: its kind from its params, how it ran from its result. */
function stepRecord(step: unknown, result: unknown): ComputerStepRecord {
  const given = obj(step) ?? {};
  const kind = STEP_KINDS.find((name) => name in given) ?? "step";
  const ran = obj(result);
  const error = obj(ran?.error);
  if (error) return { do: kind, error: typeof error.kind === "string" ? error.kind : "error" };
  return { do: kind, ...(typeof ran?.route === "string" ? { route: ran.route } : {}), ...(typeof ran?.verified === "boolean" ? { verified: ran.verified } : {}) };
}

/** The record of a call of `method` with `params` that answered `answer` (`{ ok, value }` or `{ ok: false, error }`)
 *  after `ms`. Reads the params only for a ui.act's step kinds; keeps none of their values. */
export function callRecordOf(method: string, params: unknown, answer: unknown, ms: number): ComputerCallRecord {
  const said = obj(answer);
  const ok = said?.ok === true;
  const base = { method, ok, ms: Math.max(0, Math.round(ms)) };
  if (!ok) {
    const code = obj(said?.error)?.code;
    return { ...base, code: typeof code === "string" ? code : "error" };
  }
  if (method !== "ui.act") return base;
  const value = obj(said?.value);
  const results = Array.isArray(value?.steps) ? value.steps : [];
  const asked = Array.isArray(obj(params)?.steps) ? (obj(params)!.steps as unknown[]) : [];
  return {
    ...base,
    steps: results.map((result, index) => stepRecord(asked[index], result)),
    ...(value?.expect === "met" || value?.expect === "unmet" ? { expect: value.expect } : {}),
  };
}

/** What a scope holds: its records, and how many it dropped past MAX_RECORDED_CALLS. */
type Scope = { readonly calls: ComputerCallRecord[]; dropped: number };
const scope = new AsyncLocalStorage<Scope>();

/** Runs `work` with every call a recordedClient makes inside it recorded, in the order the calls were made, and hands
 *  the records (with how many past MAX_RECORDED_CALLS were dropped) to `keep` once it settled, thrown or not, when it
 *  made any. `keep` is waited for and never fails the work. A scope inside another records into the inner one only. */
export async function recordingCalls<T>(work: () => Promise<T>, keep: (calls: readonly ComputerCallRecord[], dropped: number) => Promise<void>): Promise<T> {
  const mine: Scope = { calls: [], dropped: 0 };
  try {
    return await scope.run(mine, work);
  } finally {
    if (mine.calls.length > 0) await keep(mine.calls, mine.dropped).catch(() => undefined);
  }
}

/** Runs `work` outside any recordingCalls scope: its calls are recorded on no tool call (the owner's, through the
 *  channel, which the runner writes a record of its own for). */
export function unrecorded<T>(work: () => T): T {
  return scope.exit(work);
}

/** `client`, with each call made inside a recordingCalls scope recorded there when it settles. A call outside any scope
 *  (the owner's, through the channel, or the runner's own) is recorded nowhere and costs nothing more. */
export function recordedClient(client: ComputerClient): ComputerClient {
  return {
    call: (async (method: string, params: unknown, options?: { signal?: AbortSignal }) => {
      const into = scope.getStore();
      if (!into) return (client.call as (method: string, params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>)(method, params, options);
      // Its place is kept when it starts, so calls made together read in the order they were made, and the bound keeps
      // the first ones made. A call still going when its tool call ended reads unfinished.
      const slot = into.calls.length < MAX_RECORDED_CALLS ? into.calls.push({ method, ok: false, ms: 0, code: "unfinished" }) - 1 : undefined;
      if (slot === undefined) into.dropped += 1;
      const started = performance.now();
      const answer = await (client.call as (method: string, params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>)(method, params, options).catch((error: unknown) => {
        if (slot !== undefined) into.calls[slot] = { method, ok: false, ms: Math.round(performance.now() - started), code: "gone" };
        throw error;
      });
      if (slot !== undefined) into.calls[slot] = callRecordOf(method, params, answer, performance.now() - started);
      return answer;
    }) as ComputerClient["call"],
    close: () => client.close(),
  };
}
