// Learning, its grade and its merge: once a run's proposal passed the checks (propose.ts), one grader decides whether its
// new notes, and its skill and workflow draft, join the agent's main, and the host merges them.
// - The grader is learn/grade.ts' gradePrompt, asked as one bounded completion against main as it is now: each active
//   note's index line, the whole text only of the notes the proposal supersedes, and what the user said in the run, so
//   the prompt is bounded whatever the folder holds (GRADE_CAPS). It runs on the model the server names for grading
//   (learning.ts gradeModelOf: `--grade-model`, else its strong tier), else on the agent's own. Its answer is read by parseVerdict,
//   which fails closed. A
//   call cut off at its bound spent what nobody knows: the grade's cost is then unknown, never $0. Before it, and only
//   when this server has an independent judge (Jev), each new note goes through the injection screen: pi-browser's page
//   classifier with its own INJECTION_THRESHOLD. A score at or over it refuses the proposal, and no score refuses it too.
// - The merge is one host commit on main, made with plumbing on a temporary index: the new notes added, each note one of
//   them supersedes marked, the skill's and draft's files added or changed (one the grader held, marked pending), and
//   MEMORY.md rebuilt (buildIndex). Its message is `learning: <run id>: merged`, the verdict's
//   reason and a `Run-Id` trailer, and main moves only from the commit it was made on (compare and swap), once more on a
//   main that moved meanwhile. A run a commit on main already names is merged, never twice. The merge's own questions
//   (learn/check.ts mergeProblems) are asked again of main as it is then, and each note superseded must still be the
//   blob the grade read: one a person changed since is theirs, and nothing merges. The checked-out files are brought in
//   line.
// The merge runs in the agent's queue; the screen and the grader never do, so no run's seed waits on a model.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildIndex, gradedItems, held, INDEX_FILE, type IndexEntry, type LearnedNote, learnedPlace, mergedNote, mergeProblems, type NoteText, parseNoteFile, type Problem, supersede, supersededBy, type Verdict } from "./learn/index.js";
import type { PageJudge } from "@parcha/pi-browser";
import { claudeModel, claudeProvider, codexModel, codexProvider } from "./adapters.js";
import { FAUX_JEV_ENV, fauxFetch, jevKey } from "./decisions.js";
import { homeOf } from "./files.js";
import { FAUX_HARNESS_ENV } from "./harness.js";
import { agentFolder, checkOut, git, line, mainOf, NO_TOKENS, type Proposal, readBlobs, type Tokens, withAgentRepo } from "./learning.js";
import { type Complete, completer } from "./llm.js";
import { type ModelRef, openRouterOnly, runModels, thinkingOf } from "./model.js";

/** How long one note's screen and the grader may take (the grader's unless the server names another), and the most the
 *  grader may write. */
const SCREEN_TIMEOUT_MS = 60_000;
const GRADE_TIMEOUT_MS = 180_000;
const GRADE_MAX_TOKENS = 16_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Main as a grade reads it: its commit, every entry at its top, its notes' texts by file (any status), and each
 *  entry's object id. */
export type Main = { sha: string; files: string[]; texts: Map<string, string>; oids: Map<string, string> };
/** What a grade spent: the screen's judge and the grader. The dollars, null when any call's are unknown, and the tokens,
 *  null when any call's are. */
export type GradeCost = { usd: number | null; tokens: Tokens | null };
export type Judged = { cost: GradeCost } & ({ verdict: Verdict } | { reason: "screen" | "screen_down"; file: string } | { reason: "grade_failed"; error: Error });
/** The agentic revision the run ran: its standing instructions, and what its model is. */
export type Agent = { instructions: string; harness?: string; model?: string; thinking?: string };

/** The newest commit on main whose Run-Id trailer names the run, as git reads trailers. */
async function mergeOf(home: string, repo: string, main: string, runId: string): Promise<string | undefined> {
  const out = (await git(home, repo, ["log", "--first-parent", "--format=%H %(trailers:key=Run-Id,valueonly,separator=%x2C)", main])).toString("utf8");
  return out.split("\n").find((entry) => entry.slice(entry.indexOf(" ") + 1).split(",").includes(runId))?.split(" ")[0];
}

/** Main's top: every entry, and the text of each `.md` blob, read with plumbing. A blob that is not UTF-8 is left out. */
async function readMain(home: string, repo: string, sha: string): Promise<Main> {
  const listed = (await git(home, repo, ["ls-tree", "-z", sha])).toString("utf8").split("\0").filter(Boolean).map((entry) => {
    const [mode, type, oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
    return { mode, type, oid: oid!, path: entry.slice(entry.indexOf("\t") + 1) };
  });
  const blobs = listed.filter((entry) => entry.type === "blob" && entry.mode === "100644" && entry.path.endsWith(".md"));
  const read = await readBlobs(home, repo, blobs.map((entry) => entry.oid));
  const texts = new Map<string, string>();
  blobs.forEach((entry, i) => {
    try {
      texts.set(entry.path, utf8.decode(read[i]!));
    } catch {
      // Not UTF-8: no note of the folder's, and never read as one.
    }
  });
  return { sha, files: listed.map((entry) => entry.path), texts, oids: new Map(listed.map((entry) => [entry.path, entry.oid])) };
}

/** Main's notes, parsed: the ones out of shape left out, as a run's seed leaves them. */
const notesOf = (main: Main): LearnedNote[] => [...main.texts].flatMap(([file, text]) => {
  const note = file === INDEX_FILE ? [] : parseNoteFile(file, text);
  return Array.isArray(note) ? [] : [note];
});

/** The proposal's notes, parsed: each passed the checks, so one that does not parse is an error. */
const proposedOf = (proposal: Proposal): LearnedNote[] => proposal.notes.map(({ file, text }) => {
  const note = parseNoteFile(file, text);
  if (Array.isArray(note)) throw new Error(`the proposal's ${file} is not a note`);
  return note;
});
/** What stops the proposal joining `main` as it is now (learn/check.ts mergeProblems). */
const problemsOf = (main: Main, notes: readonly LearnedNote[]) => mergeProblems({ files: main.files, active: notesOf(main).filter((note) => note.status === "active") }, notes);

/** What a grade reads of main: each active note as the index lists it, the whole text of the ones the proposal
 *  supersedes, and the blob each of those was on main then (`graded`, by file), which its merge checks. */
export type GradeMain = { active: IndexEntry[]; superseded: NoteText[]; graded: Record<string, string> };

/** Main now, for run `runId`'s grade, in the agent's queue: merged already (a commit names the run), what stops its
 *  proposal joining main as it is now, or its active notes' index lines and the notes the proposal supersedes in full. */
export function readForGrade(data: string, agentId: string, runId: string, proposal: Proposal): Promise<{ merged: string } | { problems: Problem[] } | GradeMain> {
  const home = homeOf(data, agentId);
  return withAgentRepo(data, agentId, async () => {
    const repo = await agentFolder(data, agentId);
    const sha = (await mainOf(home, repo))!;
    const merged = await mergeOf(home, repo, sha, runId);
    if (merged) return { merged };
    const main = await readMain(home, repo, sha);
    const added = proposedOf(proposal);
    const problems = problemsOf(main, added);
    if (problems.length) return { problems };
    const active = notesOf(main).filter((note) => note.status === "active").map(({ file, name, description }) => ({ file, name, description }));
    // mergeProblems passed: each note superseded is active on main, and named once.
    const superseded = added.flatMap((note) => note.supersedes).map((file) => ({ file, text: main.texts.get(file)! }));
    return { active, superseded, graded: Object.fromEntries(superseded.map(({ file }) => [file, main.oids.get(file)!])) };
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
/** claude-agent's provider, as claudeProvider returns it. Without `auth`, it takes x-api-key, as the adapter does. */
export type RunProvider = ReturnType<typeof claudeProvider> & { auth?: "x-api-key" | "bearer" };

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
 *  process picks it (app.ts): claude-agent's from pi-ai's catalog, sent where and as the run's own requests go
 *  (claudeProvider), any other harness's by runModels. At its revision's thinking; counted in `cost` (a call that fails
 *  has an unknown cost). */
async function graderModel(env: NodeJS.ProcessEnv, agent: Agent, cost: GradeCost, named: string | undefined): Promise<Complete> {
  let chosen;
  if (named) {
    // The strong tier named over `env` itself, never a copy of it: the server's keys are properties that do not list
    // (secrets.ts withSecrets), so a spread would leave every one out. runModels and pi-ai's auth read each by name.
    const tiered = Object.create(env, { AGENT_MODEL_STRONG: { value: named, enumerable: true } }) as NodeJS.ProcessEnv;
    const picked = await runModels(tiered, undefined, ["strong"]);
    chosen = { models: picked.models, model: picked.byTier.get("strong")! };
  } else if (agent.harness === "claude-agent" && !env[FAUX_HARNESS_ENV]) {
    const choice = claudeModel(env, agent.model);
    if ("why" in choice) throw new Error(choice.why);
    const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
    // The grader asks where the run's requests go, with the run's credential and auth mode: one claudeProvider call for
    // both. It sends the id the run sends (claudeProvider's modelId), on pi-ai's anthropic provider. The catalog only
    // prices the model.
    const sent: RunProvider = claudeProvider(env, choice.model);
    const catalog = builtinModels({ authContext: graderAuth(sent) }) as unknown as PiModels;
    const at = (found: unknown) => (found && typeof found === "object" ? { ...found, baseUrl: sent.origin } : found);
    chosen = { models: { getModel: (provider: string, id: string) => at(catalog.getModel(provider, id)), completeSimple: (...call: unknown[]) => catalog.completeSimple(...call) }, model: { provider: "anthropic", modelId: sent.modelId } };
  } else if ((agent.harness === "codex" || agent.harness === "opencode") && !env[FAUX_HARNESS_ENV] && openRouterOnly(agent.harness, env)) {
    // codex on OpenRouter alone, and opencode, which takes codex's route: the grade goes where the run's requests go,
    // OpenRouter with its key, on the model the run runs (codexModel, then the id codexProvider sends), through pi-ai's
    // openrouter provider. The revision's own name (openai/<model>) would ask for an OpenAI key, which this route never
    // needs.
    const choice = await codexModel(env, agent.model, agent.harness);
    if ("why" in choice) throw new Error(choice.why);
    chosen = await runModels(env, `openrouter/${codexProvider(env, choice.model as ModelRef, agent.harness).modelId}`);
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

/** The injection screen's judge: Jev, by TypeSafe's API or OpenRouter, when this server has its key; else none, and no
 *  screen runs. Each call is counted in `cost` (one that fails, or reports no price, is unknown unless its error carries
 *  a cost). */
async function independentJudge(env: NodeJS.ProcessEnv, cost: GradeCost): Promise<PageJudge | undefined> {
  const key = jevKey(env);
  if (!key) return undefined;
  const [{ jevProvider }, { judgeFromProvider }, fetch] = await Promise.all([import("@parcha/agentrun-jev"), import("@parcha/agentrun-dsl"), fauxFetch(env, FAUX_JEV_ENV)]);
  const judge = judgeFromProvider(jevProvider({ apiKey: key.key, ...(key.route === "openrouter" ? { provider: "openrouter" as const } : {}), ...(fetch ? { fetch } : {}) })) as unknown as PageJudge;
  const add = counter(cost);
  return async (request) => {
    const result = await judge(request).catch((error: { costUsd?: unknown }) => (add(typeof error?.costUsd === "number" ? error.costUsd : null, null), Promise.reject(error)));
    // A decision provider counts `{input_tokens, output_tokens}`, with no cache of its own.
    const used = (result.usage ?? null) as { input_tokens?: unknown; output_tokens?: unknown } | null;
    add(typeof result.cost_usd === "number" ? result.cost_usd : null, typeof used?.input_tokens === "number" && typeof used.output_tokens === "number" ? { ...NO_TOKENS, input: used.input_tokens, output: used.output_tokens } : null);
    return result;
  };
}

/** The screen (only with an independent judge), then the grader, on `gradeModel` when the server names one (gradeModelOf),
 *  given `asked`, what the user said in the run: the first note the screen refuses or cannot judge, the grader's verdict,
 *  or why the grader gave none; with what it spent. Rejects only when `signal` (the server closing) aborts it: nothing
 *  is decided then. */
export async function judgeProposal(input: { runId: string; agent: Agent; main: GradeMain; proposed: NoteText[]; files?: NoteText[]; asked?: readonly string[]; gradeModel?: string; env: NodeJS.ProcessEnv; signal: AbortSignal; gradeTimeoutMs?: number }): Promise<Judged> {
  const { runId, agent, main, proposed, env, signal } = input;
  const files = input.files ?? [];
  const cost: GradeCost = { usd: 0, tokens: { ...NO_TOKENS } };
  const judge = await independentJudge(env, cost);
  if (judge) {
    const { createPageClassifier, INJECTION_THRESHOLD } = await import("@parcha/pi-browser");
    const screened = [...proposed, ...files];
    const classify = createPageClassifier({ judge: () => judge, maxPages: screened.length });
    for (const { file, text } of screened) {
      const verdict = await bounded(SCREEN_TIMEOUT_MS, signal, cost, (screen) => classify({ url: file, status: null, contentType: null, text }, screen)).catch(() => undefined);
      signal.throwIfAborted();
      // The injection score alone decides: the classifier's wall question is about pages, not notes.
      const score = verdict?.injection;
      if (typeof score !== "number" || !Number.isFinite(score)) return { reason: "screen_down", file, cost };
      if (score >= INJECTION_THRESHOLD) return { reason: "screen", file, cost };
    }
  }
  try {
    const { gradePrompt, parseVerdict } = await import("./learn/index.js");
    const prompt = gradePrompt({ run: runId, instructions: agent.instructions, active: main.active, superseded: main.superseded, proposed, ...(files.length ? { files } : {}), ...(input.asked ? { asked: input.asked } : {}) });
    const grader = await graderModel(env, agent, cost, input.gradeModel);
    const answer = await bounded(input.gradeTimeoutMs ?? GRADE_TIMEOUT_MS, signal, cost, (grade) => grader({ prompt, maxTokens: GRADE_MAX_TOKENS }, grade));
    // The items with their texts: a note the run marked risky waits whatever the grader says (parseVerdict).
    return { verdict: parseVerdict(answer.text, gradedItems(proposed, files)), cost };
  } catch (error) {
    signal.throwIfAborted();
    return { reason: "grade_failed", error: error as Error, cost };
  }
}

/** Each skill and draft file as main keeps it: as the run gave it, or, for one the grader held for its owner's OK, with
 *  `status: pending` in its SKILL.md or its README.md (learn/skills.ts held). A held workflow.json is as given: its
 *  README holds it. */
export function heldFiles(files: readonly NoteText[], verdict?: Verdict): NoteText[] {
  const waiting = new Set((verdict?.items ?? []).filter((item) => item.pending).map((item) => item.file));
  return files.map(({ file, text }) => {
    const place = learnedPlace(file);
    const judged = place?.kind === "readme" ? `workflows/${place.name}/workflow.json` : file;
    return { file, text: waiting.has(judged) && place?.kind !== "workflow" ? held(text) : text };
  });
}

/** The blob `file` is at commit `sha` of the agent's folder, or undefined when the commit holds no such file. */
async function blobAt(home: string, repo: string, sha: string, file: string): Promise<string | undefined> {
  try {
    return line(await git(home, repo, ["rev-parse", "--verify", "--quiet", `${sha}:${file}`])) || undefined;
  } catch {
    return undefined;
  }
}

/** Merges run `runId`'s proposal into main as main is now, in the agent's queue, as `verdict` judged its notes: one commit
 *  on main (its parent main) that adds the new notes, each with its `origin` and a pending one with `status: pending`
 *  (in no index, so no run reads it, until a person approves it), marks each note a kept one supersedes (a pending
 *  note's wait for its approval), adds or changes the skill's and draft's files (heldFiles: a held one pending) and
 *  rebuilds MEMORY.md, its message `learning: <run>: merged`,
 *  `reason` and the run's Run-Id; moved onto main only from the commit it was made on, once more on a main that moved
 *  meanwhile. Then the checked-out files are main's. A run a commit on main already names is that commit. `problems`
 *  when main, as it is now, takes the notes no more (mergeProblems), or when a note the merge marks superseded is not
 *  the blob the grade read (`graded`, readForGrade's): a person changed it since, and their text stands. A note held for
 *  its owner's OK marks nothing (supersededBy), so what it names is not checked. `checkout` is why the files could not
 *  be brought in line, when they could not: main is merged all the same. */
export function mergeProposal(data: string, agentId: string, runId: string, proposal: Proposal, reason: string, graded: Readonly<Record<string, string>>, verdict?: Verdict): Promise<{ merged: string; checkout: Error | undefined } | { problems: Problem[] }> {
  const home = homeOf(data, agentId);
  // Each note as main keeps it: its origin, the grader's (a run's when it names none), and a pending one waiting.
  const judged = new Map((verdict?.items ?? []).map((item) => [item.file, item]));
  const texts = proposal.notes.map(({ file, text }) => ({ file, text: mergedNote(text, { origin: judged.get(file)?.origin ?? "run", pending: judged.get(file)?.pending === true }) }));
  const added = proposedOf({ ...proposal, notes: texts });
  return withAgentRepo(data, agentId, async () => {
    const repo = await agentFolder(data, agentId);
    const checkout = (sha: string) => checkOut(repo, sha);
    for (let tries = 0; ; tries++) {
      const sha = (await mainOf(home, repo))!;
      const known = await mergeOf(home, repo, sha, runId);
      if (known) return { merged: known, checkout: await checkout(sha) };
      const main = await readMain(home, repo, sha);
      const problems = problemsOf(main, added);
      if (problems.length) return { problems };
      // What the merge marks superseded (a note held for its owner's OK marks nothing).
      const replaced = supersededBy(added);
      // The verdict was on the text the grade read: a note this merge marks that is another blob now is never marked on
      // it.
      const changed = [...replaced].filter(([old]) => main.oids.get(old) !== graded[old]).map(([old, by]): Problem => ({ rule: "supersedes", path: by, detail: `${old} changed after the grade read it` }));
      if (changed.length) return { problems: changed };
      // A skill's or a draft's file is written whole over main's: one that changed on main after the run started (a
      // person retired or approved it, or another run's merge changed it) is never written over on this run's copy.
      const moved: Problem[] = [];
      for (const { file } of proposal.files ?? []) {
        if ((await blobAt(home, repo, proposal.seed, file)) !== (await blobAt(home, repo, sha, file))) moved.push({ rule: "supersedes", path: file, detail: `${file} changed on main after the run started` });
      }
      if (moved.length) return { problems: moved };
      const notes = notesOf(main);
      // The new tree: main's, with the new notes, the ones the kept notes supersede marked, and the index rebuilt from
      // what is active then (a pending note is not).
      const files = new Map([...texts, ...heldFiles(proposal.files ?? [], verdict)].map(({ file, text }) => [file, text]));
      for (const [old, by] of replaced) files.set(old, supersede(main.texts.get(old)!, by));
      const after = [...notes.filter((note) => !replaced.has(note.file)), ...added];
      files.set(INDEX_FILE, buildIndex(after));
      const env = { GIT_INDEX_FILE: join(repo, ".git", `merge-${runId}.index`) };
      let commit: string;
      try {
        await rm(env.GIT_INDEX_FILE, { force: true });
        await git(home, repo, ["read-tree", sha], "", env);
        const entries: string[] = [];
        for (const [file, text] of files) entries.push(`100644 ${line(await git(home, repo, ["hash-object", "-w", "--no-filters", "--stdin"], text))}\t${file}\0`);
        await git(home, repo, ["update-index", "-z", "--index-info"], entries.join(""), env);
        const tree = line(await git(home, repo, ["write-tree"], "", env));
        commit = line(await git(home, repo, ["commit-tree", tree, "-p", sha, "-m", `learning: ${runId}: merged`, "-m", reason, "-m", `Run-Id: ${runId}`]));
      } finally {
        await rm(env.GIT_INDEX_FILE, { force: true });
      }
      try {
        await git(home, repo, ["update-ref", "-m", `learning: merge ${runId}`, "refs/heads/main", commit, sha]);
      } catch (error) {
        // Lost to a write since main was read: merged again onto the main that won, never forced over it.
        if (tries === 0 && (await mainOf(home, repo)) !== sha) continue;
        throw error;
      }
      return { merged: commit, checkout: await checkout(commit) };
    }
  });
}
