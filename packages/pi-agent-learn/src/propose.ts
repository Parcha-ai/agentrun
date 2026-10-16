import type { Repo } from "@parcha/pi-git-remote";
import { type Caps, createGuard } from "./guard.js";
import { renderInbox } from "./inbox.js";
import { inboxPath, RUN_ID, runBranch, usesPath } from "./layout.js";
import { type CandidatesTarget, collectCandidates } from "./tool.js";
import type { Candidate, Refusal } from "./types.js";

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
export type UsesSource = (target: CandidatesTarget) => unknown | Promise<unknown>;

export type ProposeOptions = Omit<ProposeFilesOptions, "files" | "candidates"> & {
  /** The run's store: where `collectCandidates` reads the `learn` calls. */
  readonly target: CandidatesTarget;
  readonly uses?: UsesSource;
};

/** The host step at a run's terminal: collect the run's candidates (and uses), render `inbox/<run id>.md` (and
 *  `uses/<run id>.json`), and propose them. */
export async function proposeLearning(options: ProposeOptions): Promise<ProposeResult> {
  const { target, uses: usesSource, ...rest } = options;
  const candidates = await collectCandidates(target);
  const uses = await usesSource?.(target);
  if (candidates.length === 0 && uses === undefined) return { status: "empty" };
  if (typeof rest.runId !== "string" || !RUN_ID.test(rest.runId)) return { status: "refused", refusals: [{ reason: "invalid", detail: "the run id is not valid" }] };
  const files: Record<string, string> = {};
  if (candidates.length) files[inboxPath(rest.runId)] = renderInbox(rest.runId, candidates);
  if (uses !== undefined) {
    const json = JSON.stringify(uses, null, 2);
    if (json === undefined) return { status: "refused", refusals: [{ reason: "invalid", field: "uses", detail: "the uses are not JSON" }] };
    files[usesPath(rest.runId)] = `${json}\n`;
  }
  return proposeFiles({ ...rest, files, candidates });
}
