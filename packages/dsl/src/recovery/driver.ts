// The recovery driver: the durable state of one workflow run, addressed by the interpreter's execution paths. Execution
// stays in the interpreter. The driver implements its `recovery` hooks over a RecoveryStore, admits each effect before
// it is dispatched, and holds each LLM step's record, each route's decision and the escalation that ends a run.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RouteNode, Workflow, WorkflowDeps, WorkflowNode } from "../workflow.js";
import { desugarWorkflow } from "../workflow.js";
import { chainStep, childrenOf, completedIteration, enclosingChains, enclosingIterations, isWithin, mapItemOf, nodeAt, topLevelCompletion } from "./execution-path.js";
import { bindingDigests, LEDGER_FORMAT } from "./binding.js";
import { canonicalHash as hash } from "./canonical-hash.js";
import { RecoveryError } from "./errors.js";
import { gatewayIntentOf } from "./handoff-receipts.js";
import { validateFrozenSnapshot, openedFrozenSnapshot, serializeFrozenSnapshot,
  frozenStepSessionId, frozenStepId, frozenEffectId, frozenEffectPath, admitFrozenStep, closeFrozenStepAttempt, frozenStop,
  FROZEN_SNAPSHOT_SCHEMA, FROZEN_SNAPSHOT_SCHEMA_V4, stateDelta, applyStateDelta,
  type FrozenSnapshot as Snapshot, type FrozenSnapshotV4, type ItemRecord, type MapEntry, type StateDelta,
  type PathFrame, type RouteDecision, type QuestionReceipts, type FrameTag, type StepRecord, type EscalationRow } from "./frozen-snapshot.js";
import type { RecoveryBinding, RecoveryEffect, RecoveryJournal, RecoveryNote, RecoveryParts, RecoveryStore } from "./store.js";

const failure = (code: string, message: string) => new RecoveryError(message, code);

/** The branch a route runs for its answer, as the interpreter takes it: the node's `unsure` branch when
 *  the answer's confidence is below `unsure.gte`, else the choice the answer names. */
export function routeTaken(node: RouteNode, answers: unknown): { branch: string; choice: string; unsure: boolean } {
  const answer = (answers as Record<string, { choice?: unknown; confidence?: unknown }> | undefined)?.branch;
  const choice = String(answer?.choice ?? "");
  const unsure = Boolean(node.unsure && typeof answer?.confidence === "number" && answer.confidence < node.unsure.gte);
  return { branch: unsure ? node.unsure!.branch : choice, choice, unsure };
}
/** A path the driver cannot place: the path is in the message, so the fault names where it happened. */
const pathFault = (at: unknown, message: string) => failure("FROZEN_PATH_INVALID", `${message}: ${typeof at === "string" ? at : JSON.stringify(at)}`);
/** Completes the route decisions of a checkpoint that holds a decision without `choice` and `unsure`:
 *  each takes the branch, the choice and the flag `routeTaken` derives from its stored answer, so a
 *  decision whose answer was unsure names the unsure branch it ran, never the answer's choice. */
function completeRouteDecisions(frame: PathFrame, doc: Workflow): void {
  for (const [at, decision] of Object.entries(frame.routes)) {
    if (typeof decision.choice === "string" && typeof decision.unsure === "boolean") continue;
    const node = nodeAt(doc, at);
    if (node?.node !== "route") throw pathFault(at, "Only a route's answer is a decision");
    Object.assign(decision, routeTaken(node, decision.result.answers));
  }
}

const LLM_KINDS = new Set(["agent", "decide", "extract", "report"]);

type State = Record<string, unknown>;

/** What a run's binding covers: the workflow as authored and what the host binds beside it, never the build. A run
 *  resumes across a deploy, and is refused when one of these changed: changing any of them is a new run. */
const bindingParts = (workflow: Workflow, bind: Record<string, unknown> | undefined) =>
  ({ engine: "frozen.v2", ledger: LEDGER_FORMAT, workflow, ...bind });

/** The binding of a run of `workflow` under what the host binds beside it. */
export function recoveryBinding(workflow: Workflow, bind?: Record<string, unknown>): string {
  return hash(bindingParts(workflow, bind));
}

/** What a store is opened under for a run of `workflow`: its binding, and the digest of each input the binding
 *  covers. The driver opens its store under it, and so does an operator who reconciles an effect by hand. */
export function recoveryBound(workflow: Workflow, bind?: Record<string, unknown>): RecoveryBinding {
  return { binding: recoveryBinding(workflow, bind), inputs: bindingDigests(bindingParts(workflow, bind)) };
}

/** A host's pause or cancel, and who issued it. */
export type RecoveryStop = { action: "pause" | "cancel"; source?: string };

/** How the driver reads the files a workflow declares it writes. */
export type RecoveryFiles = {
  /** Whether two names are one file. */
  same(a: string, b: string): boolean;
  /** The SHA-256 of each named file, by name. A missing file, or one outside the place files live, is refused
   *  with FROZEN_ARTIFACT_INVALID. */
  hashes(names: string[]): Record<string, string>;
};

/** The files of a workspace directory: a name is relative to it, and a file that resolves outside it is refused. */
export function workspaceFiles(cwd: string): RecoveryFiles {
  /** The file a name reaches, followed link by link as the system follows it, whether or not anything is at the end
   *  yet: a link to a reserved file that does not exist still reaches that file. What does not exist is kept as
   *  written. */
  const reached = (name: string): string => {
    const parts = (full: string) => path.relative(path.parse(full).root, full).split(path.sep).filter(Boolean);
    const start = path.resolve(cwd, name);
    let at = path.parse(start).root;
    let pending = parts(start);
    for (let links = 0; pending.length > 0;) {
      const next = path.join(at, pending[0]);
      let link: string | undefined;
      try { if (fs.lstatSync(next).isSymbolicLink()) link = fs.readlinkSync(next); }
      catch { return path.join(at, ...pending); }
      pending = pending.slice(1);
      if (link === undefined) { at = next; continue; }
      // A chain of links that never ends reaches no file: it is its own name.
      if ((links += 1) > 40) return path.join(next, ...pending);
      const target = path.resolve(at, link);
      at = path.parse(target).root;
      pending = [...parts(target), ...pending];
    }
    return at;
  };
  /** The file itself, whatever names it has: two hard links are one file. */
  const identity = (file: string): string | undefined => {
    try { const stat = fs.statSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; } catch { return undefined; }
  };
  return {
    same: (a, b) => {
      const [first, second] = [reached(a), reached(b)];
      if (first === second) return true;
      const file = identity(first);
      return file !== undefined && file === identity(second);
    },
    hashes: (names) => Object.fromEntries(names.map(name => {
      let filename: string;
      try { filename = fs.realpathSync(path.resolve(cwd, name)); }
      catch (error) {
        // A promised file the workspace no longer holds (a store that travelled without it) is an invalid artifact, never a raw errno.
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw failure("FROZEN_ARTIFACT_INVALID", `Recovery artifact is missing from the workspace: ${name}`);
        throw error;
      }
      const relative = path.relative(fs.realpathSync(cwd), filename);
      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw failure("FROZEN_ARTIFACT_INVALID", "Recovery artifact escaped workspace");
      }
      return [name, createHash("sha256").update(fs.readFileSync(filename)).digest("hex")];
    })),
  };
}

export type RecoveryOptions = {
  /** The run's identity. Its step sessions, its effects' receipts and the continuation of its escalation are named
   *  under it, so the same run is opened with the same key in every process. */
  key: string;
  /** What else must not change between two opens of the run, beside the workflow: the host's own inputs. */
  bind?: Record<string, unknown>;
  /** The document the interpreter runs, when the host rewrites the authored one before running it. Execution paths
   *  resolve in it; the binding, the labels and the declared files are the authored document's. Absent, the
   *  desugared workflow. */
  view?: Workflow;
  /** Files only the host writes. A workflow that declares one of them is refused before any step runs. */
  reservedOutputs?: readonly string[];
  /** The files a workflow declares it writes. Absent, the files of the process's working directory. */
  files?: RecoveryFiles;
  /** Closes the session of an LLM step's attempt that ended without a submission. It runs on the driver's commit
   *  chain, before the commit that records the attempt as closed; its failure is the run's. */
  closeStepSession?: (sessionId: string) => Promise<unknown>;
  /** Settles effects a killed process left unknown, through the driver's own open of the run (one generation per process).
   *  `openRecovery` calls it once, after the open and before anything resumes, when the journal holds an effect that was
   *  admitted and never completed; `unknown` is those effects, with their `intent` and the `args` the call was admitted with (what the host's door is sent; absent on a record written before args were kept). `complete(id, value, receipt)`
   *  records `value` as the effect's result, as `journal.complete` does with `{ value, files }`, hashing the files the effect declares (a missing one refuses the settlement); `receipt.intent` names
   *  the call the host's door answered, as a handoff reads it. `receipt.calls` are the outside calls the host MADE or FOUND APPLIED
   *  while settling it, records of the shape `{ outcome: "applied" | "failed" | "unknown", ... }`, so that the effect's `calls` lists
   *  every applied call exactly once. They are kept on the effect before it completes, after the calls an earlier process kept, as a
   *  dispatch keeps its own. A re-send is a call of this process. A settle from evidence that the call applied (a provider's own
   *  lookup, an answer the host kept) reports `{ outcome: "applied" }` when the calls the effect holds include no applied entry,
   *  and adds none when its applied call is already there. A settle that made no call and found none applied reports none. The
   *  effect is then answered from that result and not
   *  dispatched again. One it leaves unknown is refused at resume (`FROZEN_EFFECT_UNKNOWN`). A throw fails the open with
   *  `RECOVERY_RECONCILE_FAILED`, keeping the cause, before any effect is dispatched. */
  reconcile?: (unknown: RecoveryEffect[], complete: (id: string, value: unknown, receipt?: { intent?: { tool: string; args?: unknown }; calls?: unknown[] }) => Promise<void>) => Promise<void>;
  /** How a new run, or one stored whole, is kept. `"v3"` (the default in this release) keeps the driver's whole state in
   *  one record, rewritten at every commit, so a map's commits grow with the square of its items. `"v4"`, the keyed
   *  layout, keeps what lies in each map item in that item's record and each state the driver references once by its
   *  digest, so a commit writes what it changed: a run stored whole moves to it at its first commit. Only a store that
   *  keeps parts (its opened journal has `items` and `stateOf`) can hold it; on any other the driver keeps `"v3"` and says
   *  why once per open, in a `layout` note. A run stored in the keyed layout stays in it whatever this says, and a driver
   *  that knows only `"v3"` refuses to open it (`FROZEN_CHECKPOINT_INVALID`). Release 0.1.0-beta.13 and earlier fail their
   *  own task on a run in the keyed layout and report it refused; that ends the run's agent nodes in flight, and the run
   *  then fails on this release too, with no call repeated and nothing corrupted. So opt in only when no process on an
   *  earlier release can open the run. A build from this release on leaves a run stored in a schema newer than it knows
   *  pending (`RECOVERY_SCHEMA_NEWER`), for a build that knows it. */
  layout?: "v3" | "v4";
};

/** What a host's effect adapter receives under the driver: the interpreter's parameters, `call`, which keeps each
 *  outside call the effect makes on its record as the call ends, and `effect`, the admitted effect: its journal id and
 *  the hash of its arguments, as the journal stores them and the same in every process of the run. A host that keeps
 *  what an outside call answered under them can settle an effect whose call was cut with `journal.complete`. */
export type RecoveryEffectParams = Parameters<NonNullable<WorkflowDeps["runEffect"]>>[0] & {
  call?: (record: unknown) => void;
  effect?: { id: string; argsHash: string };
};


/** Every file a node, or anything inside it, declares it writes: an artifact's path, a call's outputs. */
function declaredFiles(node: WorkflowNode, out: string[] = []): string[] {
  if (node.node === "artifact" && node.path) out.push(node.path);
  if (node.node === "call") out.push(...(node.produces ?? []));
  for (const child of childrenOf(node)) declaredFiles(child, out);
  return out;
}

const labelOf = (node: WorkflowNode): string | undefined => "label" in node && typeof node.label === "string" ? node.label : undefined;

/** Every label in the document, a child workflow's steps named `<invocation>/<step>` as the interpreter
 *  names them, so a label that appears twice is found. */
function labelsOf(node: WorkflowNode, prefix = "", out: string[] = []): string[] {
  const label = labelOf(node);
  if (label !== undefined) out.push(`${prefix}${label}`);
  for (const child of childrenOf(node)) labelsOf(child, node.node === "workflow" ? `${prefix}${label}/` : prefix, out);
  return out;
}

/** Opens the durable state of one run of `workflow` in `store` and takes ownership of it. Execution remains in the
 *  interpreter: the workflow runs with the returned driver's hooks, and `close` lets go of the run. */
export async function openRecovery(store: RecoveryStore, workflow: Workflow, options: RecoveryOptions) {
  const reader = options.files ?? workspaceFiles(process.cwd());
  const reservedOutputs = options.reservedOutputs ?? [];
  const reserved = (name: string) => reservedOutputs.some(file => reader.same(name, file));
  /** A refusal found before any step runs: a workflow with a label on two nodes, or one that writes a file the host
   *  owns. The driver still opens (a run is durable whatever its shape), and the host ends the run through an
   *  escalation commit naming the refusal. */
  const hostOwned = declaredFiles(workflow.root).find(reserved);
  // Execution paths address every node; labels still name the node an escalation, a step record and a
  // decision are about, so two nodes may not share one.
  const labels = labelsOf(workflow.root);
  const duplicate = labels.find((label, index) => labels.indexOf(label) !== index);
  const preStepRefusal: { code: string; kind: string; message: string; label: string } | null = duplicate !== undefined ? {
    code: "RUN_CONTROL_UNSUPPORTED", kind: "duplicate_label", label: duplicate,
    message: `Frozen workflow recovery requires unique labels; "${duplicate}" names two nodes`,
  } : hostOwned !== undefined ? {
    code: "RUN_CONTROL_UNSUPPORTED", kind: "host_owned_output", label: "workflow",
    message: `Recovered artifacts must not overwrite ${reservedOutputs.length > 1 ? `${reservedOutputs.slice(0, -1).join(", ")} or ${reservedOutputs.at(-1)}` : reservedOutputs[0]}; the host owns those files, and the pin writes ${hostOwned}`,
  } : null;
  // The document the interpreter runs, and so the one its paths resolve in.
  const view = options.view ?? desugarWorkflow(workflow);
  const bound = recoveryBound(workflow, options.bind);
  const binding = bound.binding;
  const driver = options.key;
  const controller = new AbortController();
  let fatal: unknown;
  /** A pause or cancel was applied: its commit still lands, and nothing after it. */
  let stopping = false;
  const journal: RecoveryJournal = await store.open(bound);
  /** Whether the store keeps parts beside the state: the keyed layout needs both reads. */
  const keyed = typeof journal.items === "function" && typeof journal.stateOf === "function";
  /** The keyed layout is in effect for this open, and why not when the host asked for it. `moving` is a run stored whole
   *  that takes the keyed layout at its first write that knows the base of every map still running in it: a map's base
   *  is the state it starts from, which the run's whole record does not hold, and the map names it when it resumes. */
  let layoutV4 = false;
  let moving = false;
  let layoutReason: string | undefined;
  // The keyed layout's bookkeeping: the maps the run started (with the base each item is kept against), the states
  // already stored by digest, each item's record as last written (its revision aside), and the path that produced each
  // file a map item owns.
  const maps = new Map<string, { length: number; items: number; base: string; baseState?: State }>();
  const writtenStates = new Set<string>();
  const lastItems = new Map<string, string>();
  const fileOwners = new Map<string, string>();
  const deltas = new WeakMap<object, StateDelta>();
  const digests = new WeakMap<object, string>();
  const digestOf = (state: object): string => { let digest = digests.get(state); if (digest === undefined) { digest = hash(state); digests.set(state, digest); } return digest; };
  const invalid = (message: string) => failure("FROZEN_CHECKPOINT_INVALID", message);
  /** A state the run references by digest, read back and checked against it. */
  const stateBy = async (sha256: string): Promise<State> => {
    const state = await journal.stateOf!(sha256);
    if (!state || typeof state !== "object" || Array.isArray(state) || hash(state) !== sha256) throw invalid(`The state ${sha256} the run references is missing or changed`);
    writtenStates.add(sha256);
    digests.set(state, sha256);
    return state as State;
  };
  const SHA = /^[a-f0-9]{64}$/;
  const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const validEntry = (entry: unknown): entry is MapEntry => isRecord(entry) && Number.isSafeInteger(entry.length) && (entry.length as number) >= 0
    && Number.isSafeInteger(entry.items) && (entry.items as number) >= 0 && typeof entry.base === "string" && SHA.test(entry.base);
  /** The path of map item `index` of the map at `mapPath`: the prefix the interpreter gives every path inside it. */
  const itemPathOf = (mapPath: string, index: number) => `${mapPath}/items/${index}`;
  /** Reads back the records of every item the maps in `table` wrote, merging into `snapshot` what lies in them: all of
   *  it for a map still running, and what a committed map's items keep in the whole state (their committed paths, step
   *  records, clocks, files and effects) for one that committed. Nested maps are read through their item. */
  const restoreMaps = async (table: unknown, snapshot: Snapshot): Promise<void> => {
    if (!isRecord(table)) throw invalid("The run's maps are not a record");
    const frame = snapshot.pin;
    for (const [mapPath, entry] of Object.entries(table)) {
      if (!validEntry(entry) || nodeAt(view, mapPath)?.node !== "map") throw invalid(`The map at ${mapPath} is not one this run can hold`);
      const committed = frame.done.includes(mapPath);
      const baseState = committed ? undefined : await stateBy(entry.base);
      maps.set(mapPath, { length: entry.length, items: entry.items, base: entry.base, ...(baseState ? { baseState } : {}) });
      const paths = Array.from({ length: entry.items }, (_, index) => itemPathOf(mapPath, index));
      const records = await journal.items!(paths);
      for (const [index, item] of records.entries()) {
        if (item === undefined) continue;
        const path = paths[index]!;
        const record = item as unknown as ItemRecord;
        const valid = record.driver === driver && record.map === mapPath && record.index === index && record.base === entry.base
          && ["running", "committed", "failed"].includes(record.status) && isRecord(record.frame) && Array.isArray(record.frame.done)
          && [record.frame.states, record.frame.chains, record.frame.loops, record.frame.routes, record.frame.inputs, record.frame.steps, record.clocks, record.files, record.unknownResponses, record.maps].every(isRecord)
          && Array.isArray(record.effects) && record.effects.every((id) => typeof id === "string");
        if (!valid) throw invalid(`The record of map item ${path} is not one this run wrote`);
        lastItems.set(path, JSON.stringify({ ...record, revision: 0 }));
        frame.done.push(...record.frame.done);
        Object.assign(frame.steps, record.frame.steps);
        Object.assign(snapshot.clocks, record.clocks);
        for (const [name, sha256] of Object.entries(record.files)) { snapshot.files[name] = sha256 as string; fileOwners.set(name, `${path}/body`); }
        if (Object.keys(record.unknownResponses).length) Object.assign(snapshot.unknownResponses ??= {}, record.unknownResponses);
        if (!committed) {
          for (const [at, delta] of Object.entries(record.frame.states)) {
            if (!isRecord(delta) || !isRecord(delta.set) || !Array.isArray(delta.unset) || typeof delta.sha256 !== "string") throw invalid(`The state at ${at} is not a delta`);
            const state = applyStateDelta(baseState!, delta as StateDelta);
            if (hash(state) !== delta.sha256) throw invalid(`The state at ${at} does not rebuild to the state that was committed`);
            frame.states[at] = state;
            deltas.set(state, delta as StateDelta);
            digests.set(state, delta.sha256);
          }
          Object.assign(frame.chains, record.frame.chains);
          Object.assign(frame.loops, record.frame.loops);
          Object.assign(frame.routes, record.frame.routes);
          Object.assign(frame.inputs, record.frame.inputs);
        }
        await restoreMaps(record.maps, snapshot);
      }
    }
  };
  /** The whole state of a run stored in the keyed layout: its own record with every state read back by digest, and what
   *  its map items keep. */
  const restoreV4 = async (stored: FrozenSnapshotV4): Promise<Snapshot> => {
    // A copy: what the items hold is merged into the restored frame, and the store's own state (which it writes back for
    // a completion that names none) must stay the driver's record alone.
    const { maps: table, pin, ...rest } = structuredClone(stored);
    if (!isRecord(pin) || !isRecord(pin.states) || !Object.values(pin.states).every((sha256) => typeof sha256 === "string" && SHA.test(sha256)) || !Array.isArray(pin.done)) throw invalid("Invalid frozen recovery checkpoint");
    const states: Record<string, State> = {};
    for (const [at, sha256] of Object.entries(pin.states)) states[at] = await stateBy(sha256);
    const restored = { ...rest, schema: FROZEN_SNAPSHOT_SCHEMA, pin: { ...pin, done: [...pin.done], states }, clocks: { ...rest.clocks }, files: { ...rest.files } } as Snapshot;
    await restoreMaps(table, restored);
    return restored;
  };
  /** The host's stop as it was handed over (a cancel outranks a pause), and who issued it. */
  let requested: RecoveryStop | undefined;
  /** The one error the driver's stop is: its signal's reason and every refusal after it, naming the committed stop. */
  let stopError: RecoveryError | undefined;
  let snapshot: Snapshot;
  /** This process's ownership generation of the run: one per process that holds it. */
  const generation = journal.generation;
  const serial = () => serializeFrozenSnapshot(snapshot);
  /** Files the run holds, with the path that produced them: a map item's file is kept in the item's record. */
  const keepFiles = (files: Record<string, string>, at: string | undefined) => {
    Object.assign(snapshot.files, files);
    for (const name of Object.keys(files)) { if (at === undefined) fileOwners.delete(name); else fileOwners.set(name, at); }
  };
  /** The path an effect clock belongs to: an attempt's effect, a poll's or a wait's node. */
  const clockPath = (key: string): string | undefined => {
    if (key.startsWith("attempt:")) return frozenEffectPath(key.slice("attempt:".length))?.path;
    // poll:<tag>:<path>, and wait:<tag>:<path>:<ordinal>.
    const poll = /^poll:[^:]+:(\/root.*)$/s.exec(key);
    if (poll) return poll[1];
    const wait = /^wait:[^:]+:(\/root.*):\d+$/s.exec(key);
    return wait ? wait[1] : undefined;
  };
  /** One write in the keyed layout: the driver's record without what lies in map items, the records of the items that
   *  changed, and the states first referenced now. `admitting` is an effect admitted in this write; `owner` the item that
   *  lists it. */
  const keyedWrite = (admitting?: string): { state: FrozenSnapshotV4; parts: (revision: number) => RecoveryParts; owner?: string } => {
    const frame = snapshot.pin;
    const done = new Set(frame.done);
    type Build = { path: string; map: string; index: number; record: ItemRecord };
    const builds = new Map<string, Build>();
    /** The record a path lies in: undefined for the driver's own, null for an item of a map that committed (it keeps
     *  the record it last wrote). */
    const own = (path: string | undefined): Build | null | undefined => {
      const at = path === undefined ? undefined : mapItemOf(path);
      if (!at) return undefined;
      // A committed map's items keep the records they last wrote; one that committed before the run took the keyed
      // layout has none, and what lies in its items stays in the driver's record, as it was.
      if (done.has(at.map)) return maps.has(at.map) ? null : undefined;
      let build = builds.get(at.item);
      if (!build) {
        const map = maps.get(at.map);
        if (!map) throw invalid(`The map item ${at.item} belongs to no map this run started`);
        build = { path: at.item, map: at.map, index: at.index, record: {
          driver, map: at.map, index: at.index, base: map.base, revision: 0, status: "running",
          frame: { done: [], states: {}, chains: {}, loops: {}, routes: {}, inputs: {}, steps: {} },
          effects: [], clocks: {}, files: {}, unknownResponses: {}, maps: {},
        } };
        builds.set(at.item, build);
      }
      return build;
    };
    const states: Record<string, unknown> = {};
    const kept = (state: State): string => {
      const digest = digestOf(state);
      if (!writtenStates.has(digest)) { writtenStates.add(digest); states[digest] = state; }
      return digest;
    };
    const deltaOf = (map: string, state: State): StateDelta => {
      const known = deltas.get(state);
      if (known) return known;
      const base = maps.get(map)?.baseState;
      if (!base) throw invalid(`The base of the map at ${map} is not known`);
      const delta = stateDelta(base, state, digestOf(state));
      deltas.set(state, delta);
      return delta;
    };
    const pin: FrozenSnapshotV4["pin"] = { input: frame.input, done: [], states: {}, chains: {}, loops: {}, routes: {}, inputs: {}, steps: {}, ...(frame.partial ? { partial: frame.partial } : {}) };
    for (const at of frame.done) { const build = own(at); if (build === undefined) pin.done.push(at); else if (build) build.record.frame.done.push(at); }
    for (const [at, state] of Object.entries(frame.states)) {
      const build = own(at);
      if (build === undefined) pin.states[at] = kept(state);
      else if (build) build.record.frame.states[at] = deltaOf(build.map, state);
    }
    for (const table of ["chains", "loops", "routes", "inputs", "steps"] as const) {
      for (const [at, value] of Object.entries(frame[table])) {
        const build = own(at);
        if (build === undefined) (pin[table] as Record<string, unknown>)[at] = value;
        else if (build) (build.record.frame[table] as Record<string, unknown>)[at] = value;
      }
    }
    const clocks: Record<string, number> = {};
    for (const [key, value] of Object.entries(snapshot.clocks)) { const build = own(clockPath(key)); if (build === undefined) clocks[key] = value; else if (build) build.record.clocks[key] = value; }
    const files: Record<string, string> = {};
    for (const [name, sha256] of Object.entries(snapshot.files)) { const build = own(fileOwners.get(name)); if (build === undefined) files[name] = sha256; else if (build) build.record.files[name] = sha256; }
    const unknownResponses: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(snapshot.unknownResponses ?? {})) { const build = own(frozenEffectPath(id)?.path); if (build === undefined) unknownResponses[id] = value; else if (build) build.record.unknownResponses[id] = value; }
    for (const id of [...journal.effects().map((effect) => effect.id), ...(admitting === undefined || journal.effect(admitting) ? [] : [admitting])]) {
      const build = own(frozenEffectPath(id)?.path);
      if (build) build.record.effects.push(id);
    }
    // A map's item records are the first ones: count them before the maps are written.
    for (const build of builds.values()) { const map = maps.get(build.map)!; map.items = Math.max(map.items, build.index + 1); }
    const table: Record<string, MapEntry> = {};
    for (const [at, map] of maps) {
      const build = own(at);
      const entry: MapEntry = { length: map.length, items: map.items, base: map.base };
      if (build === undefined) table[at] = entry; else if (build) build.record.maps[at] = entry;
      if (!done.has(at) && map.baseState) kept(map.baseState);
    }
    /** An item is done when its body committed: a chain never commits itself, so the last step a chain body runs
     *  through, descending through nested chains, is where the body ends. */
    const finished = (item: string): boolean => {
      let at = `${item}/body`;
      let node = nodeAt(view, at);
      while (node?.node === "chain" && node.steps.length > 0) { at = `${at}/steps/${node.steps.length - 1}`; node = node.steps[node.steps.length - 1]; }
      return done.has(at);
    };
    const items: Record<string, ItemRecord> = {};
    for (const build of builds.values()) {
      build.record.status = finished(build.path) ? "committed" : "running";
      const text = JSON.stringify(build.record);
      if (lastItems.get(build.path) !== text) { lastItems.set(build.path, text); items[build.path] = build.record; }
    }
    const { pin: _pin, schema: _schema, clocks: _clocks, files: _files, unknownResponses: _unknown, ...rest } = snapshot;
    const state = serializeFrozenSnapshot({ ...rest, schema: FROZEN_SNAPSHOT_SCHEMA_V4, pin, clocks, files,
      ...(Object.keys(unknownResponses).length ? { unknownResponses } : {}), maps: table } as unknown as Snapshot) as unknown as FrozenSnapshotV4;
    const owner = admitting === undefined ? undefined : (own(frozenEffectPath(admitting)?.path) ?? undefined)?.path;
    return { state, parts: (revision) => ({ items: Object.fromEntries(Object.entries(items).map(([path, item]) => [path, { ...item, revision }])), states }), ...(owner ? { owner } : {}) };
  };
  /** Whether every map still running with something in its items has its base: then a run stored whole can move. */
  const basesKnown = (): boolean => {
    const frame = snapshot.pin;
    const done = new Set(frame.done);
    const paths = [...frame.done, ...Object.keys(frame.states), ...Object.keys(frame.chains), ...Object.keys(frame.inputs), ...Object.keys(frame.steps),
      ...Object.keys(frame.loops), ...Object.keys(frame.routes)];
    return paths.every((path) => { const at = mapItemOf(path); return !at || done.has(at.map) || Boolean(maps.get(at.map)?.baseState); });
  };
  /** One write of the driver's state, in the layout this open keeps. */
  const writeOf = (admitting?: string): { state: unknown; parts?: (revision: number) => RecoveryParts; owner?: string } => {
    if (moving && basesKnown()) { moving = false; layoutV4 = true; }
    return layoutV4 ? keyedWrite(admitting) : { state: serial() };
  };
  /** The journal's commits, in the order the driver made them: a commit a synchronous method starts lands before any
   *  later one, and an effect's admission waits for every earlier commit. A failed commit stops the run. */
  let chain: Promise<unknown> = Promise.resolve();
  const persist = <T>(write: () => Promise<T>): Promise<T> => {
    const next = chain.then(() => { if (fatal && !stopping) throw fatal; return write(); });
    chain = next.catch((error) => { if (!fatal) { fatal = error; controller.abort(error); } });
    return next;
  };
  /** Every commit the driver started has landed; a failed one is thrown. */
  const flush = async () => { await chain; if (fatal && !stopping) throw fatal; };
  try {
    // A driver an earlier process bound, with no checkpoint, is a run killed between its binding and its first
    // checkpoint when the journal holds nothing else of it: it never started, and it starts now. One with effects and
    // no checkpoint needs reconciliation.
    const stored = journal.state as Snapshot | FrozenSnapshotV4 | null;
    // A run a later build stored in a schema this build does not know: refused with its own code, so a host leaves the
    // run for a build that knows it rather than ending it.
    const known = [FROZEN_SNAPSHOT_SCHEMA, FROZEN_SNAPSHOT_SCHEMA_V4];
    const found = (stored as { schema?: unknown } | null)?.schema;
    const version = typeof found === "string" ? /^agentrun\.frozen_run\.v(\d+)$/.exec(found)?.[1] : undefined;
    if (version !== undefined && !known.includes(found as string) && Number(version) > 4) {
      throw Object.assign(new RecoveryError(`This run is stored as ${found as string}, newer than this build knows (${known.join(", ")}); open it with a build that knows it`, "RECOVERY_SCHEMA_NEWER"), { found, known });
    }
    // The keyed layout is sticky: a run stored in it stays in it. A run stored whole, or a new one, takes it when the
    // host asks for it and the store keeps parts.
    if (stored?.schema === FROZEN_SNAPSHOT_SCHEMA_V4) {
      if (!keyed) throw invalid("This run is stored in the keyed layout (agentrun.frozen_run.v4), and this store keeps no parts");
      layoutV4 = true;
    } else {
      moving = options.layout === "v4" && keyed;
      if (options.layout === "v4" && !keyed) layoutReason = "the store keeps no parts (its journal has no items and stateOf)";
    }
    const saved = stored?.schema === FROZEN_SNAPSHOT_SCHEMA_V4 ? await restoreV4(stored as FrozenSnapshotV4) : stored as Snapshot | null;
    if (journal.existing && !saved && journal.effects().length > 0) throw failure("FROZEN_CHECKPOINT_INVALID", "Existing frozen run has no checkpoint; retained workspace requires reconciliation");
    // Only the paths of the run's own document are resolved.
    if (saved) validateFrozenSnapshot(saved, { resolves: (at) => Boolean(nodeAt(view, at)) });
    snapshot = openedFrozenSnapshot(saved);
    // A route decision a checkpoint holds without the choice and the unsure flag holds the
    // answer whole: the branch taken, the choice and the flag are derived from it by the
    // interpreter's rule, and the commit below stores them.
    completeRouteDecisions(snapshot.pin, view);
    const left = journal.effects().filter((effect) => effect.status === "unknown");
    if (options.reconcile && left.length > 0) {
      let reconciling = true;
      try {
        await options.reconcile(structuredClone(left), async (id, value, receipt) => {
          if (!reconciling) throw failure("RECOVERY_RECONCILE_FAILED", `Reconcile ${id} after reconcile returned`);
          if (!left.some((effect) => effect.id === id)) throw failure("RECOVERY_RECONCILE_FAILED", `Reconcile ${id}: not an unknown effect of this run`);
          // The files the effect declares are hashed now, as a normal completion records them: a missing output refuses the
          // settlement, and a later resume refuses an output that changed.
          const at = frozenEffectPath(id)?.path;
          const declared = at === undefined ? undefined : nodeAt(view, at);
          const files = reader.hashes(declared?.node === "call" ? declared.produces ?? [] : []);
          keepFiles(files, at);
          // The calls an earlier process kept stay: the host's re-send is added after them, so a call that applied before the kill is still on record.
          if (receipt?.calls?.length) await journal.called(id, [...(journal.effect(id)?.calls ?? []), ...receipt.calls]);
          await journal.complete(id, { value, files, ...(receipt?.intent ? { intent: receipt.intent } : {}) });
        });
      } catch (error) {
        throw error instanceof RecoveryError && error.code === "RECOVERY_RECONCILE_FAILED" ? error
          : new RecoveryError(`Reconcile failed: ${error instanceof Error ? error.message : String(error)}`, "RECOVERY_RECONCILE_FAILED", { cause: error });
      } finally { reconciling = false; }
    }
    // The open's commit: a run stored whole that takes the keyed layout moves to it here, whole or not at all.
    const opening = writeOf();
    const layoutNote: Pick<RecoveryNote, "kind" | "detail"> | undefined = layoutReason ? { kind: "layout", detail: { schema: FROZEN_SNAPSHOT_SCHEMA, reason: layoutReason } } : undefined;
    await journal.save(opening.state, layoutNote, opening.parts);
  } catch (error) { await journal.close(); throw error; }
  const ordinals = new Map<string, number>();
  /** One commit of the driver's state. */
  const save = (): Promise<unknown> => {
    const write = writeOf();
    // A synchronous method does not wait for it; the failure is the run's, and the next awaited commit throws it.
    return persist(() => journal.save(write.state, undefined, write.parts)).catch(() => undefined);
  };
  /** Effects dispatched and not yet completed or failed. A pause is not taken while one is in flight. */
  let inFlight = 0;
  /** New work waiting at a seam for a pause to be taken, woken when the last effect in flight ends or a stop is taken. */
  let drained: { promise: Promise<void>; wake: () => void } | undefined;
  const wake = () => { const waiting = drained; drained = undefined; waiting?.wake(); };
  const pausePending = () => !fatal && requested?.action === "pause" && snapshot.status !== "paused" && inFlight > 0;
  const guard = () => {
    if (fatal) throw fatal;
    try {
      // The driver owns the run-wide pause and cancel; its steps stop through its signal. A pause waits for every
      // effect in flight to complete and commit; a cancel does not.
      const stop = frozenStop(snapshot.status, requested?.action);
      if (stop === "paused" && inFlight > 0) return;
      if (stop) {
        snapshot.status = stop;
        // The stopped state is still committed, after which nothing else is.
        stopping = true;
        const error = stopError = new RecoveryError(`Frozen run ${snapshot.status}`, stop === "cancelled" ? "FROZEN_CANCELLED" : "FROZEN_PAUSED", { source: requested?.source });
        fatal = error;
        controller.abort(error);
        void save();
        throw error;
      }
    } catch (error) {
      if (!fatal) { fatal = error; controller.abort(error); }
      throw error;
    }
  };
  /** A seam: where new work starts. While a pause waits for an effect in flight, new work waits here; then the pause
   *  is taken and the work is refused with it. */
  const seam = async () => {
    while (pausePending()) {
      if (!drained) { let wake!: () => void; drained = { promise: new Promise<void>((resolve) => { wake = resolve; }), wake }; }
      await drained.promise;
    }
    guard();
  };
  /** An effect in flight has ended. The last one lets a waiting pause be taken. */
  const settled = () => {
    inFlight -= 1;
    if (inFlight > 0) return;
    if (requested?.action === "pause") { try { guard(); } catch { /* The pause is taken: its commit is queued. */ } }
    wake();
  };
  const fileHashes = (names: string[]): Record<string, string> => reader.hashes(names);
  const verifyFiles = (files: Record<string, string>) => {
    if (hash(fileHashes(Object.keys(files))) !== hash(files)) throw failure("FROZEN_ARTIFACT_INVALID", "Committed artifact bytes changed; effect will not be repeated");
  };
  /** An effect-level clock is set once and kept across resume: a poll window or an attempt deadline
   *  belongs to the outside world, so downtime counts against it, never against the run. */
  const clock = (key: string, duration: number) => {
    if (snapshot.clocks[key] === undefined) { snapshot.clocks[key] = Date.now() + duration; save(); }
    if (!Number.isFinite(snapshot.clocks[key])) throw failure("FROZEN_CHECKPOINT_INVALID", "Invalid durable clock");
    return snapshot.clocks[key];
  };
  // A row that names a commit is checked against the journal: the escalation row's revision is an
  // escalation commit, or the checkpoint is refused. A placeholder revision never survives a resume.
  const escalated = snapshot.escalation;
  if (escalated && !(escalated.revision >= 1 && journal.notes().some((note) => note.revision === escalated.revision && note.kind === "escalation"))) {
    await journal.close();
    throw failure("FROZEN_CHECKPOINT_INVALID", `The escalation row names revision ${escalated.revision}, which is not an escalation commit`);
  }
  /** The frame the interpreter is running: the run's document. Its tag names its sessions and effects. */
  const active = (): { frame: PathFrame; tag: FrameTag; doc: Workflow } => ({ frame: snapshot.pin, tag: "step", doc: view });
  const doneSets = new WeakMap<PathFrame, Set<string>>();
  const doneOf = (frame: PathFrame) => doneSets.get(frame) ?? doneSets.set(frame, new Set(frame.done)).get(frame)!;
  /** Frames whose document input this process has checked: the first resume of a process starts the
   *  document, so it is where a changed input shows. */
  const inputChecked = new WeakSet<PathFrame>();
  /** The path the interpreter named, when it resolves in the running document. */
  const placed = (at: unknown, doc: Workflow): string => {
    if (typeof at !== "string" || !nodeAt(doc, at)) throw pathFault(at, "The interpreter named a path this run's document does not hold");
    return at;
  };
  /** The committed state a resume at `at` is answered from: its own, or the frontier of a chain it sits
   *  in when the frontier lies past it. A chain threads one state, so every step before its frontier,
   *  and everything inside those steps, is answered with the frontier's. */
  const answer = (frame: PathFrame, at: string): State | undefined => {
    if (frame.states[at]) return frame.states[at];
    for (const { chain, index } of enclosingChains(at)) {
      const head = frame.chains[chain];
      if (head && head.index > index) return frame.states[head.path];
    }
    return undefined;
  };
  /** Drops what no resume can ask for again: the states, chain frontiers, loop counts, route decisions
   *  and start bindings of the paths `gone` names. Step records stay: a host reads its sessions from them. */
  const prune = (frame: PathFrame, gone: (at: string) => boolean) => {
    for (const table of [frame.states, frame.chains, frame.loops, frame.routes, frame.inputs] as Array<Record<string, unknown>>) {
      for (const key of Object.keys(table)) if (gone(key)) delete table[key];
    }
  };
  const recovery: NonNullable<WorkflowDeps["recovery"]> = {
    // Every store key below is the interpreter's execution path, so a composed graph (a loop, a route, a
    // map whose body is structure, a nested child) resumes where it stopped.
    supportsExecutionPaths: true,
    async resume(node, state, _item, executionPath) {
      await seam();
      const { frame, doc } = active();
      const at = placed(executionPath, doc);
      if (frame.input === null) { frame.input = hash(state); inputChecked.add(frame); await save(); await flush(); }
      else if (!inputChecked.has(frame)) {
        if (frame.input !== hash(state)) throw failure("FROZEN_INPUT_CHANGED", `Materialized workflow input changed: ${at}`);
        inputChecked.add(frame);
      }
      verifyFiles(snapshot.files);
      const committed = answer(frame, at);
      if (committed) return committed;
      if (doneOf(frame).has(at)) throw pathFault(at, "A committed path was asked for again after its state was released");
      // A map that starts, or starts again, names the base its items are kept against: the state it starts from.
      if ((layoutV4 || moving) && node.node === "map") {
        const list = String(node.itemsPath).split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | null | undefined)?.[key], state);
        maps.set(at, { length: Array.isArray(list) ? list.length : 0, items: maps.get(at)?.items ?? 0, base: digestOf(state), baseState: state });
      }
      // A node started in an earlier process starts again from the same state, or not at all. The
      // binding is durable with the next commit, which is the first durable thing done under it.
      const digest = hash(state);
      if (frame.inputs[at] === undefined) frame.inputs[at] = digest;
      else if (frame.inputs[at] !== digest) throw failure("FROZEN_INPUT_CHANGED", `The input of ${at} changed since it started`);
      return undefined;
    },
    async commit(node, state, _item, executionPath) {
      // Finished work commits while a pause waits for an effect in flight; it starts nothing.
      guard();
      const { frame, doc } = active();
      const at = placed(executionPath, doc);
      const done = doneOf(frame);
      if (done.has(at)) throw pathFault(at, "A path commits once");
      // Every loop the path runs in is on the iteration the path belongs to: iteration k+1 commits
      // nothing before iteration k is complete.
      for (const { loop, index } of enclosingIterations(at)) {
        if (index !== (frame.loops[loop] ?? 0)) throw pathFault(at, `Iteration ${index} committed while its loop is on iteration ${frame.loops[loop] ?? 0}`);
      }
      const step = chainStep(at);
      if (step && (frame.chains[step.chain]?.index ?? -1) >= step.index) throw pathFault(at, "A chain step committed behind its chain's frontier");
      if (node.node === "artifact" && node.path) keepFiles(fileHashes([node.path]), at);
      frame.done.push(at);
      done.add(at);
      // A map that committed, alone or inside what committed, has its results in the state: what it had finished
      // when it failed earlier is no longer the run's.
      if (frame.partial && isWithin(frame.partial.path, at)) delete frame.partial;
      // Everything inside the committed node is answered by it now, and so is everything before it
      // in its chain.
      prune(frame, key => isWithin(key, at));
      if (step) {
        prune(frame, key => enclosingChains(key).some(c => c.chain === step.chain && c.index < step.index));
        frame.chains[step.chain] = { index: step.index, path: at };
      }
      frame.states[at] = state;
      const completed = completedIteration(doc, at);
      if (completed) frame.loops[completed.loop] = completed.index + 1;
      await save();
      await flush();
    },
    async fail(node, results, _error, executionPath) {
      // Finished work commits while a pause waits for an effect in flight; it starts nothing.
      guard();
      const { frame, doc } = active();
      // A map that ended on an item's failure keeps its finished items committed: the handoff's state
      // carries them under the map's key, and a later open answers them from their paths.
      frame.partial = { path: placed(executionPath, doc), as: String((node as { as?: string }).as ?? node.node), results: results.map(result => result === undefined ? null : result) };
      await save();
      await flush();
    },
    pollStartedAt(node, _item, executionPath) {
      guard();
      const { tag, doc } = active();
      const at = placed(executionPath, doc);
      return clock(`poll:${tag}:${at}`, node.poll!.deadline_s * 1000) - node.poll!.deadline_s * 1000;
    },
    async wait(_node, ms, _item, executionPath) {
      await seam();
      const { tag, doc } = active();
      const key = `${tag}:${placed(executionPath, doc)}`;
      const until = Math.min(snapshot.clocks[`poll:${key}`] ?? Infinity,
        clock(`wait:${key}:${ordinals.get(key) ?? 0}`, ms));
      // The wait's clock is durable before the wait starts, so a process that dies inside it resumes the same wait.
      await flush();
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(wait); reject(controller.signal.reason); };
        const wait = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, until - Date.now()));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      guard();
    },
  };
  /** An LLM step's record in the running frame, by its execution path. */
  const llmStep = (executionPath: unknown) => {
    const { frame, tag, doc } = active();
    const at = placed(executionPath, doc);
    if (!LLM_KINDS.has(nodeAt(doc, at)!.node)) throw pathFault(at, "Only an LLM step has a session");
    return { frame, tag, at };
  };
  const sessionOf = (tag: FrameTag, at: string, step: StepRecord, attempt = step.attempt) => frozenStepSessionId(driver, step.label, tag, at, attempt);
  /** The highest top-level step of `doc` the frame completed, and the committed path its state is
   *  read at (`topLevelCompletion`). */
  const completedHead = (frame: PathFrame, doc: Workflow): { index: number; at: string } | undefined => {
    let head: { index: number; at: string } | undefined;
    for (const at of frame.done) {
      const index = topLevelCompletion(doc, at);
      if (index !== undefined && (!head || index > head.index)) head = { index, at };
    }
    return head;
  };
  return {
    recovery, signal: controller.signal, resumed: journal.existing,
    /** This process's generation of the run: a request this process makes is named with it, so a
     *  process that asks again never reuses an earlier process's invocation. */
    get generation() { return generation; },
    /** A refusal found before any step, or null: the host escalates it before any step runs. */
    preStepRefusal,
    /** How this open keeps the run: the layout's schema, and why it is not the keyed one the host asked for. */
    get layout(): { schema: typeof FROZEN_SNAPSHOT_SCHEMA | typeof FROZEN_SNAPSHOT_SCHEMA_V4; reason?: string } {
      return { schema: layoutV4 ? FROZEN_SNAPSHOT_SCHEMA_V4 : FROZEN_SNAPSHOT_SCHEMA, ...(layoutReason ? { reason: layoutReason } : {}) };
    },
    binding,
    /** The run's key: what its step sessions and effects are named under. */
    driverId: driver,
    /** The host hands the driver its stop here. A cancel stops the driver at once, and its steps and effects through
     *  its signal. A pause refuses new work at once and is taken when no effect is in flight: an effect already
     *  dispatched completes and commits its receipt first, so a paused run resumes without a reconciliation. */
    stop: (stop: RecoveryStop) => {
      if (requested?.action !== "cancel") requested = stop;
      // A cancel after the driver paused replaces the pause it committed and the stop it reports: a cancelled run never resumes.
      if (stopError && snapshot.status === "paused" && stop.action === "cancel") {
        snapshot.status = "cancelled";
        Object.assign(stopError, { code: "FROZEN_CANCELLED", message: "Frozen run cancelled", source: stop.source });
        void save();
      }
      try { guard(); } catch { /* Sticky: the stop blocks every admission. */ }
      if (fatal) wake();
    },
    /** The driver's stop check, for a branch that hands off without entering the interpreter: a pause or cancel the
     *  driver took stops the run here, before anything resumes. */
    checkStop() { guard(); },
    /** A seam for new work: it waits while a pause waits for an effect in flight, then applies any stop taken. */
    seam,
    /** An LLM step's execution record, admitted before it dispatches. The first call fixes the label
     *  the interpreter names it by (a child's step under its invocation) and the retry limit; a resume
     *  at this path gets the same record, so its session is found again. A closed attempt advances to a new
     *  session identity here, and only here; a failed step never gets another. */
    stepSession(executionPath: unknown, label: string, admission?: { attemptsAllowed: number }): StepRecord & { stepId: string; sessionId: string; earlierSessionIds: string[] } {
      guard();
      const { frame, tag, at } = llmStep(executionPath);
      const { step, changed } = admitFrozenStep(frame.steps, at, label, admission);
      if (changed) save();
      return { ...step, stepId: frozenStepId(tag, at), sessionId: sessionOf(tag, at, step), earlierSessionIds: Array.from({ length: step.attempt }, (_, earlier) => sessionOf(tag, at, step, earlier)) };
    },
    /** Whether the step already has an execution record: a resumed step was admitted in an earlier
     *  process and is continued, never refused again. */
    stepAdmitted(executionPath: unknown): boolean { const { frame, at } = llmStep(executionPath); return frame.steps[at] !== undefined; },
    /** The current attempt did not submit: its session closes with its spend kept.
     *  The step is `closed` until a retry is admitted, or `failed` when no attempt remains. */
    stepAttemptFailed(executionPath: unknown, final = false) {
      guard();
      const { frame, tag, at } = llmStep(executionPath);
      const step = frame.steps[at];
      if (!step) throw pathFault(at, "Step attempt failed before admission");
      const id = sessionOf(tag, at, step);
      if (options.closeStepSession) void persist(() => options.closeStepSession!(id)).catch(() => undefined);
      closeFrozenStepAttempt(step, final);
      save();
    },
    /** The step delivered its record; the row and the step record agree before the step commit. */
    stepSubmitted(executionPath: unknown) {
      guard();
      const { frame, at } = llmStep(executionPath);
      const step = frame.steps[at];
      if (step) { step.status = "submitted"; save(); }
    },
    /** The short identity of an admitted LLM step (a digest of its frame and path), for the escalation
     *  row when it fails; null for a path that ran no LLM step. */
    stepId(executionPath: unknown): string | null {
      const { frame, tag, doc } = active();
      return typeof executionPath === "string" && nodeAt(doc, executionPath) && frame.steps[executionPath] ? frozenStepId(tag, executionPath) : null;
    },
    /** Spend outside any question or session, committed with the driver's state the moment it is priced, so the run's
     *  recorded spend holds it. It may be called inside a tool, so it never applies a stop; a failed commit is the run's
     *  persistence failure. */
    async charge(usd: number): Promise<void> {
      if (fatal) throw fatal;
      if (!Number.isFinite(usd) || usd <= 0) return;
      snapshot.questionSpendUsd = +((snapshot.questionSpendUsd ?? 0) + usd).toFixed(8);
      await save();
      await flush();
    },
    /** A question's metered spend, committed with the driver's state so a resume that skips the
     *  finished question still reports it; an unpriced answer (`null`) adds nothing. A route's answer is its decision: it commits in the same save, once per route path, and a resume
     *  inside the branch follows it instead of asking again. */
    recordQuestionSpend(usd: number | null, route?: { executionPath: unknown; label: string; result: Record<string, unknown>; receipts: QuestionReceipts | null }) {
      guard();
      let changed = false;
      if (usd !== null && Number.isFinite(usd) && usd >= 0) { snapshot.questionSpendUsd = +((snapshot.questionSpendUsd ?? 0) + usd).toFixed(8); changed = true; }
      if (route) {
        const { frame, doc } = active();
        const at = placed(route.executionPath, doc);
        const node = nodeAt(doc, at);
        if (node?.node !== "route") throw pathFault(at, "Only a route's answer is a decision");
        if (frame.routes[at]) throw pathFault(at, "A route is decided once");
        frame.routes[at] = { label: route.label, ...routeTaken(node, route.result.answers), request_sha256: typeof route.result.request_sha256 === "string" ? route.result.request_sha256 : null, result: route.result, receipts: route.receipts };
        changed = true;
      }
      if (changed) save();
    },
    /** The host has written what it keeps of the route at `executionPath`: its decision no longer carries the
     *  receipts a resume would write. */
    routeReceipted(executionPath: unknown) {
      guard();
      const { frame, doc } = active();
      const decision = frame.routes[placed(executionPath, doc)];
      if (!decision?.receipts) return;
      decision.receipts = null;
      save();
    },
    /** The committed decision of the route at `executionPath`, if it was answered in an earlier process. */
    routeDecision(executionPath: unknown): RouteDecision | undefined {
      const { frame, doc } = active();
      return frame.routes[placed(executionPath, doc)];
    },
    /** The escalation that ended this run (a gate that fired, or an LLM step that failed), written once
     *  as an escalation commit before anything acts on it. A later open gets the same row and the same
     *  continuation identity, whatever fires again. */
    async escalate(row: Omit<EscalationRow, "tail" | "revision">): Promise<EscalationRow> {
      guard();
      if (snapshot.escalation) return snapshot.escalation;
      const stepId = row.step_exec_id ?? null;
      const tailId = stepId ?? Math.random().toString(36).slice(2, 10);
      // The row is placed before the commit so the commit's state carries it, and the state is
      // serialized inside the commit's transaction with that commit's revision: no boundary
      // exists where the row is durable and its revision is not.
      snapshot.escalation = { ...row, step_exec_id: stepId, tail: `${driver}:escalated:${tailId}`, revision: 0 };
      // The note names the handoff, not the state: the state rides the snapshot.
      const detail = { kind: row.kind, stage: row.stage, summary: String(row.summary ?? "").slice(0, 512), step_label: row.step_label, step_exec_id: stepId, workflow_sha_used: row.workflow_sha_used,
        cost_usd: row.cost_usd, tail: snapshot.escalation.tail, state_keys: Object.keys(row.state ?? {}) };
      // The parts are computed with the state, after the row has its revision.
      let parts: ((revision: number) => RecoveryParts) | undefined;
      await persist(() => journal.save((revision: number) => { snapshot.escalation!.revision = revision; const write = writeOf(); parts = write.parts; return write.state; },
        { kind: "escalation", detail }, (revision) => parts?.(revision) ?? {}));
      return snapshot.escalation;
    },
    escalation(): EscalationRow | undefined { return snapshot.escalation; },
    /** How many effects the driver admitted. */
    effectCalls(): number { return journal.effects().length; },
    /** What the continuation inherited, against the escalation that admitted it: the level, the sizes of what it
     *  read and its identity. */
    async annotateHandoff(detail: { escalation_revision: number; tail: string; inherit: string; block_chars: number; digest_chars: number }): Promise<void> {
      await persist(() => journal.note("inherited", detail));
    },
    /** The run's spend at the moment its continuation is admitted. Spend may land under this run after
     *  the escalation commit, so the row the continuation reads the spend from is brought current here,
     *  by one `handoff` commit that names the escalation. The escalation's revision, what the
     *  continuation binds on, does not change. */
    async handoff(spend: Pick<EscalationRow, "cost_usd" | "turns" | "effect_calls">): Promise<EscalationRow> {
      guard();
      const row = snapshot.escalation;
      if (!row) throw failure("FROZEN_CHECKPOINT_INVALID", "A handoff follows an escalation; none is recorded");
      if (row.cost_usd === spend.cost_usd && row.turns === spend.turns && row.effect_calls === spend.effect_calls) return row;
      const detail = { escalation_revision: row.revision, previous_cost_usd: row.cost_usd,
        cost_usd: spend.cost_usd, turns: spend.turns, effect_calls: spend.effect_calls };
      Object.assign(row, spend);
      const write = writeOf();
      await persist(() => journal.save(write.state, { kind: "handoff", detail }, write.parts));
      return row;
    },
    /** The state the document's committed top-level prefix left behind, plus what a failed map's finished
     *  items produced under the map's key: what an escalation on a failure carries. */
    lastState(): Record<string, unknown> {
      const { frame, doc } = active();
      const head = completedHead(frame, doc);
      const state = head ? frame.states[head.at] ?? {} : {};
      const partial = frame.partial;
      return partial ? { ...state, [partial.as]: partial.results } : state;
    },
    get started() {
      if (snapshot.pin.input === null && journal.effects().length > 0) {
        throw failure("FROZEN_CHECKPOINT_INVALID", "Effects exist before the frozen input checkpoint");
      }
      return snapshot.pin.input !== null;
    },
    wrapEffect(run: (params: RecoveryEffectParams) => Promise<unknown>): NonNullable<WorkflowDeps["runEffect"]> {
      return async params => {
        await seam();
        const { tag, doc } = active();
        const at = placed(params.executionPath, doc);
        const key = `${tag}:${at}`;
        const ordinal = ordinals.get(key) ?? 0;
        ordinals.set(key, ordinal + 1);
        const id = frozenEffectId(tag, at, ordinal);
        const argsHash = hash({ input: params.input, node: params.node, idempotencyKey: params.idempotencyKey });
        const existing = journal.effect(id);
        if (existing) {
          if (existing.argsHash !== argsHash) throw failure("FROZEN_INPUT_CHANGED", "Recovered effect arguments changed");
          if (existing.status !== "completed") throw failure("FROZEN_EFFECT_UNKNOWN", `Reconcile ${id} before resuming; it will not be repeated`);
          const receipt = existing.result as { value: unknown; files: Record<string, string> };
          verifyFiles(receipt.files);
          keepFiles(receipt.files, at);
          await save();
          await flush();
          return receipt.value;
        }
        if (params.produces.some(reserved)) throw failure("RUN_CONTROL_UNSUPPORTED", "Effect declares a host-owned output path");
        // The effect's own clock: the node's deadline, and the poll window when it is a poll.
        const deadline = Math.min(snapshot.clocks[`poll:${key}`] ?? Infinity,
          clock(`attempt:${id}`, params.node.deadline_s * 1000));
        if (Date.now() >= deadline) throw failure("FROZEN_EFFECT_DEADLINE", "Effect exceeded its own deadline");
        // A tool effect is admitted with the external call it makes, keyed as a continuation keys its own calls
        // (`gatewayIntentOf`: a fetch wrapper's call is the gateway tool it names and its arguments), so a continuation
        // that inherits it unknown refuses the same call.
        const external = params.node.via === "tool" ? gatewayIntentOf(String((params.node as any).tool), params.input ?? {}) : undefined;
        // From its admission the effect is in flight: a pause waits for it to complete and commit, so the admission is
        // never left without its dispatch.
        inFlight += 1;
        try {
          // The driver's state and the admission are one transaction.
          const admission = writeOf(id);
          const admitted = await persist(() => journal.admit(id, String((params.node as any).label), argsHash, admission.state, driver, external, params.input ?? null, admission.parts, admission.owner));
          if (admitted !== "new") throw failure("FROZEN_EFFECT_UNKNOWN", `Reconcile ${id} before dispatch`);
          // What landed while the admission was being committed still counts: after a cancel, the caller's own
          // cancellation or the effect's deadline, the effect stays admitted and unknown and the adapter is never called.
          // A pause lets it dispatch and complete.
          guard();
          if (params.signal.aborted) throw params.signal.reason;
          if (Date.now() >= deadline) throw failure("FROZEN_EFFECT_DEADLINE", "Effect exceeded its own deadline");
          const signal = AbortSignal.any([params.signal, controller.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
          // A thrown/aborted call remains UNKNOWN, including transient failures: no blind retry. Each outside call the effect
          // makes is kept on its record as it ends, on the driver's commit chain, so a process killed mid-effect keeps the
          // calls it made and a commit that fails is the run's failure, which aborts the effect at once.
          const calls: unknown[] = [];
          const keep = (record: unknown) => { calls.push(record); const held = [...calls]; persist(() => journal.called(id, held)).catch(() => undefined); };
          let value: unknown;
          try { value = await run({ ...params, signal, call: keep, effect: { id, argsHash } }); }
          finally { if (calls.length) await flush(); }
          if (signal.aborted) throw signal.reason;
          const returned = value as { outcome?: unknown; effect_status?: unknown; details?: { outcome?: unknown; effect_status?: unknown } } | null;
          if (returned?.outcome === "unknown" || returned?.effect_status === "unknown"
            || returned?.details?.outcome === "unknown" || returned?.details?.effect_status === "unknown") {
            (snapshot.unknownResponses ??= {})[id] = value;
            await save(); // Preserve the observation without certifying completion.
            await flush();
            throw failure("FROZEN_EFFECT_UNKNOWN", `Reconcile ${id}: tool returned an unknown outcome`);
          }
          const files = fileHashes(params.produces);
          // A tool effect's receipt names the external call it paid for (the tool and its arguments),
          // so a continuation that inherits the receipt can answer the same call from it. Any other
          // effect keeps its arguments beside its result.
          const intent = params.node.via === "tool" ? { tool: String((params.node as any).tool), args: params.input } : undefined;
          keepFiles(files, at);
          const completion = writeOf();
          await persist(() => journal.complete(id, { value, files, ...(intent ? { intent } : { args: params.input ?? null }) }, completion.state, completion.parts));
          return value;
        } finally { settled(); }
      };
    },
    /** Every commit the driver started has landed; a failed one is thrown. */
    flush,
    /** Let go of the run once every commit the driver started has landed. */
    async close() { await chain; await journal.close(); },
  };
}
