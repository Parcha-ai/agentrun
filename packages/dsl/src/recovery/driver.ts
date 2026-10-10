// The recovery driver: the durable state of one workflow run, addressed by the interpreter's execution paths. Execution
// stays in the interpreter. The driver implements its `recovery` hooks over a RecoveryStore, admits each effect before
// it is dispatched, and holds each LLM step's record, each route's decision and the escalation that ends a run.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RouteNode, Workflow, WorkflowDeps, WorkflowNode } from "../workflow.js";
import { desugarWorkflow } from "../workflow.js";
import { chainStep, childrenOf, completedIteration, enclosingChains, enclosingIterations, isWithin, nodeAt, topLevelCompletion } from "./execution-path.js";
import { bindingDigests, LEDGER_FORMAT } from "./binding.js";
import { canonicalHash as hash } from "./canonical-hash.js";
import { RecoveryError } from "./errors.js";
import { validateFrozenSnapshot, openedFrozenSnapshot, serializeFrozenSnapshot,
  frozenStepSessionId, frozenStepId, frozenEffectId, admitFrozenStep, closeFrozenStepAttempt, frozenStop,
  type FrozenSnapshot as Snapshot, type PathFrame, type RouteDecision, type QuestionReceipts, type FrameTag, type StepRecord, type EscalationRow } from "./frozen-snapshot.js";
import type { RecoveryBinding, RecoveryJournal, RecoveryStore } from "./store.js";

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
  return {
    same: (a, b) => path.resolve(cwd, a) === path.resolve(cwd, b),
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
};

/** What a host's effect adapter receives under the driver: the interpreter's parameters, and `call`, which keeps
 *  each outside call the effect makes on its record as the call ends. */
export type RecoveryEffectParams = Parameters<NonNullable<WorkflowDeps["runEffect"]>>[0] & { call?: (record: unknown) => void };


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
  /** The host's stop as it was handed over (a cancel outranks a pause), and who issued it. */
  let requested: RecoveryStop | undefined;
  /** The one error the driver's stop is: its signal's reason and every refusal after it, naming the committed stop. */
  let stopError: RecoveryError | undefined;
  let snapshot: Snapshot;
  /** This process's ownership generation of the run: one per process that holds it. */
  const generation = journal.generation;
  const serial = () => serializeFrozenSnapshot(snapshot);
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
    const saved = journal.state as Snapshot | null;
    if (journal.existing && !saved && journal.effects().length > 0) throw failure("FROZEN_CHECKPOINT_INVALID", "Existing frozen run has no checkpoint; retained workspace requires reconciliation");
    // Only the paths of the run's own document are resolved.
    if (saved) validateFrozenSnapshot(saved, { resolves: (at) => Boolean(nodeAt(view, at)) });
    snapshot = openedFrozenSnapshot(saved);
    // A route decision a checkpoint holds without the choice and the unsure flag holds the
    // answer whole: the branch taken, the choice and the flag are derived from it by the
    // interpreter's rule, and the commit below stores them.
    completeRouteDecisions(snapshot.pin, view);
    await journal.save(serial());
  } catch (error) { await journal.close(); throw error; }
  const ordinals = new Map<string, number>();
  /** One commit of the driver's whole state. */
  const save = (): Promise<unknown> => {
    const state = serial();
    // A synchronous method does not wait for it; the failure is the run's, and the next awaited commit throws it.
    return persist(() => journal.save(state)).catch(() => undefined);
  };
  const guard = () => {
    if (fatal) throw fatal;
    try {
      // The driver owns the run-wide pause and cancel; its steps stop through its signal.
      const stop = frozenStop(snapshot.status, requested?.action);
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
    async resume(_node, state, _item, executionPath) {
      guard();
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
      // A node started in an earlier process starts again from the same state, or not at all. The
      // binding is durable with the next commit, which is the first durable thing done under it.
      const digest = hash(state);
      if (frame.inputs[at] === undefined) frame.inputs[at] = digest;
      else if (frame.inputs[at] !== digest) throw failure("FROZEN_INPUT_CHANGED", `The input of ${at} changed since it started`);
      return undefined;
    },
    async commit(node, state, _item, executionPath) {
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
      if (node.node === "artifact" && node.path) Object.assign(snapshot.files, fileHashes([node.path]));
      frame.done.push(at);
      done.add(at);
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
      guard();
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
    binding,
    /** The run's key: what its step sessions and effects are named under. */
    driverId: driver,
    /** The host hands the driver its stop here: the driver stops at once, and its steps through its signal. */
    stop: (stop: RecoveryStop) => {
      if (requested?.action !== "cancel") requested = stop;
      // A cancel after the driver paused replaces the pause it committed and the stop it reports: a cancelled run never resumes.
      if (stopError && snapshot.status === "paused" && stop.action === "cancel") {
        snapshot.status = "cancelled";
        Object.assign(stopError, { code: "FROZEN_CANCELLED", message: "Frozen run cancelled", source: stop.source });
        void save();
      }
      try { guard(); } catch { /* Sticky: the stop blocks every admission. */ }
    },
    /** The driver's stop check, for a branch that hands off without entering the interpreter: a pause or cancel the
     *  driver took stops the run here, before anything resumes. */
    checkStop() { guard(); },
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
      await persist(() => journal.save((revision: number) => { snapshot.escalation!.revision = revision; return serial(); }, { kind: "escalation", detail }));
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
      await persist(() => journal.save(serial(), { kind: "handoff", detail }));
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
        guard();
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
          Object.assign(snapshot.files, receipt.files);
          await save();
          await flush();
          return receipt.value;
        }
        if (params.produces.some(reserved)) throw failure("RUN_CONTROL_UNSUPPORTED", "Effect declares a host-owned output path");
        // The effect's own clock: the node's deadline, and the poll window when it is a poll.
        const deadline = Math.min(snapshot.clocks[`poll:${key}`] ?? Infinity,
          clock(`attempt:${id}`, params.node.deadline_s * 1000));
        if (Date.now() >= deadline) throw failure("FROZEN_EFFECT_DEADLINE", "Effect exceeded its own deadline");
        // A tool effect is admitted with the external call it makes (the tool, and the hash of its arguments, keyed as a
        // continuation keys its own calls), so a continuation that inherits it unknown refuses the same call.
        const external = params.node.via === "tool" ? { tool: String((params.node as any).tool), argsHash: hash(params.input ?? {}) } : undefined;
        // The driver's state and the admission are one transaction.
        const admitted = await persist(() => journal.admit(id, String((params.node as any).label), argsHash, serial(), driver, external));
        if (admitted !== "new") throw failure("FROZEN_EFFECT_UNKNOWN", `Reconcile ${id} before dispatch`);
        const signal = AbortSignal.any([params.signal, controller.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
        // A thrown/aborted call remains UNKNOWN, including transient failures: no blind retry. Each outside call the effect
        // makes is kept on its record as it ends, on the driver's commit chain, so a process killed mid-effect keeps the
        // calls it made and a commit that fails is the run's failure, which aborts the effect at once.
        const calls: unknown[] = [];
        const keep = (record: unknown) => { calls.push(record); const held = [...calls]; persist(() => journal.called(id, held)).catch(() => undefined); };
        let value: unknown;
        try { value = await run({ ...params, signal, call: keep }); }
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
        Object.assign(snapshot.files, files);
        await persist(() => journal.complete(id, { value, files, ...(intent ? { intent } : { args: params.input ?? null }) }, serial()));
        return value;
      };
    },
    /** Every commit the driver started has landed; a failed one is thrown. */
    flush,
    /** Let go of the run once every commit the driver started has landed. */
    async close() { await chain; await journal.close(); },
  };
}
