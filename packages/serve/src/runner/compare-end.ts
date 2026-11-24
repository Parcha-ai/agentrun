// A replay run's and an audit shadow's own comparison, at its end (learn/promote.ts gradeAnswers): with no agree_on and
// a fast model, the run asks that model once whether its answer and the other one (the agent's; for a replay of a graded
// run, the grade's expected answer written over the agent's) reach the same decision, through its
// own session (the grader's route, a tier proxy beside the session's) on its own cap, booked as its own spend: a replay's
// is the check's cost, a shadow's the served run's learning cost. Its verdict is a root entry of the run's journal
// (KINDS.compared), which pathMetrics keeps on its record (metrics `replay.compared`, `audit.compared`), where the check
// (runner/promotion.ts decideCheck) and the audit (runner/audit.ts settleAudits) read it, through compareAnswers.
import type { Api, Model } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { LearningFolder } from "../learn/folder.js";
import { type Compared, type ComparedGrade, comparedGrade, type GraderReply, gradeAnswers, gradesOf, knownAnswerText, sameAnswer } from "../learn/promote.js";
import type { PortModels } from "../port-models.js";
import type { RunLaunch } from "../run-launch.js";
import type { Store } from "../store/store.js";
import { runPathOverStore } from "../store-reads/learning.js";
import { auditedAnswerOf } from "./audit.js";
import { held, heldEndOfRun } from "./held.js";
import type { EndOfRunTurn } from "./loop-contract.js";
import { answerOf } from "./promotion.js";

/** The grader's route among a run's tier routes (never a learned workflow's tier, nor a subagent's), which is also the
 *  label its requests carry on the run's record. */
export const GRADER = "grader";

/** The most tokens the grader's verdict may take: a JSON object of a few words. */
const GRADER_MAX_TOKENS = 1_000;

export type CompareEndDeps = {
  readonly store: Store;
  readonly folder: () => LearningFolder;
  readonly log: (line: string) => void;
  readonly redact?: (text: string) => string;
};

/** The job input as the grader reads it: the launch's text, or its typed input as JSON. */
const inputText = (input: unknown): string => (typeof input === "string" ? input : JSON.stringify(input ?? null));

/** The two answers a replay run or a shadow compares at its end: the known one and the workflow's. A replay's workflow
 *  answer is its own, when the workflow it replays answered it; its known answer is its source run's newest grade's
 *  expected answer written over that run's own answer (knownAnswerText, which the check reads too), else that run's
 *  own answer, with that grade (`graded`, null for none), which its verdict keeps. A shadow's agent answer is its own;
 *  the workflow's is the served run's answer it audits (its open ledger line's turn). Null: nothing to compare. */
async function pairOf(launch: RunLaunch, deps: CompareEndDeps, runId: string): Promise<{ agent: string; workflow: string; graded?: ComparedGrade | null } | null> {
  if (launch.replay) {
    const path = await runPathOverStore(deps.store, runId, launch.learning, deps.redact);
    if (path.path !== "workflow" || path.workflow !== launch.replay.workflow) return null;
    const workflow = await answerOf(deps.store, runId, BACKGROUND_CONTEXT);
    const said = await answerOf(deps.store, launch.replay.of, BACKGROUND_CONTEXT);
    // The grade read once: the verdict keeps it, so the check judges this input on the grade its grader was asked against.
    const graded = await gradeOf(deps.store, launch.replay.of);
    const agent = graded?.expected ? knownAnswerText(said, graded.expected) : said;
    return workflow === null || agent === null ? null : { agent, workflow, graded };
  }
  if (launch.audit) {
    const [agent, workflow] = [await answerOf(deps.store, runId, BACKGROUND_CONTEXT), await auditedAnswerOf({ store: deps.store, context: BACKGROUND_CONTEXT, folder: deps.folder }, runId)];
    return workflow === null || agent === null ? null : { agent, workflow };
  }
  return null;
}

/** Run `of`'s newest grade as the check judges it (comparedGrade), null when it has none. */
async function gradeOf(store: Store, of: string): Promise<ComparedGrade | null> {
  const source = await store.runs.get(of);
  return comparedGrade(source ? (await gradesOf(store.settings, source.agentId)).findLast((one) => one.run === of) : undefined);
}

/** The end-of-run step of a replay run or an audit's shadow (its callers pass no other run): its comparison (above),
 *  asked only when the run completed, was not cut, has a grader (its route exists only for a revision that names no
 *  agree_on, graderRouteOf), and the two answers are not already the same. In a run's own process the step is its runner's (held.ts endOfRun): it reads other runs and the
 *  learning ledger, which no run's process may. A comparison that fails keeps no verdict: the pair then differs, compared
 *  whole (compareAnswers), in the log's words. */
export function compareEndOfRun(launch: RunLaunch, deps: CompareEndDeps): EndOfRunTurn | undefined {
  if (held()) return heldEndOfRun();
  return async (input) => {
    if (input.cut !== undefined || input.outcome !== "completed" || !input.grade || input.grader === undefined) return undefined;
    try {
      const pair = await pairOf(launch, deps, input.runId);
      if (!pair || sameAnswer(pair.agent, pair.workflow)) return undefined;
      const grade = input.grade;
      const verdict = await gradeAnswers(inputText(launch.input), pair.agent, pair.workflow, { model: input.grader, ask: (request) => grade(request) });
      const compared: Compared = pair.graded !== undefined ? { ...verdict, graded: pair.graded } : verdict;
      return { also: [], compared };
    } catch (error) {
      deps.log(`learning: run ${input.runId}'s comparison was not asked (${(error as Error)?.message ?? error})`);
      return undefined;
    }
  };
}

/** How long one grader request may take before it is cut: a verdict is a few words, so a request this late is stuck. */
export const GRADER_DEADLINE_MS = 60_000;

/** One request to the grader's model over `models` (the run's port on the grader's route): its reply's text, the run's
 *  cap refusing it (`refused`: the proxy sent nothing and booked nothing), or a failure on its way (`failed`). pi-ai
 *  retries nothing of its own: the one retry is gradeAnswers'. Bounded by `signal` (the run's stop, its lost claim, its
 *  session closing) and `deadlineMs`, one combined abort signal: either one aborts the request and answers `cut`, and
 *  gradeAnswers asks it no more. Whatever it spent before it was cut is booked as any cut request is (the run's cap at its
 *  worst case). */
export async function graderAsk(models: PortModels, request: { readonly system: string; readonly user: string }, given: { readonly signal?: AbortSignal; readonly deadlineMs?: number } = {}): Promise<GraderReply> {
  const failure = (words: string): GraderReply => (/spend_cap_reached/.test(words) ? { refused: words } : { failed: words });
  const deadlineMs = given.deadlineMs ?? GRADER_DEADLINE_MS;
  const stopped = { cut: "its request was stopped with the run" } as const;
  if (given.signal?.aborted) return stopped;
  const limit = AbortSignal.timeout(deadlineMs);
  const signal = given.signal ? AbortSignal.any([given.signal, limit]) : limit;
  // An aborted request answers by whichever signal aborted it: the run's stop, else the deadline.
  const cutOf = (): GraderReply => (given.signal?.aborted ? stopped : { cut: `its request gave no answer within ${deadlineMs / 1000} s` });
  try {
    const model = models.getModels()[0] as Model<Api> | undefined;
    if (!model) return { failed: "the grader's route is not up" };
    const message = await models.completeSimple(model, { systemPrompt: request.system, messages: [{ role: "user", content: request.user, timestamp: Date.now() }] }, { maxTokens: GRADER_MAX_TOKENS, maxRetries: 0, signal });
    if (message.stopReason === "error" || message.stopReason === "aborted") return signal.aborted ? cutOf() : failure(message.errorMessage ?? message.stopReason);
    return { text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") };
  } catch (error) {
    return signal.aborted ? cutOf() : failure((error as Error)?.message ?? String(error));
  }
}

/** `step` with the run's grader handed in: its fast model's name and one request to it, over `models` (the run's port on
 *  GRADER), cut by the step's `signal` (the loop aborts it on a person's stop or cancel, a lost claim or the session
 *  closing) or at GRADER_DEADLINE_MS. No grader: no step at all, so the run ends as it did before there was one. */
export function withGrader(step: EndOfRunTurn | undefined, grader: { readonly model: string; readonly models: () => Promise<PortModels> } | undefined): EndOfRunTurn | undefined {
  if (!step || !grader) return undefined;
  return (input) => step({ ...input, grader: grader.model, grade: async (request) => graderAsk(await grader.models(), request, { signal: input.signal }) });
}
