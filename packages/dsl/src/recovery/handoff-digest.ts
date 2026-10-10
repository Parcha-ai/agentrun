import fs from "node:fs";
import path from "node:path";
import { redactSensitiveValue, redactText } from "./handoff-redact.js";
import { HANDOFF_FILES_DIR } from "./handoff-files.js";
import { boundedValue } from "./handoff-block.js";

// What a continuation receives beyond the escalation row: every fact comes from the journal and the step sessions'
// transcripts, so a resumed continuation rebuilds the same digest from the same bytes. Each section has its own budget
// and the assembled text is never sliced, so the closing instruction is always present.

/** One step's transcript message, as a host's reader returns it. */
export type TranscriptMessage = { role: "user" | "assistant" | "toolResult"; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; stopReason?: string };

export const DIGEST_STEP_LIMIT = 3 * 1024;
export const DIGEST_LIMIT = 24 * 1024;
const DIGEST_ARGS_LIMIT = 240;
const DIGEST_RESULT_LIMIT = 160;
const DIGEST_TEXT_LIMIT = 600;
const DIGEST_LIST_LIMIT = 40;

/** A step's spend: `usd` is a floor when `state` is `partial` and unknown when null; a spend recorded without a state
 *  (a recorded trace's `session.spent` row) is complete. */
export type InheritedSession = { id: string; role: string; state: string; file: string | null; spend?: { usd: number | null; turns: number; state?: "complete" | "partial" | "unavailable"; toolCalls?: number } };
const spendText = (spend: NonNullable<InheritedSession["spend"]>): string =>
  spend.usd === null ? "cost unknown" : spend.state === "partial" ? `at least $${spend.usd.toFixed(4)}, some cost unknown` : `$${spend.usd.toFixed(4)}`;
export type InheritedEffect = { id: string; name: string; status: string; session?: string | null; result?: unknown };

export type InheritedJob = {
  runId: string;
  /** A step's transcript by its session id (the run's durable file holds them), or null when there is none. */
  transcriptOf: (sessionId: string) => readonly TranscriptMessage[] | null;
  cwd: string;
  evidenceDir?: string | null;
  sessions: InheritedSession[];
  effects: InheritedEffect[];
  /** Workspace-relative produced files with the sha256 the driver committed for them. */
  files: Record<string, string>;
  /** The file writeFrozenEvidence wrote each effect's whole receipt to, by effect id. */
  effectFiles?: Record<string, string>;
};

/** The label a step's identity carries, distinct for every session the frozen driver admits. A step's
 *  session is `<run>:<label>:<step|adapt>:<execution path>:a<attempt>` (the label as the
 *  interpreter names the node: a child's step `invocation/step`, a plan's `adapt:<gate>/step`, and a
 *  label may hold colons), read as the label with each map item index its path runs under as `[k]` and
 *  each loop iteration as `#k`. */
export function stepLabelOf(runId: string, sessionId: string): string | null {
  if (!sessionId.startsWith(`${runId}:`)) return null;
  const match = /^(.+):(?:step|adapt):(\/root(?:\/.*)?):a\d+$/.exec(sessionId.slice(runId.length + 1));
  if (!match) return null;
  const [, label, at] = match;
  const marks = [...at.matchAll(/\/(items|iterations)\/(\d+)\/body(?=\/|$)/g)].map(([, kind, index]) => kind === "items" ? `[${index}]` : `#${index}`);
  return `${label}${marks.join("")}`;
}

const oneLine = (value: unknown, limit: number) => {
  const safe = redactSensitiveValue(value);
  const text = typeof safe === "string" ? safe : JSON.stringify(safe);
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}<${flat.length - limit} more chars>` : flat;
};

const textOf = (content: unknown): string => Array.isArray(content)
  ? content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n")
  : typeof content === "string" ? content : "";

/** One completed LLM step, from its transcript (`transcriptOf`): what it was asked, what it called, what it concluded and
 *  what it submitted. Bounded per step; a step whose transcript is absent or unreadable says so. */
export function stepDigest(runId: string, session: InheritedSession, transcriptOf: (sessionId: string) => readonly TranscriptMessage[] | null): string {
  const label = stepLabelOf(runId, session.id) ?? session.id;
  const head = `### Step \`${label}\` (${session.state}${session.spend ? `, ${session.spend.turns} turn${session.spend.turns === 1 ? "" : "s"}, ${spendText(session.spend)}` : ""})`;
  let messages: readonly any[] | null;
  try { messages = transcriptOf(session.id); }
  catch { return `${head}\n- transcript unreadable`; }
  if (!messages) return `${head}\n- transcript unavailable`;
  const lines: string[] = [head];
  const firstUser = messages.find(m => m.role === "user");
  if (firstUser) lines.push(`- asked: ${oneLine(textOf(firstUser.content), DIGEST_TEXT_LIMIT)}`);
  const results = new Map<string, any>();
  for (const m of messages) if (m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
  let submission: unknown;
  let lastText = "";
  const calls: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block?.type === "toolCall") {
        if (block.name === "submit") { submission = block.arguments; continue; }
        const result = results.get(block.id);
        const outcome = result ? (result.isError ? "error" : "ok") + (textOf(result.content) ? `: ${oneLine(textOf(result.content), DIGEST_RESULT_LIMIT)}` : "") : "no result";
        calls.push(`- called ${block.name}(${oneLine(block.arguments ?? {}, DIGEST_ARGS_LIMIT)}) → ${outcome}`);
      } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) lastText = block.text;
    }
  }
  const callLines = calls.length > DIGEST_LIST_LIMIT ? [...calls.slice(0, DIGEST_LIST_LIMIT), `- …${calls.length - DIGEST_LIST_LIMIT} more calls`] : calls;
  lines.push(...callLines);
  // Only what the step said and did crosses the boundary; its private reasoning never does.
  if (lastText) lines.push(`- concluded: ${oneLine(lastText, DIGEST_TEXT_LIMIT)}`);
  else lines.push("- ended without a text conclusion");
  if (submission !== undefined) lines.push(`- submitted: ${oneLine(boundedValue(submission), DIGEST_TEXT_LIMIT * 2)}`);
  // The step's own budget: whole lines, then a count. The head is never dropped.
  const kept: string[] = [lines[0]];
  let used = lines[0].length;
  for (const line of lines.slice(1)) {
    if (used + line.length + 1 > DIGEST_STEP_LIMIT) { kept.push(`- …${lines.length - kept.length} more lines omitted`); break; }
    kept.push(line);
    used += line.length + 1;
  }
  return redactText(kept.join("\n"));
}

const listDir = (dir: string, limit: number, skip: ReadonlySet<string> = new Set()): string[] => {
  if (!dir || !fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      const full = path.join(current, entry.name);
      if (skip.has(`${prefix}${entry.name}`)) continue;
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else { let size = 0; try { size = fs.statSync(full).size; } catch { /* listed without size */ } out.push(`- ${redactText(`${prefix}${entry.name}`)} (${size} bytes)`); }
    }
  };
  walk(dir, "");
  return out;
};

/** The digest the continuation reads after the escalation block: the completed
 *  LLM steps' transcripts, the evidence gathered, the files produced with their receipts, and the
 *  one rule that this is a continuation. Deterministic for a given ledger and workspace. */
export function inheritedJobDigest(job: InheritedJob): string {
  const steps = job.sessions
    .filter(s => s.role === "step" && stepLabelOf(job.runId, s.id))
    .map(s => stepDigest(job.runId, s, job.transcriptOf));
  // The frozen attempt's own files are listed by the escalation block; this lists what the steps gathered.
  const evidence = job.evidenceDir ? listDir(job.evidenceDir, DIGEST_LIST_LIMIT, new Set([path.posix.basename(HANDOFF_FILES_DIR)])) : [];
  const effectsBy = new Map(job.effects.filter(e => e.status === "completed").map(e => [e.id, e]));
  const fileEntries = Object.entries(job.files).sort(([a], [b]) => a.localeCompare(b));
  const files = fileEntries.slice(0, DIGEST_LIST_LIMIT).map(([file, sha]) => {
    let size: number | null = null;
    try { size = fs.statSync(path.join(job.cwd, file)).size; } catch { /* the receipt still names it */ }
    return `- ${redactText(file)}${size === null ? " (missing on disk)" : ` (${size} bytes)`} sha256 ${sha.slice(0, 12)}`;
  });
  if (fileEntries.length > DIGEST_LIST_LIMIT) files.push(`- …${fileEntries.length - DIGEST_LIST_LIMIT} more`);
  const paid = [...effectsBy.values()].filter(e => e.name !== "submit" && !["read", "write", "edit", "grep", "find", "bash"].includes(e.name));
  const header = ["## THE JOB AS IT STANDS (inherited from the frozen attempt)", ""];
  const footer = ["", "You are continuing this job, not restarting it. Everything listed above is done and paid for: use it, do not redo it, and cite it (step labels, file names) when you explain what you did."];
  const effectLine = (e: InheritedEffect) => `- ${e.name} [${e.id}] completed${e.result === undefined ? "" : ` → ${oneLine(e.result, DIGEST_RESULT_LIMIT)}`}${job.effectFiles?.[e.id] ? ` (whole: ${job.effectFiles[e.id]})` : ""}`;
  // Display order: steps, effects, files, evidence. Budget order: the cheap ledger facts first, the
  // transcripts take what is left. A section that does not fit keeps its heading and as many whole
  // lines as fit, then a count.
  const sections: Record<string, string[]> = {
    steps: ["### LLM steps run so far (their transcripts, bounded; a step that did not submit shows how it ended)", ...(steps.length ? steps : ["- none"])],
    effects: [`### Paid effects already made (${paid.length})`,
      ...(paid.length ? ["These tool calls already ran; their results are previewed below, whole in the file each line names, and in the state above. Calling the same tool again buys the same answer twice.", ...paid.slice(0, DIGEST_LIST_LIMIT).map(effectLine)] : ["- none"]),
      ...(paid.length > DIGEST_LIST_LIMIT ? [`- …${paid.length - DIGEST_LIST_LIMIT} more`] : [])],
    files: ["### Files produced in the workspace (with the driver's receipts)", ...(files.length ? files : ["- none"])],
    evidence: [`### Evidence directory${job.evidenceDir ? ` (\`${job.evidenceDir}\`)` : ""}`, ...(evidence.length ? evidence : ["- empty"])],
  };
  let budget = DIGEST_LIMIT - [...header, ...footer].join("\n").length;
  const rendered: Record<string, string> = {};
  for (const name of ["effects", "files", "evidence", "steps"]) {
    const section = sections[name];
    const text = section.join("\n");
    if (text.length + 2 <= budget) { rendered[name] = text; budget -= text.length + 2; continue; }
    const kept: string[] = [section[0]];
    let used = section[0].length;
    for (const line of section.slice(1)) {
      if (used + line.length + 1 > budget - 48) break;
      kept.push(line);
      used += line.length + 1;
    }
    if (kept.length < section.length) kept.push(`- …${section.length - kept.length} more entries omitted`);
    rendered[name] = kept.join("\n");
    budget -= rendered[name].length + 2;
  }
  const body = ["steps", "effects", "files", "evidence"].flatMap(name => [rendered[name], ""]);
  return redactText([...header, ...body, ...footer].join("\n"));
}
