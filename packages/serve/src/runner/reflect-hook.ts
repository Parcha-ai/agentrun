// The learning lane's end-of-run step on the runner (loop-contract.ts EndOfRunTurn): what a run that learns keeps
// beside its end, with no look-back turn and no grade. Two things, one merge a round on its agent's learning folder:
//   - its owner's feedback (a grade's words, a message after its first), appended to corrections.md as one line, with
//     no model turn;
//   - its compile turn (learn/compile.ts), when one is due: the job written as a workflow, or a revision of a held one,
//     checked (`checkDraft`: the workflow checks, its dry run, the secret and hidden-character refusals) and committed
//     directly, with the compiled record on the run's learning. A compile whose drafts all failed is recorded on the
//     agent's promotion records (compile once: `compileFailed`), never silent.
// How it ended is kept beside the run's end (learning_proposals): merged with what it wrote, or dropped with its reason
// and words. What the run must never learn (`refuse`: the host's secrets and what it was handed, its sign-in pointer
// among them) is refused by the checks and cut from everything the step keeps; a run whose list can't be read learns
// nothing.
import { cutStrings } from "../key-refusal.js";
import { type Problem, redactSecrets } from "../learn/index.js";
import { type CompileAsk, type CompiledRecord, compileTurn, type DraftChecked } from "../learn/compile.js";
import type { LearnedFile } from "../learning.js";
import { correctionsCapOf, said, STOPPED } from "../learning-words.js";
import type { AlsoRow, EndOfRunKept, EndOfRunTurn } from "./loop-contract.js";

/** A turn the spend cap refused (the cap's refusal words, cap.ts CAP_REFUSAL_PREFIX). */
export const CAP_REFUSAL = /^spend_cap_reached(?: \([^)]*\))?: /;

/** A draft the checks passed, as it is committed: its files whole, the README held for its owner's OK when it calls an
 *  unpriced tool (`held`), and the commit a revision was read at (`bases`, its conflict base). */
export type DraftCommit = {
  readonly name: string;
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly held?: readonly string[];
  readonly bases?: Readonly<Record<string, string>>;
};

/** What a merge landed: the commit (and the correction it left out beside its draft, learn/commit.ts
 *  LearningCommitResult `refusedCorrection`), or why it did not. */
export type Committed =
  | { readonly ok: true; readonly commit: string; readonly refusedCorrection?: readonly Problem[] }
  | { readonly ok: false; readonly reason: "conflict" | "refused" | "unavailable"; readonly problems: readonly Problem[] };

/** What the step reads of the run and the host. */
export interface ReflectDeps {
  /** Whether the run's job gave nothing new to learn from: its only tool work was its learned workflows, each answering,
   *  with nothing said after its first message. Such a run compiles nothing unless a compile is due, and its learning is
   *  dropped `empty` in said.onlyWorkflow's words. Absent, or a read that throws: none. */
  readonly nothingNew?: (runId: string) => Promise<boolean>;
  /** The run's facts: whether it learns, a person's cancel, its cap reached, its cap, its cost so far as a person is shown
   *  it (`costUsd`, kept as the job's), and under a cap its spend as the cap's gates read it (`spentUsd`; null: unknown). */
  readonly facts: (runId: string) => Promise<{ learns: boolean; cancelled?: boolean; capReached?: boolean; costUsd: number | null } & ({ capUsd?: undefined } | { capUsd: number; spentUsd: number | null })>;
  /** What the run's owner said of it: a grade's words, and each message they sent after its first, in order. */
  readonly feedback: (runId: string) => Promise<readonly string[]>;
  /** Why the owner's words would be refused as a line of corrections.md on main now (learn/commit.ts correctionRefused);
   *  empty when they would be taken. */
  readonly correctionRefused: (input: { runId: string; agentId: string; round: number; text: string; refuse: readonly string[] }) => Promise<readonly Problem[]>;
  /** The compile turn's facts (learn/compile.ts CompileAsk), `refuse` cut from what they quote: undefined when the run
   *  compiles nothing (its job not due, a workflow that answered). Absent, or a read that throws: no compile turn. */
  readonly compileFacts?: (input: { runId: string; agentId: string; outcome: "completed" | "failed"; refuse: readonly string[]; round: number }) => Promise<CompileAsk | undefined>;
  /** Compile once: a compile turn whose drafts all failed their checks (one answered, none passed) is the compile's
   *  attempt, kept on a promotion record (learning-end.ts recordDraftFailed) that compileFacts reads. Its `workflow` and
   *  `errors` come cut of `refuse`. Absent: none kept. */
  readonly compileFailed?: (input: { runId: string; agentId: string; compile: CompileAsk; workflow: string; errors: readonly string[] }) => Promise<void>;
  /** The compile turn's deadline, every attempt in it. Default learn/compile.ts COMPILE_TIMEOUT_MS. */
  readonly compileDeadlineMs?: number;
  /** One compile draft through the checks (learning-end.ts checkDraftOf): its errors, else what is committed and its
   *  digest. `revised`: a revision's workflow and the commit of main it was read at, its conflict base. */
  readonly checkDraft: (input: { runId: string; agentId: string; draft: { name: string; text: string }; refuse: readonly string[]; revised?: { readonly workflow: string; readonly base: string } }) => Promise<DraftChecked<DraftCommit>>;
  /** The round's merge on the agent's learning folder (learning-end.ts commitDirect): its draft and its owner's
   *  correction, one commit by the run. */
  readonly commit: (input: { runId: string; agentId: string; round: number; draft?: DraftCommit; correction?: string; refuse: readonly string[] }) => Promise<Committed>;
  /** Every value the run must never learn: the host's secrets and what the run was handed, its sign-in pointer among
   *  them; `unreadable` when what it was handed can't be read back, and the run learns nothing. Absent, none. */
  readonly refuse?: (runId: string) => Promise<readonly string[] | "unreadable">;
  /** For tests: the clock. Default Date.now. */
  readonly now?: () => number;
  /** Which end of the run this is: 1, its first (the default); an end after a follow-up opened the run again is the next
   *  round, kept beside the earlier rounds' (every row the step gives carries it), with a merge of its own. */
  readonly round?: number;
}

/** A learning kept beside the run's end: its state, reason and words, and what it wrote. */
const keptRow = (proposal: Record<string, unknown>): AlsoRow => ({ table: "learning_proposals", row: { turn: null, proposal } });
const dropped = (reason: string, detail: string, extra: object = {}): AlsoRow => keptRow({ ...extra, state: "dropped", reason, detail });

/** A kept row with every string in it cut of `refuse` in every form and of every secret-shaped run (learn/secrets.ts
 *  redactSecrets), with an empty list too. */
const cutRow = (row: AlsoRow, refuse: readonly string[]): AlsoRow =>
  row.table === "learning_proposals" ? { table: row.table, row: cutStrings(row.row, (text) => redactSecrets(text, refuse, Number.POSITIVE_INFINITY)) as typeof row.row } : row;

/** `rows` with round `round` on each learning row (none on a run's first, round 1). */
const roundOf = (rows: { readonly also: readonly AlsoRow[] } | undefined, round: number): { readonly also: readonly AlsoRow[] } | undefined =>
  !rows || round === 1 ? rows : { also: rows.also.map((row): AlsoRow => (row.table === "learning_proposals" ? ({ ...row, row: { ...row.row, round } } as AlsoRow) : row)) };

/** The end-of-run step for runs that learn. */
export function createReflectHook(deps: ReflectDeps): EndOfRunTurn {
  const round = deps.round ?? 1;
  const hook: EndOfRunTurn = async (input) => {
    const facts = await deps.facts(input.runId);
    if (!facts.learns) return undefined;
    const now = deps.now ?? Date.now;
    // When the job answered and what it cost: as the step starts, the run's spend so far is the job's. A compile turn an
    // earlier claim asked first (cut by a crash or a lost claim) reads that ask's, which it kept with its prompt. A run's
    // first round answered when its job's end was kept (the run's end time), never after it.
    let answeredAt = new Date(round === 1 && input.endedAt !== undefined ? input.endedAt : now()).toISOString();
    let job = facts.costUsd;
    const firstAsk = (kept: EndOfRunKept | undefined): boolean => {
      if (typeof kept?.answered_at !== "string" || (typeof kept.job_cost_usd !== "number" && kept.job_cost_usd !== null)) return false;
      [answeredAt, job] = [kept.answered_at, kept.job_cost_usd];
      return true;
    };
    const begun = firstAsk(input.keptOf?.(round));
    // What the step's model turns cost: the run's spend once it closed less the job's, unknown when either is. Kept with
    // every end once a compile turn was asked; 0 for an end that asked none. The step's only model turn is its compile
    // turn, so this is the compile's spend: it joins the revision it drafts, or the bill's unattributed when it kept no
    // draft (store-reads/learning.ts compilesOf, learning-cost.ts amortize), never the run's own.
    let asked = begun;
    const spent = async () => {
      if (!asked) return { answered_at: answeredAt, job_cost_usd: job, look_back_usd: 0 };
      const total = (await deps.facts(input.runId)).costUsd;
      return { answered_at: answeredAt, job_cost_usd: job, look_back_usd: total === null || job === null ? null : Math.max(0, Math.round((total - job) * 1e9) / 1e9) };
    };
    // An end that asks nothing more: its drop alone, or, when an earlier claim asked the compile turn (stopped during it),
    // with that ask's figures and what the turn spent since, so the run's cost stays the job's own and the rest learning's.
    const unasked = async (row: AlsoRow) => (begun ? { also: [keptRow({ ...(row.row as { proposal: object }).proposal, ...(await spent()) })] } : { also: [row] });
    // A person's stop, before or during the step, or a fault: nothing kept.
    if (input.cut === "stopped" || facts.cancelled) return unasked(dropped("cancelled", said.stopped(STOPPED.cancelled)));
    if (input.cut === "stopped-looking") return unasked(dropped("cancelled", said.stopped(STOPPED.cancelledLooking)));
    if (input.cut === "faulted") return unasked(dropped("crashed", said.stopped(STOPPED.crashed)));
    // What the run must never learn, read once, before anything: a run whose list can't be read learns nothing, never
    // over a shorter one.
    const read = deps.refuse ? await deps.refuse(input.runId).catch(() => "unreadable" as const) : [];
    if (read === "unreadable") return unasked(dropped("reflect_failed", said.stopped(STOPPED.refuseUnread)));
    const refuse = read;
    const close = async (row: AlsoRow) => ({ also: [cutRow(row.table === "learning_proposals" ? keptRow({ ...(row.row.proposal as object), ...(await spent()) }) : row, refuse)] });
    // The owner's words: one line of corrections.md, checked against main now so a refused one never holds a draft back.
    const words = (await deps.feedback(input.runId).catch(() => [] as string[])).map((text) => text.trim()).filter(Boolean);
    const correction = words.length ? words.join(" ") : undefined;
    const refusedCorrection = correction === undefined ? [] : await deps.correctionRefused({ runId: input.runId, agentId: input.agentId, round, text: correction, refuse }).catch((): Problem[] => [{ rule: "encoding", detail: "the owner's correction could not be checked" }]);
    const taken = correction !== undefined && !refusedCorrection.length ? correction : undefined;
    // The compile turn, when one is due and the run's cap has room: a cap it reached, or a spend under it that is unknown,
    // asks no model turn (the cap keeps no reserve).
    const noRoom = facts.capReached ? "no_budget" : facts.capUsd !== undefined && facts.spentUsd === null ? "unknown_cost" : undefined;
    const workflowOnly = input.outcome === "completed" && deps.nothingNew !== undefined && (await deps.nothingNew(input.runId).catch(() => false));
    const compile = !noRoom && deps.compileFacts ? await deps.compileFacts({ runId: input.runId, agentId: input.agentId, outcome: input.outcome, refuse, round }).catch(() => undefined) : undefined;
    let draft: DraftCommit | undefined;
    let compiled: { record: CompiledRecord; draft_errors?: string[] } | undefined;
    // A draft the checks refused: their problems by rule (a draft never answered refused nothing).
    let draftProblems: Problem[] = [];
    if (compile) {
      // A revision of main's text keeps the commit of main it was read at (`compile_base`) with each attempt: an attempt
      // an earlier claim asked answers with that claim's commit, never the one this claim read (main may have moved
      // since), and it is the revised workflow's conflict base in every check of the turn.
      let revised = compile.mode === "revise" && compile.base ? { workflow: compile.workflow, base: compile.base } : undefined;
      let capped = false;
      const result = await compileTurn<DraftCommit>({
        ask: async (prompt, attempt, left) => {
          asked = true;
          const keep: Record<string, string | number | null> = { answered_at: answeredAt, job_cost_usd: job, ...(revised ? { compile_base: revised.base } : {}) };
          const answer = await input.ask(prompt, { origin: "reflect", ...(round > 1 ? { round } : {}), deadlineMs: left, step: `compile-${attempt}`, keep });
          if ("failed" in answer && CAP_REFUSAL.test(answer.failed.message)) capped = true;
          firstAsk(answer.kept);
          const base = answer.kept?.compile_base;
          if (revised && typeof base === "string") revised = { ...revised, base };
          return "ended" in answer ? { answer: answer.answer } : undefined;
        },
        compile,
        refuse,
        check: (one) => deps.checkDraft({ runId: input.runId, agentId: input.agentId, draft: one, refuse, ...(revised ? { revised } : {}) }),
        ...(deps.compileDeadlineMs !== undefined ? { deadlineMs: deps.compileDeadlineMs } : {}),
        now,
      });
      if (capped && !result.kept) {
        if (!taken) return close(dropped("no_budget", said.noBudget));
      } else if (result.kept) {
        draft = result.kept;
        compiled = { record: result.record! };
      } else if (result.record) {
        compiled = { record: result.record, draft_errors: result.draftErrors };
        // Each error names its file already (checkDraftOf); one with no rule behind it (an answer the compile could not
        // read) is the workflow's.
        if (result.drafted) draftProblems = result.draftProblems ?? result.draftErrors.map((detail) => ({ rule: "workflow" as const, detail }));
        // Compile once: its failed drafts are the compile's attempt, on record before the learning closes. The draft's
        // name and errors are the model's words: cut of `refuse` as the proposal row is (cutRow) before they are saved
        // on the promotion record or logged, whose reads cut only the server's secrets, never this run's.
        const cut = (text: string) => redactSecrets(text, refuse, Number.POSITIVE_INFINITY);
        if (result.drafted && deps.compileFailed) await deps.compileFailed({ runId: input.runId, agentId: input.agentId, compile, workflow: cut(result.record.workflow), errors: result.draftErrors.map(cut) }).catch(() => undefined);
      }
    }
    const compiledFields = compiled ? { compiled: compiled.record, ...(compiled.draft_errors?.length ? { draft_errors: compiled.draft_errors } : {}) } : {};
    if (draft || taken !== undefined) {
      const done = await deps.commit({ runId: input.runId, agentId: input.agentId, round, ...(draft ? { draft } : {}), ...(taken !== undefined ? { correction: taken } : {}), refuse }).catch((error): Committed => ({ ok: false, reason: "unavailable", problems: [{ rule: "encoding", detail: error instanceof Error ? error.message : String(error) }] }));
      if (done.ok) {
        const readme = draft?.files.find((file) => file.path.endsWith("/README.md"));
        const json = draft?.files.find((file) => file.path.endsWith("/workflow.json"));
        const workflows: LearnedFile[] = draft && json ? [{ file: json.path, name: draft.name, ...(readme && draft.held?.includes(readme.path) ? { pending: true as const } : {}) }] : [];
        // The draft and the correction are judged apart: one the merge left out (corrections.md filled during the compile)
        // is reported as the check before the compile reports one.
        const left = done.refusedCorrection?.length ? done.refusedCorrection : undefined;
        const corrections = taken !== undefined && !left ? 1 : 0;
        const problems = [...refusedCorrection, ...(left ?? []), ...draftProblems];
        return close(keptRow({ state: "merged", reason: null, merged: done.commit, ...(workflows.length ? { workflows } : {}), ...(corrections ? { corrections } : {}), ...(problems.length ? { problems } : {}), ...compiledFields, detail: said.merged(workflows, corrections, problems) }));
      }
      if (done.reason === "unavailable") return close(dropped("reflect_failed", said.stopped(STOPPED.failed), compiledFields));
      return close(dropped("checker", correctionWords(done.problems), { problems: [...done.problems], ...compiledFields }));
    }
    if (refusedCorrection.length) return close(dropped("checker", correctionWords(refusedCorrection), { problems: [...refusedCorrection, ...draftProblems], ...compiledFields }));
    if (draftProblems.length) return close(dropped("checker", said.checker(draftProblems), { problems: draftProblems, ...compiledFields }));
    // A compile turn that never answered refused nothing: it failed, its attempts kept.
    if (compiled && !draft && compiled.draft_errors?.length) return close(dropped("reflect_failed", said.stopped(STOPPED.unanswered), compiledFields));
    if (noRoom && compile === undefined && deps.compileFacts) return close(dropped(noRoom, noRoom === "no_budget" ? said.noBudget : said.unknownCost));
    return close(dropped("empty", workflowOnly ? said.onlyWorkflow : said.empty, compiledFields));
  };
  return async (input) => roundOf(await hook(input), round);
}

/** Why a correction (or a merge) was refused, in a person's words: the cap's own sentence when the cap refused it, else
 *  the checks'. */
function correctionWords(problems: readonly Problem[]): string {
  const cap = correctionsCapOf(problems);
  return cap ? said.correctionsFull(cap.detail) : problems.length ? said.checker(problems) : said.stopped(STOPPED.notChecked);
}
