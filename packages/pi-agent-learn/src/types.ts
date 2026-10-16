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
