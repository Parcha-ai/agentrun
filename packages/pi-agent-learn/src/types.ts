import type { TreeEntry } from "@parcha/pi-git-remote";

/** What a `learn` call can note. `used` marks an existing learning that helped; `workflow` says when to use a workflow
 *  the run saved; the other three propose a new learning. */
export const LEARN_TYPES = Object.freeze(["lesson", "fact", "correction", "used", "workflow"] as const);
export type LearnType = (typeof LEARN_TYPES)[number];

/** The types a learning entry in the repository has. */
export const ENTRY_TYPES = Object.freeze(["lesson", "fact", "correction"] as const);
export type EntryType = (typeof ENTRY_TYPES)[number];

/** One `learn` call, as the run stores it: one per call id, so a replayed call rewrites the same candidate. */
export type Candidate = {
  readonly callId: string;
  readonly type: LearnType;
  readonly text: string;
  readonly evidence: readonly string[];
  /** For `used`, the learning that helped; for `workflow`, the saved workflow's name; for the others, the learning this
   *  one corrects or replaces, when there is one. */
  readonly id?: string;
  /** Set by the host when the run read content it does not trust: the curator then asks whether the text is an
   *  instruction that came from that content. */
  readonly untrusted?: boolean;
};

/** Who writes to the agent repository: a run proposing on its own branch, or the curator writing main. */
export type Role = "run" | "curate";

export type RefusalReason =
  | "secret_value"
  | "secret_shape"
  | "invisible_unicode"
  | "rules_locked"
  | "path_not_allowed"
  | "case_data"
  | "too_large"
  | "too_many"
  | "invalid";

/** Why a write may not happen. `detail` never repeats the value that was refused. */
export type Refusal = {
  readonly reason: RefusalReason;
  readonly path?: string;
  readonly field?: string;
  readonly detail: string;
};

export type GuardInput = {
  readonly role: Role;
  /** Required with `files` for the `run` role: a run writes only paths named for its own id. */
  readonly runId?: string;
  /** Paths to write, as the repository will hold them; null deletes. */
  readonly files?: Readonly<Record<string, string | null>>;
  readonly candidates?: readonly Candidate[];
  /** Plaintext values the host holds as secrets at this moment. */
  readonly secrets?: Iterable<string>;
  /** Values from this run's input; a learning that repeats one is case data. */
  readonly caseValues?: Iterable<string>;
};

/**
 * The structural check every writer runs before anything reaches git: secrets, rules-tier paths, paths outside the
 * role's allowlist, invisible Unicode, case data and sizes. Empty means allowed. It refuses and never redacts, and it
 * makes no model call: semantic judgments belong to the curator.
 */
export type Guard = (input: GuardInput) => readonly Refusal[];

// ---------------------------------------------------------------- the curator's ports to the workflows lane

/** Main as curation reads it: the commit it builds on, and reads at a commit. */
export type RepoRead = {
  readonly main: string;
  readonly read: (path: string, sha: string) => Promise<string | undefined>;
  readonly list: (prefix: string, sha: string) => Promise<TreeEntry[]>;
};

/** A saved workflow a run proposed. */
export type WorkflowCandidate = {
  readonly run: string;
  readonly name: string;
  /** The agent's when-to-use text, from its `learn` call of type `workflow`; undefined when it saved the workflow
   *  without one. Structured preconditions are `when` in `trial.json`, never this. */
  readonly description?: string;
  /** `<sha256>.json` and `latest` as the run's branch holds them under `inbox/<run id>/workflows/<name>/`, byte-for-byte;
   *  empty when the run only described a workflow already on main. */
  readonly records: Readonly<Record<string, string>>;
  readonly untrusted: boolean;
};

export type AdmitWorkflowInput = RepoRead & { readonly workflow: WorkflowCandidate };

/** `admitted`: the files to commit on main, only under `.pi/agentrun/workflows/<name>/` and SKILL.md and trial.json in
 *  `.agents/skills/<name>/`. `unchanged`: the same records and description are already on main. Every `reason` goes
 *  into the report and a commit message, so it names no value from the case. */
export type AdmitWorkflowResult =
  | { readonly status: "admitted"; readonly files: Readonly<Record<string, string | null>>; readonly reason: string }
  | { readonly status: "unchanged"; readonly reason: string }
  | { readonly status: "held" | "refused"; readonly reason: string };

export type AdmitWorkflow = (input: AdmitWorkflowInput) => Promise<AdmitWorkflowResult>;

/** One use of a saved workflow in a run, as `uses/<run id>.json` holds it. */
export type WorkflowUse = {
  readonly name: string;
  /** The record the run used. */
  readonly sha256: string;
  /** `frozen`: the workflow finished the case itself; `escalated`: it handed the case back to the agent; `failed`. */
  readonly outcome: "frozen" | "escalated" | "failed";
  readonly at: string;
};

export type SettleUsesInput = RepoRead & { readonly run: string; readonly uses: readonly WorkflowUse[] };

/** `files` to commit on main, only inside the folders of the workflows the uses name; one decision per workflow. */
export type SettleUsesResult = {
  readonly files: Readonly<Record<string, string | null>>;
  readonly decisions: readonly { readonly name: string; readonly action: "promote" | "demote" | "hold"; readonly reason: string; readonly rollbackTo?: string }[];
};

export type SettleUses = (input: SettleUsesInput) => Promise<SettleUsesResult>;
