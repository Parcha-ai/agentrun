import type { Session } from "@earendil-works/pi-durable";
import type { Repo } from "@parcha/pi-git-remote";
import { type Caps, createGuard } from "./guard.js";
import { type Draft, runBranchFiles } from "./branch.js";
import { COMMIT_SHA, memoPath, RUN_ID, runBranch, WORKFLOW_NAME } from "./layout.js";
import { type Reflection, reflectionProblem } from "./reflect.js";
import { learningsAt, readSeed } from "./seed.js";
import type { ServedRun } from "./serving.js";
import { collectCandidates } from "./tool.js";
import type { Candidate, Refusal } from "./types.js";
import { collectUses, collectWorkflows, COPIED_TEXT, copiesRead, liveRevisionAt, revisionOf } from "./workflows.js";

/** What `collectCandidates` reads: a pi-durable Harness or a session. */
export type ProposeTarget = Parameters<typeof collectCandidates>[0];

/** A saved workflow the step left out of the proposal, and why, in words that name nothing the run read. */
/** What the proposal left out, and why: a saved workflow by its name, or `reflection`, the memo's two sections. */
export type Withheld = { readonly name: string; readonly reason: string };

/** `proposed`: one commit made and pushed. `already`: the run's branch held a commit for this run, so none was made, and it
 *  is pushed again. `empty`: nothing to propose. `refused`: the guard objected; nothing was committed or pushed.
 *  `withheld`, when there are any: the saved workflows that carry text the run read (`read`), proposed with none of it,
 *  and the reflection when it was out of shape or the guard refused it, the memo then holding the host's lines. */
export type ProposeResult =
  | { readonly status: "proposed" | "already"; readonly sha: string; readonly withheld?: readonly Withheld[] }
  | { readonly status: "empty"; readonly withheld?: readonly Withheld[] }
  | { readonly status: "refused"; readonly refusals: readonly Refusal[] };

export type ProposeFilesOptions = {
  readonly repo: Repo;
  readonly runId: string;
  /** Path to text, as the run's branch will hold it: the guard allows only what a run writes on the shared layout. */
  readonly files: Readonly<Record<string, string>>;
  /** The commit a new branch starts from. Default: main. */
  readonly parent?: string;
  readonly candidates?: readonly Candidate[];
  /** Plaintext values the host holds as secrets now. */
  readonly secrets?: Iterable<string>;
  /** Values from this run's input. */
  readonly caseValues?: Iterable<string>;
  readonly caps?: Partial<Caps>;
};

/** Guards the whole proposal, then makes one commit on `runs/<run id>` carrying a `Run-Id` trailer and pushes it by sha. Any
 *  guard hit refuses all of it. A second call, from this host or a restarted one with an empty local repository, makes no
 *  second commit. */
export async function proposeFiles(options: ProposeFilesOptions): Promise<ProposeResult> {
  const { repo, runId, files } = options;
  const refusals = createGuard(options.caps)({
    role: "run", runId, files, ...(options.candidates ? { candidates: options.candidates } : {}),
    ...(options.secrets ? { secrets: options.secrets } : {}), ...(options.caseValues ? { caseValues: options.caseValues } : {}),
  });
  if (refusals.length) return { status: "refused", refusals };
  const branch = runBranch(runId);
  const count = options.candidates?.length ?? 0;
  const { sha, created } = await repo.commitTo(branch, {
    files,
    message: `learn: run ${runId} proposes ${count} candidate(s)`,
    trailers: { "Run-Id": runId },
    ...(options.parent === undefined || (await repo.resolve(branch)) !== undefined ? {} : { parent: options.parent }),
  });
  // An unchanged tree makes no commit and returns the branch's base: that is not a proposal for this run.
  if (!created && !(await repo.log({ ref: sha, max: 1 }))[0]?.trailers["Run-Id"]?.includes(runId)) return { status: "empty" };
  await repo.push(sha, branch);
  return { status: created ? "proposed" : "already", sha };
}

/** A run's workflow uses, from lane B5; written to `uses/<run id>.json`. Undefined means none. */
export type UsesSource = (target: ProposeTarget) => unknown | Promise<unknown>;

/** The DSL's saved records the host collected from the run's workflow store: per workflow name, each file's name
 *  (`<sha256>.json` or `latest`) and its content, as the store wrote them. */
export type WorkflowRecords = Readonly<Record<string, { readonly files: Readonly<Record<string, string>> }>>;

export type ProposeOptions = Omit<ProposeFilesOptions, "files" | "candidates"> & {
  /** The run's store: where `collectCandidates` reads the `learn` calls. */
  readonly target: ProposeTarget;
  readonly uses?: UsesSource;
  /** Proposed as drafts, `workflows/<name>/workflow.json` with a `README.md`: the document `latest` names. */
  readonly workflows?: WorkflowRecords;
  /** Set when the run read untrusted content: the memo and every note say so. */
  readonly untrusted?: boolean;
  /** How the run ended, for the memo. Default `completed`. */
  readonly outcome?: "completed" | "failed" | "stopped";
  /** What the run cost, when the host knows it, for the memo. */
  readonly costUsd?: number;
  /** The agent's reply to `REFLECT_PROMPT`, read with `parseReflection`: the memo's "What happened" and "What could be
   *  better" in its own words. Out of shape, or holding what the guard refuses (a secret, this case's data), it is left
   *  out and the host's lines stand; the notes are proposed either way. */
  readonly reflection?: Reflection;
  /**
   * The untrusted texts the run read (the pages its tools fetched, say). A saved workflow any `COPIED_TEXT` characters of
   * whose strings (case and whitespace folded) appear in one is withheld: its records stay out of the proposal and the result
   * names it. The run's other workflows and notes are proposed as usual.
   */
  readonly read?: Iterable<string>;
  /**
   * The run's working directory, where its workflow store lives. When given, the step collects what the run saved
   * (`collectWorkflows`) and how it used the workflows it had (`collectUses`, read from `target` when that is an open
   * Session) and proposes them with its candidates, so a host that passes it cannot forget the workflow pieces. An explicit
   * `workflows` or `uses` wins over what is collected.
   */
  readonly workDir?: string;
  /** The commit the run was seeded from, for `workDir`'s workflows. Default: the seed in `target`, else main. */
  readonly seedSha?: string;
  /** What the host served the run (`serve`), for the collected uses: each is a use of its own revision, with the host's
   *  verdict. */
  readonly served?: readonly ServedRun[];
};

/** The host step at a run's terminal: collect the run's candidates (and uses and saved workflows) and propose them as the run's
 *  branch on the shared layout, from the commit the run was seeded from: the memo, a note per lesson, fact or correction,
 *  one more use on each note it used, the index, a draft per workflow, and `uses/<run id>.json`. */
export async function proposeLearning(options: ProposeOptions): Promise<ProposeResult> {
  const { target, uses: usesSource, workflows, untrusted, read, workDir, seedSha, served, outcome, costUsd, reflection, ...rest } = options;
  const candidates = await collectCandidates(target);
  let records = workflows;
  let uses = await usesSource?.(target);
  if (workDir !== undefined && typeof rest.runId === "string" && RUN_ID.test(rest.runId)) {
    if (workflows === undefined) {
      const baseline = seedSha ?? (await readSeed(target))?.sha ?? (await rest.repo.resolve("main"));
      if (baseline !== undefined) records = (await collectWorkflows({ repo: rest.repo, workDir, seedSha: baseline })).records;
    }
    if (usesSource === undefined && typeof (target as { commit?: unknown }).commit === "function") {
      uses = await collectUses({ target: target as unknown as Pick<Session, "commit">, workDir, run: rest.runId, ...(served ? { served } : {}) });
    }
  }
  const withheld: Withheld[] = [];
  const texts = read === undefined ? [] : [...read].filter((text): text is string => typeof text === "string");
  if (texts.length && records) {
    const kept: Record<string, { readonly files: Readonly<Record<string, string>> }> = {};
    for (const [name, entry] of Object.entries(records)) {
      const revision = await revisionOf(name, entry.files);
      if (revision && copiesRead(revision.workflow, texts)) withheld.push({ name, reason: `${COPIED_TEXT} or more characters of its text are in content the run read` });
      else kept[name] = entry;
    }
    records = kept;
  }
  const out = <T extends object>(result: T): T => (withheld.length ? { ...result, withheld } : result);
  const described = new Map(candidates.filter((c) => c.type === "workflow" && typeof c.id === "string").map((c) => [c.id!, c.text] as const));
  const names = [...new Set([...Object.keys(records ?? {}), ...described.keys()])].sort();
  // A run that noted nothing still proposes its memo when it reflected.
  const nothing = candidates.length === 0 && uses === undefined && names.length === 0;
  if (nothing && reflection === undefined) return out({ status: "empty" as const });
  if (nothing && reflectionProblem(reflection!) !== undefined) {
    withheld.push({ name: "reflection", reason: reflectionProblem(reflection!)! });
    return out({ status: "empty" as const });
  }
  if (typeof rest.runId !== "string" || !RUN_ID.test(rest.runId)) return { status: "refused", refusals: [{ reason: "invalid", detail: "the run id is not valid" }] };
  // The commit the run was seeded from: its branch starts there, and its memo and notes name it. A run that was not seeded
  // starts from main as it is now.
  const seed = (await readSeed(target))?.sha;
  if (seed !== undefined && !COMMIT_SHA.test(seed)) return { status: "refused", refusals: [{ reason: "invalid", field: "seed", detail: "the run's seed is not a commit id" }] };
  if (seed !== undefined && (await rest.repo.resolve(seed)) !== seed) return { status: "refused", refusals: [{ reason: "invalid", field: "seed", detail: "the run's seed is not a commit of the agent repository" }] };
  const base = seed ?? (await rest.repo.resolve("main"));
  if (base === undefined) return { status: "refused", refusals: [{ reason: "invalid", field: "seed", detail: "the agent repository has no main" }] };
  let json: string | undefined;
  if (uses !== undefined) {
    try {
      json = JSON.stringify(uses, null, 2);
    } catch {
      // A bigint or a cycle has no JSON form.
    }
    if (json === undefined) return { status: "refused", refusals: [{ reason: "invalid", field: "uses", detail: "the uses are not JSON" }] };
  }
  const drafts: Draft[] = [];
  for (const name of names) {
    if (!WORKFLOW_NAME.test(name)) return { status: "refused", refusals: [{ reason: "invalid", field: "workflows", detail: "a workflow name is not valid" }] };
    const files = records?.[name]?.files;
    const workflow = files ? (await revisionOf(name, files))?.workflow : await liveRevisionAt(rest.repo, name, base);
    if (files && workflow === undefined) return { status: "refused", refusals: [{ reason: "invalid", field: "workflows", detail: "a workflow's records are not the DSL's" }] };
    drafts.push({ name, ...(workflow === undefined ? {} : { workflow }), ...(described.has(name) ? { description: described.get(name)! } : {}) });
  }
  const { learnings } = await learningsAt(rest.repo, base);
  const filesWith = (agent?: Reflection) => runBranchFiles({
    runId: rest.runId, base, seeded: seed !== undefined, candidates, untrusted: untrusted === true, learnings, drafts,
    ...(json === undefined ? {} : { uses: `${json}\n` }), ...(outcome ? { outcome } : {}), ...(costUsd === undefined ? {} : { costUsd }),
    ...(agent ? { reflection: agent } : {}),
  });
  const secrets = rest.secrets === undefined ? undefined : [...rest.secrets];
  const caseValues = rest.caseValues === undefined ? undefined : [...rest.caseValues];
  let files = filesWith();
  if (reflection !== undefined) {
    const problem = reflectionProblem(reflection);
    if (problem) withheld.push({ name: "reflection", reason: problem });
    else {
      const reflected = filesWith(reflection);
      const memo = memoPath(rest.runId);
      const hits = createGuard(rest.caps)({ role: "run", runId: rest.runId, files: reflected, candidates, ...(secrets ? { secrets } : {}), ...(caseValues ? { caseValues } : {}) }).filter((r) => r.path === memo);
      if (hits.length) withheld.push({ name: "reflection", reason: `the guard: ${[...new Set(hits.map((r) => r.reason))].join(", ")}` });
      else files = reflected;
      if (hits.length && nothing) return out({ status: "empty" as const });
    }
  }
  const result = await proposeFiles({ ...rest, ...(secrets ? { secrets } : {}), ...(caseValues ? { caseValues } : {}), files, candidates, parent: base });
  return result.status === "refused" ? result : out(result);
}
