import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CliLearningRuntime } from './state.js';
import type { SdkUsage } from '../sdk/runs.js';

export type TranscriptCursor = {
  path: string; offset: number; dev: number; ino: number;
  /** Only an ENOENT observed at the first Claude submit may later establish a new file boundary. */
  absent?: { observedAt: number; sessionId: string; turnId: string };
};
export type DialogueMessage = { role: 'user' | 'assistant'; text: string };
export type ToolEvidence = { id: string; name: string; status: 'started' | 'completed' | 'failed' };
export type PromptEvidence = {
  messages: DialogueMessage[];
  tools: ToolEvidence[];
  answer: string;
  model?: string;
  /** Native counters for this prompt only; absent when source usage cannot be established. */
  usage?: SdkUsage;
  /** Newly born first-Claude file, verified against the submitted prompt before policy capture. */
  verifiedCursor?: TranscriptCursor;
  complete: boolean;
  reason?: string;
  seedObserved: boolean;
};
export type CliHookInput = {
  event: 'UserPromptSubmit' | 'Stop' | 'Interrupt' | 'StopFailure' | 'SessionEnd';
  sessionId: string;
  turnId?: string;
  cwd: string;
  transcriptPath?: string;
  prompt?: string;
  answer?: string;
  model?: string;
  stopHookActive?: boolean;
};
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[\w.:@+-]{1,200}$/.test(v);
const bounded = (v: unknown, max = 131072): v is string => typeof v === 'string' && Buffer.byteLength(v) <= max;

const tokenKeys = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const;
type TokenCounts = Record<typeof tokenKeys[number], number>;
/** Match the importer's cache convention: Codex input includes cache tokens, Claude input excludes them. */
function nativeUsage(value: unknown, runtime: CliLearningRuntime): TokenCounts | undefined {
  if (!object(value)) return;
  const values: unknown[] = [value.input_tokens, value.output_tokens,
    runtime === 'codex' ? value.cached_input_tokens : value.cache_read_input_tokens,
    runtime === 'codex' ? value.cache_write_input_tokens : value.cache_creation_input_tokens];
  if (!values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return;
  const [input, output, cacheRead, cacheWrite] = values as [number, number, number, number];
  const uncached = runtime === 'codex' ? input - cacheRead - cacheWrite : input;
  if (uncached < 0 || !Number.isSafeInteger(uncached + output + cacheRead + cacheWrite)) return;
  return { input_tokens: uncached, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite };
}

/** The two harnesses use different prompt identities. Missing identities are not guessed from timestamps. */
export function normalizeHookInput(runtime: CliLearningRuntime, input: unknown): CliHookInput | null {
  if (!object(input) || !identifier(input.session_id) || !bounded(input.cwd, 4096) || !isAbsolute(input.cwd)) return null;
  if (!['UserPromptSubmit', 'Stop', 'Interrupt', 'StopFailure', 'SessionEnd'].includes(input.hook_event_name)) return null;
  if (input.agent_id) return null; // Independently enroll root sessions, not every spawned child.
  const turnId = runtime === 'codex' ? input.turn_id : input.prompt_id;
  if (input.hook_event_name !== 'SessionEnd' && !identifier(turnId)) return null;
  if (input.hook_event_name === 'UserPromptSubmit' && !bounded(input.prompt)) return null;
  return {
    event: input.hook_event_name,
    sessionId: input.session_id,
    ...(identifier(turnId) ? { turnId } : {}),
    cwd: input.cwd,
    ...(bounded(input.transcript_path, 4096) && isAbsolute(input.transcript_path) ? { transcriptPath: input.transcript_path } : {}),
    ...(bounded(input.prompt) ? { prompt: input.prompt } : {}),
    ...(bounded(input.last_assistant_message) ? { answer: input.last_assistant_message } : {}),
    ...(bounded(input.model, 200) ? { model: input.model } : {}),
    stopHookActive: input.stop_hook_active === true,
  };
}

export async function captureTranscriptCursor(path?: string, firstPrompt?: {
  runtime: CliLearningRuntime; sessionId: string; turnId: string;
}): Promise<TranscriptCursor | null> {
  if (!path) return null;
  const observedAt = Date.now();
  try {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      return info.isFile() ? { path, offset: info.size, dev: info.dev, ino: info.ino } : null;
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || firstPrompt?.runtime !== 'claude-code'
      || !isAbsolute(path) || !identifier(firstPrompt.sessionId) || !identifier(firstPrompt.turnId)) return null;
    // open() also returns ENOENT for a dangling symlink. That is not evidence that the
    // native transcript path itself did not exist at enrollment.
    try { await lstat(path); return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
    return { path, offset: 0, dev: -1, ino: -1,
      absent: { observedAt, sessionId: firstPrompt.sessionId, turnId: firstPrompt.turnId } };
  }
}

const messageText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(item => object(item) && ['text', 'input_text', 'output_text'].includes(item.type) && typeof item.text === 'string').map(item => item.text).join('\n') : '';
const nonTextContent = new Set(['image', 'image_url', 'input_image', 'output_image', 'document', 'file', 'input_file', 'output_file', 'audio', 'input_audio', 'output_audio', 'video', 'input_video', 'output_video']);
const hasNonTextContent = (content: unknown): boolean => (Array.isArray(content) ? content : [content])
  .some(block => object(block) && nonTextContent.has(block.type));
const RECORD_BYTES = 1024 * 1024, METADATA_RECORD_BYTES = 16 * 1024 * 1024;
const largeClaudeMetadata = (row: Record<string, any>): boolean => ['api-request-shape', 'api-request-blob'].includes(row.type)
  || (row.type === 'attachment' && object(row.attachment) && row.attachment.type === 'prompt_snapshot');
// This bounded prefix only permits buffering a larger record. The parsed native type below
// still decides eligibility, and snapshot records still pass source/session/ancestry checks.
const snapshotPrefix = /^\s*\{\s*(?:"(?:parentUuid|isSidechain|sessionId|uuid|timestamp|cwd|userType|version|type)"\s*:\s*(?:"(?:[^"\\]|\\.)*"|null|true|false|-?\d+(?:\.\d+)?)\s*,\s*)*"attachment"\s*:\s*\{\s*"type"\s*:\s*"prompt_snapshot"\s*[,}]/;
const largeClaudeMetadataPrefix = (prefix: string): boolean => /^\s*\{\s*"type"\s*:\s*"api-request-(?:shape|blob)"\s*[,}]/.test(prefix) || snapshotPrefix.test(prefix);

/** Read only bytes written after enrollment for this prompt. Tool results and reasoning never become dialogue. */
export async function collectPromptEvidence(options: {
  runtime: CliLearningRuntime;
  cursor: TranscriptCursor | null;
  turnId: string;
  sessionId?: string;
  prompt?: string;
  answer?: string;
  seedMarker?: string;
  maxBytes?: number;
}): Promise<PromptEvidence> {
  const result: PromptEvidence = { messages: [], tools: [], answer: options.answer ?? '', complete: true, seedObserved: false };
  const incomplete = (reason: string) => { result.complete = false; result.reason ??= reason; };
  if (!options.cursor) { incomplete('The prompt transcript was unavailable at enrollment.'); return result; }
  const cursor = options.cursor;
  if (cursor.absent && (options.runtime !== 'claude-code' || options.sessionId !== cursor.absent.sessionId
    || options.turnId !== cursor.absent.turnId || !Number.isFinite(cursor.absent.observedAt))) {
    incomplete('The missing transcript receipt does not belong to this source prompt.'); return result;
  }
  let freshRootVerified = false, freshIdentityInvalid = false;
  const requestUsage = new Map<string, TokenCounts | undefined>();
  let invalidUsage = false;
  const recordUsage = (id: unknown, value: unknown) => {
    if (!identifier(id)) { invalidUsage = true; return; }
    const next = nativeUsage(value, options.runtime), previous = requestUsage.get(id);
    if (options.runtime === 'claude-code' && value !== undefined && !next) invalidUsage = true;
    if (options.runtime === 'codex' && requestUsage.has(id)
      && (!next || !previous || tokenKeys.some(key => next[key] !== previous[key]))) invalidUsage = true;
    // Claude repeats one message's counters across streamed blocks; later blocks finish those counts.
    if (next) requestUsage.set(id, previous && options.runtime === 'claude-code'
      ? Object.fromEntries(tokenKeys.map(key => [key, Math.max(previous[key], next[key])])) as TokenCounts : next);
    else if (!requestUsage.has(id)) requestUsage.set(id, undefined);
  };
  const tools = new Map<string, ToolEvidence>();
  let evidenceBytes = 0;
  let finalAssistantText: string | undefined;
  const message = (role: 'user' | 'assistant', text: string) => {
    if (!text) return;
    evidenceBytes += Buffer.byteLength(text);
    if (evidenceBytes > 131072 || result.messages.length >= 200) { incomplete('The prompt dialogue exceeds the evidence limit.'); return; }
    result.messages.push({ role, text });
  };
  const call = (id: unknown, name: unknown) => {
    if (!identifier(id) || !bounded(name, 200)) return;
    if (tools.size >= 500) { incomplete('The prompt tool count exceeds the evidence limit.'); return; }
    tools.set(id, { id, name, status: 'started' });
  };
  const returned = (id: unknown, failed: boolean) => {
    if (!identifier(id)) return;
    const tool = tools.get(id);
    if (tool) tool.status = failed ? 'failed' : 'completed';
  };
  let lastClaudeUuid: string | undefined;
  let sawClaudePrompt = false;
  const consume = (line: string): boolean => {
    if (!line.trim()) return true;
    let row: any;
    try { row = JSON.parse(line); } catch { invalidUsage = true; incomplete('A prompt transcript record could not be parsed.'); return true; }
    if (!object(row)) { invalidUsage = true; return true; }
    if (Buffer.byteLength(line) > RECORD_BYTES && !(options.runtime === 'claude-code' && largeClaudeMetadata(row))) {
      invalidUsage = true;
      incomplete('A transcript record exceeds the evidence limit.'); return true;
    }
    if (options.runtime === 'codex') {
      const payload = row.payload;
      if (!object(payload)) {
        if (['token_usage_record', 'response_item', 'event_msg'].includes(row.type)) invalidUsage = true;
        return true;
      }
      if ((row.type === 'session_meta' && options.sessionId && identifier(payload.id) && payload.id !== options.sessionId)
        || (options.sessionId && identifier(payload.session_id) && payload.session_id !== options.sessionId)) {
        invalidUsage = true;
        incomplete('The transcript includes a different session.'); return true;
      }
      if (identifier(payload.turn_id) && payload.turn_id !== options.turnId) {
        incomplete('Another prompt started before the completion was captured.'); return false;
      }
      if (row.type === 'token_usage_record') {
        // Only the native per-response record carries exact prompt identity. Session/turn totals and
        // legacy token_count events can repeat earlier usage, so they are never added to this window.
        if (options.sessionId && payload.thread_id === options.sessionId && payload.turn_id === options.turnId)
          recordUsage(payload.response_id, payload.usage);
        else invalidUsage = true;
        return true;
      }
      if (row.type === 'compacted') { invalidUsage = true; incomplete('The prompt compacted its execution evidence before capture completed.'); }
      if (row.type === 'event_msg' && payload.type === 'turn_aborted' && payload.turn_id === options.turnId) incomplete('The prompt was interrupted before capture completed.');
      if (row.type !== 'response_item') return true;
      if (payload.type === 'message') {
        const text = messageText(payload.content);
        if (payload.role === 'developer' && options.seedMarker && text.includes(`AgentRun context receipt: ${options.seedMarker}`)) result.seedObserved = true;
        if (payload.role === 'user') {
          if (hasNonTextContent(payload.content)) incomplete('The prompt includes non-text source content that was not captured.');
          message('user', text);
        }
        if (payload.role === 'assistant' && (payload.channel === undefined || ['final', 'commentary'].includes(payload.channel))
          && (payload.phase === undefined || ['final_answer', 'commentary'].includes(payload.phase))) {
          if (hasNonTextContent(payload.content)) incomplete('The prompt includes non-text source content that was not captured.');
          message('assistant', text);
          if (text && payload.channel !== 'commentary' && payload.phase !== 'commentary') finalAssistantText = text;
        }
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') call(payload.call_id, payload.name);
      else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') returned(payload.call_id, payload.is_error === true);
    } else {
      if (row.isSidechain === true) return true;
      if (cursor.absent && !freshRootVerified) {
        // Metadata and attachments can precede the first user row, but no dialogue or
        // tool history is accepted until that row proves this newly enrolled root prompt.
        if (!['user', 'assistant'].includes(row.type)) return true;
        if (row.type !== 'user' || row.sessionId !== cursor.absent.sessionId
          || (row.promptId ?? row.prompt_id) !== cursor.absent.turnId || row.parentUuid !== null
          || !identifier(row.uuid) || row.isMeta || row.toolUseResult || row.message?.role !== 'user') {
          freshIdentityInvalid = true;
          incomplete('The new Claude transcript does not begin with the enrolled root prompt.'); return false;
        }
        freshRootVerified = true;
      }
      if (options.sessionId && identifier(row.sessionId) && row.sessionId !== options.sessionId) {
        invalidUsage = true;
        if (cursor.absent) { freshIdentityInvalid = true; incomplete('The new transcript includes a different session.'); return false; }
        incomplete('The transcript includes a different session.'); return true;
      }
      const promptId = row.promptId ?? row.prompt_id;
      if (identifier(promptId) && promptId !== options.turnId) {
        freshIdentityInvalid ||= Boolean(cursor.absent);
        incomplete('Another prompt started before the completion was captured.'); return false;
      }
      // A cursor starts within one linear native conversation. A later parent jump is a rewind or
      // missing branch; do not attach its messages to this prompt merely because their bytes are later.
      if (['user', 'assistant', 'attachment'].includes(row.type) && identifier(row.uuid)) {
        if (lastClaudeUuid && row.uuid !== lastClaudeUuid && Object.hasOwn(row, 'parentUuid') && row.parentUuid !== lastClaudeUuid) {
          invalidUsage = true;
          freshIdentityInvalid ||= Boolean(cursor.absent);
          incomplete('The transcript conversation branched or has missing ancestry.'); return false;
        }
        lastClaudeUuid = row.uuid;
      }
      if (row.type === 'system' && (row.subtype === 'compact_boundary' || row.subtype === 'microcompact_boundary')) {
        invalidUsage = true;
        incomplete('The prompt compacted its execution evidence before capture completed.');
      }
      if (row.type === 'attachment' && object(row.attachment) && row.attachment.type === 'hook_additional_context'
        && row.attachment.hookEvent === 'UserPromptSubmit' && Array.isArray(row.attachment.content)
        && row.attachment.content.every((item: unknown) => typeof item === 'string') && options.seedMarker
        && row.attachment.content.some((text: string) => text.includes(`AgentRun context receipt: ${options.seedMarker}`))) {
        result.seedObserved = true;
      }
      const nativeMessage = row.message;
      if (!object(nativeMessage)) { if (row.type === 'assistant') invalidUsage = true; return true; }
      if (row.type === 'assistant' && nativeMessage.role !== 'assistant') invalidUsage = true;
      // Source role comes from the native message envelope, never a tool's content or a string prefix.
      if ((row.type === 'user' || row.type === 'assistant') && nativeMessage.role === row.type) {
        if (row.type === 'assistant' && (nativeMessage.model !== '<synthetic>' || row.isApiErrorMessage === true)) {
          if (options.sessionId && row.sessionId === options.sessionId) recordUsage(nativeMessage.id, nativeMessage.usage);
          else invalidUsage = true;
        }
        if (hasNonTextContent(nativeMessage.content)) incomplete('The prompt includes non-text source content that was not captured.');
        const text = messageText(nativeMessage.content);
        if (row.type === 'user' && text && !row.isMeta && !row.toolUseResult && !sawClaudePrompt) {
          sawClaudePrompt = true;
          if (options.prompt !== undefined && !identifier(promptId) && text.trim() !== options.prompt.trim()) {
            invalidUsage = true;
            incomplete('The transcript prompt does not match the submitted prompt.'); return false;
          }
        }
        message(row.type, text);
        if (row.type === 'assistant' && text) {
          finalAssistantText = text;
          result.model = bounded(nativeMessage.model, 200) && nativeMessage.model ? nativeMessage.model : undefined;
        }
      }
      if (Array.isArray(nativeMessage.content)) for (const block of nativeMessage.content) {
        if (!object(block)) continue;
        if (row.type === 'assistant' && block.type === 'tool_use') call(block.id, block.name);
        if (row.type === 'user' && block.type === 'tool_result') returned(block.tool_use_id, block.is_error === true);
      }
    }
    return true;
  };
  const readCursor = await readWindow(cursor, options.maxBytes ?? 64 * 1024 * 1024, consume, reason => {
    invalidUsage = true;
    incomplete(reason);
  }, options.runtime);
  if (cursor.absent) {
    if (!freshRootVerified || freshIdentityInvalid) {
      incomplete('The first Claude transcript could not be bound to the enrolled prompt.');
      result.messages = []; tools.clear(); result.seedObserved = false; delete result.model;
      invalidUsage = true;
    } else if (readCursor) result.verifiedCursor = readCursor;
  }
  result.tools = [...tools.values()];
  if (result.tools.some(tool => tool.status === 'started')) incomplete('A tool call has no recorded result in this prompt window.');
  if (!options.answer?.trim() || finalAssistantText?.trim() !== options.answer.trim()) {
    invalidUsage = true;
    incomplete('The final assistant response is not yet present in this prompt transcript.');
  }
  if (!result.answer) result.answer = result.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '';
  if (!invalidUsage && requestUsage.size && [...requestUsage.values()].every(value => value !== undefined)) {
    const total: TokenCounts = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    for (const usage of requestUsage.values()) for (const key of tokenKeys) total[key] += usage![key];
    if (tokenKeys.every(key => Number.isSafeInteger(total[key]))
      && Number.isSafeInteger(tokenKeys.reduce((sum, key) => sum + total[key], 0))) result.usage = { ...total, cost_usd: null };
  }
  return result;
}

/** Stream bounded records, not a whole transcript window. Oversized records never consume unbounded memory. */
async function readWindow(cursor: TranscriptCursor, maxBytes: number, consume: (line: string) => boolean, incomplete: (reason: string) => void, runtime: CliLearningRuntime): Promise<TranscriptCursor | undefined> {
  try {
    const file = await open(cursor.path, cursor.absent ? constants.O_RDONLY | constants.O_NOFOLLOW : 'r');
    try {
      const info = await file.stat();
      const identityMatches = cursor.absent
        ? info.birthtimeMs > 0 && info.birthtimeMs >= cursor.absent.observedAt && cursor.offset === 0
        : info.dev === cursor.dev && info.ino === cursor.ino;
      if (!info.isFile() || !identityMatches || info.size < cursor.offset) {
        incomplete('The prompt transcript changed or was truncated.'); return;
      }
      const length = info.size - cursor.offset;
      if (length > maxBytes) { incomplete('The prompt transcript exceeds the evidence byte limit.'); return; }
      if (!length) return;
      const stream = file.createReadStream({ start: cursor.offset, end: info.size - 1, autoClose: false, highWaterMark: 64 * 1024 });
      let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0), discarding = false, records = 0, bytes = 0, recordLimit = RECORD_BYTES;
      for await (const raw of stream) {
        const chunk = Buffer.from(raw as Uint8Array);
        bytes += chunk.length;
        let start = 0;
        while (start < chunk.length) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          if (!discarding) {
            const part = chunk.subarray(start, end);
            if (pending.length + part.length > recordLimit && recordLimit === RECORD_BYTES && runtime === 'claude-code') {
              const prefix = pending.length >= 4096 ? pending.subarray(0, 4096)
                : Buffer.concat([pending, part.subarray(0, 4096 - pending.length)]);
              if (largeClaudeMetadataPrefix(prefix.toString('utf8'))) recordLimit = METADATA_RECORD_BYTES;
            }
            if (pending.length + part.length > recordLimit) {
              incomplete('A transcript record exceeds the evidence limit.'); pending = Buffer.alloc(0); discarding = true;
            } else pending = pending.length ? Buffer.concat([pending, part]) : part;
          }
          if (newline < 0) break;
          if (++records > 100_000) { incomplete('The prompt transcript exceeds the record limit.'); return; }
          if (!discarding) {
            let line: string | undefined;
            try { line = new TextDecoder('utf8', { fatal: true }).decode(pending); }
            catch { incomplete('A transcript record contains invalid text.'); }
            if (line !== undefined && !consume(line)) return;
          }
          pending = Buffer.alloc(0); discarding = false; recordLimit = RECORD_BYTES; start = newline + 1;
        }
      }
      if (bytes !== length) incomplete('The prompt transcript changed while reading.');
      if (pending.length || discarding) incomplete('The last transcript record is not yet flushed.');
      return { path: cursor.path, offset: info.size, dev: info.dev, ino: info.ino };
    } finally { await file.close(); }
  } catch { incomplete('The prompt transcript could not be read.'); }
}
