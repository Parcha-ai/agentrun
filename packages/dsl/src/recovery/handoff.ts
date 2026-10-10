import fs from "node:fs/promises";
import path from "node:path";
import { escalationContextBlock } from "./handoff-block.js";
import { inheritedJobDigest, type InheritedSession, type TranscriptMessage } from "./handoff-digest.js";
import { HANDOFF_FILES_DIR, inputProvenance, writeHandoffFiles } from "./handoff-files.js";
import { inheritableReceipts, inheritableUnknowns, type InheritedReceipt, type InheritedUnknown } from "./handoff-receipts.js";
import type { EscalationRow, FrozenSnapshot } from "./frozen-snapshot.js";
import type { RecoveryJournal } from "./store.js";

/** What a continuation inherits from a run that escalated. The package returns it; the host decides who continues. */
export type Handoff = {
  /** What happened, the typed state, inputs and spend: bounded and redacted. */
  block: string;
  /** Each LLM step's transcript, each paid effect and result, files and evidence; null when it could not be built. */
  digest: string | null;
  /** The attempt written as files under the workspace, relative paths, sorted. */
  files: string[];
  /** Completed tool effects, keyed by tool and argument hash. */
  receipts: InheritedReceipt[];
  /** Effects the continuation must not send again. */
  unknown: InheritedUnknown[];
  /** Why the attempt files could not be written, when they could not: the block then points at files that are not there. */
  filesError?: string;
  /** Why the digest is null, when it is. */
  digestError?: string;
};

export type HandoffOptions = {
  /** The run's workspace: the attempt's files are written under it. */
  cwd: string;
  /** The run's identity as its step sessions are named (`<run>:<label>:step:...`). */
  runId: string;
  /** The input the run started from, as the dispatch carried it. */
  input?: unknown;
  /** Where the attempt's report was moved to, when the host set one aside. */
  reportPath?: string | null;
  /** The host's sizes for the continuation. */
  budget?: { max_tool_calls?: number; max_seconds?: number } | null;
  /** The run's step sessions with their spend, from the host's own record of them. */
  sessions?: readonly InheritedSession[];
  /** A step's transcript by its session id, or null when there is none. */
  transcriptOf?: (sessionId: string) => readonly TranscriptMessage[] | null;
};

/** The one place a handoff is built: the escalation row and effects of an open journal, rendered as the continuation's
 *  first turn. The row must be one the driver committed. Deterministic for a journal and a workspace. */
export async function buildHandoff(journal: Pick<RecoveryJournal, "state" | "effects">, options: HandoffOptions): Promise<Handoff> {
  const snapshot = journal.state as FrozenSnapshot | null;
  const row: EscalationRow | undefined = snapshot?.escalation;
  if (!row) throw new Error("A handoff is built from an escalation the driver committed");
  const effects = journal.effects();
  const routes = snapshot?.pin?.routes && typeof snapshot.pin.routes === "object" && !Array.isArray(snapshot.pin.routes) ? { ...snapshot.pin.routes } : {};
  let files: string[] = [];
  let effectFiles: Record<string, string> = {};
  let filesError: string | undefined;
  try { ({ files, effectFiles } = await writeHandoffFiles(options.cwd, row, { effects, routes }, options.input)); }
  catch (error) { filesError = String((error as Error)?.message ?? error); }
  const evidenceDir = path.join(options.cwd, "evidence");
  const gathered = await fs.readdir(evidenceDir).then((names) => names.some((name) => name !== path.basename(HANDOFF_FILES_DIR)), () => false);
  const evidence = gathered ? (row.evidence_dir ?? evidenceDir) : null;
  const block = escalationContextBlock({ ...row, evidence_dir: evidence, report_path: options.reportPath ?? null, files,
    inputs: options.input === undefined ? [] : inputProvenance(options.input), budget: options.budget ?? null });
  let digest: string | null = null;
  let digestError: string | undefined;
  try {
    digest = inheritedJobDigest({
      runId: options.runId, transcriptOf: options.transcriptOf ?? (() => null), cwd: options.cwd, evidenceDir: evidence,
      sessions: [...(options.sessions ?? [])],
      effects: effects.map((e) => ({ id: e.id, name: e.name, status: e.status, ...(e.status === "completed" ? { result: e.result } : {}) })),
      files: snapshot?.files && typeof snapshot.files === "object" ? snapshot.files : {}, effectFiles,
    });
  } catch (error) { digestError = `digest unavailable: ${String((error as Error)?.message ?? error)}`; }
  return { block, digest, files, receipts: inheritableReceipts(effects), unknown: inheritableUnknowns(effects), ...(filesError ? { filesError } : {}), ...(digestError && digest === null ? { digestError } : {}) };
}

/** The continuation's first turn: the escalation block, then the digest. Deterministic from its inputs. */
export const handoffFirstTurn = (handoff: Pick<Handoff, "block" | "digest">): string => [handoff.block, handoff.digest].filter(Boolean).join("\n\n");
