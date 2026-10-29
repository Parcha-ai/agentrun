// Copyright 2026 Vercel Inc. Licensed under the Apache License, Version 2.0; see LICENSE in this package.
// From github.com/vercel-labs/durable-harness, packages/harness-codex/src/rollout.ts at ea8aa4060c (UPSTREAM.json records its blob and sha256).
// Changed by Parcha, 2026-10-27: message prefixes; comments.
/**
 * Codex's rollout, as the run's log holds it. Pure functions, no Node
 * imports.
 *
 * A Codex thread persists as one append-only JSONL file, the rollout:
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`, one
 * `{timestamp, type, payload}` object per line. Its `response_item` lines are
 * the model-visible history (messages, `function_call`,
 * `function_call_output`, reasoning); its `event_msg` lines mark turns
 * (`task_started`, `task_complete`, `turn_aborted`) and carry the
 * `client_id` of every user message. Copied alone into an empty
 * `CODEX_HOME`, it is enough to resume the thread (`thread/resume` by id).
 *
 * The harness mirrors it into the session's native journal
 * (the process layer), one record per line, on the stream
 * `rollout:<threadId>`; the `codex.thread` stream records which thread is
 * the session's and where its file goes. Restoring is writing those lines
 * back, byte for byte, into a wiped `CODEX_HOME`.
 */

/** The journal stream naming the session's thread: `{ threadId, path }` records, the last one wins. */
export const THREAD_STREAM = 'codex.thread';

/** The journal stream of a thread's rollout lines. */
export const rolloutStream = (threadId: string) => `rollout:${threadId}`;

/** A `codex.thread` record. */
export interface ThreadRecord {
  threadId: string;
  /** The rollout file, relative to `CODEX_HOME` (`sessions/…/rollout-…-<threadId>.jsonl`). */
  path: string;
}

/** One rollout line, parsed. */
export interface RolloutLine {
  timestamp?: string;
  type: string;
  payload?: Record<string, unknown> & { type?: string };
}

/** A model tool call in the rollout, with its output if the rollout has one. */
export interface RolloutCall {
  callId: string;
  name: string;
  arguments: string;
  /** Whether a `function_call_output` for it follows. */
  answered: boolean;
  /** Line index of the `function_call`. */
  line: number;
}

/** What the harness reads off a rollout. */
export interface RolloutSummary {
  /** The thread id `session_meta` names, if the first line is one. */
  threadId?: string;
  /** Every `function_call` of the model, in order. */
  calls: RolloutCall[];
  /** Calls with no output: what a crash left dangling. */
  dangling: RolloutCall[];
  /** The `client_id` of every user message (the harness sends submission ids). */
  clientIds: Set<string>;
  /** Turns started (`task_started`) and ended (`task_complete` or `turn_aborted`). */
  turnsStarted: number;
  turnsEnded: number;
  /** The last turn has ended (or none started). */
  idle: boolean;
  /** How the last turn that ended ended: `task_complete` or `turn_aborted`. */
  lastTurn?: 'completed' | 'aborted';
  /** The `client_id`s of the user messages in the last turn that started. */
  lastTurnClientIds: Set<string>;
  /** The last `task_complete`'s `last_agent_message`, if the last turn completed. */
  lastAgentMessage?: string;
}

export function parseLine(line: string): RolloutLine | undefined {
  try {
    const value = JSON.parse(line) as RolloutLine;
    return value && typeof value === 'object' && typeof value.type === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a line is the rollout's `session_meta` (its first line: without it there is no thread to resume). */
export function isSessionMeta(line: string | undefined): boolean {
  return !!line && parseLine(line)?.type === 'session_meta';
}

export function summarizeRollout(lines: readonly string[]): RolloutSummary {
  const calls: RolloutCall[] = [];
  const outputs = new Set<string>();
  const clientIds = new Set<string>();
  let threadId: string | undefined;
  let started = 0;
  let ended = 0;
  let lastTurn: RolloutSummary['lastTurn'];
  let lastTurnClientIds = new Set<string>();
  let lastAgentMessage: string | undefined;
  lines.forEach((raw, i) => {
    const line = parseLine(raw);
    if (!line) return;
    const p = line.payload ?? {};
    if (line.type === 'session_meta' && i === 0) {
      const id = (p as { id?: unknown }).id ?? (p as { meta?: { id?: unknown } }).meta?.id;
      if (typeof id === 'string') threadId = id;
    } else if (line.type === 'response_item') {
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.call_id === 'string') {
        calls.push({ callId: p.call_id, name: String(p.name ?? ''), arguments: String(p.arguments ?? p.input ?? ''), answered: false, line: i });
      } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && typeof p.call_id === 'string') {
        outputs.add(p.call_id);
      }
    } else if (line.type === 'event_msg') {
      if (p.type === 'task_started') {
        started++;
        lastTurnClientIds = new Set();
        lastAgentMessage = undefined;
      } else if (p.type === 'task_complete') {
        ended++;
        lastTurn = 'completed';
        lastAgentMessage = typeof p.last_agent_message === 'string' ? p.last_agent_message : undefined;
      } else if (p.type === 'turn_aborted') {
        ended++;
        lastTurn = 'aborted';
        lastAgentMessage = undefined;
      } else if (p.type === 'item_completed') {
        const item = (p as { item?: { type?: unknown; client_id?: unknown } }).item;
        if (item?.type === 'UserMessage' && typeof item.client_id === 'string') {
          clientIds.add(item.client_id);
          lastTurnClientIds.add(item.client_id);
        }
      }
    }
  });
  for (const c of calls) c.answered = outputs.has(c.callId);
  return {
    ...(threadId ? { threadId } : {}),
    calls,
    dangling: calls.filter((c) => !c.answered),
    clientIds,
    turnsStarted: started,
    turnsEnded: ended,
    idle: ended >= started,
    ...(lastTurn ? { lastTurn } : {}),
    lastTurnClientIds,
    ...(ended >= started && lastAgentMessage !== undefined ? { lastAgentMessage } : {}),
  };
}

/** The call id of a `function_call` or `custom_tool_call` line, if the line is one. */
export function callIdOf(line: string): string | undefined {
  if (!line.includes('call_id') || (!line.includes('function_call') && !line.includes('custom_tool_call'))) return undefined;
  const l = parseLine(line);
  const p = l?.payload;
  return l?.type === 'response_item' && p && (p.type === 'function_call' || p.type === 'custom_tool_call') && typeof p.call_id === 'string' ? p.call_id : undefined;
}

/** Whether the rollout has a `function_call` line for this call. */
export function hasCall(lines: readonly string[], callId: string): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.includes(callId)) continue;
    const p = parseLine(l)?.payload;
    if (p && (p.type === 'function_call' || p.type === 'custom_tool_call') && p.call_id === callId) return true;
  }
  return false;
}

/** Whether a line ends a turn (`task_complete` or `turn_aborted`). */
export function endsTurn(line: string): boolean {
  if (!line.includes('task_complete') && !line.includes('turn_aborted')) return false;
  const l = parseLine(line);
  return l?.type === 'event_msg' && (l.payload?.type === 'task_complete' || l.payload?.type === 'turn_aborted');
}

/** The file a set of mirrored lines restores to: each line and its newline. */
export function rolloutText(lines: readonly string[]): string {
  let out = '';
  for (const l of lines) out += `${l}\n`;
  return out;
}

/**
 * The rollout path relative to `CODEX_HOME`, from the absolute path
 * app-server reports. Codex resumes a thread only from a file with its
 * canonical name, `rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl` (any
 * directory under `sessions/`, any timestamp): anything else is "no rollout
 * found" or "not a canonical rollout filename".
 */
export function relativeRolloutPath(absolute: string, threadId: string): string {
  const at = absolute.lastIndexOf('/sessions/');
  const rel = at >= 0 ? absolute.slice(at + 1) : '';
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  if (rel.includes('..') || !/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/.test(name) || name !== `${name.slice(0, 28)}${threadId}.jsonl`) {
    return `sessions/rollout-1970-01-01T00-00-00-${threadId}.jsonl`;
  }
  return rel;
}

/** A thread id as the harness accepts it from app-server (untrusted: it names a file to tail). */
const THREAD_ID = /^[0-9A-Za-z-]{8,64}$/;

/** Whether `rel` is a rollout path the driver itself would derive for `threadId`: `sessions/[YYYY/MM/DD/]rollout-<ts>-<threadId>.jsonl`, nothing else. */
export function isRolloutPath(rel: string, threadId: string): boolean {
  if (!THREAD_ID.test(threadId)) return false;
  const m = /^sessions\/(?:\d{4}\/\d{2}\/\d{2}\/)?rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9A-Za-z-]+)\.jsonl$/.exec(rel);
  return !!m && m[1] === threadId;
}

/**
 * The rollout path relative to `CODEX_HOME`, from the absolute path a VM's
 * app-server reports (docs/workspaces.md §5.6): the driver derives the path
 * it tails itself and refuses anything else. `homes` are what `CODEX_HOME`
 * may be written as (the path the harness set, and the one app-server's
 * `initialize` says, which may be its canonical form). Throws for a path
 * outside them or not of the form `isRolloutPath` accepts.
 */
export function rolloutPathIn(homes: readonly string[], absolute: string, threadId: string): string {
  for (const home of homes) {
    const prefix = `${home.replace(/\/+$/, '')}/`;
    if (!home || !absolute.startsWith(prefix)) continue;
    const rel = absolute.slice(prefix.length);
    if (isRolloutPath(rel, threadId)) return rel;
  }
  throw new Error('agentrun-harness-codex: app-server named a rollout file the driver would not derive for the thread (outside CODEX_HOME, or not sessions/…/rollout-<ts>-<threadId>.jsonl)');
}
