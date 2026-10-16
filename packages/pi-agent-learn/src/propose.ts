import type { Session } from "@earendil-works/pi-durable";
import type { Repo } from "@parcha/pi-git-remote";
import { type Caps, createGuard } from "./guard.js";
import { renderInbox } from "./inbox.js";
import { inboxPath, inboxWorkflowDir, RUN_ID, runBranch, usesPath, WORKFLOW_NAME } from "./layout.js";
import { readSeed } from "./seed.js";
import { collectCandidates } from "./tool.js";
import type { Candidate, Refusal } from "./types.js";
import { collectUses, collectWorkflows } from "./workflows.js";

/** What `collectCandidates` reads: a pi-durable Harness or a session. */
export type ProposeTarget = Parameters<typeof collectCandidates>[0];

/** `proposed`: one commit made and pushed. `already`: the run's branch held a commit for this run, so none was made, and it
 *  is pushed again. `empty`: nothing to propose. `refused`: the guard objected; nothing was committed or pushed. */
export type ProposeResult =
  | { readonly status: "proposed" | "already"; readonly sha: string }
  | { readonly status: "empty" }
  | { readonly status: "refused"; readonly refusals: readonly Refusal[] };

export type ProposeFilesOptions = {
  readonly repo: Repo;
  readonly runId: string;
  /** Path to text, as the run's branch will hold it: the guard allows only this run's inbox and uses files. */
  readonly files: Readonly<Record<string, string>>;
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
  /** Committed under `inbox/<run id>/workflows/<name>/`. Whatever is not a workflow name or a record name is refused. */
  readonly workflows?: WorkflowRecords;
  /**
   * The run's working directory, where its workflow store lives. When given, the step collects what the run saved
   * (`collectWorkflows`) and how it used the workflows it had (`collectUses`, read from `target` when that is an open
   * Session) and proposes them with its candidates, so a host that passes it cannot forget the workflow pieces. An explicit
   * `workflows` or `uses` wins over what is collected.
   */
  readonly workDir?: string;
  /** The commit the run was seeded from, for `workDir`'s workflows. Default: the seed in `target`, else main. */
  readonly seedSha?: string;
};

/** The host step at a run's terminal: collect the run's candidates (and uses), render `inbox/<run id>.md` (and
 *  `uses/<run id>.json`), add the workflow records, and propose them. */
export async function proposeLearning(options: ProposeOptions): Promise<ProposeResult> {
  const { target, uses: usesSource, workflows, workDir, seedSha, ...rest } = options;
  const candidates = await collectCandidates(target);
  let records = workflows;
  let uses = await usesSource?.(target);
  if (workDir !== undefined && typeof rest.runId === "string" && RUN_ID.test(rest.runId)) {
    if (workflows === undefined) {
      const baseline = seedSha ?? (await readSeed(target))?.sha ?? (await rest.repo.resolve("main"));
      if (baseline !== undefined) records = (await collectWorkflows({ repo: rest.repo, workDir, seedSha: baseline })).records;
    }
    if (usesSource === undefined && typeof (target as { commit?: unknown }).commit === "function") {
      uses = await collectUses({ target: target as unknown as Pick<Session, "commit">, workDir, run: rest.runId });
    }
  }
  const pairs = Object.entries(records ?? {}).flatMap(([name, { files }]) => Object.entries(files).map(([file, content]) => [name, file, content] as const));
  if (candidates.length === 0 && uses === undefined && pairs.length === 0) return { status: "empty" };
  if (typeof rest.runId !== "string" || !RUN_ID.test(rest.runId)) return { status: "refused", refusals: [{ reason: "invalid", detail: "the run id is not valid" }] };
  const files: Record<string, string> = {};
  if (candidates.length) files[inboxPath(rest.runId)] = renderInbox(rest.runId, candidates);
  if (uses !== undefined) {
    let json: string | undefined;
    try {
      json = JSON.stringify(uses, null, 2);
    } catch {
      // A bigint or a cycle has no JSON form.
    }
    if (json === undefined) return { status: "refused", refusals: [{ reason: "invalid", field: "uses", detail: "the uses are not JSON" }] };
    files[usesPath(rest.runId)] = `${json}\n`;
  }
  for (const [name, file, content] of pairs) {
    if (!WORKFLOW_NAME.test(name)) return { status: "refused", refusals: [{ reason: "invalid", field: "workflows", detail: "a workflow name is not valid" }] };
    files[`${inboxWorkflowDir(rest.runId, name)}${file}`] = content;
  }
  return proposeFiles({ ...rest, files, candidates });
}
