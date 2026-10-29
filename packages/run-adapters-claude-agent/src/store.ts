// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-claude-code/src/store.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, imports rewritten for AgentRun
// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-claude-code/src/store.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
import type { JournalRecord, NativeJournal, TranscriptEntry } from './host/process.js';

/**
 * Claude Code's transcript, mirrored into the run's log.
 *
 * Claude Code writes its session as an append-only JSONL transcript. The
 * Agent SDK mirrors every line it writes to a `SessionStore` (`append`), and a
 * resume loads the session back from it (`load`) before the CLI starts. This
 * store is that adapter over the drive's `NativeJournal`: each entry is one
 * journal record (group-committed with everything else the drive writes),
 * deduped by the entry's `uuid`, so the transcript is a fold of the log and
 * any machine can resume it.
 *
 * The entries are opaque: their shape is CLI-internal. Two things are read
 * from them: an assistant entry's `tool_use` ids (for the barrier below), and
 * the `uuid` of a user message the drive sent (to tell whether a placed
 * prompt reached the transcript): a user entry's own `uuid`, or, for a
 * message the CLI took in mid-turn (a steer), the `source_uuid` of the
 * `queued_command` attachment it became.
 */

/** The SDK's `SessionKey` (structurally; the SDK is a peer dependency). */
export interface SessionKey {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}

/** One transcript line, as the SDK hands it over: JSON with a string `type`. */
export interface TranscriptLine {
  type: string;
  uuid?: string;
  [k: string]: unknown;
}

/** The journal stream of the main transcript. */
export const CLAUDE_STREAM = 'claude';
/** The journal stream of a subagent transcript (`subpath` like `subagents/agent-<id>`). */
export const subStream = (subpath: string) => `${CLAUDE_STREAM}/${subpath}`;
const streamOf = (key: SessionKey) => (key.subpath ? subStream(key.subpath) : CLAUDE_STREAM);

/** The `tool_use` ids an assistant entry carries. */
export function toolUseIds(entry: TranscriptLine | undefined): string[] {
  if (entry?.type !== 'assistant') return [];
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c?.type === 'tool_use' && typeof c.id === 'string').map((c) => c.id as string);
}

/** The `tool_use_id`s a user entry answers (its `tool_result` blocks). */
export function toolResultIds(entry: TranscriptLine | undefined): string[] {
  if (entry?.type !== 'user') return [];
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c?.type === 'tool_result' && typeof c.tool_use_id === 'string').map((c) => c.tool_use_id as string);
}

export interface JournalSessionStoreOptions {
  /** The journal's records as of the drive's start, blobs resolved (`journal.read()`). */
  records: JournalRecord[];
  /**
   * Hold appended entries this long before they go to the journal, so the
   * SDK's frames (one `append` per line with eager flushing) ride in fewer
   * batches. `barrier` and `flush` send them at once. Default 0.
   */
  coalesceMs?: number;
}

/**
 * A `SessionStore` (the SDK's `@alpha` mirror interface) whose storage is the
 * drive's journal.
 *
 * - `append` queues the entries on the journal and returns: the journal is
 *   the durable writer (one batch in flight, the rest in the next), so the
 *   SDK's own retries and timeouts never come into play. A journal that
 *   failed has already halted the drive.
 * - `load` returns what the log holds, as of the drive's start. Every
 *   session's key is the run, so `projectKey` (the CLI's cwd, which differs
 *   from machine to machine) is ignored.
 * - `barrier(toolUseId)` resolves once the assistant entry that made that
 *   call is committed: before a `replay: 'never'` tool runs, the call that
 *   asked for it is in the log.
 */
export class JournalSessionStore {
  private readonly loaded = new Map<string, TranscriptLine[]>();
  private readonly calls = new Set<string>();
  private readonly users = new Set<string>();
  private readonly waiters = new Map<string, (() => void)[]>();
  private readonly results = new Set<string>();
  private readonly resultWaiters = new Map<string, (() => void)[]>();
  private held: ({ stream: string; entry: TranscriptLine } | { message: TranscriptEntry })[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly coalesceMs: number;
  /** Entries this drive appended (for tests and diagnostics). */
  appended = 0;

  constructor(
    private readonly journal: NativeJournal,
    options: JournalSessionStoreOptions
  ) {
    this.coalesceMs = options.coalesceMs ?? 0;
    for (const r of options.records) {
      if (r.stream !== CLAUDE_STREAM && !r.stream.startsWith(`${CLAUDE_STREAM}/`)) continue;
      const entry = r.data as TranscriptLine | undefined;
      // An offloaded entry read without its blob (`journalRecords`, not `journal.read()`): nothing to note.
      if (!entry) continue;
      const list = this.loaded.get(r.stream) ?? [];
      list.push(entry);
      this.loaded.set(r.stream, list);
      this.note(entry);
    }
  }

  /**
   * Whether the log holds a transcript to resume: one with a message in it.
   * Lines committed before a crash may be only queue operations, and the CLI
   * refuses to resume those ("No conversation found"), every time: such a
   * session starts again as a new one, under the same id.
   */
  get hasSession(): boolean {
    return (this.loaded.get(CLAUDE_STREAM) ?? []).some((e) => (e.type === 'user' || e.type === 'assistant') && !!e.uuid);
  }

  /**
   * Whether the user message sent with this `uuid` is in the transcript (the
   * log's, or appended since): as its own user entry, or as the
   * `queued_command` attachment a mid-turn message becomes.
   */
  hasUser(uuid: string): boolean {
    return this.users.has(uuid);
  }

  /** Whether an assistant entry that made this tool call is in the transcript. */
  hasCall(toolUseId: string): boolean {
    return this.calls.has(toolUseId);
  }

  async append(key: SessionKey, entries: TranscriptLine[]): Promise<void> {
    const stream = streamOf(key);
    for (const entry of entries) {
      this.held.push({ stream, entry });
      this.appended++;
      this.note(entry);
    }
    if (this.coalesceMs <= 0) this.release();
    else this.timer ??= setTimeout(() => this.release(), this.coalesceMs);
  }

  /** An entry of the normalized transcript, held and committed with the lines around it. */
  message(entry: TranscriptEntry): void {
    this.held.push({ message: entry });
    if (this.coalesceMs <= 0) this.release();
    else this.timer ??= setTimeout(() => this.release(), this.coalesceMs);
  }

  /** Everything appended so far is committed. */
  async flush(): Promise<void> {
    this.release();
    await this.journal.flush();
  }

  /** Hand the held entries to the journal (which group-commits them). */
  private release(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const item of this.held.splice(0)) {
      if ('message' in item) this.journal.message(item.message);
      // Entries without a uuid (titles, mode markers, queue operations) are appended as they come.
      else this.journal.append(item.stream, item.entry, item.entry.uuid ? { id: item.entry.uuid } : {});
    }
  }

  async load(key: SessionKey): Promise<TranscriptLine[] | null> {
    const entries = this.loaded.get(streamOf(key));
    return entries?.length ? entries : null;
  }

  async listSubkeys(_key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return [...this.loaded.keys()].filter((s) => s !== CLAUDE_STREAM).map((s) => s.slice(CLAUDE_STREAM.length + 1));
  }

  /**
   * Resolve once the assistant entry that made `toolUseId` is committed. The
   * SDK delivers an entry about 100 ms after the CLI wrote it, and the tool
   * runs right after the CLI wrote it, so this usually waits for the mirror
   * first. Rejects after `timeoutMs` (the caller does not run the tool).
   */
  async barrier(toolUseId: string, timeoutMs: number): Promise<void> {
    if (!this.calls.has(toolUseId)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const list = this.waiters.get(toolUseId)?.filter((w) => w !== done) ?? [];
          if (list.length) this.waiters.set(toolUseId, list);
          else this.waiters.delete(toolUseId);
          reject(new Error(`the transcript entry for tool call ${toolUseId} did not reach the log within ${timeoutMs} ms`));
        }, timeoutMs);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.set(toolUseId, [...(this.waiters.get(toolUseId) ?? []), done]);
      });
    }
    await this.flush();
  }

  private note(entry: TranscriptLine): void {
    if (entry.type === 'user' && entry.uuid) this.users.add(entry.uuid);
    const attachment = entry.type === 'attachment' ? (entry.attachment as { type?: unknown; source_uuid?: unknown } | undefined) : undefined;
    if (attachment?.type === 'queued_command' && typeof attachment.source_uuid === 'string') this.users.add(attachment.source_uuid);
    for (const id of toolUseIds(entry)) {
      this.calls.add(id);
      for (const w of this.waiters.get(id) ?? []) w();
      this.waiters.delete(id);
    }
    for (const id of toolResultIds(entry)) {
      this.results.add(id);
      for (const w of this.resultWaiters.get(id) ?? []) w();
      this.resultWaiters.delete(id);
    }
  }

  /**
   * Resolve once the user entry that answers `toolUseId` (its `tool_result`) is committed: a call the CLI answered
   * itself (a refusal) is told to the host only once the log holds the answer. Rejects after `timeoutMs`.
   */
  async resultBarrier(toolUseId: string, timeoutMs: number): Promise<void> {
    if (!this.results.has(toolUseId)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const list = this.resultWaiters.get(toolUseId)?.filter((w) => w !== done) ?? [];
          if (list.length) this.resultWaiters.set(toolUseId, list);
          else this.resultWaiters.delete(toolUseId);
          reject(new Error(`the transcript entry answering tool call ${toolUseId} did not reach the log within ${timeoutMs} ms`));
        }, timeoutMs);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        this.resultWaiters.set(toolUseId, [...(this.resultWaiters.get(toolUseId) ?? []), done]);
      });
    }
    await this.flush();
  }
}
