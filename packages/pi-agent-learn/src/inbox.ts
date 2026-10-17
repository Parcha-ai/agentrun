import { COMMIT_SHA } from "./layout.js";
import { type Candidate, LEARN_TYPES } from "./types.js";

/** The line before the JSON that holds the candidates exactly. A reader trusts that block and nothing above it. */
const FENCE = "~~~json candidates";

export class InboxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxFormatError";
  }
}

export type InboxOptions = {
  /** The commit the run was seeded from, so a reader can stamp a learning with what the run actually saw. */
  readonly seed?: string;
  /** The run read untrusted content: every candidate is marked untrusted. */
  readonly untrusted?: boolean;
};

/** `inbox/<run id>.md`: front matter (the run and its seed commit, written before any model text), the candidates for a
 *  person to read, and the candidates as one JSON line, each with its untrusted mark. */
export function renderInbox(runId: string, candidates: readonly Candidate[], options: InboxOptions = {}): string {
  if (options.seed !== undefined && !COMMIT_SHA.test(options.seed)) throw new InboxFormatError("the seed is not a commit id");
  const untrusted = options.untrusted === true;
  const front = ["---", `run: ${runId}`, ...(options.seed === undefined ? [] : [`seed: ${options.seed}`]), `candidates: ${candidates.length}`, "---"];
  const lines = [...front, `# Run ${runId} proposes ${candidates.length} candidate(s)${untrusted ? " (untrusted)" : ""}`, ""];
  candidates.forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.type}${c.id === undefined ? "" : ` ${c.id}`}`, "", c.text, "");
    if (c.evidence.length) lines.push("Evidence:", ...c.evidence.map((item) => `- ${item}`), "");
  });
  const exact = candidates.map(({ callId, type, text, evidence, id }) => ({ callId, type, text, evidence, ...(id === undefined ? {} : { id }), untrusted }));
  lines.push(FENCE, JSON.stringify(exact), "~~~", "");
  return lines.join("\n");
}

/** A candidate as the inbox holds it. */
export type InboxCandidate = Candidate & { readonly untrusted: boolean };

/** `seed` is absent when the run was not seeded. */
export type Inbox = { readonly run: string; readonly seed?: string; readonly candidates: readonly InboxCandidate[] };

/** Reads an inbox back from its last fenced block, so text in a candidate cannot stand in for the block. */
export function parseInbox(text: string): Inbox {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  const front = lines[0] === "---" && end > 0 ? lines.slice(1, end) : [];
  const field = (key: string) => front.find((line) => line.startsWith(`${key}: `))?.slice(key.length + 2);
  const run = field("run");
  if (run === undefined || run === "") throw new InboxFormatError("the inbox has no run in its front matter");
  const seed = field("seed");
  if (seed !== undefined && !COMMIT_SHA.test(seed)) throw new InboxFormatError("the seed in the front matter is not a commit id");
  const at = lines.lastIndexOf(FENCE);
  if (at < 0 || lines[at + 2] !== "~~~") throw new InboxFormatError("the inbox has no candidates block");
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[at + 1]!);
  } catch {
    throw new InboxFormatError("the candidates block is not JSON");
  }
  if (!Array.isArray(parsed)) throw new InboxFormatError("the candidates block is not a list");
  const candidates = parsed.map((entry: unknown, i): InboxCandidate => {
    const c = entry as Record<string, unknown> | null;
    const evidence = c?.evidence;
    if (
      c === null || typeof c !== "object" || typeof c.callId !== "string" || !LEARN_TYPES.includes(c.type as never) || typeof c.text !== "string" ||
      !Array.isArray(evidence) || evidence.some((item) => typeof item !== "string") || (c.id !== undefined && typeof c.id !== "string") || (c.untrusted !== undefined && typeof c.untrusted !== "boolean")
    ) {
      throw new InboxFormatError(`candidate ${i} is not a candidate`);
    }
    return { callId: c.callId, type: c.type as Candidate["type"], text: c.text, evidence: evidence as string[], ...(c.id === undefined ? {} : { id: c.id as string }), untrusted: c.untrusted === true };
  });
  return { run, ...(seed === undefined ? {} : { seed }), candidates };
}
