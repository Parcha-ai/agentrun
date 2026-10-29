// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-process/src/journal.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: imports from AgentRun's kernel; blobs are kept in the session's own records; message prefixes; the fence comment names the session writer's fence.
import { randomUUID } from 'node:crypto';
import { BLOB_PIECE_CHARS, blobStreamName, type DriveContext, Fatal, readBlobs, Restart, sha256Hex, writeBlob } from '../kernel/index.js';
import {
  JOURNAL,
  type JournalBatch,
  type JournalRecord,
  journalBatches,
  journalKey,
  journalRecords,
  type StoredEntry,
  TRANSCRIPT,
  type TranscriptEntry,
} from './records.js';

/**
 * Records longer than this (as JSON text) go to the blob stream instead of
 * the log. The log is folded whole on every cold drive and polled by every
 * viewer, so it should stay lean. The World's own limit is far higher (see
 * the README, "Payload limits").
 */
export const DEFAULT_INLINE_MAX_BYTES = 32 * 1024;

/**
 * The session's blob stream (harness-world's `blobs.ts`): content-addressed,
 * append-only, one line per blob (or per piece of one). Shared with the
 * document-backed workspace, which keeps its large files there.
 */
export { blobStreamName, readBlobs };

export interface NativeJournalOptions {
  /** Offload records whose JSON text is longer than this. Default `DEFAULT_INLINE_MAX_BYTES`. */
  inlineMaxBytes?: number;
  /**
   * Called once, with the error, when a batch write fails or is refused.
   * Default: `ctx.halt(err)`, which stops the drive (and so kills the child
   * a `ProcessHost` spawned with `ctx.signal`).
   */
  onPoison?: (err: unknown) => void;
  /** Characters per blob chunk. Default 2M. */
  blobPieceChars?: number;
}

interface Queued {
  stream: string;
  seq: number;
  id?: string;
  data: unknown;
}

const encoder = new TextEncoder();

/**
 * The writer (and reader) of a process harness's native journal, for one drive.
 *
 * `append` queues a record; the journal keeps one batch in flight and
 * commits everything queued behind it as the next batch (group commit), one
 * record-only effect `journal:<n>` per batch. `flush()` is the barrier: it
 * resolves once every record appended before it is committed. Call it before
 * a `replay: 'never'` tool runs (the tool bridge's `beforeNever`) and at the
 * end of a turn.
 *
 * Under run-ahead durability (`DriverOptions.runAhead`) a batch is issued,
 * not yet durable, when its effect returns; the kernel waits for it at its
 * own barriers (before a `never` effect, before the drive goes idle), so
 * `flush()` before a `never` tool still means "in the log before the tool".
 *
 * The journal's writes are in-band writes of the drive: they go through
 * `ctx.effect`, so the writer fence (once a newer drive opens the session,
 * this drive's writes are refused: a `Restart`), first-writer-wins per key and the
 * outcome rules apply. A failed or refused write poisons the journal
 * (`append` becomes a no-op, `flush` rejects) and halts the drive. So does a
 * batch number another writer took first (two drives of one session, the
 * other's batch already in this drive's fold, where `ctx.effect` would hand
 * back its result as if it were this batch's): that is a `Restart`, and the
 * drive rebuilds from the log instead of losing the batch's records.
 */
export class NativeJournal {
  private readonly inlineMax: number;
  private readonly onPoison: (err: unknown) => void;
  private readonly pieceChars: number;
  /** The next batch number. */
  private n: number;
  /** Next position per stream (log plus queue). */
  private readonly next = new Map<string, number>();
  /** Record ids in the log or queued. */
  private readonly ids = new Set<string>();
  /** Blobs known to be in the blob stream. */
  private readonly blobs = new Set<string>();
  private queue: Queued[] = [];
  private inflight: Promise<void> | undefined;
  private appended = 0;
  private written = 0;
  private waiters: { target: number; resolve: () => void; reject: (err: unknown) => void }[] = [];
  private failure: { err: unknown } | undefined;
  /** This writer, in each batch's output: a batch is this journal's only if it says so. */
  private readonly writer = randomUUID();

  constructor(
    private readonly ctx: DriveContext,
    options: NativeJournalOptions = {}
  ) {
    this.inlineMax = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;
    this.onPoison = options.onPoison ?? ((err) => ctx.halt?.(err));
    this.pieceChars = options.blobPieceChars ?? BLOB_PIECE_CHARS;
    const state = ctx.state();
    this.n = journalBatches(state).length;
    for (const r of journalRecords(state)) {
      this.next.set(r.stream, r.seq + 1);
      if (r.id !== undefined) this.ids.add(r.id);
      if (r.blob) this.blobs.add(r.blob);
    }
  }

  /** The error that poisoned this journal, if one did. */
  get poisoned(): unknown {
    return this.failure?.err;
  }

  /** How many records `stream` has (committed plus queued). */
  length(stream: string): number {
    return this.next.get(stream) ?? 0;
  }

  /** Whether a record with this id is in the log or queued. */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  /**
   * Queue a record (a JSON value) on `stream`. Returns `false` when it was
   * not queued: a record with the same `id` is already in the log or queued
   * (dedupe), or the journal is poisoned.
   */
  append(stream: string, data: unknown, options: { id?: string } = {}): boolean {
    if (this.failure) return false;
    if (options.id !== undefined) {
      if (this.ids.has(options.id)) return false;
      this.ids.add(options.id);
    }
    const seq = this.next.get(stream) ?? 0;
    this.next.set(stream, seq + 1);
    this.queue.push({ stream, seq, data, ...(options.id !== undefined ? { id: options.id } : {}) });
    this.appended++;
    this.pump();
    return true;
  }

  /** Append an entry to the normalized transcript. */
  message(entry: TranscriptEntry): boolean {
    return this.append(TRANSCRIPT, entry);
  }

  /** Resolves once every record appended so far is committed; rejects if the journal is poisoned. */
  flush(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure.err);
    if (this.written >= this.appended) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ target: this.appended, resolve, reject }));
  }

  /** The records of `stream` (or every stream) in the log, in order. Offloaded ones have `data: undefined`. */
  records<T = unknown>(stream?: string): JournalRecord<T>[] {
    return journalRecords<T>(this.ctx.state(), stream);
  }

  /** The same records with their blobs read back from the blob stream and checked against their hashes. */
  read<T = unknown>(stream?: string): Promise<JournalRecord<T>[]> {
    return readJournal<T>(this.ctx, stream);
  }

  private pump(): void {
    if (this.inflight) return;
    this.inflight = (async () => {
      // Let a synchronous burst of appends ride in one batch.
      await Promise.resolve();
      while (this.queue.length > 0 && !this.failure) {
        const batch = this.queue;
        this.queue = [];
        try {
          await this.write(batch);
        } catch (err) {
          this.poison(err);
          return;
        }
        this.written += batch.length;
        this.settleWaiters();
      }
    })().finally(() => {
      this.inflight = undefined;
      if (this.queue.length > 0 && !this.failure) this.pump();
    });
  }

  private settleWaiters(): void {
    const still: typeof this.waiters = [];
    for (const w of this.waiters) {
      if (this.written >= w.target) w.resolve();
      else still.push(w);
    }
    this.waiters = still;
  }

  private poison(err: unknown): void {
    if (this.failure) return;
    this.failure = { err };
    this.queue = [];
    for (const w of this.waiters.splice(0)) w.reject(err);
    this.onPoison(err);
  }

  private async write(queued: Queued[]): Promise<void> {
    const streams: JournalBatch['streams'] = {};
    for (const q of queued) {
      const part = (streams[q.stream] ??= { from: q.seq, entries: [] });
      part.entries.push(await this.store(q));
    }
    const n = this.n;
    const batch: JournalBatch = { v: 1, n, streams };
    const writer = this.writer;
    const out = await this.ctx.effect(journalKey(n), { name: JOURNAL, replay: 'safe', input: batch }, async () => ({ n, records: queued.length, writer }));
    if ((out as { writer?: unknown } | undefined)?.writer !== writer) throw new Restart(`agentrun-kernel: journal batch ${n} was written by another drive`);
    this.n = n + 1;
  }

  /** A record as the batch stores it: inline, or offloaded to the blob stream (written before the batch). */
  private async store(q: Queued): Promise<StoredEntry> {
    const id = q.id !== undefined ? { id: q.id } : {};
    // The transcript is what UIs read from the fold: it always stays inline.
    if (q.stream === TRANSCRIPT) return { ...id, data: q.data };
    const text = JSON.stringify(q.data);
    if (text === undefined) throw new TypeError(`agentrun-kernel: journal record on ${q.stream} is not JSON`);
    const bytes = encoder.encode(text).length;
    if (bytes <= this.inlineMax) return { ...id, data: q.data };
    const hash = await sha256Hex(text);
    if (!this.blobs.has(hash)) {
      await writeBlob(this.ctx.world, this.ctx.runId, text, { hash, pieceChars: this.pieceChars });
      this.blobs.add(hash);
    }
    return { ...id, blob: hash, bytes };
  }
}

/**
 * Read a session's journal with offloaded records resolved: the blob stream
 * is read once and every blob is checked against its hash. A blob the log
 * names but the stream does not hold is `Fatal` (the batch commits only
 * after its blobs are written, so the session cannot continue); a read that
 * fails is thrown as it is (the delivery is retried).
 */
export async function readJournal<T = unknown>(
  ctx: Pick<DriveContext, 'world' | 'runId' | 'state'>,
  stream?: string
): Promise<JournalRecord<T>[]> {
  const records = journalRecords<T>(ctx.state(), stream);
  if (!records.some((r) => r.blob)) return records;
  const blobs = await readBlobs(ctx.world, ctx.runId);
  return records.map((r) => {
    if (!r.blob) return r;
    const text = blobs.get(r.blob);
    if (text === undefined) throw new Fatal(`agentrun-kernel: journal blob ${r.blob} (${r.stream} #${r.seq}) is missing from ${blobStreamName(ctx.runId)}`);
    return { ...r, data: JSON.parse(text) as T };
  });
}
