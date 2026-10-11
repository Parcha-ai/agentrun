// The recovery driver's durable state and its workflow-free transitions. Everything the driver runs is
// addressed by the interpreter's execution path, an opaque string here: the driver (`driver.ts`) reads
// the path grammar, maps nodes onto these records and owns the store's lifecycle.
import { createHash } from "node:crypto";
import { RecoveryError } from "./errors.js";

const failure = (code: string, message: string) => new RecoveryError(message, code);

export const FROZEN_SNAPSHOT_SCHEMA = "agentrun.frozen_run.v3";

type State = Record<string, unknown>;

/** What a question's receipts need beyond its answer: the request's producer invocation, its size and its
 *  latency. */
export type QuestionReceipts = { invocation: string; request_bytes: number; latency_ms: number };
/** A committed route: the judge's answer for the route's question, whole, so a resume re-derives the
 *  same branch from it without asking again; the branch it runs (the node's unsure branch when the answer
 *  was unsure), with the answer's choice and the unsure flag beside it (a checkpoint that holds a decision
 *  without those two fields has neither: the driver derives all three from `result` when it opens). `receipts`
 *  is set in the commit that decides and cleared by the save after the host has written what it keeps of the
 *  answer: a resume that finds it set writes them, so a crash between the two never leaves the spend without
 *  its receipts. A host that keeps nothing commits null. */
export type RouteDecision = { label: string; branch: string; choice: string; unsure: boolean; request_sha256: string | null; result: Record<string, unknown>; receipts: QuestionReceipts | null };

/** What one document's run committed, by execution path. `done` is every committed path in commit
 *  order; `states` keeps the committed state of the paths a resume may still be answered from (a
 *  chain's frontier step, a finished map item or parallel branch whose structure has not committed, a
 *  loop's iterations); `chains` names each chain's frontier; `loops` counts each loop's completed
 *  iterations; `routes` holds each route's committed decision; `inputs` binds each started, uncommitted
 *  path to the state it started from; `steps` holds each LLM step's execution record. */
export type PathFrame = {
  /** The state the document started from, bound at its first resume: every later process starts the
   *  document from the same bytes or is refused. */
  input: string | null;
  done: string[];
  states: Record<string, State>;
  chains: Record<string, { index: number; path: string }>;
  loops: Record<string, number>;
  routes: Record<string, RouteDecision>;
  inputs: Record<string, string>;
  steps: Record<string, StepRecord>;
  /** A map that ended on an item's failure: the finished items' results, keyed by the map's `as`, so
   *  the handoff carries the completed child work and a redispatch never loses it. */
  partial?: { path: string; as: string; results: unknown[] };
};

/** The recovery driver's durable state. It lives whole in the journal; each commit replaces it. No run
 *  clock: clocks exist only per effect. */
export type FrozenSnapshot = {
  schema: typeof FROZEN_SNAPSHOT_SCHEMA;
  /** What the run of the workflow document committed. */
  pin: PathFrame;
  startedAt: number;
  status: "running" | "paused" | "cancelled";
  /** Effect-level clocks (poll windows, attempt deadlines), absolute, keyed by effect. */
  clocks: Record<string, number>;
  files: Record<string, string>;
  unknownResponses?: Record<string, unknown>;
  /** Spend by question nodes, which have no session of their own: metered per answer, carried with the frames. */
  questionSpendUsd?: number;
  /** The durable form of the escalation that ended the run; set once, reused on resume. */
  escalation?: EscalationRow;
};

export type StepRecord = { label: string; attempt: number; attemptsAllowed: number; status: "running" | "closed" | "failed" | "submitted" };

export type EscalationRow = {
  kind: string; stage: string; summary: string;
  state: Record<string, unknown>;
  workflow_sha_used: string; pin_sha256: string;
  /** The node that ended the run: the gate that fired or the LLM step that failed. */
  step_label: string; step_exec_id: string | null;
  cost_usd: number; turns: number; effect_calls: number;
  evidence_dir: string;
  /** The identity the continuation of an escalated run runs under. */
  tail: string;
  /** The escalation commit's revision: what the continuation binds on. */
  revision: number;
  /** The typed failure that ended the attempt, when one did: its code and its typed detail (a rail's
   *  limit), so the handoff keeps the classification a resume reads back. */
  failure?: { code: string; detail?: Record<string, number | string> };
};

/** What a saved snapshot is checked against: whether a path resolves in the run's document. */
export type FrozenShape = { resolves: (path: string) => boolean };

export const emptyPathFrame = (): PathFrame => ({ input: null, done: [], states: {}, chains: {}, loops: {}, routes: {}, inputs: {}, steps: {} });

const record = (value: unknown): boolean => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const SHA256 = /^[a-f0-9]{64}$/;

type Fields = Record<string, unknown>;
/** `value` as an object whose fields can be read, or null. */
const fields = (value: unknown): Fields | null => record(value) ? value as Fields : null;
const entriesOf = (value: unknown): Array<[string, unknown]> | null => { const object = fields(value); return object ? Object.entries(object) : null; };
const nonNegativeInt = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

/** Whether a saved frame is one the driver could have written for its document. */
function validFrame(value: unknown, resolves: (path: string) => boolean): boolean {
  const frame = fields(value);
  if (!frame || !Array.isArray(frame.done) || !frame.done.every((path: unknown) => typeof path === "string" && resolves(path))) return false;
  const doneList = frame.done as string[];
  const done = new Set(doneList);
  if (done.size !== doneList.length) return false;
  if (!(frame.input === null ? doneList.length === 0 : typeof frame.input === "string" && SHA256.test(frame.input))) return false;
  const [states, chains, loops, routes, inputs, steps] = [frame.states, frame.chains, frame.loops, frame.routes, frame.inputs, frame.steps].map(entriesOf);
  const partial = frame.partial === undefined ? undefined : fields(frame.partial);
  return Boolean(states && states.every(([path, state]) => done.has(path) && record(state))
    && chains && chains.every(([, head]) => { const at = fields(head); return Boolean(at && nonNegativeInt(at.index) && typeof at.path === "string" && done.has(at.path)); })
    && loops && loops.every(([loop, count]) => resolves(loop) && nonNegativeInt(count))
    && routes && routes.every(([route, decision]) => {
      const at = fields(decision);
      const receipts = fields(at?.receipts);
      return Boolean(at && resolves(route) && typeof at.label === "string" && typeof at.branch === "string" && ((typeof at.choice === "string" && typeof at.unsure === "boolean") || (at.choice === undefined && at.unsure === undefined)) && record(at.result) && (at.request_sha256 === null || typeof at.request_sha256 === "string")
        && (at.receipts === null || (receipts && typeof receipts.invocation === "string" && nonNegativeInt(receipts.request_bytes) && Number.isFinite(receipts.latency_ms))));
    })
    && inputs && inputs.every(([path, digest]) => resolves(path) && !done.has(path) && typeof digest === "string" && SHA256.test(digest))
    && steps && steps.every(([path, step]) => {
      const at = fields(step);
      return Boolean(at && resolves(path) && typeof at.label === "string"
        && nonNegativeInt(at.attempt) && Number.isSafeInteger(at.attemptsAllowed) && (at.attemptsAllowed as number) >= 1
        && ["running", "closed", "failed", "submitted"].includes(String(at.status)));
    })
    && (partial === undefined || (partial && typeof partial.path === "string" && resolves(partial.path) && typeof partial.as === "string" && Array.isArray(partial.results))));
}

/** Refuses a saved snapshot the driver could not have produced for this run. */
export function validateFrozenSnapshot(saved: any, shape: FrozenShape): void {
  if (!record(saved) || saved.schema !== FROZEN_SNAPSHOT_SCHEMA || !Number.isFinite(saved.startedAt)
    || (saved.questionSpendUsd !== undefined && !(Number.isFinite(saved.questionSpendUsd) && saved.questionSpendUsd >= 0))
    || !["running", "paused", "cancelled"].includes(saved.status)
    || !record(saved.clocks) || !Object.values(saved.clocks).every(Number.isFinite)
    || !record(saved.files) || !Object.values(saved.files).every(value => typeof value === "string" && SHA256.test(value))
    || !validFrame(saved.pin, shape.resolves)
    || (saved.escalation !== undefined && (!record(saved.escalation) || typeof saved.escalation.tail !== "string" || typeof saved.escalation.kind !== "string" || !Number.isSafeInteger(saved.escalation.revision)))
    // A checkpoint that holds a second document's frame is refused: the driver runs one document.
    || saved.adaptation !== undefined) {
    throw failure("FROZEN_CHECKPOINT_INVALID", "Invalid frozen recovery checkpoint");
  }
}

/** Keys an older journal may hold that the driver neither reads nor writes: dropped on open, so a
 *  checkpoint that has them does not carry them forward as stale counts. */
const RETIRED_SNAPSHOT_KEYS = ["unpricedQuestions", "effectCalls", "effectGrants", "effectSpendUsd", "effectHoldsUsd", "effectRecoveredUsd", "lookSpendUsd"] as const;

/** The snapshot a driver runs under: the saved one (a paused run resumes running, retired keys
 *  dropped), or a fresh one. */
export function openedFrozenSnapshot(saved: FrozenSnapshot | null | undefined): FrozenSnapshot {
  const snapshot: FrozenSnapshot = saved ?? { schema: FROZEN_SNAPSHOT_SCHEMA, pin: emptyPathFrame(), startedAt: Date.now(), status: "running", clocks: {}, files: {} };
  if (snapshot.status === "paused") snapshot.status = "running";
  for (const key of RETIRED_SNAPSHOT_KEYS) delete (snapshot as Record<string, unknown>)[key];
  return snapshot;
}

/** The snapshot as the journal stores it. Workflow state contains optional internal fields; this
 *  matches its JSON checkpoint semantics, while refusing non-finite values instead of silently
 *  changing them to null. */
export function serializeFrozenSnapshot(snapshot: FrozenSnapshot): FrozenSnapshot {
  return JSON.parse(JSON.stringify(snapshot, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw failure("FROZEN_CHECKPOINT_INVALID", "Non-finite workflow state");
    return value;
  }));
}

/** The namespace a frame's sessions and effects are named under. The driver writes `step`; `adapt` names the
 *  sessions and effects of a second document's frame in an older journal. */
export type FrameTag = "step" | "adapt";

/** The session an LLM step's attempt runs in: the step's label (for the reader: labels repeat across
 *  loop iterations and map items), its frame and execution path (what makes it unique), and the
 *  attempt. */
export function frozenStepSessionId(driver: string, label: string, frame: FrameTag, path: string, attempt: number): string {
  return `${driver}:${label}:${frame}:${path}:a${attempt}`;
}

/** A step's short identity where a name must be short and file-safe (its files, the continuation an
 *  escalation hands off to): a digest of its frame and execution path, so it is the same in every process. */
export function frozenStepId(frame: FrameTag, path: string): string {
  return createHash("sha256").update(`${frame}:${path}`).digest("hex").slice(0, 10);
}

/** The receipt id of a call's `ordinal`th effect at an execution path. */
export function frozenEffectId(frame: FrameTag, path: string, ordinal: number): string {
  return `${frame}:${path}#call:${ordinal}`;
}

/** An LLM step's execution record under admission. The first call fixes the label the interpreter
 *  names the step by and the retry limit; a later call gets the same
 *  record. A closed attempt advances to the next attempt here, and only here, when an admission asks
 *  and an attempt remains, else the step fails. `changed` says the snapshot owes a save. */
export function admitFrozenStep(steps: Record<string, StepRecord>, path: string, label: string,
  admission?: { attemptsAllowed: number }): { step: StepRecord; changed: boolean } {
  let step = steps[path];
  if (!step) {
    if (!admission) throw failure("FROZEN_PATH_INVALID", `The step at ${path} is admitted with its retry limit`);
    step = { label, attempt: 0, attemptsAllowed: Math.max(1, admission.attemptsAllowed), status: "running" };
    steps[path] = step;
    return { step, changed: true };
  }
  if (step.status === "closed" && admission) {
    if (step.attempt + 1 >= step.attemptsAllowed) step.status = "failed";
    else { step.attempt += 1; step.status = "running"; }
    return { step, changed: true };
  }
  return { step, changed: false };
}

/** The current attempt ended without a submission: `closed` until a retry is admitted, or
 *  `failed` when the failure is final or no attempt remains. */
export function closeFrozenStepAttempt(step: StepRecord, final: boolean): void {
  step.status = final || step.attempt + 1 >= step.attemptsAllowed ? "failed" : "closed";
}

/** The run-wide stop the driver applies: the host's pause or cancel it was handed, or null when it keeps
 *  running. A cancelled snapshot stays cancelled. */
export function frozenStop(status: FrozenSnapshot["status"], requested: "pause" | "cancel" | undefined): "paused" | "cancelled" | null {
  return status === "cancelled" || requested === "cancel" ? "cancelled" : requested === "pause" ? "paused" : null;
}
