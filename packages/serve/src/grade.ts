// Learning, its grade and its merge: once a run's proposal passed the checks (propose.ts), one grader decides whether its
// new notes, and its skill and workflow draft, join the agent's main, and the host merges them.
// - The grader is learn/grade.ts' gradePrompt, asked as one bounded completion against main as it is now: each active
//   note's index line, the whole text only of the notes the proposal supersedes, and what the user said in the run, so
//   the prompt is bounded whatever the folder holds (GRADE_CAPS). It runs on the model the server names for grading
//   (learning.ts gradeModelOf: `--grade-model`, else its strong tier), else on the agent's own. Its answer is read by parseVerdict,
//   which fails closed. A
//   call cut off at its bound spent what nobody knows: the grade's cost is then unknown, never $0. No injection screen
//   runs before it: a page classifier cannot see where a note came from, and dropped a preference the user stated (it
//   reads like an instruction); the grader's Planted question decides, with what the user said in view.
// - The merge is one commit on main by the learning script (learn/folder.ts writeLearning, one exec): the new notes
//   added, each note one of them supersedes marked, the skill's and draft's files added or changed (one the grader held,
//   marked pending), and MEMORY.md rebuilt (buildIndex). Its message is `learning: <run id>: merged`, the verdict's
//   reason and a `Run-Id` trailer, and main moves only from the main it read (compare and swap), computed again on a
//   main that moved meanwhile; the script writes the run's diff file and the snapshot in the same exec. A run whose diff
//   file the folder holds is merged, never twice. The merge's own questions (learn/check.ts mergeProblems) are asked
//   again of main as it is then, each note superseded must still be the blob the grade read (one a person changed since
//   is theirs, and nothing merges), a new note's name must be free on main as git holds it, and each skill or draft file
//   must be on main as it was on the run's seed (the script checks both).
// Both read main from the folder's snapshot and its bodies (learn/folder.ts), never with git.
// TODO(tl-jobs): grade and merge are the built-in learning run the RUNNER runs (model calls through the proxy and cap,
// git through learningWorkspace(agent).exec, its own journal). Until the runner has an entry point for built-in runs,
// learning-run.ts calls readForGrade, judgeProposal and mergeProposal here, in the server; they move whole.
// The merge runs in the agent's queue; the grader never does, so no run's seed waits on a model.
import { buildIndex, gradedItems, held, INDEX_FILE, type IndexEntry, type LearnedNote, learnedPlace, mergedNote, mergeProblems, type NoteText, parseNoteFile, type Problem, supersede, supersededBy, type Verdict } from "./learn/index.js";
import { FolderRefused, readRunDiff, type Snapshot, snapshotNotes, topOf, writeLearning } from "./learn/folder.js";
import { readMain } from "./learn/commit.js";
import { harnessOf } from "./harness-table.js";
import { type Provider, providerFor } from "./provider.js";
import { learningWorkspace, NO_TOKENS, type Proposal, type Tokens, withAgentRepo } from "./learning.js";
import { type Complete, completer } from "./llm.js";
import { type ModelRef, runModels, thinkingOf } from "./model.js";

/** How long the grader may take (unless the server names another), and the most it may write. */
const GRADE_TIMEOUT_MS = 180_000;
const GRADE_MAX_TOKENS = 16_000;
/** What a grade spent: the grader's calls. The dollars, null when any call's are unknown, and the tokens,
 *  null when any call's are. */
export type GradeCost = { usd: number | null; tokens: Tokens | null };
export type Judged = { cost: GradeCost } & ({ verdict: Verdict; unread?: string } | { reason: "grade_failed"; error: Error });
/** The agentic revision the run ran: its standing instructions, and what its model is. */
export type Agent = { instructions: string; harness?: string; model?: string; thinking?: string };


/** The proposal's notes, parsed: each passed the checks, so one that does not parse is an error. */
const proposedOf = (proposal: Proposal): LearnedNote[] => proposal.notes.map(({ file, text }) => {
  const note = parseNoteFile(file, text);
  if (Array.isArray(note)) throw new Error(`the proposal's ${file} is not a note`);
  return note;
});
/** What stops the proposal joining main as its snapshot has it (learn/check.ts mergeProblems). */
const problemsOf = (main: Snapshot, notes: readonly LearnedNote[]) => mergeProblems({ files: topOf(main), active: snapshotNotes(main).filter((note) => note.status === "active") }, notes);
/** The folder's snapshot, which a run's grade and merge always find: the run was seeded from its main. */
const mainOf = (snapshot: Snapshot | undefined): Snapshot => {
  if (!snapshot) throw new Error("the agent's learning folder has no main");
  return snapshot;
};

/** What a grade reads of main: each active note as the index lists it, the whole text of the ones the proposal
 *  supersedes, and the blob each of those was on main then (`graded`, by file), which its merge checks. */
export type GradeMain = { active: IndexEntry[]; superseded: NoteText[]; graded: Record<string, string> };

/** Main now, for run `runId`'s grade, in the agent's queue: merged already (a commit names the run), what stops its
 *  proposal joining main as it is now, or its active notes' index lines and the notes the proposal supersedes in full. */
export function readForGrade(data: string, agentId: string, runId: string, proposal: Proposal): Promise<{ merged: string } | { problems: Problem[] } | GradeMain> {
  return withAgentRepo(data, agentId, async () => {
    const ws = (await learningWorkspace(data, agentId, { make: true }))!;
    const merged = await readRunDiff(ws, runId);
    if (merged) return { merged: merged.merge };
    return readMain(ws, proposal);
  });
}

/** Counts one call in `cost`: its dollars and tokens, each null when unknown (a call that failed, or reported none). */
const counter = (cost: GradeCost) => (usd: number | null, tokens: Tokens | null) => {
  cost.usd = usd !== null && Number.isFinite(usd) && cost.usd !== null ? cost.usd + usd : null;
  cost.tokens = tokens && cost.tokens ? { input: cost.tokens.input + tokens.input, cache_read: cost.tokens.cache_read + tokens.cache_read, cache_write: cost.tokens.cache_write + tokens.cache_write, output: cost.tokens.output + tokens.output } : null;
};

/** `work`, given a signal that aborts at `ms` or with `outer`, and rejected then whether or not it listens. A call cut
 *  off so, before it settled, spent what nobody knows: `cost` turns unknown (null dollars and tokens), never the zeros
 *  it started from, and a late answer leaves it unknown. */
function bounded<T>(ms: number, outer: AbortSignal, cost: GradeCost, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (outer.aborted) return Promise.reject(outer.reason);
  const signal = AbortSignal.any([outer, AbortSignal.timeout(ms)]);
  let settled = false;
  const doing = work(signal).finally(() => (settled = true));
  doing.catch(() => undefined);
  const cut = new Promise<never>((_, reject) => {
    const stop = () => {
      if (settled) return;
      counter(cost)(null, null);
      reject(signal.reason);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  return Promise.race([doing, cut]);
}

/** pi-ai's usage of one completion, as it reports it: `input` apart from what was read from or written to the cache. */
type PiUsage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
/** That usage by the platform's names; null when there is none, or a count is not a whole number. */
const tokensOf = (usage: PiUsage | undefined): Tokens | null =>
  usage && [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0].every((n) => Number.isSafeInteger(n) && n >= 0) ? { input: usage.input, cache_read: usage.cacheRead ?? 0, cache_write: usage.cacheWrite ?? 0, output: usage.output } : null;
type PiModels = { getModel(provider: string, id: string): unknown; completeSimple(...args: unknown[]): Promise<{ usage?: PiUsage }> };
/** A run's provider, as providerFor returns it. Without `auth`, it takes x-api-key, as the adapter does. */
export type RunProvider = Pick<Provider, "origin" | "credential"> & { auth?: "x-api-key" | "bearer" };

/** The variable pi-ai's anthropic provider reads for each auth mode: it sends the first as `authorization: Bearer`, the
 *  second as `x-api-key`. */
const BEARER_VARIABLE = "ANTHROPIC_AUTH_TOKEN";
const X_API_KEY_VARIABLE = "ANTHROPIC_API_KEY";

/** pi-ai's auth context for a grade on `provider`, the run's: its credential under the one variable pi-ai reads for its
 *  auth mode, and no other variable of serve's env. */
export function graderAuth(provider: RunProvider) {
  const name = provider.auth === "bearer" ? BEARER_VARIABLE : X_API_KEY_VARIABLE;
  return { env: async (asked: string) => (asked === name ? (await provider.credential()) || undefined : undefined), fileExists: async () => false };
}

/** One completion for the grader: on the model the server names for grading (`named`), picked as a workflow's strong
 *  tier is (runModels: the gateway, pi-ai's providers, or the faux module); else on the agent's own model, as its run's
 *  process picks it (app.ts): one chosen on its wire's own settings sent where and as the run's own requests go
 *  (providerFor), any other by runModels. At its revision's thinking; counted in `cost` (a call that fails
 *  has an unknown cost). */
async function graderModel(env: NodeJS.ProcessEnv, agent: Agent, cost: GradeCost, named: string | undefined): Promise<Complete> {
  let chosen;
  // The agent's harness, resolved once (harness-table.ts).
  const entry = harnessOf(env, agent.harness);
  if (named) {
    // The strong tier named over `env` itself, never a copy of it: the server's keys are properties that do not list
    // (secrets.ts withSecrets), so a spread would leave every one out. runModels and pi-ai's auth read each by name.
    const tiered = Object.create(env, { AGENT_MODEL_STRONG: { value: named, enumerable: true } }) as NodeJS.ProcessEnv;
    const picked = await runModels(tiered, undefined, ["strong"]);
    chosen = { models: picked.models, model: picked.byTier.get("strong")! };
  } else if (entry?.facts && entry.onWire(env)) {
    // A harness whose model is chosen on its wire's own settings (its entry's onWire): the grade goes where the run's
    // requests go (providerFor), with the run's credential and auth mode, on the model the run runs (its entry's model,
    // then the id providerFor sends).
    const choice = await entry.model(env, agent.model, true);
    if (!choice) throw new Error(`${entry.id} does not run here.`);
    if ("why" in choice) throw new Error(choice.why);
    const sent = providerFor(entry.facts.wire, env, choice.model as ModelRef, entry.id);
    if (entry.facts.wire === "anthropic-messages") {
      // On pi-ai's anthropic provider at the run's endpoint. The catalog only prices the model.
      const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
      const catalog = builtinModels({ authContext: graderAuth(sent) }) as unknown as PiModels;
      const at = (found: unknown) => (found && typeof found === "object" ? { ...found, baseUrl: sent.origin } : found);
      chosen = { models: { getModel: (provider: string, id: string) => at(catalog.getModel(provider, id)), completeSimple: (...call: unknown[]) => catalog.completeSimple(...call) }, model: { provider: "anthropic", modelId: sent.modelId } };
    } else {
      // The Responses API through OpenRouter alone (onWire's other case): OpenRouter with its key, through pi-ai's
      // openrouter provider. The revision's own name (openai/<model>) would ask for an OpenAI key, which this route never
      // needs.
      chosen = await runModels(env, `openrouter/${sent.modelId}`);
    }
  } else chosen = await runModels(env, agent.model);
  const models = chosen.models as unknown as PiModels;
  const { model } = chosen;
  const add = counter(cost);
  return async (args, signal) => {
    // The call's tokens from pi-ai's own usage, which keeps the cache's reads and writes apart.
    let usage: PiUsage | undefined;
    const tapped: PiModels = {
      getModel: (provider, id) => models.getModel(provider, id),
      completeSimple: async (...call) => {
        const message = await models.completeSimple(...call);
        usage = message.usage;
        return message;
      },
    };
    const answer = await completer(tapped as never, () => model, thinkingOf(env, agent.thinking))(args, signal).catch((error: Error) => (add(null, null), Promise.reject(error)));
    add(answer.cost_usd, tokensOf(usage));
    return answer;
  };
}

/** The grader, on `gradeModel` when the server names one (gradeModelOf), given `asked`, what the user said in the run:
 *  its verdict, or why it gave none; with what it spent. An answer the host cannot read is asked once more, with the same
 *  prompt and under the same bound, each ask counted once in `cost`; two such answers are a drop that could not be read,
 *  with the last answer as it came (`unread`, for the caller to cut of secrets and keep). Rejects only when `signal` (the
 *  server closing) aborts it: nothing is decided then. */
export async function judgeProposal(input: { runId: string; agent: Agent; main: GradeMain; proposed: NoteText[]; files?: NoteText[]; asked?: readonly string[]; triggered?: readonly { source: string; text: string }[]; gradeModel?: string; env: NodeJS.ProcessEnv; signal: AbortSignal; gradeTimeoutMs?: number }): Promise<Judged> {
  const { runId, agent, main, proposed, env, signal } = input;
  const files = input.files ?? [];
  const cost: GradeCost = { usd: 0, tokens: { ...NO_TOKENS } };
  try {
    const { gradePrompt, parseVerdict, UNREADABLE_REASON } = await import("./learn/index.js");
    const prompt = gradePrompt({ run: runId, instructions: agent.instructions, active: main.active, superseded: main.superseded, proposed, ...(files.length ? { files } : {}), ...(input.asked ? { asked: input.asked } : {}), ...(input.triggered ? { triggered: input.triggered } : {}) });
    const grader = await graderModel(env, agent, cost, input.gradeModel);
    const ask = () => bounded(input.gradeTimeoutMs ?? GRADE_TIMEOUT_MS, signal, cost, (grade) => grader({ prompt, maxTokens: GRADE_MAX_TOKENS }, grade));
    // The items with their texts: a note the run marked risky waits whatever the grader says (parseVerdict).
    const items = gradedItems(proposed, files);
    const first = parseVerdict((await ask()).text, items);
    if (first.reason !== UNREADABLE_REASON || first.items.length) return { verdict: first, cost };
    const again = (await ask()).text;
    const verdict = parseVerdict(again, items);
    return verdict.reason === UNREADABLE_REASON && !verdict.items.length ? { verdict, unread: typeof again === "string" ? again : "", cost } : { verdict, cost };
  } catch (error) {
    signal.throwIfAborted();
    return { reason: "grade_failed", error: error as Error, cost };
  }
}

/** Each skill and draft file as main keeps it: as the run gave it, or, for one the grader held for its owner's OK, with
 *  `status: pending` in its SKILL.md or its README.md (learn/skills.ts held). A held workflow.json is as given: its
 *  README holds it. */
/** The graded item a proposal's file is judged as: a draft's README.md with its workflow.json, every other file as
 *  itself (a note, a skill's SKILL.md, a draft's workflow.json). */
const itemOf = (file: string): string => {
  const place = learnedPlace(file);
  return place?.kind === "readme" ? `workflows/${place.name}/workflow.json` : file;
};

/** `proposal` with only what `verdict` keeps (a verdict per item): each note, skill and draft (both its files) its item
 *  keeps or holds; the ones it drops are left out. A proposal with no verdict (a merge resumed on one kept before the
 *  grade read items) is as it is. */
export function keptProposal(proposal: Proposal, verdict?: Verdict): Proposal {
  if (!verdict?.items.length) return proposal;
  const kept = new Set(verdict.items.filter((item) => item.keep).map((item) => item.file));
  const files = (proposal.files ?? []).filter(({ file }) => kept.has(itemOf(file)));
  const { files: _, ...rest } = proposal;
  return { ...rest, notes: proposal.notes.filter(({ file }) => kept.has(file)), ...(files.length ? { files } : {}) };
}

export function heldFiles(files: readonly NoteText[], verdict?: Verdict): NoteText[] {
  const waiting = new Set((verdict?.items ?? []).filter((item) => item.pending).map((item) => item.file));
  return files.map(({ file, text }) => {
    const place = learnedPlace(file);
    const judged = place?.kind === "readme" ? `workflows/${place.name}/workflow.json` : file;
    return { file, text: waiting.has(judged) && place?.kind !== "workflow" ? held(text) : text };
  });
}

/** Merges run `runId`'s proposal into main as main is now, in the agent's queue, as `verdict` judged its notes: one commit
 *  on main (its parent main) by the learning script that adds the new notes, each with its `origin` and a pending one
 *  with `status: pending` (in no index, so no run reads it, until a person approves it), marks each note a kept one
 *  supersedes (a pending note's wait for its approval), adds or changes the skill's and draft's files (heldFiles: a held
 *  one pending) and rebuilds MEMORY.md, its message `learning: <run>: merged`, `reason` and the run's Run-Id; moved onto
 *  main only from the main it read, computed again on a main that moved meanwhile, with the run's diff file and the
 *  snapshot written in the same exec. A run whose diff file the folder holds is that merge. `problems` when main, as it
 *  is now, takes the notes no more (mergeProblems, or a new note's name held on main by a file that is no note), when a
 *  note the merge marks superseded is not the blob the grade read (`graded`, readForGrade's: a person changed it since,
 *  and their text stands), or when a skill's or draft's file changed on main after the run's seed. A note held for its
 *  owner's OK marks nothing (supersededBy), so what it names is not checked. `checkout` is why the files could not be
 *  brought in line, when they could not (the script left them, and the snapshot was rebuilt): main is merged all the
 *  same. */
export function mergeProposal(data: string, agentId: string, runId: string, proposal: Proposal, reason: string, graded: Readonly<Record<string, string>>, verdict?: Verdict): Promise<{ merged: string; checkout: Error | undefined } | { problems: Problem[] }> {
  // Each note as main keeps it: its origin, the grader's (a run's when it names none), and a pending one waiting.
  const judged = new Map((verdict?.items ?? []).map((item) => [item.file, item]));
  const texts = proposal.notes.map(({ file, text }) => ({ file, text: mergedNote(text, { origin: judged.get(file)?.origin ?? "run", pending: judged.get(file)?.pending === true }) }));
  const added = proposedOf({ ...proposal, notes: texts });
  type Merged = { merged: string; checkout: Error | undefined } | { problems: Problem[] };
  return withAgentRepo(data, agentId, async () => {
    const ws = (await learningWorkspace(data, agentId, { make: true }))!;
    const known = await readRunDiff(ws, runId);
    if (known) return { merged: known.merge, checkout: undefined };
    try {
      const done = await writeLearning<Merged>(ws, async ({ snapshot, body }) => {
        const main = mainOf(snapshot);
        const problems = problemsOf(main, added);
        if (problems.length) return { result: { problems } };
        // What the merge marks superseded (a note held for its owner's OK marks nothing).
        const replaced = supersededBy(added);
        const oids = new Map(main.notes.map((note) => [note.file, note.oid]));
        // The verdict was on the text the grade read: a note this merge marks that is another blob now is never marked on
        // it.
        const changed = [...replaced].filter(([old]) => oids.get(old) !== graded[old]).map(([old, by]): Problem => ({ rule: "supersedes", path: by, detail: `${old} changed after the grade read it` }));
        if (changed.length) return { result: { problems: changed } };
        // The new tree: main's, with the new notes, the ones the kept notes supersede marked, and the index rebuilt from
        // what is active then (a pending note is not).
        const files = new Map([...texts, ...heldFiles(proposal.files ?? [], verdict)].map(({ file, text }) => [file, text]));
        for (const [old, by] of replaced) files.set(old, supersede(await body(old, oids.get(old)!), by));
        const after = [...snapshotNotes(main).filter((note) => !replaced.has(note.file)), ...added];
        files.set(INDEX_FILE, buildIndex(after));
        return {
          result: { merged: "", checkout: undefined },
          change: {
            by: { run: runId, reason },
            writes: [...files].map(([path, text]) => ({ path, text })),
            // A new note's name is free on main, as git holds it: a file the notes leave out included.
            absent: texts.map(({ file }) => file),
            // A skill's or a draft's file is written whole over main's: one that changed on main after the run started (a
            // person retired or approved it, or another run's merge changed it) is never written over on this run's copy.
            same: (proposal.files ?? []).map(({ file }) => ({ commit: proposal.seed, path: file })),
          },
        };
      });
      return done.main ? { merged: done.main, checkout: undefined } : done.result;
    } catch (error) {
      if (!(error instanceof FolderRefused)) throw error;
      return { problems: [...error.absent.map((path): Problem => ({ rule: "exists", path, detail: "the folder has a note by this name" })), ...error.same.map((path): Problem => ({ rule: "supersedes", path, detail: `${path} changed on main after the run started` }))] };
    }
  });
}
