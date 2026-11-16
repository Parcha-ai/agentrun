import { createHash } from 'node:crypto';
import type { FactPosition } from 'eve/events';
import type { HookEvent } from 'eve/hooks';
import type { SessionReader } from 'eve/sessions';

type ReaderEvent = ReturnType<SessionReader['stream']> extends AsyncIterable<infer Event> ? Event : never;
const MAX_EVENTS = 10_000, MAX_BYTES = 4_000_000;
type Invalid = 'limit' | 'conflict' | 'position' | 'payload';

/** Private eve state, never an AgentRun payload. Retain only while the corresponding turn is pending. */
export interface PendingEvidence {
  events: Array<{ event: HookEvent; position: FactPosition; at: string; digest: string }>;
  bytes: number;
  invalid?: Invalid;
}

export function emptyPendingEvidence(): PendingEvidence { return { events: [], bytes: 0 }; }

const validPosition = (position: FactPosition): boolean => Number.isSafeInteger(position.line) && position.line >= 0
  && Number.isSafeInteger(position.index) && position.index >= 0;
const keyOf = (position: FactPosition): string => `${position.line}:${position.index}`;
const compare = (a: FactPosition, b: FactPosition): number => a.line - b.line || a.index - b.index;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const core = (event: HookEvent | ReaderEvent): HookEvent => ({ type: event.type,
  ...(event.scope === undefined ? {} : { scope: event.scope }), data: event.data }) as HookEvent;
const digestOf = (event: HookEvent | ReaderEvent): string => createHash('sha256').update(JSON.stringify(canonical(core(event)))).digest('hex');

/**
 * Capture the exact public hook fact and its public source position before the current step flushes.
 * `committedThrough` is position(ctx.view): it validates the source line, not its final event index.
 * No last-event or complete-commit assertion is inferred from a terminal fact or that view cursor.
 */
export function recordHookEvent(state: PendingEvidence, event: HookEvent, position: FactPosition,
  observed: { at: string; committedThrough?: number }): PendingEvidence {
  if (state.invalid) return state;
  if (!validPosition(position) || observed.committedThrough !== undefined &&
    (!Number.isSafeInteger(observed.committedThrough) || observed.committedThrough <= position.line))
    return { ...state, invalid: 'position' };
  try {
    // Snapshot the public JSON payload so caller mutation cannot rewrite an earlier hook observation.
    const encoded = JSON.stringify({ event: core(event), position, at: observed.at });
    if (Buffer.byteLength(encoded) > MAX_BYTES) return { ...state, invalid: 'limit' };
    const snapshot = JSON.parse(encoded) as PendingEvidence['events'][number];
    const digest = digestOf(snapshot.event);
    const duplicate = state.events.find(saved => keyOf(saved.position) === keyOf(position));
    if (duplicate) return duplicate.digest === digest ? state : { ...state, invalid: 'conflict' };
    snapshot.digest = digest;
    const bytes = state.bytes + Buffer.byteLength(JSON.stringify(snapshot));
    if (bytes > MAX_BYTES || state.events.length >= MAX_EVENTS) return { ...state, invalid: 'limit' };
    return { events: [...state.events, snapshot], bytes };
  } catch {
    // A malformed future payload cannot fail the user's native hook or become a silently missing fact.
    return { ...state, invalid: 'payload' };
  }
}

/**
 * Finite durable history plus facts already accepted by the current hook's step. The cache's last
 * line is deliberately partial: hooks expose positions, but do not expose a commit's last index.
 * Normalization may stop at an observed target settlement; this reader never fabricates EOL there.
 */
export function withPendingEvidence(reader: SessionReader, state: PendingEvidence): SessionReader {
  return { id: reader.id, async *stream(options = {}) {
    if (options.follow !== false) throw new Error('finite_history_required');
    const start = options.startIndex ?? 0;
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('invalid_history_position');
    if (state.invalid) throw new Error(`pending_evidence_${state.invalid}`);
    options.signal?.throwIfAborted();
    type Row = { event: ReaderEvent; digest: string; durable: boolean };
    const merged = new Map<string, Row>();
    let bytes = 0, readCount = 0;
    const budget = (value: unknown) => {
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > MAX_BYTES || ++readCount > MAX_EVENTS) throw new Error('history_limit');
    };
    let previous: FactPosition | undefined;
    for await (const event of reader.stream({ ...options, startIndex: start, follow: false })) {
      options.signal?.throwIfAborted();
      budget(event);
      const position = event.meta.position;
      if (!validPosition(position) || position.line < start) throw new Error('invalid_history_position');
      const key = keyOf(position), digest = digestOf(event), duplicate = merged.get(key);
      if (duplicate) {
        if (duplicate.digest !== digest) throw new Error('conflicting_history');
        // Repeated source coverage may extend reader metadata without changing the accepted fact.
        if (duplicate.event.meta.endOfLine === false && event.meta.endOfLine !== false ||
          (event.meta.next ?? 0) > (duplicate.event.meta.next ?? 0)) merged.set(key, { event, digest, durable: true });
        continue;
      }
      if (previous && compare(position, previous) <= 0) throw new Error('unordered_history');
      previous = position;
      merged.set(key, { event, digest, durable: true });
    }
    for (const saved of state.events) {
      options.signal?.throwIfAborted();
      if (!validPosition(saved.position)) throw new Error('invalid_history_position');
      if (saved.position.line < start) continue;
      const key = keyOf(saved.position), digest = digestOf(saved.event), duplicate = merged.get(key);
      if (duplicate) {
        if (duplicate.digest !== digest) throw new Error('conflicting_history');
        continue; // Real source metadata takes precedence over the reconstructed hook reader metadata.
      }
      budget(saved);
      merged.set(key, { event: { ...saved.event, meta: { position: saved.position, at: saved.at, endOfLine: false } }, digest, durable: false });
    }
    const rows = [...merged.values()].sort((a, b) => compare(a.event.meta.position, b.event.meta.position));
    let expectedLine = start, lastLine = -1, lastIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!, { line, index } = row.event.meta.position;
      const next = rows[i + 1];
      if (line !== lastLine && (line !== expectedLine || index !== 0) || line === lastLine && index !== lastIndex + 1)
        throw new Error('history_gap');
      const anotherInLine = next?.event.meta.position.line === line;
      if (row.durable && row.event.meta.endOfLine !== false && anotherInLine) throw new Error('conflicting_history_boundary');
      if (row.durable && row.event.meta.endOfLine === false && next && !anotherInLine) throw new Error('partial_history_commit');
      if (!row.durable) row.event = { ...row.event, meta: { ...row.event.meta,
        endOfLine: Boolean(next && !anotherInLine) } };
      if (!anotherInLine) expectedLine = Math.max(line + 1, row.event.meta.next ?? line + 1);
      lastLine = line; lastIndex = index;
    }
    // Validate the whole finite merge before yielding any facts; a conflicting tail cannot be hidden
    // by a caller stopping at an earlier settlement.
    for (const row of rows) { options.signal?.throwIfAborted(); yield row.event; }
  } };
}
