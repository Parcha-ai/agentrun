// The shadow audit of a serving learned workflow, at a run's claim and its end (learn/audit.ts keeps the ledger).
//   startAudit (withAudit: at the served run's end, before the end commits): a run the promoted workflow answered (path
//     `workflow`; a run it handed back is never drawn and never counts as served) is drawn at 1 in k (auditDrawn, from its id), and a drawn one appends a `started` line to audits.jsonl (with the
//     promotion serving it and the answer it audits, `turn`: the id of the run's newest answer row now), then starts its
//     shadow run: the same agent and revision on the same input with learning off (no seed, no look-back), marked as the
//     audit of the served run (launch.audit), no row of the run list, billed to the agent as learning cost. Its cap is
//     what the served run's cap left (the two together never pass it; the served run's later gates count it beside them,
//     learning-end.ts besideOf); none left, no shadow (`skipped: "no allowance"`). A shadow never waits on a person: where
//     it would park (an approval its owner's setting asks, a raise of that cap, a question) it ends at once in
//     AUDIT_PARKED's words (AdapterRunSpec.neverWaits, the gate untouched: nothing is let through, no one is asked to
//     answer), and its row is `parked`. Only a run started over the API (no trigger: its context is never rebuilt for a
//     shadow) of an agent every tool of which only reads (learn/audit.ts auditWriterOf, the replay's readOnlyHint rule): a
//     shadow never writes again.
//   settleAudits: each open started line (no result row yet) whose two runs, read by id, ended writes its row (agreed:
//     the audited answer, its `turn`'s, and the shadow's say the same, learn/promote.ts sameAnswer; a follow-up's answer
//     since is never read), oldest served run first; then, rows added or not, the hold rule reads the serving revisions'
//     rows: a hold is a function of the ledger alone.
//   applyHold: at least hold_disagree disagreements in the newest hold_window rows of the digest's current promotion
//     hold the workflow (a promotion hold carrying `audit`, with those rows, each text cut of the host's secrets before
//     it is shortened, learn/secrets.ts excerptShown): the agent's next run asks one recompile with them as data
//     (runner/learning-end.ts compileAskOf), which S3a's check decides on its inputs plus the disagreeing ones. A second
//     hold within stop_window served runs of the first stops it: no compile, the stop said on the record.
//   gradeRow: an owner's grade on a run the workflow answered alone is a row too (source grade, agreed = the grade).
// Every number is the agent definition's (learning-setting.ts auditLoopOf). Nothing here fails a claim: a failure is logged.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { overCapMessage } from "@parcha/agentrun-kernel/kernel/cap";
import { auditLoopOf, type AuditLoop } from "../learning-setting.js";
import { RUN_CAP_MIN_USD } from "../learning-batch.js";
import { launchBody, readLaunchBody, type RunLaunch } from "../run-launch.js";
import { runEntries } from "../store-reads/journal.js";
import { runPathOverStore } from "../store-reads/learning.js";
import { type AlsoRow, FINAL_STATES, type RunRow, type Store, StoreConstraint } from "../store/store.js";
import { openRunMcpAuth, sealRunMcpAuth } from "../store/seal.js";
import { isObject, type Json } from "../validate.js";
import { type AuditRow, type AuditStarted, auditableLaunch, auditChange, auditEveryOf, auditDrawn, auditsOffWords, auditWriterOf, holdOf, type LedgerLine, ledgerOf, lineKey, openAudits, rowsOf, shadowRunId } from "../learn/audit.js";
import { lastRunsOf } from "../learn/compile.js";
import { readLearning, writeLearning, type LearningFolder } from "../learn/folder.js";
import { type AuditDisagreement, CHECK_TEXT_MAX, type PromotionRecord, promotionOf, promotionsOf, promotionStartOf, recordPromotion, sameAnswer, servingOf } from "../learn/promote.js";
import { excerptShown } from "../learn/secrets.js";
import type { Shown } from "../learning.js";
import { auditRoomOf } from "./learning-end.js";
import type { EndOfRunTurn } from "./loop-contract.js";
import { answerOf, answerRowOf } from "./promotion.js";
import { servedOf, type WorkflowFirst } from "./workflow-first.js";

/** What the audit reads and writes at a claim (or the server's grade): the agent, the run claimed (none for a grade),
 *  its revision (whose definition holds the numbers) and launch, the agent's learning folder, the host's secrets as a
 *  hold's texts are cut of them (`shown`, as a check's are), the seal key (a shadow is handed the per_run MCP
 *  credentials its served run was). */
export type AuditDeps = {
  readonly store: Store;
  readonly agentId: string;
  readonly revisionId: string;
  readonly context: Context;
  readonly folder: () => LearningFolder;
  readonly shown: () => Promise<Pick<Shown, "text">>;
  readonly log: (line: string) => void;
  readonly sealKey?: Buffer;
  readonly now?: () => number;
};

/** The words a second hold within stop_window leaves on its record: what the owner reads. */
export const STOPPED_TWICE = "stopped: the workflow disagreed with the agent twice";

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

/** The served runs of `workflow` (at `digest` when given) that `keep` keeps too, the newest `n` of them (lastRunsOf: the
 *  shadows and the agent's own runs among them never push one out of the read). */
const servedRuns = (store: Pick<Store, "runs">, agentId: string, n: number, workflow: string, digest: string | undefined, keep: (row: RunRow) => boolean = () => true) =>
  lastRunsOf(store, agentId, n, (row) => served(row) && metricsOf(row).workflow === workflow && (digest === undefined || metricsOf(row).workflow_digest === digest) && keep(row));

/** How many of the newest stop_window runs `workflow` at `digest` served were not auditable (auditableLaunch: a trigger
 *  started them): what the promotions read counts beside the audit line. */
export async function notAuditableOf(store: Pick<Store, "runs">, agentId: string, workflow: string, digest: string, loop: Pick<AuditLoop, "stop_window">): Promise<number> {
  return (await servedRuns(store, agentId, loop.stop_window, workflow, digest)).filter((row) => (metricsOf(row) as { not_auditable?: unknown }).not_auditable === true).length;
}

/** The words a shadow run ends failed with where it would wait on a person (AdapterRunSpec.neverWaits: an approval, a
 *  raise of its cap, which is what its served run's cap left, a question), what it would wait on after them: its row is
 *  `parked`, with no verdict. */
export const AUDIT_PARKED = "the audit ended where it would wait on a person";

/** The served run's end-of-run step `step` (none for a run that only uses what its agent learned), its audit started
 *  after it (startAudit) on an end the run reached on its own (a cut run starts none): the learned workflow that served
 *  it, read from its journal whatever claim it served on (servedOf), and, for a capped run, what its cap leaves once this
 *  end is counted (auditRoomOf: its job, its look-back, the grades beside it and the one this end queues). A run that
 *  could never be audited (no learning start, or not auditableLaunch) keeps `step` as it is. */
export function withAudit(step: EndOfRunTurn | undefined, deps: AuditDeps & { readonly launch: RunLaunch; readonly redact?: (text: string) => string }): EndOfRunTurn | undefined {
  if (!deps.launch.learning || !auditableLaunch(deps.launch)) return step;
  return async (input) => {
    const rows = step ? await step(input) : undefined;
    if (input.cut === undefined) await auditAtEnd(deps, input.runId, rows?.also ?? []);
    return rows;
  };
}

/** Only a run the workflow answered is drawn: its path `workflow` by the one classifier its record keeps
 *  (store-reads/learning.ts runPathOverStore, with the run's `redact`), never one it handed back. */
async function auditAtEnd(deps: AuditDeps & { readonly launch: RunLaunch; readonly redact?: (text: string) => string }, runId: string, queued: readonly AlsoRow[]): Promise<void> {
  try {
    const entries = await runEntries(deps.store, runId, BACKGROUND_CONTEXT);
    const served = servedOf(entries);
    if (!served?.digest) return;
    if ((await runPathOverStore(deps.store, runId, deps.launch.learning, deps.redact)).path !== "workflow") return;
    const capUsd = deps.launch.maxCostUsd;
    await startAudit({ ...deps, runId, ...(capUsd !== undefined ? { room: () => auditRoomOf(deps.store, runId, capUsd, entries, queued) } : {}) }, { name: served.workflow, digest: served.digest });
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
 *  never created. Idempotent: one line and one shadow per run. */
export async function startAudit(deps: AuditDeps & { readonly runId: string; readonly launch: RunLaunch; readonly room?: () => Promise<number | null> }, serve: Pick<WorkflowFirst, "name" | "digest" | "replay"> | undefined): Promise<void> {
  const { store, agentId, runId, launch, log } = deps;
  if (!serve || serve.replay || launch.replay || launch.audit || !launch.learning || !auditableLaunch(launch)) return;
  try {
    // Read after the claim pinned the revision's MCP tools (mcp-claim.ts pinFirst): the pin a revision saved without one
    // takes at its first run is what its tools are classed by.
    const revision = await store.agents.revision(deps.revisionId);
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
    const promoted = promotionStartOf(await promotionsOf(store.settings, agentId), serve.name, serve.digest);
    // The answer audited: the run's newest answer now, at the end that drew it, kept by its row's id so a follow-up's
    // answer since is never the one compared.
    const turn = turnOf((await answerRowOf(store, runId, deps.context))?.id);
    // What the served run's cap leaves its shadow (none for an uncapped run), to a millionth, never above it.
    const room = deps.room ? await deps.room() : undefined;
    const allowance = room === undefined || room === null ? room : Math.floor(room * 1e6 + 1e-6) / 1e6;
    if (allowance === null || (allowance !== undefined && allowance < RUN_CAP_MIN_USD)) {
      const skipped: AuditRow = { run: runId, shadow_run: null, workflow: serve.name, digest: serve.digest, promoted_at: promoted?.at ?? null, source: "shadow", agreed: null, served_cost: null, shadow_cost: null, ...turn, skipped: "no allowance", at: iso((deps.now ?? Date.now)()) };
      await addLines(deps, [skipped]);
      log(`workflow-first: ${serve.name} at ${serve.digest} served this run, drawn for its audit (1 in ${k}); no shadow: ${allowance === null ? "what it spent under its cap is not known" : `its cap leaves $${allowance}, under a run's smallest cap`} (no allowance)`);
      return;
    }
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
      audit: { of: runId, workflow: serve.name, digest: serve.digest },
    };
    const started: AuditStarted = { source: "started", run: runId, shadow_run: id, workflow: serve.name, digest: serve.digest, promoted_at: promoted?.at ?? null, ...turn, at: iso((deps.now ?? Date.now)()) };
    await addLines(deps, [started]);
    const sealed = await handedTo(deps, runId, id);
    try {
      await store.runs.create({ id, agentId, revisionId: deps.revisionId }, { body: launchBody(shadow) as Json, ...(sealed ? { sealed } : {}) });
    } catch (error) {
      if (error instanceof StoreConstraint && (await store.runs.get(id))) return;
      throw error;
    }
    log(`workflow-first: ${serve.name} at ${serve.digest} serves this run; drawn for its audit (1 in ${k}): its shadow run ${id} runs the agent on the same input`);
  } catch (error) {
    log(`workflow-first: the audit of this run did not start (${(error as Error)?.message ?? error})`);
  }
}

/** The per_run MCP credentials run `from` was handed, sealed for shadow run `id` alone (as a replay run's are). */
async function handedTo(deps: Pick<AuditDeps, "store" | "sealKey">, from: string, id: string): Promise<Uint8Array | undefined> {
  if (!deps.sealKey) return undefined;
  const sealed = await deps.store.runs.launch(from).then((one) => one.sealed ?? null, () => null);
  const handed = sealed === null ? undefined : openRunMcpAuth(deps.sealKey, from, sealed);
  return handed && Object.keys(handed).length ? sealRunMcpAuth(deps.sealKey, id, handed) : undefined;
}

/** Writes the row of each open audit (a started line with no row yet) whose two runs, read by id, ended, the batch
 *  oldest served run first (the ledger's tail is its newest); a run that is gone (its shadow never created, say) ends it
 *  with no verdict. Then applies the hold rule over the ledger as it is now, rows added or not: the hold is a function of
 *  the ledger, so one a crash or a failed write lost after the rows were committed is made at the next claim. */
export async function settleAudits(deps: AuditDeps): Promise<void> {
  const { store, log } = deps;
  try {
    // An agent with no promotion record never served a learned workflow: it has no ledger to read.
    if (!(await promotionsOf(store.settings, deps.agentId)).length) return;
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
      if (shadow?.state !== "ended" || !(await store.runs.get(row.run))) return null;
      // The audited answer (the row's turn), never the run's newest: a follow-up since may have answered again.
      const [a, b] = [await auditedAnswer(deps, row), await answerOf(store, row.shadow_run!, deps.context)];
      return a === null || b === null ? null : sameAnswer(a, b);
    }) : { all: lines, added: [] };
    const written = rowsOf(added);
    if (written.length) log(`workflow-first: ${written.length} audit row${written.length === 1 ? "" : "s"} written (${written.filter((row) => row.agreed === false).length} disagreeing)`);
    await holdByLedger(deps, rowsOf(all));
  } catch (error) {
    log(`workflow-first: the audits were not settled (${(error as Error)?.message ?? error}); a later claim settles them`);
  }
}

/** The row an owner's grade of served run `run` writes (source grade, agreed = the grade, counted for the digest's
 *  promotion now), then the hold rule: only for a run the workflow answered alone (its answer is the workflow's).
 *  Nothing else: no round, no compile by itself. */
export async function gradeRow(deps: AuditDeps, run: RunRow, correct: boolean): Promise<void> {
  const m = metricsOf(run);
  if (m.path !== "workflow" || typeof m.workflow !== "string" || typeof m.workflow_digest !== "string") return;
  const promoted = promotionStartOf(await promotionsOf(deps.store.settings, deps.agentId), m.workflow, m.workflow_digest);
  // The answer graded: the run's newest now, kept by its row's id (as a shadow's audit keeps its turn).
  const turn = turnOf((await answerRowOf(deps.store, run.id, deps.context))?.id);
  const row: AuditRow = { run: run.id, shadow_run: null, workflow: m.workflow, digest: m.workflow_digest, promoted_at: promoted?.at ?? null, source: "grade", agreed: correct, served_cost: run.costUsd, shadow_cost: null, ...turn, at: iso((deps.now ?? Date.now)()) };
  const { all } = await addLines(deps, [row], async () => correct, true);
  await holdByLedger(deps, rowsOf(all));
}

/** The ledger's lines on the agent's learning folder's main. */
async function readLedger(deps: Pick<AuditDeps, "folder">): Promise<LedgerLine[]> {
  const folder = deps.folder();
  try {
    return await readLearning(folder.workspace, ledgerOf);
  } finally {
    await folder.end().catch(() => undefined);
  }
}

/** Appends `lines` (each not in the ledger yet, lineKey; a row's verdict read by `agreed` once it is known to be new) in
 *  their order, and answers the ledger after (`all`) with the lines it appended. A grade's row (`again`) replaces an
 *  earlier grade of the same run. */
async function addLines(deps: AuditDeps, lines: readonly LedgerLine[], agreed?: (row: AuditRow) => Promise<boolean | null>, again = false): Promise<{ all: LedgerLine[]; added: LedgerLine[] }> {
  const folder = deps.folder();
  try {
    const verdicts = new Map<string, boolean | null>();
    const done = await writeLearning(folder.workspace, async (read) => {
      const before = (await ledgerOf(read)).filter((one) => !again || !lines.some((line) => lineKey(line) === lineKey(one)));
      const known = new Set(before.map(lineKey));
      const fresh: LedgerLine[] = [];
      for (const line of lines) {
        const key = lineKey(line);
        if (known.has(key)) continue;
        if (line.source === "started" || !agreed) {
          fresh.push(line);
          continue;
        }
        if (!verdicts.has(key)) verdicts.set(key, await agreed(line));
        fresh.push({ ...line, agreed: verdicts.get(key)! });
      }
      const change = auditChange(before, fresh);
      return { result: { all: [...before, ...change.added], added: change.added }, ...(change.change ? { change: change.change } : {}) };
    });
    return done.result;
  } finally {
    await folder.end().catch(() => undefined);
  }
}

/** The hold rule over the ledger's rows `all` for each workflow that serves now (its champion's digest), whether or not
 *  a row was just added: idempotent (applyHold holds only a digest whose newest record still promotes it). */
async function holdByLedger(deps: AuditDeps, all: readonly AuditRow[]): Promise<void> {
  if (!all.length) return;
  const loop = await auditLoopOfRevision(deps.store, deps.revisionId);
  for (const { workflow, digest } of servingOf(await promotionsOf(deps.store.settings, deps.agentId))) {
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
  const records = await promotionsOf(store.settings, agentId);
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
  for (const row of hold.disagreed) {
    const input = await store.runs.launch(row.run).then((one) => inputText(readLaunchBody(one.body)?.input ?? null), () => "");
    // The answer the row compared (its turn's), as the verdict read it: never a follow-up's since.
    const draft = await auditedAnswer(deps, row);
    const agent = row.shadow_run ? await answerOf(store, row.shadow_run, deps.context) : null;
    disagreements.push({ run: row.shadow_run ?? row.run, served: row.run, input: cut(input), agent: agent === null ? null : cut(agent), draft: draft === null ? null : cut(draft), ...(row.source === "grade" ? { graded: true as const } : {}) });
  }
  const said = `it disagreed with the agent's own answer on ${hold.disagreed.length} of its last ${hold.rows.length} audited runs (the bar: ${loop.hold_disagree} of ${loop.hold_window})`;
  const reason = stopped ? STOPPED_TWICE : `held: ${said}; the agent's next run recompiles it once with them`;
  const record: PromotionRecord = {
    workflow, digest, at: iso((deps.now ?? Date.now)()), decided: "hold", reason,
    audit: { window: loop.hold_window, disagree: loop.hold_disagree, rows: hold.rows.length, disagreements, ...(stopped ? { stopped: true as const } : {}) },
    ...(current.commit ? { commit: current.commit } : {}),
  };
  const kept = await recordPromotion(store.settings, agentId, record, (was) => was?.decided === "promote" && was.at === current.at);
  if (kept.won) log(`workflow-first: ${workflow} at ${digest} ${stopped ? `stopped (${said}, a second hold within ${loop.stop_window} served runs)` : reason}`);
}
