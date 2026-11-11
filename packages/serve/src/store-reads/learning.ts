// A run's learning end, from the one store: what its end-of-run turn kept (learning_proposals) and the end of the
// learning run queued with it, which grades and merges it on the runner (runner/learning-loop.ts), read from that
// run's row and journal. It gives the fields the server's own grade set on a run's learning (learning.ts Learning) and
// the run's view, its whole learning, its learning ledger line, /v2/usage and /v2/stats read: how it ended and why, in
// a person's words, the verdict, what it merged, learned, held for the owner's OK and lost, what the checks left out,
// and what the grade spent. What the server keeps on a run before its end (what it was given and read, its seed's
// notes, its answer's time and costs) is the run's, not this.
import { posix } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { currentLearning, holdsForOk, type Learning, LEARNING_REASONS, type NoteUsed, type Shown } from "../learning.js";
import { runLearningBody } from "../learning-routes.js";
import { learningStartOf, readLaunchBody, type RunLaunch } from "../run-launch.js";
import { type Impact, type ImpactLearning, learningImpact, noteRuns, notesRead, type Reflect, reflects } from "../learning-run.js";
import type { NoteRuns } from "../learning.js";
import { type NoteFiles, notesOf } from "../usage.js";
import type { RunRow } from "@parcha/pi-durable-agent";
import type { EntryLike, TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { runEntries, runReflect, runTimeline } from "./journal.js";
import { FINAL_STATES } from "../store/store.js";
import type { AnalyticsFilter } from "./analytics.js";
import { journalEntries } from "../runner/journal-reader.js";
import { KINDS } from "../runner/journal-kinds.js";
import { keptOf, learnedOf, lostOf, type DroppedData, type GradedData, type KeptProposal, type MergedData } from "../runner/learning-loop.js";
import type { Store } from "../store/store.js";

/** A run's learning end: the Learning fields its end sets. */
export type RunLearningEnd = Pick<Learning, "state" | "reason" | "detail" | "at" | "problems" | "verdict" | "graded" | "merged" | "cost_usd" | "tokens" | "learned" | "pending" | "skills" | "workflows" | "lost" | "answered_at" | "job_cost_usd" | "look_back_usd">;

/** The kept row as the end-of-run hook writes it (runner/reflect-hook.ts): proposed with the proposal, or dropped, with
 *  when the job answered, its cost and what looking back cost once the run looked back. */
type KeptRow = {
  readonly state?: string; readonly reason?: string; readonly detail?: string; readonly problems?: Learning["problems"]; readonly left?: Learning["problems"]; readonly proposal?: KeptProposal;
  readonly answered_at?: unknown; readonly job_cost_usd?: unknown; readonly look_back_usd?: unknown;
};

const timeOf = (ms: number) => new Date(ms).toISOString();
const usdOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** What a kept row says of a run that looked back (learning-run.ts closeLearning's fields): none for one that did not. */
function answeredOf(row: KeptRow): Pick<Learning, "answered_at" | "job_cost_usd" | "look_back_usd"> {
  if (typeof row.answered_at !== "string") return {};
  return { answered_at: row.answered_at, job_cost_usd: usdOrNull(row.job_cost_usd), look_back_usd: usdOrNull(row.look_back_usd) };
}

/** Run `runId`'s learning end; null when the run kept no learning. Proposed while its learning run has not ended. */
export async function runLearningEnd(store: Store, runId: string): Promise<RunLearningEnd | null> {
  const kept = await store.learning.proposal(runId);
  if (!kept) return null;
  const row = (kept.proposal ?? {}) as KeptRow;
  return { ...(await endOfKept(store, kept, row)), ...answeredOf(row) };
}

/** The learning end a kept row and its learning run's journal say. */
async function endOfKept(store: Store, kept: NonNullable<Awaited<ReturnType<Store["learning"]["proposal"]>>>, row: KeptRow): Promise<RunLearningEnd> {
  const at = timeOf(kept.createdAt);
  // Dropped before it was proposed (a cut run, nothing to keep, the checks): its end is the kept row's.
  if (row.state !== "proposed" || !row.proposal) {
    return { state: "dropped", reason: (row.reason ?? null) as Learning["reason"], detail: row.detail ?? null, at, ...(row.problems?.length ? { problems: row.problems } : {}) };
  }
  // What the checks left out goes with it to its end.
  const left = row.left?.length ? { problems: row.left } : {};
  const proposed: RunLearningEnd = { state: "proposed", reason: null, detail: row.detail ?? null, at, ...left };
  if (!kept.learningRunId) return proposed;
  const entries = await journalEntries(store.readJournal(kept.learningRunId), BACKGROUND_CONTEXT);
  const dataOf = <T>(kind: string) => entries.find((entry) => entry.kind === kind)?.data as T | undefined;
  const merged = dataOf<MergedData>(KINDS.learningMerged);
  const dropped = dataOf<DroppedData>(KINDS.learningDropped);
  if (!merged && !dropped) return proposed;
  const graded = dataOf<GradedData>(KINDS.learningGraded);
  const learningRun = await store.runs.get(kept.learningRunId);
  const endedAt = learningRun?.endedAt ? timeOf(learningRun.endedAt) : at;
  // What the grade spent: the graded entry's, or what a grade that failed spent before it did.
  const spent = graded ?? (dropped && "usd" in dropped ? { usd: dropped.usd ?? null, tokens: dropped.tokens ?? null } : undefined);
  const cost = spent ? { cost_usd: { grade: spent.usd }, tokens: { grade: spent.tokens ?? null } } : {};
  if (merged && graded) {
    const what = learnedOf(keptOf(row.proposal, graded.verdict), graded.verdict);
    return {
      state: "merged", reason: null, detail: merged.detail, at: endedAt, ...left, verdict: graded.verdict, graded: { ...graded.graded }, ...cost, merged: merged.commit,
      learned: what.learned, ...(what.pending.length ? { pending: what.pending } : {}), ...(what.skills.length ? { skills: what.skills } : {}), ...(what.workflows.length ? { workflows: what.workflows } : {}),
    };
  }
  const reason = (dropped?.reason ?? null) as Learning["reason"];
  const lost = reason === "grader" ? lostOf(row.proposal) : [];
  return {
    state: "dropped", reason, detail: dropped?.detail ?? null, at: endedAt,
    ...(dropped?.problems?.length ? { problems: [...dropped.problems] as Learning["problems"] } : left),
    // The verdict, when one was given; the blobs it read only go with a merge (the server kept them for its merge alone).
    ...(graded ? { verdict: graded.verdict } : {}), ...cost, ...(lost.length ? { lost } : {}),
  };
}

/** How the runs that tried to learn fared (GET /stats's `learning`): `runs` with a learning end, `merged`, `dropped` by
 *  reason, and `in_progress` (proposed, its learning run not ended). The shape today's counts give (learning-run.ts
 *  learningStats). */
export type LearningCounts = { runs: number; merged: number; dropped: Record<string, number>; in_progress: number };

/** GET /stats's learning counts from the one store, over the runs `filter` picks as the analytics pick them (not archived,
 *  their own or their agent's; started in [from, to); of `agent`): an agentic run with a learning end counts, its end
 *  read as the run's view reads it (runLearningEnd). A workflow's run, and one with no learning, is not counted; nor is
 *  one whose reason this server does not give (an older server's). An imported run keeps no learning in the store. */
export async function learningCountsOverStore(store: Store, filter: AnalyticsFilter): Promise<LearningCounts> {
  const from = filter.from === undefined ? -Infinity : Date.parse(filter.from);
  const to = filter.to === undefined ? Infinity : Date.parse(filter.to);
  const out: LearningCounts = { runs: 0, merged: 0, dropped: {}, in_progress: 0 };
  const agentArchived = new Map<string, boolean>();
  const workflow = new Map<string, boolean>();
  for (const run of await store.runs.list(filter.agent !== undefined ? { agentId: filter.agent } : {})) {
    if (filter.agent !== undefined && run.agentId !== filter.agent) continue;
    if (run.importedFrom || run.archivedAt !== null || !(run.startedAt >= from && run.startedAt < to)) continue;
    if (!agentArchived.has(run.agentId)) agentArchived.set(run.agentId, ((await store.agents.get(run.agentId))?.archivedAt ?? null) !== null);
    if (agentArchived.get(run.agentId)) continue;
    if (!workflow.has(run.revisionId)) workflow.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind === "workflow");
    if (workflow.get(run.revisionId)) continue;
    const learning = await runLearningEnd(store, run.id);
    // A reason this server does not give (an older server's) is not counted.
    if (!learning || (learning.reason !== null && !(LEARNING_REASONS as readonly string[]).includes(learning.reason))) continue;
    out.runs += 1;
    if (learning.state === "merged") out.merged += 1;
    else if (learning.state === "dropped") out.dropped[learning.reason ?? "unknown"] = (out.dropped[learning.reason ?? "unknown"] ?? 0) + 1;
    else out.in_progress += 1;
  }
  return out;
}

/** An agent's learning counts as its learning view gives them (GET /agents/{id}/learning, learning-run.ts ofAgent's
 *  counts): how its runs that tried to learn fared, less `runs`, from the one store. Its notes' runs and its impact are
 *  agentLearningOverStore's. */
export async function agentLearningCountsOverStore(store: Store, agentId: string): Promise<Omit<LearningCounts, "runs">> {
  const { runs: _, ...counts } = await learningCountsOverStore(store, { agent: agentId });
  return counts;
}

/** Agent `agentId`'s learning view from the one store (GET /agents/{id}/learning, learning-run.ts ofAgent): its counts
 *  (agentLearningCountsOverStore), each note's runs given it and that read it (noteRuns over notesOf), and what learning
 *  changed (learningImpact), never a run's files. Each run's part is read from its launch (the notes it was given,
 *  learningStartOf), its journal once final (the notes its job read, notesReadOf) and its learning end (when its job
 *  answered and what it and looking back cost, its grade's cost). `seed_notes`, the notes a run started from, is its
 *  launch's seedNotes: every note in its seed, before the budget picked the given ones (main's seed_notes). */
export async function agentLearningOverStore(store: Store, agentId: string): Promise<{ counts: Omit<LearningCounts, "runs">; impact: Impact; notes: NoteRuns }> {
  const counts = await agentLearningCountsOverStore(store, agentId);
  const kinds = new Map<string, string | undefined>();
  const rows: RunRow[] = [];
  const learnings = new Map<string, ImpactLearning | null>();
  const files: NoteFiles[] = [];
  for (const run of await store.runs.list({ agentId })) {
    if (run.agentId !== agentId) continue;
    if (!kinds.has(run.revisionId)) kinds.set(run.revisionId, (await store.agents.revision(run.revisionId))?.kind);
    const final = FINAL_STATES.includes(run.state);
    const started = await learningStartOfRun(store, run.id);
    const end = await runLearningEnd(store, run.id);
    const read = final && started?.given.length ? notesReadOf(started.given, await runReflect(store, run.id, BACKGROUND_CONTEXT), await runTimeline(store, run.id, BACKGROUND_CONTEXT, { settled: true })) : [];
    if (started || end) files.push(notesOf({ given: started?.given ?? [], read }));
    // The row learningImpact reads (the file path's RunRow): an ended run is a completed one.
    rows.push({
      id: run.id, kind: kinds.get(run.revisionId) === "workflow" ? "workflow" : "agentic", state: run.state === "ended" ? "completed" : run.state,
      startedAt: new Date(run.startedAt).toISOString(), endedAt: run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
      costUsd: run.costUsd, importedFrom: run.importedFrom, archivedAt: run.archivedAt === null ? null : new Date(run.archivedAt).toISOString(),
    } as unknown as RunRow);
    // What its claim laid of the skills and workflows it was offered (the newest learningLaid entry): the run started from
    // those alone.
    const laid = end && (started?.skills?.length || started?.workflows?.length) ? laidOf(await runEntries(store, run.id, BACKGROUND_CONTEXT)) : undefined;
    learnings.set(run.id, end ? impactLearningOf(end, started, laid) : null);
  }
  return { counts, impact: learningImpact(rows, (row) => learnings.get(row.id) ?? null), notes: noteRuns(files) };
}

/** What a run's claim laid of its learning seed: the learned skills and workflows it was given, by name. */
type Laid = { readonly skills: readonly string[]; readonly workflows: readonly string[] };
/** The newest learningLaid entry of a run's journal (its last claim's lay); none laid when it has none. */
export function laidOf(entries: readonly EntryLike[]): Laid {
  const data = (entries.findLast((entry) => entry.kind === KINDS.learningLaid)?.data ?? {}) as { skills?: unknown; workflows?: unknown };
  const names = (list: unknown) => (Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : []);
  return { skills: names(data.skills), workflows: names(data.workflows) };
}

/** What a run's learning end tells its impact, as ofAgent's learningOf read a held run: how it ended and when, the notes
 *  it started from; when its job answered and its costs once it looked back (a look-back of 0 for an ended one that did
 *  not); its grade's cost once it ended (0 when nothing was graded). */
function impactLearningOf(end: RunLearningEnd, started: RunLaunch["learning"], laid: Laid | undefined): ImpactLearning {
  const over = end.state === "merged" || end.state === "dropped";
  const looked = end.answered_at !== undefined ? { answered_at: end.answered_at, job_cost_usd: end.job_cost_usd ?? null, look_back_usd: end.look_back_usd ?? null } : over ? { look_back_usd: 0 } : {};
  return {
    state: end.state, reason: end.reason, at: end.at, ...(started?.seedNotes !== undefined ? { seed_notes: started.seedNotes } : {}),
    ...(laid?.skills.length ? { seed_skills: laid.skills.length } : {}), ...(laid?.workflows.length ? { seed_workflows: laid.workflows.length } : {}), ...looked,
    ...(over ? { grade_usd: end.cost_usd ? end.cost_usd.grade : 0 } : {}),
  };
}

/** A run's learning end with the notes its start gave it (`given`, when it started from a seed) and those its job read
 *  (`read`, only when it read one): what a run view and GET /runs/{id}/learning show beside the end. */
export type RunLearning = RunLearningEnd & { readonly given?: NoteUsed[]; readonly read?: NoteUsed[] };

/** The notes a run's job read (learning-run.ts noteRead's rule, over the runner's journal rows): its own successful
 *  `read` calls on a file of its copy of the folder, the end-of-run turn's (`reflect`) left out, keyed on the notes it was
 *  `given` and named as given. A file it was not given (MEMORY.md, one it wrote, one not in its seed) is not one of them. */
export function notesReadOf(given: readonly NoteUsed[] | undefined, reflect: Pick<Reflect, "after" | "until"> | undefined, rows: readonly TimelineEvent[]): NoteUsed[] {
  if (!given?.length) return [];
  const names = new Map(given.map((note) => [note.file, note.name]));
  return notesRead(reflect as Reflect | undefined, rows).flatMap((file) => (names.has(file) ? [{ file, name: names.get(file)! }] : []));
}

/** What a run's job did with the learned skills and workflows its launch offered it (GET /runs/{id}/learning `used`:
 *  its `skills` and `workflows`, apart from the skills and workflows it learned): each skill, and whether the job read its SKILL.md (a read of `.agents/skills/<name>/SKILL.md`, or a
 *  harness's own skill tool on it); each learned workflow the job called, by the call's `name` (callArgsOf), how
 *  many calls and how many failed. The end-of-run turn's rows are left out, as notesRead leaves them. */
export type LearnedUse = { readonly skills: readonly { readonly name: string; readonly read: boolean }[]; readonly workflows: readonly { readonly name: string; readonly calls: number; readonly failed: number }[] };
/** learned_workflow by every name a harness calls it (runner/learning-end.ts LEARNED_NAMES). */
const WORKFLOW_CALLS = new Set(["learned_workflow", "mcp__hands__learned_workflow"]);
/** Each tool call of a run's journal, by its call's id: its tool and the arguments it was called with, as recorded (pi's
 *  call in its assistant entry, a CLI harness's in its record's call start). A timeline row's input preview is cut and
 *  for some tools absent, so what a call read or ran is read from these. */
export function callArgsOf(entries: readonly EntryLike[]): Map<string, { tool: string; args: Record<string, unknown> }> {
  const out = new Map<string, { tool: string; args: Record<string, unknown> }>();
  const argsOf = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
  for (const entry of entries) {
    if (entry.kind === "pi.assistant") {
      for (const part of ((entry.model?.[0] as { content?: unknown } | undefined)?.content ?? []) as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
        if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") out.set(part.id, { tool: part.name, args: argsOf(part.arguments) });
      }
    } else if (entry.kind === KINDS.callStart) {
      const data = (entry.data ?? {}) as { callId?: unknown; tool?: unknown; input?: unknown };
      if (typeof data.callId === "string" && typeof data.tool === "string") out.set(data.callId, { tool: data.tool, args: argsOf(data.input) });
    }
  }
  return out;
}

/** Whether call `call` read skill `name`'s SKILL.md: the read hand on `.agents/skills/<name>/SKILL.md`, a CLI adapter's
 *  read_skill_file of the skill's SKILL.md, or claude-agent's Skill tool on the skill. */
function readsSkill(call: { tool: string; args: Record<string, unknown> }, name: string): boolean {
  const text = (key: string) => (typeof call.args[key] === "string" ? (call.args[key] as string) : "");
  if (call.tool === "read" || call.tool === "mcp__hands__read") return posix.normalize(text("path")).endsWith(`skills/${name}/SKILL.md`);
  if (call.tool === "read_skill_file") return text("skill") === name && posix.normalize(text("path")) === "SKILL.md";
  if (call.tool === "Skill") return [text("skill"), text("command"), text("name")].includes(name);
  return false;
}

export function learnedUseOf(started: RunLaunch["learning"], reflect: Pick<Reflect, "after" | "until"> | undefined, rows: readonly TimelineEvent[], args: ReadonlyMap<string, { tool: string; args: Record<string, unknown> }> = new Map()): LearnedUse {
  const job = rows.filter((row) => !reflects(reflect as Reflect | undefined, row.id));
  const results = new Map(job.flatMap((row) => (row.kind === "tool_result" && row.tool_use_id ? [[row.tool_use_id, row.tool_status] as const] : [])));
  const calls = job.filter((row) => row.kind === "tool_use" && !row.parent_tool_use_id && row.tool_use_id).flatMap((row) => {
    const call = args.get(row.tool_use_id!);
    return call ? [{ id: row.tool_use_id!, ...call }] : [];
  });
  const skills = (started?.skills ?? []).map((name) => ({ name, read: calls.some((call) => results.get(call.id) === "success" && readsSkill(call, name)) }));
  const workflows = new Map<string, { calls: number; failed: number }>();
  for (const call of calls) {
    if (!WORKFLOW_CALLS.has(call.tool) || typeof call.args.name !== "string") continue;
    const seen = workflows.get(call.args.name) ?? { calls: 0, failed: 0 };
    seen.calls += 1;
    if (results.get(call.id) !== "success") seen.failed += 1;
    workflows.set(call.args.name, seen);
  }
  return { skills, workflows: [...workflows].map(([name, seen]) => ({ name, ...seen })) };
}

/** `end` with its run's given notes (from its launch's learning start) and the notes its job read. */
export function withNotes(end: RunLearningEnd, started: RunLaunch["learning"], read: readonly NoteUsed[]): RunLearning {
  return {
    ...end,
    ...(started ? { given: started.given.map((note): NoteUsed => ({ file: note.file, name: note.name })) } : {}),
    ...(read.length ? { read: [...read] } : {}),
  };
}

/** Run `runId`'s learning start as its launch records it (run-launch.ts learningStartOf, the one reader): its given notes,
 *  its seed sha and its # Learned section; undefined when the run does not learn or has no launch. */
async function learningStartOfRun(store: Store, runId: string): Promise<RunLaunch["learning"]> {
  const row = await store.runs.launch(runId).catch(() => undefined);
  const launch = row ? readLaunchBody(row.body) : undefined;
  return launch ? learningStartOf(launch) : undefined;
}

/** GET /runs/{id}/learning from the one store, in the shape the route gives (learning-routes.ts runLearningBody): the
 *  run's learning end (runLearningEnd), the notes it was given and the seed it started from as its launch records them,
 *  what it held for its owner's OK as the store's run view reads it (no statuses: never the learning folder), settled
 *  once the run is final. Null when the run kept no learning. */
export async function runLearningOverStore(store: Store, runId: string, shown: Shown, secrets: readonly string[]) {
  const end = await runLearningEnd(store, runId);
  if (!end) return null;
  const started = await learningStartOfRun(store, runId);
  const row = await store.runs.get(runId);
  const settled = row !== undefined && FINAL_STATES.includes(row.state);
  const used = started?.given.length || started?.skills?.length || started?.workflows?.length;
  const [reflect, rows, entries] = used ? await Promise.all([runReflect(store, runId, BACKGROUND_CONTEXT), runTimeline(store, runId, BACKGROUND_CONTEXT, { settled }), runEntries(store, runId, BACKGROUND_CONTEXT)]) : [undefined, [], []];
  const read = started?.given.length ? notesReadOf(started.given, reflect, rows) : [];
  const learning = withNotes(end, started, read) as Learning;
  const current = holdsForOk(learning) ? currentLearning(learning, undefined) : learning;
  return runLearningBody({ id: runId, learning: current, seed: started?.seed ?? null, settled, used: learnedUseOf(started, reflect, rows, callArgsOf(entries)) }, shown, secrets);
}
