import { createHash, type Hash } from 'node:crypto';

type Policy = { text: string; complete: boolean; reason?: string };
type Blob = { role: string; text?: string; complete: boolean; reason?: string };
type Request = { shapeHash: string; refs: string[]; complete: boolean; reason?: string };
export type ClaudeWireState = {
  version: 1;
  shapes: Record<string, Policy>;
  blobs: Record<string, Blob>;
  requests: Record<string, Request>;
  current?: { prompt: string; text: string; stableText?: string; complete: boolean; reason?: string };
  /** Re-read ordinary source rows from this byte offset after restoring the JSON cache. */
  replayFrom?: number;
  reminders?: string[];
};

const POLICY_BYTES = 256 * 1024, CACHE_BYTES = 4 * 1024 * 1024, MAX_REFS = 4096;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requestId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const refused = (reason: string): Policy => ({ text: '', complete: false, reason });
type SourceRun = { role: string; messageId?: string; value?: Hash; blocks: number; bytes: number; lastOffset?: number };
// Incremental digests contain no recoverable conversation text and are never serialized.
// On a cache reload the caller replays typed rows from replayFrom to hydrate this state.
const sourceRuns = new WeakMap<ClaudeWireState, SourceRun>();

function hashValue(value: unknown, write: (part: string) => void, depth = 0): void {
  if (depth > 64) throw new Error('Native message nesting exceeds the hashing bound.');
  if (typeof value === 'string') {
    write('"');
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 65536, value.length);
      if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
      write(JSON.stringify(value.slice(start, end)).slice(1, -1)); start = end;
    }
    write('"'); return;
  }
  if (value === null || typeof value !== 'object') { write(JSON.stringify(value) ?? 'null'); return; }
  if (Array.isArray(value)) {
    write('['); value.forEach((item, index) => { if (index) write(','); hashValue(item, write, depth + 1); }); write(']'); return;
  }
  write('{'); let first = true;
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (key === 'cache_control' || item === undefined) continue;
    if (!first) write(','); first = false; write(JSON.stringify(key)); write(':'); hashValue(item, write, depth + 1);
  }
  write('}');
}

function sourceMessage(previous: ClaudeWireState, next: ClaudeWireState, row: Record<string, any>, offset?: number): void {
  const message = row.message;
  if (!object(message) || message.role !== row.type || message.content == null) {
    sourceRuns.delete(next); delete next.replayFrom; return;
  }
  const role = message.role, messageId = typeof message.id === 'string' ? message.id : undefined;
  const before = sourceRuns.get(previous);
  if (offset !== undefined && before?.lastOffset !== undefined && offset <= before.lastOffset && offset !== previous.replayFrom) return;
  const restarting = offset !== undefined && offset === previous.replayFrom;
  const same = !restarting && before?.role === role && (role === 'user' || (messageId !== undefined && messageId === before?.messageId));
  const unprimed = !before && previous.replayFrom !== undefined && offset !== previous.replayFrom;
  const run: SourceRun = same ? { ...before!, value: before!.value?.copy() } : {
    role, ...(messageId ? { messageId } : {}), blocks: 0, bytes: 0,
    ...(!unprimed ? { value: createHash('sha256').update('{"content":[') } : {}),
  };
  if (!same && !unprimed) {
    if (offset !== undefined) next.replayFrom = offset; else delete next.replayFrom;
  }
  run.lastOffset = offset;
  sourceRuns.set(next, run);
  if (!run.value) return;
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
    : Array.isArray(message.content) ? message.content : [message.content];
  try {
    const write = (part: string) => {
      run.bytes += Buffer.byteLength(part);
      if (run.bytes > 64 * 1024 * 1024) throw new Error('Native message hashing exceeds the byte bound.');
      run.value!.update(part);
    };
    for (const block of blocks) {
      if (run.blocks++ > 100_000) throw new Error('Native message hashing exceeds the block bound.');
      if (run.blocks > 1) write(','); hashValue(block, write);
    }
    const digest = run.value.copy().update(`],"role":${JSON.stringify(role)}}`).digest('hex');
    const known = next.blobs[digest];
    put(next.blobs, digest, known && known.role !== role ? { role: 'unknown', complete: false, reason: 'A native transcript hash conflicts with its recorded role.' }
      : { role, complete: true }, 8192);
  } catch { delete run.value; }
}

function policy(content: unknown, redact: (text: string) => string): Policy {
  const values = typeof content === 'string' ? [content] : Array.isArray(content)
    && content.every(block => object(block) && block.type === 'text' && typeof block.text === 'string')
      ? content.map(block => block.text as string) : undefined;
  if (!values) return refused('The native request contains unsupported system policy content.');
  if (values.reduce((size, value) => size + Buffer.byteLength(value) + 2, 0) > POLICY_BYTES)
    return refused('The native request policy exceeds the 256 KiB evidence limit.');
  const original = values.join('\n\n');
  let text: string;
  try { text = redact(original); } catch { return refused('The native request policy could not be safely captured.'); }
  if (typeof text !== 'string' || Buffer.byteLength(text) > POLICY_BYTES)
    return refused('The native request policy exceeds the 256 KiB evidence limit.');
  return { text, complete: text === original, ...(text !== original ? { reason: 'The native request policy contains withheld or redacted text.' } : {}) };
}

function put<T>(map: Record<string, T>, key: string, value: T, limit: number): void {
  delete map[key]; map[key] = value;
  while (Object.keys(map).length > limit) delete map[Object.keys(map)[0]!];
}

function bounded(state: ClaudeWireState): ClaudeWireState {
  // Eviction only removes reconstruction inputs. A later request referring to an evicted
  // record becomes explicitly incomplete; the independently retained current snapshot stays pinned.
  while (Buffer.byteLength(JSON.stringify(state)) > CACHE_BYTES) {
    const map = Object.keys(state.requests).length ? state.requests : Object.keys(state.blobs).length ? state.blobs : state.shapes;
    const key = Object.keys(map)[0];
    if (!key) { state.current = state.current ? { prompt: state.current.prompt, ...refused('The native request cache exceeds its evidence limit.') } : undefined; break; }
    delete map[key];
  }
  return state;
}

/** Keep native request policy only. User/assistant/tool blobs contribute roles and hashes,
 * never conversation text, tool descriptions, arguments, credentials, or raw request bodies. */
export function updateClaudeWire(state: ClaudeWireState | undefined, row: unknown,
  options: { promptId?: string; redact: (text: string) => string; recordOffset?: number }): ClaudeWireState {
  const previous = state ?? { version: 1 as const, shapes: {}, blobs: {}, requests: {} };
  if (!object(row) || row.agentId || row.isSidechain || !['user', 'assistant', 'attachment', 'api-request-shape', 'api-request-blob', 'api-request'].includes(row.type)) return previous;
  const next: ClaudeWireState = { ...previous, shapes: { ...previous.shapes }, blobs: { ...previous.blobs }, requests: { ...previous.requests } };
  const run = sourceRuns.get(previous); if (run) sourceRuns.set(next, run);
  if (row.type === 'user' || row.type === 'assistant') {
    sourceMessage(previous, next, row, Number.isSafeInteger(options.recordOffset) && options.recordOffset! >= 0 ? options.recordOffset : undefined);
    return bounded(next);
  }
  if (row.type === 'attachment') {
    const attachment = row.attachment;
    if (object(attachment) && attachment.type === 'total_tokens_reminder' && row.renderedRole === 'system'
      && typeof attachment.text === 'string' && /^<total_tokens>(?:\d{1,20}|Infinite) tokens left<\/total_tokens>$/.test(attachment.text)
      && Array.isArray(row.rendered) && row.rendered.length === 1
      && row.rendered[0]?.content === `<system-reminder>\n${attachment.text}\n</system-reminder>`) {
      next.reminders = [...(next.reminders ?? []).filter(text => text !== attachment.text), attachment.text].slice(-256);
    }
    return bounded(next);
  }
  if (row.type === 'api-request-shape') {
    if (!hash(row.shapeHash)) return previous;
    const captured = object(row.shape) ? policy(row.shape.system, options.redact) : refused('The native request shape has no captured system policy.');
    const known = next.shapes[row.shapeHash];
    put(next.shapes, row.shapeHash, known && JSON.stringify(known) !== JSON.stringify(captured)
      ? refused('A native shape hash was reused for different policy.') : captured, 128);
    return bounded(next);
  }
  if (row.type === 'api-request-blob') {
    if (!hash(row.hash)) return previous;
    const message = row.message;
    const role = object(message) && typeof message.role === 'string' ? message.role : 'unknown';
    const captured: Blob = ['system', 'developer'].includes(role)
      ? { role, ...policy(message.content, options.redact) }
      : ['user', 'assistant', 'tool'].includes(role) ? { role, complete: true }
        : { role: 'unknown', complete: false, reason: 'A referenced native message has an unsupported role.' };
    const known = next.blobs[row.hash];
    put(next.blobs, row.hash, known && JSON.stringify(known) !== JSON.stringify(captured)
      ? { role: 'unknown', complete: false, reason: 'A native message hash was reused for different policy.' } : captured, 8192);
    return bounded(next);
  }

  const main = row.querySource === 'sdk' || (typeof row.querySource === 'string' && row.querySource.startsWith('repl_main_thread'));
  const prompt = typeof options.promptId === 'string' && options.promptId.length > 0 && options.promptId.length <= 200 ? options.promptId : undefined;
  const failCurrent = (reason: string) => { if (main) next.current = prompt ? { prompt, ...refused(reason) } : undefined; };
  if (!requestId(row.id) || !hash(row.shapeHash) || !Number.isSafeInteger(row.keep) || row.keep < 0 || row.keep > MAX_REFS
    || !Array.isArray(row.tail) || row.tail.length > MAX_REFS || !row.tail.every(hash)) {
    failCurrent('The native request has malformed or oversized reconstruction metadata.'); return bounded(next);
  }
  let reason: string | undefined;
  const fail = (value: string) => { reason ??= value; };
  let refs: string[] = [];
  if (row.keep > 0) {
    const base = requestId(row.base) ? next.requests[row.base] : undefined;
    if (!base || !base.complete || base.refs.length < row.keep) fail('The native request base is missing, incomplete, or shorter than its retained prefix.');
    else refs = base.refs.slice(0, row.keep);
  }
  if (refs.length + row.tail.length > MAX_REFS) fail('The native request has too many referenced messages.');
  else refs.push(...row.tail);
  if (Object.hasOwn(row, 'cut') || Object.hasOwn(row, 'withheld')) fail('The native request declares cut or withheld evidence.');
  const shape = next.shapes[row.shapeHash];
  if (!shape) fail('The native request shape is missing from the bounded policy cache.');
  else if (!shape.complete) fail(shape.reason ?? 'The native request shape policy is incomplete.');
  const parts: string[] = [], stableParts: string[] = [];
  let policyBytes = 0, oversized = false;
  const include = (label: string, content: string, reminder = false) => {
    if (!content || oversized) return;
    const size = Buffer.byteLength(label) + 1 + Buffer.byteLength(content) + (parts.length ? 2 : 0);
    if (policyBytes + size > POLICY_BYTES) {
      oversized = true; fail('The reconstructed native policy exceeds the 256 KiB evidence limit.'); return;
    }
    parts.push(`${label}\n${content}`); if (!reminder) stableParts.push(`${label}\n${content}`); policyBytes += size;
  };
  if (shape) include('Native API system policy:', shape.text);
  for (const ref of refs) {
    const entry = next.blobs[ref];
    if (!entry) { fail('A native request message is missing from the bounded policy cache.'); continue; }
    if (!entry.complete) fail(entry.reason ?? 'A referenced native policy message is incomplete.');
    if (entry.role === 'system' || entry.role === 'developer') include(`Native API ${entry.role} message:`, entry.text ?? '',
      entry.role === 'system' && (next.reminders ?? []).includes(entry.text ?? ''));
  }
  const text = oversized ? '' : parts.join('\n\n');
  const known = next.requests[row.id];
  if (known && (known.shapeHash !== row.shapeHash || JSON.stringify(known.refs) !== JSON.stringify(refs)))
    fail('A native request identity was reused for different reconstruction metadata.');
  put(next.requests, row.id, { shapeHash: row.shapeHash, refs, complete: !reason, ...(reason ? { reason } : {}) }, 32);
  if (main) next.current = prompt ? { prompt, text, stableText: oversized ? '' : stableParts.join('\n\n'), complete: !reason, ...(reason ? { reason } : {}) } : undefined;
  return bounded(next);
}
