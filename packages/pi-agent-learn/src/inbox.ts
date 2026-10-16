import { type Candidate, LEARN_TYPES } from "./types.js";

/** The line before the JSON that holds the candidates exactly. A reader trusts that block and nothing above it. */
const FENCE = "~~~json candidates";

export class InboxFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxFormatError";
  }
}

/** `inbox/<run id>.md`: front matter, the candidates for a human to read, and the candidates as one JSON line. */
export function renderInbox(runId: string, candidates: readonly Candidate[]): string {
  const lines = ["---", `run: ${runId}`, `candidates: ${candidates.length}`, "---", `# Run ${runId} proposes ${candidates.length} candidate(s)`, ""];
  candidates.forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.type}${c.id === undefined ? "" : ` ${c.id}`}`, "", c.text, "");
    if (c.evidence.length) lines.push("Evidence:", ...c.evidence.map((item) => `- ${item}`), "");
  });
  const exact = candidates.map(({ callId, type, text, evidence, id, untrusted }) => ({ callId, type, text, evidence, ...(id === undefined ? {} : { id }), ...(untrusted === true ? { untrusted } : {}) }));
  lines.push(FENCE, JSON.stringify(exact), "~~~", "");
  return lines.join("\n");
}

export type Inbox = { readonly run: string; readonly candidates: readonly Candidate[] };

/** Reads an inbox back from its last fenced block, so text in a candidate cannot stand in for the block. */
export function parseInbox(text: string): Inbox {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  const run = lines[0] === "---" && end > 0 ? lines.slice(1, end).find((line) => line.startsWith("run: "))?.slice(5) : undefined;
  if (run === undefined || run === "") throw new InboxFormatError("the inbox has no run in its front matter");
  const at = lines.lastIndexOf(FENCE);
  if (at < 0 || lines[at + 2] !== "~~~") throw new InboxFormatError("the inbox has no candidates block");
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[at + 1]!);
  } catch {
    throw new InboxFormatError("the candidates block is not JSON");
  }
  if (!Array.isArray(parsed)) throw new InboxFormatError("the candidates block is not a list");
  const candidates = parsed.map((entry: unknown, i): Candidate => {
    const c = entry as Record<string, unknown> | null;
    const evidence = c?.evidence;
    if (
      c === null || typeof c !== "object" || typeof c.callId !== "string" || !LEARN_TYPES.includes(c.type as never) || typeof c.text !== "string" ||
      !Array.isArray(evidence) || evidence.some((item) => typeof item !== "string") || (c.id !== undefined && typeof c.id !== "string") ||
      (c.untrusted !== undefined && typeof c.untrusted !== "boolean")
    ) {
      throw new InboxFormatError(`candidate ${i} is not a candidate`);
    }
    return {
      callId: c.callId, type: c.type as Candidate["type"], text: c.text, evidence: evidence as string[], ...(c.id === undefined ? {} : { id: c.id as string }),
      ...(c.untrusted === true ? { untrusted: true } : {}),
    };
  });
  return { run, candidates };
}
