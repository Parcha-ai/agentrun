// The shadow audit of a serving learned workflow, at a run's claim (learn/audit.ts keeps the ledger).
//   startAudit: a run the promoted workflow serves first is drawn at 1 in k (auditDrawn, from its id), and a drawn one
//     starts its shadow run: the same agent and revision on the same input with learning off (no seed, no look-back),
//     marked as the audit of the served run (launch.audit), no row of the run list, billed to the agent as learning cost.
//     Only a run started over the API (no trigger: its context is never rebuilt for a shadow) of an agent every tool of
//     which only reads (learn/audit.ts auditWriterOf, the replay's readOnlyHint rule): a shadow never writes again.
//   settleAudits: each shadow that ended, its served run ended too, writes one row to audits.jsonl (agreed: the two
//     answers say the same, learn/promote.ts sameAnswer), oldest served run first; then, rows added or not, the hold rule
//     reads the serving revisions' rows: a hold is a function of the ledger alone.
//   applyHold: at least hold_disagree disagreements in the newest hold_window rows hold the workflow (a promotion hold,
//     source `audit`, with those rows): the agent's next run asks one recompile with them as data
//     (runner/learning-end.ts compileAskOf), which S3a's check decides on its inputs plus the disagreeing ones. A second
//     hold within stop_window served runs of the first stops it: no compile, the stop said on the record.
//   gradeRow: an owner's grade on a run the workflow answered alone is a row too (source grade, agreed = the grade).
// Every number is the agent definition's (learning-setting.ts auditLoopOf). Nothing here fails a claim: a failure is logged.
import type { Context } from "@earendil-works/chord/context";
import { auditLoopOf, type AuditLoop } from "../learning-setting.js";
import { SERVED_PATHS, type RunPath } from "../learning-cost.js";
import { launchBody, readLaunchBody, type RunLaunch } from "../run-launch.js";
import { FINAL_STATES, type RunRow, type Store, StoreConstraint } from "../store/store.js";
import { openRunMcpAuth, sealRunMcpAuth } from "../store/seal.js";
import { isObject, type Json } from "../validate.js";
import { type AuditRow, auditableLaunch, auditChange, auditEveryOf, auditDrawn, auditsOf, auditsOffWords, auditWriterOf, holdOf, isShadowRun, shadowRunId } from "../learn/audit.js";
import { lastRunsOf } from "../learn/compile.js";
import { readLearning, writeLearning, type LearningFolder } from "../learn/folder.js";
import { type AuditDisagreement, CHECK_TEXT_MAX, type PromotionRecord, promotionOf, promotionsOf, recordPromotion, sameAnswer, servingOf } from "../learn/promote.js";
import { answerOf } from "./promotion.js";
import type { WorkflowFirst } from "./workflow-first.js";

/** What the audit reads and writes at a claim (or the server's grade): the agent, the run claimed (none for a grade),
 *  its revision (whose definition holds the numbers) and launch, the agent's learning folder, the seal key (a shadow is
 *  handed the per_run MCP credentials its served run was). */
export type AuditDeps = {
  readonly store: Store;
  readonly agentId: string;
  readonly revisionId: string;
  readonly context: Context;
  readonly folder: () => LearningFolder;
  readonly log: (line: string) => void;
  readonly sealKey?: Buffer;
  readonly now?: () => number;
};

/** The words a second hold within stop_window leaves on its record: what the owner reads. */
export const STOPPED_TWICE = "stopped: the workflow disagreed with the agent twice";
/** The most of an agent's newest runs settleAudits reads for shadows that ended: AUDIT_MAX and some (each claim of a
 *  learning run settles them, so a shadow is read within the runs started while it ran). */
const RUNS_READ = 1_200;

const iso = (ms: number) => new Date(ms).toISOString();
const cut = (text: string) => (text.length > CHECK_TEXT_MAX ? `${text.slice(0, CHECK_TEXT_MAX)}…` : text);
const inputText = (input: unknown): string => (typeof input === "string" ? input : JSON.stringify(input) ?? "");
const metricsOf = (row: RunRow | undefined) => (isObject(row?.metrics as Json) ? (row!.metrics as { path?: unknown; workflow?: unknown; workflow_digest?: unknown }) : {});
const served = (row: RunRow) => SERVED_PATHS.includes(metricsOf(row).path as RunPath);

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

/** Starts the shadow of run `runId` when the learned workflow `serve` serves it first and its id is drawn: never for a
 *  replay or a shadow, a run that does not learn, one not auditable (auditableLaunch: a trigger started it, or it was
 *  handed files), nor a run of an agent that can call a tool that writes (auditWriterOf). Idempotent: one shadow per run. */
export async function startAudit(deps: AuditDeps & { readonly runId: string; readonly launch: RunLaunch }, serve: WorkflowFirst | undefined): Promise<void> {
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
    const shadow: RunLaunch = {
      input: launch.input,
      title: `Audit of ${launch.title}`.slice(0, 200),
      place: launch.place,
      ...(launch.repo !== undefined ? { repo: launch.repo } : {}),
      ...(launch.harness !== undefined ? { harness: launch.harness } : {}),
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.effort !== undefined ? { effort: launch.effort } : {}),
      ...(launch.maxCostUsd !== undefined ? { maxCostUsd: launch.maxCostUsd } : {}),
      ...(launch.plane ? { plane: launch.plane } : {}),
      ...(launch.approvers !== undefined ? { approvers: launch.approvers } : {}),
      ...(launch.documents !== undefined ? { documents: launch.documents } : {}),
      ...(launch.boxAllow !== undefined ? { boxAllow: launch.boxAllow } : {}),
      ...(launch.boxAllowSet ? { boxAllowSet: true as const } : {}),
      ...(launch.archilDisk ? { archilDisk: launch.archilDisk } : {}),
      audit: { of: runId, workflow: serve.name, digest: serve.digest },
    };
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

/** Writes a row for each shadow of the agent that ended whose served run ended too, the batch oldest served run first (the
 *  ledger's tail is its newest), then applies the hold rule over the ledger as it is now, rows added or not: the hold is a
 *  function of the ledger, so one a crash or a failed write lost after the rows were committed is made at the next claim. */
export async function settleAudits(deps: AuditDeps): Promise<void> {
  const { store, agentId, log } = deps;
  try {
    const shadows = (await store.runs.list({ agentId, limit: RUNS_READ })).filter((row) => isShadowRun(row.id) && FINAL_STATES.includes(row.state) && row.runner === null);
    const now = (deps.now ?? Date.now)();
    const rows: { row: AuditRow; at: number }[] = [];
    for (const shadow of shadows) {
      const audit = await store.runs.launch(shadow.id).then((one) => readLaunchBody(one.body)?.audit, () => undefined);
      if (!audit) continue;
      const servedRow = await store.runs.get(audit.of);
      if (!servedRow || !FINAL_STATES.includes(servedRow.state) || servedRow.runner !== null) continue;
      rows.push({ at: servedRow.startedAt, row: { run: audit.of, shadow_run: shadow.id, workflow: audit.workflow, digest: audit.digest, source: "shadow", agreed: null, served_cost: servedRow.costUsd, shadow_cost: shadow.costUsd, at: iso(now) } });
    }
    rows.sort((a, b) => a.at - b.at || (a.row.run < b.row.run ? -1 : a.row.run > b.row.run ? 1 : 0));
    const { all, added } = await addRows(deps, rows.map(({ row }) => row), async (row) => {
      const shadow = await store.runs.get(row.shadow_run!);
      if (shadow?.state !== "ended") return null;
      const [a, b] = [await answerOf(store, row.run, deps.context), await answerOf(store, row.shadow_run!, deps.context)];
      return a === null || b === null ? null : sameAnswer(a, b);
    });
    if (added.length) log(`workflow-first: ${added.length} audit row${added.length === 1 ? "" : "s"} written (${added.filter((row) => row.agreed === false).length} disagreeing)`);
    await holdByLedger(deps, all);
  } catch (error) {
    log(`workflow-first: the audits were not settled (${(error as Error)?.message ?? error}); a later claim settles them`);
  }
}

/** The row an owner's grade of served run `run` writes (source grade, agreed = the grade), then the hold rule: only for a
 *  run the workflow answered alone (its answer is the workflow's). Nothing else: no round, no compile by itself. */
export async function gradeRow(deps: AuditDeps, run: RunRow, correct: boolean): Promise<void> {
  const m = metricsOf(run);
  if (m.path !== "workflow" || typeof m.workflow !== "string" || typeof m.workflow_digest !== "string") return;
  const row: AuditRow = { run: run.id, shadow_run: null, workflow: m.workflow, digest: m.workflow_digest, source: "grade", agreed: correct, served_cost: run.costUsd, shadow_cost: null, at: iso((deps.now ?? Date.now)()) };
  const { all } = await addRows(deps, [row], async () => correct, true);
  await holdByLedger(deps, all);
}

/** Adds `rows` (each not in the ledger yet, its verdict read by `agreed` once it is known to be new) in their order, and
 *  answers the ledger after (`all`, undefined when nothing serves, so there is no ledger to read) with the rows it added.
 *  A grade's row (`again`) replaces an earlier grade of the same run. */
async function addRows(deps: AuditDeps, rows: readonly AuditRow[], agreed: (row: AuditRow) => Promise<boolean | null>, again = false): Promise<{ all: AuditRow[] | undefined; added: AuditRow[] }> {
  // Nothing to add and no workflow serving: no ledger read at all (the claim of an agent with nothing promoted).
  if (!rows.length && !servingOf(await promotionsOf(deps.store.settings, deps.agentId)).some((one) => one.digest !== null)) return { all: undefined, added: [] };
  const folder = deps.folder();
  try {
    if (!rows.length) return { all: await readLearning(folder.workspace, auditsOf), added: [] };
    const verdicts = new Map<string, boolean | null>();
    const done = await writeLearning(folder.workspace, async (read) => {
      const before = (await auditsOf(read)).filter((one) => !again || !rows.some((row) => row.source === one.source && row.run === one.run));
      const known = new Set(before.map((one) => `${one.source}:${one.run}`));
      const fresh: AuditRow[] = [];
      for (const row of rows) {
        if (known.has(`${row.source}:${row.run}`)) continue;
        const key = `${row.source}:${row.run}`;
        if (!verdicts.has(key)) verdicts.set(key, await agreed(row));
        fresh.push({ ...row, agreed: verdicts.get(key)! });
      }
      const change = auditChange(before, fresh);
      return { result: { all: [...before, ...change.added], added: change.added }, ...(change.change ? { change: change.change } : {}) };
    });
    return done.result;
  } finally {
    await folder.end().catch(() => undefined);
  }
}

/** The hold rule over the ledger `all` for each workflow that serves now (its champion's digest), whether or not a row
 *  was just added: idempotent (applyHold holds only a digest whose newest record still promotes it). */
async function holdByLedger(deps: AuditDeps, all: readonly AuditRow[] | undefined): Promise<void> {
  if (!all?.length) return;
  const loop = await auditLoopOfRevision(deps.store, deps.revisionId);
  for (const { workflow, digest } of servingOf(await promotionsOf(deps.store.settings, deps.agentId))) {
    if (digest !== null) await applyHold(deps, all, loop, workflow, digest);
  }
}

/** The hold rule on `workflow` at `digest` over the ledger `rows`, when it serves now (its newest record promotes it):
 *  a hold (source audit) with the disagreeing rows, or a stop when an earlier audit hold of the workflow is within
 *  stop_window served runs. Kept only while the record it read is still the digest's (of two claims, one holds). */
async function applyHold(deps: AuditDeps, rows: readonly AuditRow[], loop: AuditLoop, workflow: string, digest: string): Promise<void> {
  const { store, agentId, log } = deps;
  const records = await promotionsOf(store.settings, agentId);
  const current = promotionOf(records, workflow, digest);
  if (current?.decided !== "promote") return;
  const hold = holdOf(rows, workflow, digest, loop);
  if (!hold) return;
  const first = records.findLast((one) => one.workflow === workflow && one.source === "audit" && one.decided === "hold");
  const since = first ? Date.parse(first.at) : undefined;
  const servedSince = since === undefined ? 0 : (await servedRuns(store, agentId, loop.stop_window, workflow, undefined, (row) => row.startedAt >= since)).length;
  const stopped = first !== undefined && servedSince < loop.stop_window;
  const disagreements: AuditDisagreement[] = [];
  for (const row of hold.disagreed) {
    const input = await store.runs.launch(row.run).then((one) => inputText(readLaunchBody(one.body)?.input ?? null), () => "");
    const draft = await answerOf(store, row.run, deps.context);
    const agent = row.shadow_run ? await answerOf(store, row.shadow_run, deps.context) : null;
    disagreements.push({ run: row.shadow_run ?? row.run, served: row.run, input: cut(input), agent: agent === null ? null : cut(agent), draft: draft === null ? null : cut(draft), ...(row.source === "grade" ? { graded: true as const } : {}) });
  }
  const said = `it disagreed with the agent's own answer on ${hold.disagreed.length} of its last ${hold.rows.length} audited runs (the bar: ${loop.hold_disagree} of ${loop.hold_window})`;
  const reason = stopped ? STOPPED_TWICE : `held: ${said}; the agent's next run recompiles it once with them`;
  const record: PromotionRecord = {
    workflow, digest, at: iso((deps.now ?? Date.now)()), decided: "hold", source: "audit", reason,
    audit: { window: loop.hold_window, disagree: loop.hold_disagree, rows: hold.rows.length, disagreements, ...(stopped ? { stopped: true as const } : {}) },
    ...(current.commit ? { commit: current.commit } : {}),
  };
  const kept = await recordPromotion(store.settings, agentId, record, (was) => was?.decided === "promote" && was.at === current.at);
  if (kept.won) log(`workflow-first: ${workflow} at ${digest} ${stopped ? `stopped (${said}, a second hold within ${loop.stop_window} served runs)` : reason}`);
}
