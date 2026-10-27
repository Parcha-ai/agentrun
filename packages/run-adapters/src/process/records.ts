// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/records.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: imports from AgentRun's kernel; message prefixes.
import type { EffectRecord, SessionState } from '../kernel/index.js';

/**
 * The shape of a process harness's records in the run's log, and the pure
 * readers for it. No Node imports: UIs (the demo's transcript, in a browser
 * tab) read sessions with this module.
 *
 * A process harness mirrors its native session state (Claude Code's JSONL
 * transcript, Codex's rollout, OpenCode's events) into the
 * log as **journal batches**: record-only effects named `journal`, keyed
 * `journal:<n>`, each carrying the records appended since the last batch,
 * grouped by stream. The kernel's rules make the batches linear: the first
 * committed step per key wins, a stale driver's step is fenced, and a batch
 * counts only once its outcome is committed. Every reader, the writer
 * included, sees the same records in the same order.
 *
 * Next to its native streams, every process harness writes one normalized
 * stream, `transcript` (`TranscriptEntry`), so one view renders any of them.
 */

/** The effect name of every journal batch (`step//harness-world//journal` in dashboards). */
export const JOURNAL = 'journal';
/** The normalized transcript's stream name. */
export const TRANSCRIPT = 'transcript';
/** The memo key of batch `n`. */
export const journalKey = (n: number) => `${JOURNAL}:${n}`;

/**
 * One record as a batch stores it: its JSON value inline (`data`), or, when
 * it is large, the SHA-256 of its JSON text (`blob`), whose bytes are in the
 * session's blob stream (see `NativeJournal`).
 */
export interface StoredEntry {
  /** The harness's own id for the record, if it has one (dedupe). */
  id?: string;
  data?: unknown;
  blob?: string;
  /** Length of the offloaded JSON text. */
  bytes?: number;
}

/** A `journal` effect's input. */
export interface JournalBatch {
  v: 1;
  /** This batch's number: it is the `n`-th accepted batch of the session. */
  n: number;
  /** Records per stream, with the stream position of the first. */
  streams: Record<string, { from: number; entries: StoredEntry[] }>;
}

/** A record read back from the log. */
export interface JournalRecord<T = unknown> {
  stream: string;
  /** 0-based position in its stream. */
  seq: number;
  id?: string;
  /** The record. `undefined` for an offloaded one read here; `NativeJournal.read` resolves blobs. */
  data: T;
  blob?: string;
  /** The batch it arrived in. */
  batch: number;
  stepId: string;
  /** The batch's index in `SessionState.effectOrder` (to relate records to other effects). */
  at: number;
}

/** A tool call an assistant message made. Its effect is `tool:<id>` (see `toolBridge`). */
export interface TranscriptToolCall {
  id: string;
  name: string;
}

/**
 * The normalized transcript. User prompts are not here: they appear through
 * the submissions the harness placed (`placeSubmissions`). What is here:
 *
 * - `message` / `assistant`: the model's text, and the tool calls it made
 *   (their inputs and results are the tool effects themselves);
 * - `message` / `user` with `synthetic`: a message the harness sent itself,
 *   such as a recovery note;
 * - `turn`: a turn boundary. A turn is open from the first placement after
 *   the last `turn` entry until the next one.
 */
export type TranscriptEntry =
  | { type: 'message'; role: 'assistant'; text: string; toolCalls?: TranscriptToolCall[] }
  | { type: 'message'; role: 'user'; text: string; synthetic: string }
  | { type: 'turn'; status: 'completed' | 'failed' | 'interrupted'; error?: string };

export interface BatchRef {
  batch: JournalBatch;
  record: EffectRecord;
  /** Index in `effectOrder`. */
  at: number;
}

/**
 * The accepted batches, in order: `journal:0`, `journal:1`, ... up to the
 * first that has no committed outcome. A batch whose intent landed but whose
 * outcome did not (its writer died between the two writes) does not count;
 * the next writer reuses its key.
 */
export function journalBatches(state: SessionState): BatchRef[] {
  const index = new Map<EffectRecord, number>();
  state.effectOrder.forEach((r, i) => index.set(r, i));
  const out: BatchRef[] = [];
  for (let n = 0; ; n++) {
    const record = state.effects.get(journalKey(n));
    if (!record || record.status !== 'completed' || record.name !== JOURNAL) break;
    out.push({ batch: record.input as JournalBatch, record, at: index.get(record) ?? -1 });
  }
  return out;
}

/** Every record of `stream` (or of every stream), in log order. Offloaded records have `data: undefined`. */
export function journalRecords<T = unknown>(state: SessionState, stream?: string): JournalRecord<T>[] {
  const out: JournalRecord<T>[] = [];
  const seqs = new Map<string, number>();
  for (const { batch, record, at } of journalBatches(state)) {
    for (const [name, part] of Object.entries(batch.streams ?? {})) {
      if (stream !== undefined && name !== stream) continue;
      for (const entry of part.entries) {
        const seq = seqs.get(name) ?? 0;
        seqs.set(name, seq + 1);
        out.push({
          stream: name,
          seq,
          ...(entry.id !== undefined ? { id: entry.id } : {}),
          data: entry.data as T,
          ...(entry.blob ? { blob: entry.blob } : {}),
          batch: batch.n,
          stepId: record.stepId,
          at,
        });
      }
    }
  }
  return out;
}

/** The normalized transcript, in log order. */
export function transcriptOf(state: SessionState): JournalRecord<TranscriptEntry>[] {
  return journalRecords<TranscriptEntry>(state, TRANSCRIPT);
}

/**
 * The `effectOrder` index of the last `unavailable` fact (harness-world's
 * `lastUnavailable`, spelled here so this module stays type-only on the
 * kernel), or -1.
 */
function lastUnavailable(state: SessionState): number {
  for (let i = state.effectOrder.length - 1; i >= 0; i--) if (state.effectOrder[i]!.name === 'unavailable') return i;
  return -1;
}

/**
 * Where the last turn ended: the `effectOrder` index of the batch holding
 * the last `turn` entry, or of the last `unavailable` fact (a turn the
 * harness could not run: it is over, with an error, and nothing in it is
 * recovered), or -1 if no turn has ended yet. Everything after it belongs to
 * the current (or an interrupted) turn.
 */
export function lastTurnEnd(state: SessionState): number {
  let at = -1;
  for (const r of transcriptOf(state)) if (r.data?.type === 'turn') at = r.at;
  return Math.max(at, lastUnavailable(state));
}

/**
 * A batch input for UIs: the transcript entries as they are, every other
 * stream as a count (native records can be large, and a page polling a
 * session should not carry them).
 */
export function summarizeBatch(input: unknown): unknown {
  const batch = input as JournalBatch | undefined;
  if (!batch || typeof batch !== 'object' || !batch.streams) return input;
  const streams: Record<string, unknown> = {};
  for (const [name, part] of Object.entries(batch.streams)) {
    streams[name] =
      name === TRANSCRIPT
        ? part
        : {
            from: part.from,
            count: part.entries.length,
            blobs: part.entries.filter((e) => e.blob).length,
          };
  }
  return { v: batch.v, n: batch.n, streams };
}

/** The transcript entries of one batch input (inline only; transcript entries are never offloaded). */
export function batchTranscript(input: unknown): TranscriptEntry[] {
  const part = (input as JournalBatch | undefined)?.streams?.[TRANSCRIPT];
  return (part?.entries ?? []).map((e) => e.data as TranscriptEntry).filter(Boolean);
}

export interface OpenTurn {
  /** `effectOrder` index of the batch that ended the previous turn (-1: none ended yet). */
  since: number;
  /** Submissions placed in this turn. */
  placed: string[];
  /** Tool calls made in it. */
  calls: EffectRecord[];
  /** Transcript entries written in it (assistant text, earlier recovery notes). */
  entries: JournalRecord<TranscriptEntry>[];
}

/**
 * The turn that has not ended: everything after the last `turn` entry of
 * the transcript. `undefined` when the last turn ended and nothing happened
 * since (nothing to recover; new submissions start a new turn as usual).
 */
export function openTurn(state: SessionState): OpenTurn | undefined {
  const transcript = transcriptOf(state);
  const end = transcript.findLast((r) => r.data?.type === 'turn');
  const failed = lastUnavailable(state);
  const since = Math.max(end?.at ?? -1, failed);
  const after = state.effectOrder.slice(since + 1);
  // A crash drill's own step places its chaos submission: that is not a turn.
  const placed = after.filter((e) => e.placed.length > 0 && !e.name.startsWith('tool.') && e.name !== 'chaos').flatMap((e) => e.placed);
  const calls = after.filter((e) => e.name.startsWith('tool.'));
  const entries = transcript.filter((r) => (end ? r.seq > end.seq : true) && r.at > failed);
  if (placed.length === 0 && calls.length === 0 && entries.length === 0) return undefined;
  return { since, placed, calls, entries };
}
