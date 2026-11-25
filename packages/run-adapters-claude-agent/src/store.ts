// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-claude-code/src/store.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, and AgentRun's own since the port from upstream froze on 2026-11-07.
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

/** The timers a barrier's wait runs on (the system's by default; a test passes a fake clock). */
export interface BarrierTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const SYSTEM_TIMERS: BarrierTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface JournalSessionStoreOptions {
  /** The journal's records as of the drive's start, blobs resolved (`journal.read()`). */
  records: JournalRecord[];
  /** The timers `barrier` and `resultBarrier` wait on. Default the system's. */
  timers?: BarrierTimers;
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
 *   asked for it is in the log. The SDK mirrors a message's lines only once
 *   the message ends, while the CLI runs each call as its block ends, so the
 *   wait's clock restarts on each stream event of the message that made the
 *   call, up to its `message_stop` (`heard`): it runs out `timeoutMs` after
 *   that message's last event.
 */
export class JournalSessionStore {
  private readonly loaded = new Map<string, TranscriptLine[]>();
  private readonly calls = new Set<string>();
  private readonly users = new Set<string>();
  private readonly userWaiters = new Map<string, (() => void)[]>();
  private readonly waiters = new Map<string, (() => void)[]>();
  private readonly results = new Set<string>();
  private readonly resultWaiters = new Map<string, (() => void)[]>();
  /** The message stream each call was made in (its `parent_tool_use_id`, `''` for the main thread), from the SDK's live
   *  blocks, until its message's `message_stop`. */
  private readonly callScopes = new Map<string, string>();
  /** The clocks of the waits on each call, by its id: each one restarts its wait. */
  private readonly clocks = new Map<string, Set<() => void>>();
  private held: ({ stream: string; entry: TranscriptLine } | { message: TranscriptEntry })[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly coalesceMs: number;
  private readonly timers: BarrierTimers;
  /** Entries this drive appended (for tests and diagnostics). */
  appended = 0;

  constructor(
    private readonly journal: NativeJournal,
    options: JournalSessionStoreOptions
  ) {
    this.coalesceMs = options.coalesceMs ?? 0;
    this.timers = options.timers ?? SYSTEM_TIMERS;
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

  /**
   * Resolve once the user message sent with this `uuid` is in the transcript (`hasUser`): the CLI took it, as a turn's
   * own message or, mid-turn, as a `queued_command` attachment. Never rejects; it waits as long as the store lives.
   */
  whenUser(uuid: string): Promise<void> {
    if (this.users.has(uuid)) return Promise.resolve();
    return new Promise<void>((resolve) => this.userWaiters.set(uuid, [...(this.userWaiters.get(uuid) ?? []), resolve]));
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

  /** The main transcript as a resume loads it: the log's lines as of the drive's start, and those `extend` added. */
  lines(): readonly TranscriptLine[] {
    return this.loaded.get(CLAUDE_STREAM) ?? [];
  }

  /**
   * A line the harness writes into the main transcript before the CLI loads it (a dangling call's result on a resume):
   * on the log, deduped by its `uuid` like the CLI's own, and in what `load` returns, after the lines before it.
   */
  extend(entry: TranscriptLine): void {
    this.loaded.set(CLAUDE_STREAM, [...this.lines(), entry]);
    this.held.push({ stream: CLAUDE_STREAM, entry });
    this.note(entry);
    this.release();
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
   * SDK delivers a message's entries once the CLI has written the whole
   * message, and the tool runs once the CLI wrote its block, so this usually
   * waits for the mirror first. Rejects after `timeoutMs` (the caller does
   * not run the tool), counted from the last stream event of the message that
   * made the call (`heard`), or from now if none is heard.
   */
  async barrier(toolUseId: string, timeoutMs: number): Promise<void> {
    if (!this.calls.has(toolUseId)) await this.wait(toolUseId, timeoutMs, this.waiters, () => new Error(`the transcript entry for tool call ${toolUseId} did not reach the log within ${timeoutMs} ms`));
    await this.flush();
  }

  /**
   * One message `query()` yielded. An `assistant` message names the calls its block made, in its stream (the main
   * thread's, or a subagent's by its `parent_tool_use_id`); it and each `stream_event` of that stream restart the clock
   * of every wait on a call made in it. A message's last event is its `message_stop`: it restarts those clocks one last
   * time and unties the message's calls from the stream, whose next message reuses its `parent_tool_use_id`. So a call
   * whose line never lands is refused `timeoutMs` after its message ended, whatever streams after it, and a stream that
   * stalls, `timeoutMs` after its last event.
   */
  heard(m: { type: string; parent_tool_use_id?: string | null; message?: unknown; event?: unknown }): void {
    const scope = m.parent_tool_use_id ?? '';
    if (m.type === 'assistant') for (const id of toolUseIds(m as TranscriptLine)) this.callScopes.set(id, scope);
    else if (m.type !== 'stream_event') return;
    for (const [id, restarts] of this.clocks) if (this.callScopes.get(id) === scope) for (const restart of [...restarts]) restart();
    if ((m.event as { type?: unknown } | undefined)?.type === 'message_stop') for (const [id, of] of this.callScopes) if (of === scope) this.callScopes.delete(id);
  }

  /** Wait for `note` to wake a waiter on `id` in `waiters`; reject with `error()` once the clock runs out (`heard` restarts it). */
  private wait(id: string, timeoutMs: number, waiters: Map<string, (() => void)[]>, error: () => Error): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const clock = this.timers;
      let timer: unknown;
      const restart = () => {
        clock.clearTimeout(timer);
        timer = clock.setTimeout(expire, timeoutMs);
      };
      const stop = () => {
        clock.clearTimeout(timer);
        const restarts = this.clocks.get(id);
        restarts?.delete(restart);
        if (!restarts?.size) this.clocks.delete(id);
      };
      const done = () => {
        stop();
        resolve();
      };
      const expire = () => {
        stop();
        const list = waiters.get(id)?.filter((w) => w !== done) ?? [];
        if (list.length) waiters.set(id, list);
        else waiters.delete(id);
        reject(error());
      };
      waiters.set(id, [...(waiters.get(id) ?? []), done]);
      this.clocks.set(id, (this.clocks.get(id) ?? new Set()).add(restart));
      restart();
    });
  }

  private note(entry: TranscriptLine): void {
    if (entry.type === 'user' && entry.uuid) this.user(entry.uuid);
    const attachment = entry.type === 'attachment' ? (entry.attachment as { type?: unknown; source_uuid?: unknown } | undefined) : undefined;
    if (attachment?.type === 'queued_command' && typeof attachment.source_uuid === 'string') this.user(attachment.source_uuid);
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

  private user(uuid: string): void {
    this.users.add(uuid);
    for (const w of this.userWaiters.get(uuid) ?? []) w();
    this.userWaiters.delete(uuid);
  }

  /**
   * Resolve once the user entry that answers `toolUseId` (its `tool_result`) is committed: a call the CLI answered
   * itself (a refusal) is told to the host only once the log holds the answer. Rejects after `timeoutMs`, on the same
   * clock as `barrier`: the answer is mirrored with the rest of its message, once that message ends.
   */
  async resultBarrier(toolUseId: string, timeoutMs: number): Promise<void> {
    if (!this.results.has(toolUseId)) await this.wait(toolUseId, timeoutMs, this.resultWaiters, () => new Error(`the transcript entry answering tool call ${toolUseId} did not reach the log within ${timeoutMs} ms`));
    await this.flush();
  }
}
