// A computer protocol call as a run's record keeps it: its method, when it started, whether it answered, how long it
// took, its error's code, the app it named, and for ui.act each step's kind, what it acted on as a person reads it, the
// route it ran by and whether a readback showed it took. Never a typed or set value and never an answer's bytes: no
// screenshot is in it, and no text a step set or typed (a secure field's included). What a step acted on is the element's
// role and name as the run's own ui.observe answers showed them (the words on the screen, never a field's value), a key
// step's chord (one with a modifier, or a named key: never a lone character, which may be a password's), a nav step's
// place.
//
// The record has two homes. The owner's calls (the computer call channel, computer-channel.ts) are `computer.call`
// entries on the run's journal. The agent's calls are the `computer_calls` of the tool call that made them, on its
// tool_result row (timeline/timeline.ts): the adapter loop runs each tool call inside recordingCalls (a pi-native tool's,
// code mode's among them, through the session's io: pi.ts), and the run's computer client (recordedClient, made at the
// claim) records each call made inside one.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ComputerClient } from "@parcha/agentrun-computer";
import { stepOf, type ComputerCallRow, type ComputerStepRow } from "./timeline/computer.js";

/** The element a step acted on, as the run's ui.observe answers named it: its role, and its name when it has one. */
export type ComputerTarget = NonNullable<ComputerStepRow["on"]>;

/** One step of a ui.act call: its kind (press, set, click, type, key, ...), what it acted on (`on`, a key step's `keys`,
 *  a nav step's `nav`), and how it ran (its route, and whether a readback showed it took) or the kind of error that
 *  refused it. */
export type ComputerStepRecord = ComputerStepRow;

/** One computer call, as a run's record keeps it: its method, when it started (`started_at`, ISO, so a reader places each
 *  call of a tool call on the run's own clock), the app it named (apps.launch's and apps.terminate's id, a ui call's
 *  target app; for a ui.observe that named none, the app its answer showed), whether it answered and in how long, the error's code when it failed, and a ui.act's steps and whether
 *  its expect held. */
export type ComputerCallRecord = ComputerCallRow;

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
  if (typeof one.started_at !== "string") return undefined;
  const steps = Array.isArray(one.steps) ? one.steps.flatMap((step) => {
    const s = obj(step);
    if (!s || typeof s.do !== "string") return [];
    const on = targetOf(s.on);
    return [{
      do: s.do,
      ...(on ? { on } : {}),
      ...(typeof s.keys === "string" ? { keys: s.keys } : {}),
      ...(typeof s.nav === "string" ? { nav: s.nav } : {}),
      ...(typeof s.route === "string" ? { route: s.route } : {}),
      ...(typeof s.verified === "boolean" ? { verified: s.verified } : {}),
      ...(typeof s.error === "string" ? { error: s.error } : {}),
    }];
  }) : undefined;
  return {
    method: one.method, started_at: one.started_at, ...(typeof one.app === "string" ? { app: one.app } : {}), ok: one.ok, ms: one.ms,
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

/** A ComputerTarget as an entry kept it. */
function targetOf(value: unknown): ComputerTarget | undefined {
  const one = obj(value);
  if (!one || typeof one.role !== "string") return undefined;
  return { role: one.role, ...(typeof one.name === "string" ? { name: one.name } : {}) };
}

/** The longest element name a row shows: past it, cut with "…" (shownName), after the run's redaction read it whole. */
export const MAX_TARGET_NAME = 60;
/** The longest element name a record keeps, whole. A longer one (no control's name on a screen is that long) is kept as
 *  no name at all: a part of it could hold part of a secret the redaction no longer recognizes. */
export const MAX_KEPT_NAME = 1000;

/** An element's name as a row shows it: through the run's redaction whole, then cut at MAX_TARGET_NAME. Cut first, a
 *  held secret across the cut would show its first part. */
export function shownName(name: string, redact?: (text: string) => string): string {
  const said = redact ? redact(name) : name;
  return said.length > MAX_TARGET_NAME ? `${said.slice(0, MAX_TARGET_NAME - 1)}…` : said;
}

/** What a ui.act step's ref names, as the run's ui.observe answers showed it. */
export type TargetNames = (ref: string) => ComputerTarget | undefined;

/** A ui.act step's record: what it acted on from its params (stepOf, the element by `names`), how it ran from its
 *  result. */
function stepRecord(step: unknown, result: unknown, names: TargetNames): ComputerStepRecord {
  const what = stepOf(step, names);
  const ran = obj(result);
  const error = obj(ran?.error);
  if (error) return { ...what, error: typeof error.kind === "string" ? error.kind : "error" };
  return { ...what, ...(typeof ran?.route === "string" ? { route: ran.route } : {}), ...(typeof ran?.verified === "boolean" ? { verified: ran.verified } : {}) };
}

/** The app a call of `method` names: apps.launch's and apps.terminate's id, a ui call's target app. */
function appOf(method: string, params: unknown): string | undefined {
  const given = obj(params);
  const app = method.startsWith("apps.") ? given?.id : method.startsWith("ui.") ? obj(given?.target)?.app : undefined;
  return typeof app === "string" && app ? app : undefined;
}

/** The record of a call of `method` with `params`, started at `startedAt` (ms since the epoch), that answered `answer`
 *  (`{ ok, value }` or `{ ok: false, error }`) after `ms`. Reads the params only for the app they name and a ui.act's
 *  steps (each step's element by `names`); keeps no typed or set value. */
export function callRecordOf(method: string, params: unknown, answer: unknown, ms: number, startedAt: number, names: TargetNames = () => undefined): ComputerCallRecord {
  const said = obj(answer);
  const ok = said?.ok === true;
  // A look that names no app looks at the one in front: the answer names it.
  const shown = method === "ui.observe" && ok ? obj(obj(said?.value)?.app)?.id : undefined;
  const app = appOf(method, params) ?? (typeof shown === "string" && shown ? shown : undefined);
  const base = { method, started_at: new Date(startedAt).toISOString(), ...(app ? { app } : {}), ok, ms: Math.max(0, Math.round(ms)) };
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
    steps: results.map((result, index) => stepRecord(asked[index], result, names)),
    ...(value?.expect === "met" || value?.expect === "unmet" ? { expect: value.expect } : {}),
  };
}

/** The most refs a client keeps the names of: past it, the ones learned first go. */
const MAX_NAMED_REFS = 10_000;

/** The names a client's ui.observe answers gave each ref: role and name (never a value), the name whole up to
 *  MAX_KEPT_NAME (the row cuts it, after the redaction: shownName).
 *  Each observe's nodes are learned again (a ref's element keeps its ref across states, so its newest name wins). */
export class RefNames {
  readonly #byRef = new Map<string, ComputerTarget>();
  learn(answer: unknown): void {
    const nodes = obj(obj(answer)?.value)?.nodes;
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      const one = obj(node);
      if (typeof one?.ref !== "string" || typeof one.role !== "string") continue;
      const name = typeof one.name === "string" ? one.name.replace(/\s+/g, " ").trim() : "";
      this.#byRef.delete(one.ref);
      this.#byRef.set(one.ref, { role: one.role, ...(name && name.length <= MAX_KEPT_NAME ? { name } : {}) });
    }
    for (const ref of this.#byRef.keys()) {
      if (this.#byRef.size <= MAX_NAMED_REFS) break;
      this.#byRef.delete(ref);
    }
  }
  readonly of: TargetNames = (ref) => this.#byRef.get(ref);
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
 *  (the owner's, through the channel, or the runner's own) is recorded nowhere; its ui.observe answer still names the
 *  refs a later recorded step acts on. */
export function recordedClient(client: ComputerClient): ComputerClient {
  const names = new RefNames();
  // Bound: a provider's DaemonClient reads its own fields through `this`.
  const send = client.call.bind(client) as (method: string, params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  return {
    call: (async (method: string, params: unknown, options?: { signal?: AbortSignal }) => {
      const into = scope.getStore();
      if (!into) {
        const answer = await send(method, params, options);
        if (method === "ui.observe") names.learn(answer);
        return answer;
      }
      // Its place is kept when it starts, so calls made together read in the order they were made, and the bound keeps
      // the first ones made. A call still going when its tool call ended reads unfinished.
      const startedAt = Date.now();
      const app = appOf(method, params);
      const open = { method, started_at: new Date(startedAt).toISOString(), ...(app ? { app } : {}), ok: false };
      const slot = into.calls.length < MAX_RECORDED_CALLS ? into.calls.push({ ...open, ms: 0, code: "unfinished" }) - 1 : undefined;
      if (slot === undefined) into.dropped += 1;
      const started = performance.now();
      const answer = await send(method, params, options).catch((error: unknown) => {
        if (slot !== undefined) into.calls[slot] = { ...open, ms: Math.round(performance.now() - started), code: "gone" };
        throw error;
      });
      if (method === "ui.observe") names.learn(answer);
      if (slot !== undefined) into.calls[slot] = callRecordOf(method, params, answer, performance.now() - started, startedAt, names.of);
      return answer;
    }) as ComputerClient["call"],
    close: () => client.close(),
  };
}
