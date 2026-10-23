import { createHash } from "node:crypto";
import { LearnError } from "./errors.js";
import { CAPS, COMMIT_SHA, LEARNING_ID, RUN_ID } from "./layout.js";
import { ENTRY_TYPES, type EntryType } from "./types.js";

/** `retired`: taken out on purpose by `retireLearning`; the file stays, it is never shown again, and curation holds a
 *  run that learns it again. */
export const STATUSES = Object.freeze(["active", "superseded", "archived", "retired"] as const);
export type Status = (typeof STATUSES)[number];

/** `all`, or a short lowercase name of the inputs a learning applies to. */
export const SCOPE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

/** One learning: one file, `learnings/<id>.md`, frontmatter then the general rule. */
export type Learning = {
  readonly id: string;
  readonly type: EntryType;
  readonly scope: string;
  readonly status: Status;
  readonly provenance: {
    /** The runs that proposed it, first one first. */
    readonly runs: readonly string[];
    /** The agent repository commit the first run was seeded from. */
    readonly sha: string;
    /** True when a proposing run had read content the host does not trust. */
    readonly untrusted: boolean;
    /** `branch-base` when the first run's inbox did not name its seed: `sha` is then the main commit its branch starts
     *  from. Absent when `sha` is the seed. */
    readonly shaFrom?: "branch-base";
  };
  /** How many runs marked it `used`. */
  readonly uses: number;
  /** The learnings this one replaces. */
  readonly supersedes: readonly string[];
  /** For a superseded learning, the one that replaced it. */
  readonly supersededBy?: string;
  /** The general rule. Never this case's data. */
  readonly text: string;
};

const KEYS = ["id", "type", "scope", "status", "provenance", "uses", "supersedes"] as const;
const OPTIONAL_KEYS = ["supersededBy"] as const;
const PROVENANCE_KEYS = ["runs", "sha", "untrusted"] as const;
const OPTIONAL_PROVENANCE_KEYS = ["shaFrom"] as const;

/** `L-` and 12 hex digits of SHA-256 over the run id and the text: the same run and text always give the same id. */
export function learningId(runId: string, text: string): string {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new LearnError("invalid", "the run id is not valid");
  if (typeof text !== "string" || text.trim() === "") throw new LearnError("invalid", "a learning needs text");
  return `L-${createHash("sha256").update(`${runId}\n${text}`, "utf8").digest("hex").slice(0, 12)}`;
}

function bad(message: string): LearnError {
  return new LearnError("format", message);
}

function checkLearning(l: Learning): void {
  if (!l || typeof l !== "object") throw bad("a learning is an object");
  if (typeof l.id !== "string" || !LEARNING_ID.test(l.id)) throw bad("id is not L- and 12 lowercase hex digits");
  if (!(ENTRY_TYPES as readonly string[]).includes(l.type)) throw bad(`type is not one of ${ENTRY_TYPES.join(", ")}`);
  if (typeof l.scope !== "string" || !SCOPE.test(l.scope)) throw bad("scope is not a short lowercase name");
  if (!(STATUSES as readonly string[]).includes(l.status)) throw bad(`status is not one of ${STATUSES.join(", ")}`);
  const p = l.provenance;
  if (!p || typeof p !== "object") throw bad("provenance is missing");
  if (!Array.isArray(p.runs) || p.runs.length === 0 || !p.runs.every((r) => typeof r === "string" && RUN_ID.test(r))) throw bad("provenance.runs is not a list of run ids");
  if (new Set(p.runs).size !== p.runs.length) throw bad("provenance.runs repeats a run");
  if (typeof p.sha !== "string" || !COMMIT_SHA.test(p.sha)) throw bad("provenance.sha is not a commit id");
  if (typeof p.untrusted !== "boolean") throw bad("provenance.untrusted is not true or false");
  if (p.shaFrom !== undefined && p.shaFrom !== "branch-base") throw bad("provenance.shaFrom is not branch-base");
  if (!Number.isSafeInteger(l.uses) || l.uses < 0) throw bad("uses is not a whole number");
  if (!Array.isArray(l.supersedes) || !l.supersedes.every((s) => typeof s === "string" && LEARNING_ID.test(s))) throw bad("supersedes is not a list of learning ids");
  if (l.supersedes.includes(l.id)) throw bad("a learning cannot supersede itself");
  if (l.supersededBy !== undefined) {
    if (typeof l.supersededBy !== "string" || !LEARNING_ID.test(l.supersededBy)) throw bad("supersededBy is not a learning id");
    if (l.supersededBy === l.id) throw bad("a learning cannot supersede itself");
    if (l.status !== "superseded" && l.status !== "retired") throw bad("only a superseded or retired learning names what superseded it");
  }
  if (typeof l.text !== "string" || l.text.trim() === "") throw bad("the text is empty");
  if (/\r/.test(l.text)) throw bad("the text holds a carriage return");
}

/** The file for a learning. Byte-stable: the same learning always renders the same bytes. */
export function renderLearning(learning: Learning): string {
  checkLearning(learning);
  const p = learning.provenance;
  const out = [
    "---",
    `id: ${learning.id}`,
    `type: ${learning.type}`,
    `scope: ${learning.scope}`,
    `status: ${learning.status}`,
    "provenance:",
    `  runs: ${JSON.stringify(p.runs)}`,
    `  sha: ${p.sha}`,
    `  untrusted: ${p.untrusted}`,
    ...(p.shaFrom === undefined ? [] : [`  shaFrom: ${p.shaFrom}`]),
    `uses: ${learning.uses}`,
    `supersedes: ${JSON.stringify(learning.supersedes)}`,
    ...(learning.supersededBy === undefined ? [] : [`supersededBy: ${learning.supersededBy}`]),
    "---",
    learning.text.replace(/\s+$/, ""),
    "",
  ].join("\n");
  const size = Buffer.byteLength(out, "utf8");
  if (size > CAPS.learning) throw new LearnError("too_large", `the learning file is ${size} bytes; the cap is ${CAPS.learning}`);
  return out;
}

function jsonList(value: string, field: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw bad(`${field} is not a list`);
  }
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) throw bad(`${field} is not a list of strings`);
  return parsed as string[];
}

/** Parses a learning file as `renderLearning` writes it, and nothing looser: an unknown, missing or repeated key, or a
 *  value out of shape, is a `format` error. */
export function parseLearning(file: string): Learning {
  if (typeof file !== "string") throw bad("a learning file is text");
  if (Buffer.byteLength(file, "utf8") > CAPS.learning) throw new LearnError("too_large", `a learning file holds at most ${CAPS.learning} bytes`);
  if (!file.startsWith("---\n")) throw bad("a learning file starts with frontmatter");
  const end = file.indexOf("\n---\n", 3);
  if (end < 0) throw bad("the frontmatter is not closed");
  const head = file.slice(4, end).split("\n");
  const fields = new Map<string, string>();
  const provenance = new Map<string, string>();
  let inProvenance = false;
  for (const line of head) {
    const nested = line.startsWith("  ");
    const match = /^([a-zA-Z]+):(?: (.*))?$/.exec(nested ? line.slice(2) : line);
    if (!match) throw bad(`the frontmatter line ${JSON.stringify(line.slice(0, 40))} is not "key: value"`);
    const [, key, value = ""] = match as unknown as [string, string, string | undefined];
    if (nested) {
      if (!inProvenance || ![...PROVENANCE_KEYS, ...OPTIONAL_PROVENANCE_KEYS].includes(key as never)) throw bad(`unexpected nested key ${key}`);
      if (provenance.has(key)) throw bad(`provenance.${key} appears twice`);
      provenance.set(key, value);
      continue;
    }
    if (![...KEYS, ...OPTIONAL_KEYS].includes(key as never)) throw bad(`unknown key ${key}`);
    if (fields.has(key)) throw bad(`${key} appears twice`);
    fields.set(key, value);
    inProvenance = key === "provenance";
    if (inProvenance && value !== "") throw bad("provenance holds nested keys");
  }
  for (const key of KEYS) if (!fields.has(key)) throw bad(`${key} is missing`);
  for (const key of PROVENANCE_KEYS) if (!provenance.has(key)) throw bad(`provenance.${key} is missing`);
  const untrusted = provenance.get("untrusted");
  if (untrusted !== "true" && untrusted !== "false") throw bad("provenance.untrusted is not true or false");
  const uses = fields.get("uses")!;
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(uses)) throw bad("uses is not a whole number");
  const learning: Learning = {
    id: fields.get("id")!,
    type: fields.get("type") as EntryType,
    scope: fields.get("scope")!,
    status: fields.get("status") as Status,
    provenance: {
      runs: jsonList(provenance.get("runs")!, "provenance.runs"), sha: provenance.get("sha")!, untrusted: untrusted === "true",
      ...(provenance.has("shaFrom") ? { shaFrom: provenance.get("shaFrom") as "branch-base" } : {}),
    },
    uses: Number(uses),
    supersedes: jsonList(fields.get("supersedes")!, "supersedes"),
    ...(fields.has("supersededBy") ? { supersededBy: fields.get("supersededBy")! } : {}),
    text: file.slice(end + 5).replace(/\s+$/, ""),
  };
  checkLearning(learning);
  return learning;
}
