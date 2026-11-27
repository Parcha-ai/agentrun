// The shadow audit of a serving learned workflow, at a run's claim and its end (learn/audit.ts keeps the ledger).
//   startAudit (withAudit: at the served run's end, before the end commits): a run the promoted workflow answered (path
//     `workflow`; a run it handed back is never drawn and never counts as served) is drawn at 1 in k (auditDrawn, from its id), and a drawn one adds a `started` audit record (with the
//     promotion serving it and the answer it audits, `turn`: the id of the run's newest answer row now), then starts its
//     shadow run: the same agent and revision on the same input with learning off (no seed, no compile turn), marked as the
//     audit of the served run (launch.audit), no row of the run list, billed to the agent as learning cost. Its cap is
//     what the served run's cap left (the two together never pass it; the served run's later gates count it beside them,
//     learning-end.ts shadowBesideOf); none left, no shadow (`skipped: "no allowance"`). A shadow never waits on a person: where
//     it would park (an approval its owner's setting asks, a raise of that cap, a question) it ends at once in
//     AUDIT_PARKED's words (AdapterRunSpec.neverWaits, the gate untouched: nothing is let through, no one is asked to
//     answer), and its row is `parked`. Only a run started over the API (no trigger: its context is never rebuilt for a
//     shadow) of an agent every tool of which only reads (learn/audit.ts auditWriterOf, the replay's readOnlyHint rule): a
//     shadow never writes again.
//   settleAudits: each open started line (no result row yet) whose two runs, read by id, ended writes its row (agreed:
//     the audited answer, its `turn`'s, judged against the shadow's as the check judges a draft against the agent's
//     answer, runner/promotion.ts answerJudged: on the served run's revision's agree_on, learning-setting.ts agreeOnOf,
//     else the grader's verdict the shadow kept at its end, runner/compare-end.ts; a follow-up's answer since is never
//     read), oldest served run first; then, rows added or not, the hold rule reads the serving revisions'
//     rows: a hold is a function of the ledger alone.
//   applyHold: at least hold_disagree disagreements in the newest hold_window rows of the digest's current promotion
//     hold the workflow (a promotion hold carrying `audit`, with those rows, each text cut of the host's secrets before
//     it is shortened, learn/secrets.ts excerptShown): the agent's next run asks one recompile with them as data
//     (runner/learning-end.ts compileAskOf), which S3a's check decides on its inputs plus the disagreeing ones. A second
//     hold within stop_window served runs of the first stops it: no compile, the stop said on the record.
//   gradeRow: an owner's grade on a run the workflow answered alone is a row too (source grade): agreed = the grade's
//     verdict on the served answer, except a wrong one under agree_on with an expected answer, judged on those fields
//     against it (answerJudged). A graded run is counted by its grade row alone (learn/audit.ts
//     windowOf): the check and the audit read one ground truth, a grade's answer where a person gave one, else the agent's.
// Every number is the agent definition's (learning-setting.ts auditLoopOf). Nothing here fails a claim: a failure is logged.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { overCapMessage } from "@parcha/agentrun-kernel/kernel/cap";
import { sourceSyncOf } from "../source-sync/types.js";
import type { AuxiliaryAdmitter } from "../source-sync/auxiliary.js";
import { agreeOnOf, auditLoopOf, type AuditLoop } from "../learning-setting.js";
import { launchBody, readLaunchBody, type RunLaunch } from "../run-launch.js";
import { runEntries } from "../store-reads/journal.js";
import { runPathOverStore } from "../store-reads/learning.js";
import { FINAL_STATES, type RunRow, type Store, StoreConstraint } from "../store/store.js";
import { openRunLaunch, sealHandedLaunch } from "../store/seal.js";
import { type AtRunEnd, LEARNING_CHILD_MS, noteLearningChild, RUN_CAP_MIN_USD } from "../learning-work.js";
import { isObject, type Json } from "../validate.js";
import { addAuditLines, type AuditRow, type AuditStarted, auditableLaunch, auditEveryOf, auditDrawn, auditsOffWords, auditWriterOf, holdOf, type LedgerLine, ledgerOf, lineKey, openAudits, rowsOf, shadowRunId } from "../learn/audit.js";
import { lastRunsOf, sinceReset } from "../learn/compile.js";
import { type AuditDisagreement, CHECK_TEXT_MAX, compareAnswers, comparedGrade, comparedOf, gradesOf, type PromotionRecord, promotionOf, promotionsOf, promotionStartOf, recordPromotion, servingOf } from "../learn/promote.js";
import { excerptShown } from "../learn/secrets.js";
import type { Shown } from "../learning.js";
import { auditRoomOf } from "./learning-end.js";
import type { EndOfRunTurn } from "./loop-contract.js";
import { answerJudged, answerOf, answerRowOf } from "./promotion.js";
import { servedOf, type WorkflowFirst } from "./workflow-first.js";
import { held, heldEndOfRun } from "./held.js";

/** What the audit reads and writes at a claim (or the server's grade): the agent, the run claimed (none for a grade),
 *  its revision (whose definition holds the numbers) and launch, the host's secrets as a
 *  hold's texts are cut of them (`shown`, as a check's are), the seal key (a shadow is handed the per_run MCP
 *  credentials its served run was). */
export type AuditDeps = {
  readonly store: Store;
  readonly agentId: string;
  readonly revisionId: string;
  readonly context: Context;
  readonly shown: () => Promise<Pick<Shown, "text">>;
  readonly log: (line: string) => void;
  readonly sealKey?: Buffer;
  readonly admitAuxiliary?: AuxiliaryAdmitter;
  readonly now?: () => number;
  /** Why model spend beside the claimed run is skipped (claim-secrets.ts claimSpendOff). Absent: it runs. */
  readonly spendOff?: (what: string) => string | undefined;
  /** Whether the claim holds its run's own model key now (claim-secrets.ts keyedNow): its shadow then spends on a sealed
   *  copy of that key. Absent: never. */
  readonly keyed?: () => boolean;
  /** What the claim queued to start at its run's end (learning-work.ts atRunEnd): run after the end-of-run step, before
   *  the audit's start (withAudit). */
  readonly atEnd?: AtRunEnd;
};

/** The words a second hold within stop_window leaves on its record: what the owner reads. */
export const STOPPED_TWICE = "stopped: the workflow disagreed with the known answer twice";

const iso = (ms: number) => new Date(ms).toISOString();
const ended = (row: RunRow | undefined) => row !== undefined && FINAL_STATES.includes(row.state) && row.runner === null;
const inputText = (input: unknown): string => (typeof input === "string" ? input : JSON.stringify(input) ?? "");
const metricsOf = (row: RunRow | undefined) => (isObject(row?.metrics as Json) ? (row!.metrics as { path?: unknown; workflow?: unknown; workflow_digest?: unknown }) : {});
/** A run the audit counts as served: one its learned workflow answered (path `workflow`). One it handed back (path
 *  `handed_back`) is the agent's answer: never drawn, never counted. */
const served = (row: RunRow) => metricsOf(row).path === "workflow";
/** A line's `turn` (AuditRow.turn): the answer row's id, none when the run had no answer. */
const turnOf = (id: string | undefined): { turn?: string } => (id === undefined ? {} : { turn: id });
/** The answer an audit row is of: its `turn`'s, read from the run by that row's id; none when it names none. */
const auditedAnswer = (deps: Pick<AuditDeps, "store" | "context">, row: Pick<AuditRow, "run" | "turn">) => (row.turn === undefined ? Promise.resolve(null) : answerOf(deps.store, row.run, deps.context, row.turn));

/** The audit numbers of revision `revisionId`'s definition (each one it leaves out at its default). */
export async function auditLoopOfRevision(store: Pick<Store, "agents">, revisionId: string): Promise<AuditLoop> {
  try {
    return auditLoopOf(((await store.agents.revision(revisionId))?.body as { learning?: unknown } | undefined)?.learning);
  } catch {
    return auditLoopOf(undefined);
  }
}

/** The answer paths an audit of a run of revision `revisionId` compares on, as its check does (learning-setting.ts
 *  agreeOnOf: its agree_on); undefined, the whole answer. A read that fails throws: settleAudits leaves the row to a
 *  later claim, never comparing on the whole answer an agent that named its fields (#3182 review). */
export async function agreeOnOfRevision(store: Pick<Store, "agents">, revisionId: string): Promise<readonly string[] | undefined> {
  return agreeOnOf(((await store.agents.revision(revisionId))?.body as { learning?: unknown } | undefined)?.learning);
}

/** The served answer shadow run `shadowRun` audits: its open line's `turn`'s answer, read from the served run by that row's
 *  id (what settleAudits compares the shadow's answer with); null when no open line names it, or it names no turn. */
export async function auditedAnswerOf(deps: Pick<AuditDeps, "store" | "agentId" | "context">, shadowRun: string): Promise<string | null> {
  const open = openAudits(await readLedger(deps)).find((line) => line.shadow_run === shadowRun);
  return open ? auditedAnswer(deps, open) : null;
}

/** The served runs of `workflow` (at `digest` when given) that `keep` keeps too, since the agent's learning's reset
 *  (sinceReset), the newest `n` of them (lastRunsOf: the shadows and the agent's own runs among them never push one out
 *  of the read). */
const servedRuns = async (store: Pick<Store, "runs" | "settings">, agentId: string, n: number, workflow: string, digest: string | undefined, keep: (row: RunRow) => boolean = () => true) => {
  const since = await sinceReset(store, agentId);
  return lastRunsOf(store, agentId, n, (row) => served(row) && metricsOf(row).workflow === workflow && (digest === undefined || metricsOf(row).workflow_digest === digest) && keep(row) && since(row));
};

/** How many of the newest stop_window runs `workflow` at `digest` served were not auditable (auditableLaunch: a trigger
 *  started them): what the promotions read counts beside the audit line. */
export async function notAuditableOf(store: Pick<Store, "runs" | "settings">, agentId: string, workflow: string, digest: string, loop: Pick<AuditLoop, "stop_window">): Promise<number> {
  return (await servedRuns(store, agentId, loop.stop_window, workflow, digest)).filter((row) => (metricsOf(row) as { not_auditable?: unknown }).not_auditable === true).length;
}

/** The words a shadow run ends failed with where it would wait on a person (AdapterRunSpec.neverWaits: an approval, a
 *  raise of its cap, which is what its served run's cap left, a question), what it would wait on after them: its row is
 *  `parked`, with no verdict. */
export const AUDIT_PARKED = "the audit ended where it would wait on a person";

/** The served run's end-of-run step `step` (none for a run that only uses what its agent learned), its audit started
 *  after it (startAudit) on an end the run reached on its own (a cut run starts none): the learned workflow that served
 *  it, read from its journal whatever claim it served on (servedOf), and, for a capped run, what its cap leaves once this
 *  end is counted (auditRoomOf: its job, its follow-ups, its compile turns). A run that
 *  could never be audited (no learning start, or not auditableLaunch) keeps `step` as it is. */
export function withAudit(step: EndOfRunTurn | undefined, deps: AuditDeps & { readonly launch: RunLaunch; readonly redact: (text: string) => string }): EndOfRunTurn | undefined {
  if (!deps.launch.learning) return step;
  const audited = auditableLaunch(deps.launch);
  // A run never audited gets no step it had none of: the end of a run with no step queues nothing (its checks wait).
  if (!audited && (!deps.atEnd || !step)) return step;
  // In a run's own process the whole step is its runner's (held.ts endOfRun), the audit's start with it: it reads the
  // run's journal and writes the ledger and a run, which no run's process may.
  if (held()) return heldEndOfRun();
  // What the claim queued for its run's end (a check on its own key) starts first, so the audit's room counts it.
  return async (input) => {
    const rows = step ? await step(input) : undefined;
    if (input.cut === undefined) {
      await deps.atEnd?.run();
      if (audited) await auditAtEnd(deps, input.runId);
    }
    return rows;
  };
}

/** Only a run the workflow answered is drawn: its path `workflow` by the one classifier its record keeps
 *  (store-reads/learning.ts runPathOverStore, with the run's `redact`), never one it handed back. */
async function auditAtEnd(deps: AuditDeps & { readonly launch: RunLaunch; readonly redact: (text: string) => string }, runId: string): Promise<void> {
  try {
    const entries = await runEntries(deps.store, runId, BACKGROUND_CONTEXT);
    const served = servedOf(entries);
    if (!served?.digest) return;
    if ((await runPathOverStore(deps.store, runId, deps.launch.learning, deps.redact)).path !== "workflow") return;
    const capUsd = deps.launch.maxCostUsd;
    await startAudit({ ...deps, runId, ...(capUsd !== undefined ? { room: () => auditRoomOf(deps.store, runId, capUsd, entries) } : {}) }, { name: served.workflow, digest: served.digest });
  } catch (error) {
    deps.log(`workflow-first: the audit of this run did not start (${(error as Error)?.message ?? error})`);
  }
}

/** Starts the shadow of run `runId`, at its end, when the learned workflow `serve` served it first and its id is drawn:
 *  never for a replay or a shadow, a run that does not learn, one not auditable (auditableLaunch: a trigger started it,
 *  or it was handed files), nor a run of an agent that can call a tool that writes (auditWriterOf). A capped run's shadow
 *  is capped at what its cap leaves (`room`, read now: the served run spent all it will under it), so the two never
 *  spend past the served run's cap; with less than a run's smallest cap left (or a spend not known), no shadow is started
 *  and its row says `skipped: "no allowance"`. Its started line is appended first: a shadow is created only once the
 *  ledger names it (settlement finds it there, never in a window of runs), and one whose line could not be written is
 *  never created. Idempotent: one line and one shadow per run. A run the agent's learning reads no more starts none, as
 *  it adds no grade row (gradeRow): one before its learning's reset (sinceReset), ended again after it by a follow-up,
 *  or one on a named disk (learn/learning-of.ts). */
export async function startAudit(deps: AuditDeps & { readonly runId: string; readonly launch: RunLaunch; readonly room?: () => Promise<number | null> }, serve: Pick<WorkflowFirst, "name" | "digest" | "replay"> | undefined): Promise<void> {
  const { store, agentId, runId, launch, log } = deps;
  if (!serve || serve.replay || launch.replay || launch.audit || !launch.learning || !auditableLaunch(launch)) return;
  // A shadow is a run of its own the runner starts: on the served run's own key while its claim holds it, else on the
  // server's; skipped where the run's key was erased, or the server holds none (claimSpendOff).
  const off = deps.spendOff?.("A shadow audit");
  if (off) return void log(`workflow-first: ${off}`);
  try {
    // The run is there at its end (its end commits after this step).
    const row = await store.runs.get(runId);
    if (row && ((row.disk ?? null) !== null || !(await sinceReset(store, agentId))(row))) return;
    // Read after the claim pinned the revision's MCP tools (mcp-claim.ts pinFirst): the pin a revision saved without one
    // takes at its first run is what its tools are classed by.
    const revision = await store.agents.revision(deps.revisionId);
    if ((launch.sourceProject || sourceSyncOf(revision?.body)) && !deps.admitAuxiliary) {
      log("workflow-first: an auxiliary audit requires its own project placement for this moved agent; no audit was started. Start a normal run to use the saved project.");
      return;
    }
    const writer = auditWriterOf(revision);
    if (writer !== undefined) {
      log(`workflow-first: ${serve.name} at ${serve.digest} serves this run, never audited: ${auditsOffWords(writer)}`);
      return;
    }
    const loop = auditLoopOf((revision?.body as { learning?: unknown } | undefined)?.learning);
    const before = (await servedRuns(store, agentId, loop.audit_later_after, serve.name, serve.digest, (row) => row.id !== runId)).length;
    const k = auditEveryOf(loop, before);
    if (!auditDrawn(runId, k)) return;
    const id = shadowRunId(runId);
    // Once per run: an end after a follow-up finds its shadow made, or its row written (skipped, or settled). A started
    // line with no shadow (a crash between the two) is made now.
    if (await store.runs.get(id)) return;
    if ((await readLedger(deps)).some((line) => line.run === runId && line.source === "shadow")) return;
    const promoted = promotionStartOf(await promotionsOf(store.learning, agentId), serve.name, serve.digest);
    // The answer audited: the run's newest answer now, at the end that drew it, kept by its row's id so a follow-up's
    // answer since is never the one compared.
    const turn = turnOf((await answerRowOf(store, runId, deps.context))?.id);
    // What the served run's cap leaves its shadow (none for an uncapped run), to a millionth, never above it.
    const room = deps.room ? await deps.room() : undefined;
    const allowance = room === undefined || room === null ? room : Math.floor(room * 1e6 + 1e-6) / 1e6;
    if (allowance === null || (allowance !== undefined && allowance < RUN_CAP_MIN_USD)) {
      const skipped: AuditRow = { run: runId, shadow_run: null, workflow: serve.name, digest: serve.digest, promoted_at: promoted?.at ?? null, source: "shadow", agreed: null, served_cost: null, shadow_cost: null, ...turn, skipped: "no allowance", at: iso((deps.now ?? Date.now)()) };
      await addLines(deps, [skipped]);
      await noteLearningChild(store.settings, runId, { run: null, kind: "shadow", at: (deps.now ?? Date.now)(), ...(deps.keyed?.() ? { keyed: true as const } : {}), dropped: "no_budget" });
      log(`workflow-first: ${serve.name} at ${serve.digest} served this run, drawn for its audit (1 in ${k}); no shadow: ${allowance === null ? "what it spent under its cap is not known" : `its cap leaves $${allowance}, under a run's smallest cap`} (no allowance)`);
      return;
    }
    // Its start, and its deadline from it (learning-work.ts LEARNING_CHILD_MS): its runner cancels it there.
    const at = (deps.now ?? Date.now)();
    const shadow: RunLaunch = {
      input: launch.input,
      title: `Audit of ${launch.title}`.slice(0, 200),
      place: launch.place,
      ...(launch.repo !== undefined ? { repo: launch.repo } : {}),
      ...(launch.harness !== undefined ? { harness: launch.harness } : {}),
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
      ...(allowance !== undefined ? { maxCostUsd: allowance } : {}),
      ...(launch.plane ? { plane: launch.plane } : {}),
      ...(launch.approvers !== undefined ? { approvers: launch.approvers } : {}),
      ...(launch.documents !== undefined ? { documents: launch.documents } : {}),
      ...(launch.boxAllow !== undefined ? { boxAllow: launch.boxAllow } : {}),
      ...(launch.boxAllowSet ? { boxAllowSet: true as const } : {}),
      ...(launch.archilDisk ? { archilDisk: launch.archilDisk } : {}),
      audit: { of: runId, workflow: serve.name, digest: serve.digest, deadlineAt: at + LEARNING_CHILD_MS },
    };
    const started: AuditStarted = { source: "started", run: runId, shadow_run: id, workflow: serve.name, digest: serve.digest, promoted_at: promoted?.at ?? null, ...turn, at: iso((deps.now ?? Date.now)()) };
    // The ledger after (`all`, never `added`): a started line already there (a crash between it and its shadow) is in it,
    // and its shadow is made now. None there: the append refused it, as a purge took the digest since the draw (or the
    // run), and settleAudits would never settle a shadow with no line, so none is made.
    const { all } = await addLines(deps, [started]);
    if (!all.some((line) => lineKey(line) === lineKey(started))) {
      log(`workflow-first: ${serve.name} at ${serve.digest} served this run, drawn for its audit (1 in ${k}); no shadow: the workflow's version was purged since`);
      return;
    }
    const keyed = deps.keyed?.() === true;
    const sealed = await handedTo(deps, runId, id, keyed);
    // Named as the run's learning work before it exists (learning-work.ts): its learning_work lists it while it runs, and
    // the same write moves the run's learning deadline to this one's.
    await noteLearningChild(store.settings, runId, { run: id, kind: "shadow", at, ...(keyed ? { keyed: true as const } : {}) });
    try {
      if (sourceSyncOf(revision?.body)) await deps.admitAuxiliary!({ runId: id, agentId, revisionId: deps.revisionId, launch: shadow, ...(sealed ? { sealed } : {}) });
      else await store.runs.create({ id, agentId, revisionId: deps.revisionId }, { body: launchBody(shadow) as Json, ...(sealed ? { sealed } : {}) });
    } catch (error) {
      if (error instanceof StoreConstraint && (await store.runs.get(id))) return;
      throw error;
    }
    log(`workflow-first: ${serve.name} at ${serve.digest} serves this run; drawn for its audit (1 in ${k}): its shadow run ${id} runs the agent on the same input`);
  } catch (error) {
    log(`workflow-first: the audit of this run did not start (${(error as Error)?.message ?? error})`);
  }
}

/** The per_run MCP credentials run `from` was handed, and its own model key when `keyed`, sealed for shadow run `id`
 *  alone (store/seal.ts sealHandedLaunch, as a replay run's are). A keyed shadow whose run holds no key now is never
 *  started (throws): it would spend on the server's key. */
async function handedTo(deps: Pick<AuditDeps, "store" | "sealKey">, from: string, id: string, keyed: boolean): Promise<Uint8Array | undefined> {
  // A run's own process holds no seal key: its runner seals them again, from its own run alone (held.ts handOn).
  const sealed = deps.sealKey
    ? await deps.store.runs.launch(from).then((one) => (one.sealed === null ? undefined : sealHandedLaunch(deps.sealKey!, from, one.sealed, id, keyed)), () => undefined)
    : await held()?.handOn(from, id, keyed);
  if (keyed && (!deps.sealKey || !sealed || !openRunLaunch(deps.sealKey, id, sealed)?.model)) throw new Error("the run whose own model key its shadow would spend on holds none now");
  return sealed;
}

/** Writes the row of each open audit (a started line with no row yet) whose two runs, read by id, ended, the batch
 *  oldest served run first (the ledger's tail is its newest); a run that is gone (its shadow never created, say) ends it
 *  with no verdict. Then applies the hold rule over the ledger as it is now, rows added or not: the hold is a function of
 *  the ledger, so one a crash or a failed write lost after the rows were committed is made at the next claim. */
export async function settleAudits(deps: AuditDeps): Promise<void> {
  const { store, log } = deps;
  try {
    // An agent with no promotion record never served a learned workflow: it has no ledger to read.
    if (!(await promotionsOf(store.learning, deps.agentId)).length) return;
    const lines = await readLedger(deps);
    const now = (deps.now ?? Date.now)();
    const rows: { row: AuditRow; at: number }[] = [];
    for (const open of openAudits(lines)) {
      const [servedRow, shadow] = [await store.runs.get(open.run), await store.runs.get(open.shadow_run)];
      // Its shadow is created after its line, at the served run's claim: one missing once the served run ended never ran.
      if ((servedRow && !ended(servedRow)) || (shadow && !ended(shadow))) continue;
      // One that ended where it would wait on a person (AUDIT_PARKED: an approval, a raise of its cap, a question), or
      // once its cost passed its cap (the kernel's overCapEnd: it would wait on a raise), has no answer: `parked`.
      const parked = shadow?.state === "failed" && ((shadow.summary ?? "").startsWith(AUDIT_PARKED) || overCapMessage(shadow.summary) !== undefined);
      rows.push({ at: servedRow?.startedAt ?? 0, row: { run: open.run, shadow_run: open.shadow_run, workflow: open.workflow, digest: open.digest, promoted_at: open.promoted_at, source: "shadow", agreed: null, served_cost: servedRow?.costUsd ?? null, shadow_cost: shadow?.costUsd ?? null, ...turnOf(open.turn), ...(parked ? { parked: true as const } : {}), at: iso(now) } });
    }
    rows.sort((a, b) => a.at - b.at || (a.row.run < b.row.run ? -1 : a.row.run > b.row.run ? 1 : 0));
    const { all, added } = rows.length ? await addLines(deps, rows.map(({ row }) => row), async (row) => {
      const shadow = await store.runs.get(row.shadow_run!);
      const served = await store.runs.get(row.run);
      if (shadow?.state !== "ended" || !served) return null;
      // The audited answer (the row's turn), never the run's newest: a follow-up since may have answered again.
      const [a, b] = [await auditedAnswer(deps, row), await answerOf(store, row.shadow_run!, deps.context)];
      // Judged as the check judges a draft against the agent's answer (answerJudged): on the fields the served run's
      // revision says carry the decision, else equal, else the grader's verdict its shadow kept at its end
      // (runner/compare-end.ts), else the whole answer. A grade of the served run, where one was given, outranks this row
      // (learn/audit.ts windowOf).
      const verdict = comparedOf(isObject(shadow.metrics as Json) ? (shadow.metrics as { audit?: { compared?: unknown } }).audit?.compared : undefined);
      return a === null || b === null ? null : answerJudged({ agent: b, answer: a, ...(verdict ? { compared: verdict } : {}) }, await agreeOnOfRevision(store, served.revisionId));
    }) : { all: lines, added: [] };
    const written = rowsOf(added);
    if (written.length) log(`workflow-first: ${written.length} audit row${written.length === 1 ? "" : "s"} written (${written.filter((row) => row.agreed === false).length} disagreeing)`);
    await holdByLedger(deps, rowsOf(all));
  } catch (error) {
    log(`workflow-first: the audits were not settled (${(error as Error)?.message ?? error}); a later claim settles them`);
  }
}

/** The row an owner's grade of served run `run` writes (source grade, counted for the digest's promotion now), then the
 *  hold rule: only for a run the workflow answered alone (its answer is the workflow's). Its verdict is the owner's on
 *  the served answer itself: graded right, it agrees, however an `expected` answer words it. Graded wrong, it disagrees,
 *  except under the revision's agree_on with an `expected` answer (an empty one is none): then only those fields judge
 *  it, each against the expected answer's value where it gives one (runner/promotion.ts answerJudged), so a grade
 *  that corrects only what no agree_on field says is no disagreement. Nothing else: no round, no compile by itself. A run before the agent's learning reset (sinceReset) adds no row: its
 *  grade is kept, but a promotion of the same digest after the reset is never held by what came before it. A run on a
 *  named disk adds none either (learn/learning-of.ts): the hold rule would copy its answers into the promotion's
 *  disagreements, and the agent's compile reads those. */
export async function gradeRow(deps: AuditDeps, run: RunRow, correct: boolean, expected?: Readonly<Record<string, unknown>>): Promise<void> {
  const m = metricsOf(run);
  if (m.path !== "workflow" || typeof m.workflow !== "string" || typeof m.workflow_digest !== "string") return;
  if ((run.disk ?? null) !== null || !(await sinceReset(deps.store, deps.agentId))(run)) return;
  const promoted = promotionStartOf(await promotionsOf(deps.store.learning, deps.agentId), m.workflow, m.workflow_digest);
  // The answer graded: the run's newest now, kept by its row's id (as a shadow's audit keeps its turn).
  const turn = turnOf((await answerRowOf(deps.store, run.id, deps.context))?.id);
  const row: AuditRow = { run: run.id, shadow_run: null, workflow: m.workflow, digest: m.workflow_digest, promoted_at: promoted?.at ?? null, source: "grade", agreed: correct, served_cost: run.costUsd, shadow_cost: null, ...turn, at: iso((deps.now ?? Date.now)()) };
  const known = expected && Object.keys(expected).length ? expected : undefined;
  const { all } = await addLines(deps, [row], async (one) => {
    if (correct) return true;
    const on = known ? await agreeOnOfRevision(deps.store, run.revisionId) : undefined;
    if (!on?.length) return false;
    const said = await auditedAnswer(deps, one);
    return said === null ? null : answerJudged({ agent: said, answer: said, expected: known }, on);
  }, true);
  await holdByLedger(deps, rowsOf(all));
}

/** The agent's ledger (learn/audit.ts ledgerOf). */
const readLedger = (deps: Pick<AuditDeps, "store" | "agentId">): Promise<LedgerLine[]> => ledgerOf(deps.store.learning, deps.agentId);

/** Appends `lines` (each not in the ledger yet, lineKey; a row's verdict read by `agreed` once it is known to be new) in
 *  their order, and answers the ledger after (`all`) with the lines it appended. A grade's row (`again`) replaces an
 *  earlier grade of the same run. */
async function addLines(deps: AuditDeps, lines: readonly LedgerLine[], agreed?: (row: AuditRow) => Promise<boolean | null>, again = false): Promise<{ all: LedgerLine[]; added: LedgerLine[] }> {
  const known = new Set(again ? [] : (await readLedger(deps)).map(lineKey));
  const fresh: LedgerLine[] = [];
  for (const line of lines) {
    if (known.has(lineKey(line))) continue;
    fresh.push(line.source === "started" || !agreed ? line : { ...line, agreed: await agreed(line) });
  }
  return addAuditLines(deps.store.learning, deps.agentId, fresh, again);
}

/** The hold rule over the ledger's rows `all` for each workflow that serves now (its champion's digest, skipping a
 *  as a claim's), whether or not a row was just added:
 *  idempotent (applyHold holds only a digest whose newest record still promotes it). */
async function holdByLedger(deps: AuditDeps, all: readonly AuditRow[]): Promise<void> {
  if (!all.length) return;
  const loop = await auditLoopOfRevision(deps.store, deps.revisionId);
  const records = await promotionsOf(deps.store.learning, deps.agentId);
  for (const { workflow, digest } of servingOf(records)) {
    if (digest !== null) await applyHold(deps, all, loop, workflow, digest);
  }
}

/** The hold rule on `workflow` at `digest` over the ledger `rows`, when it serves now (its newest record promotes it),
 *  on the rows of its current promotion alone (promotionStartOf: a digest its owner's replay promoted again after a hold
 *  starts on none): a hold carrying `audit` with the disagreeing rows, or a stop when an earlier audit hold of the
 *  workflow is within stop_window served runs. Kept only while the record it read is still the digest's (of two claims,
 *  one holds). */
async function applyHold(deps: AuditDeps, rows: readonly AuditRow[], loop: AuditLoop, workflow: string, digest: string): Promise<void> {
  const { store, agentId, log } = deps;
  const records = await promotionsOf(store.learning, agentId);
  const current = promotionOf(records, workflow, digest);
  if (current?.decided !== "promote") return;
  const hold = holdOf(rows, workflow, digest, promotionStartOf(records, workflow, digest)?.at ?? null, loop);
  if (!hold) return;
  const first = records.findLast((one) => one.workflow === workflow && one.decided === "hold" && one.audit !== undefined);
  const since = first ? Date.parse(first.at) : undefined;
  const servedSince = since === undefined ? 0 : (await servedRuns(store, agentId, loop.stop_window, workflow, undefined, (row) => row.startedAt >= since)).length;
  const stopped = first !== undefined && servedSince < loop.stop_window;
  // Each text cut of the host's secrets whole, then shortened (learn/secrets.ts excerptShown), as a check's are.
  const shown = await deps.shown();
  const cut = (text: string) => excerptShown(text, shown, CHECK_TEXT_MAX);
  const disagreements: AuditDisagreement[] = [];
  // A grade's row shows the right answer its grade gave, the known answer the served one missed.
  const grades = hold.disagreed.some((row) => row.source === "grade") ? await gradesOf(store.learning, agentId) : [];
  for (const row of hold.disagreed) {
    const input = await store.runs.launch(row.run).then((one) => inputText(readLaunchBody(one.body)?.input ?? null), () => "");
    // The answer the row compared (its turn's), as the verdict read it: never a follow-up's since.
    const draft = await auditedAnswer(deps, row);
    const agent = row.shadow_run ? await answerOf(store, row.shadow_run, deps.context) : null;
    const expected = row.source === "grade" ? comparedGrade(grades.find((one) => one.run === row.run))?.expected : undefined;
    disagreements.push({ run: row.shadow_run ?? row.run, served: row.run, input: cut(input), agent: agent === null ? null : cut(agent), draft: draft === null ? null : cut(draft), ...(row.source === "grade" ? { graded: true as const } : {}), ...(expected ? { expected: cut(JSON.stringify(expected)) } : {}) });
  }
  const said = `it disagreed with the known answer on ${hold.disagreed.length} of its last ${hold.rows.length} audited runs (the bar: ${loop.hold_disagree} of ${loop.hold_window})`;
  const reason = stopped ? STOPPED_TWICE : `held: ${said}; the agent's next run recompiles it once with them`;
  const record: PromotionRecord = {
    workflow, digest, at: iso((deps.now ?? Date.now)()), decided: "hold", reason,
    audit: { window: loop.hold_window, disagree: loop.hold_disagree, rows: hold.rows.length, disagreements, ...(stopped ? { stopped: true as const } : {}) },
    ...(current.commit ? { commit: current.commit } : {}),
  };
  const kept = await recordPromotion(store.learning, agentId, record, (was) => was?.decided === "promote" && was.at === current.at);
  if (kept.won) log(`workflow-first: ${workflow} at ${digest} ${stopped ? `stopped (${said}, a second hold within ${loop.stop_window} served runs)` : reason}`);
}
