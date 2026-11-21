import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { discoverNative } from '../native/discovery.js';
import { snapshotNativeInstructions, type NativeInstructionSnapshot } from '../native/instructions.js';
import { updateClaudeWire, type ClaudeWireState } from './claude-wire.js';
import type { TranscriptCursor } from './evidence.js';
import { readPrivateJson, writePrivateJson, type CliLearningRuntime } from './state.js';

export const CLI_POLICY_BYTES = 256 * 1024;
export const CLAUDE_IMPORTS_PENDING = 'Claude standing instructions contain imports whose policy files were not captured.';
export const CLAUDE_SNAPSHOT_PENDING = 'A current native Claude system-prompt snapshot has not been recorded.';
type PolicyCache = {
  version: 1 | 3; runtime: CliLearningRuntime; dev: number; ino: number; offset: number;
  base: string; developer: string[]; world: Record<string, string>;
  claude?: { uuid?: string; parentUuid?: string; systemPrompt: string[] };
  claudeLeaf?: string; claudePrompt?: string;
  claudeInstructions?: Record<string, { type: string; content: string }>;
  claudeInstructionsComplete?: boolean;
  claudeFirst?: { prompt: string; systemPrompt: string[]; instructions?: Record<string, { type: string; content: string }>; instructionsComplete?: boolean; invalidated?: boolean; wire?: { text: string; stableText?: string; complete: boolean; reason?: string }; context?: string };
  claudePromptChanged?: boolean; claudePromptWireIncomplete?: string;
  claudeWire?: ClaudeWireState; claudeContext?: string;
  invalidated?: boolean; incomplete?: string;
  decodeFault?: { replacement: boolean; world: boolean };
};
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const contentText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(item => object(item) && ['input_text', 'output_text', 'text'].includes(item.type) && typeof item.text === 'string').map(item => item.text).join('\n') : '';
const policyMessage = (item: any) => item?.type === 'message' && ['system', 'developer'].includes(item.role)
  ? contentText(item.content) : '';

/** Read only policy metadata before enrollment, not historical dialogue. Cached append offsets make long sessions
 * cheap after their first scan. A deadline checkpoint is incomplete until a later invocation reaches the boundary. */
export async function readTranscriptPolicy(options: {
  runtime: CliLearningRuntime; cursor: TranscriptCursor | null; sessionId?: string; turnId?: string; requireWire?: boolean;
  cachePath?: string; redact?: (text: string) => string; budgetMs?: number;
}): Promise<{ text: string; incomplete?: string; instructionsCaptured?: boolean; wireCaptured?: boolean; scannedBytes?: number; totalBytes?: number }> {
  const cursor = options.cursor, redact = options.redact ?? (text => text);
  if (!cursor) return { text: '', incomplete: 'Native session policy metadata is unavailable.' };
  if (options.runtime === 'claude-code' && cursor.absent) return { text: '', incomplete: CLAUDE_SNAPSHOT_PENDING };
  const version = options.runtime === 'claude-code' ? 3 : 1;
  let cache = options.cachePath ? await readPrivateJson<PolicyCache>(options.cachePath) : undefined;
  if (!cache || cache.version !== version || cache.runtime !== options.runtime || cache.dev !== cursor.dev || cache.ino !== cursor.ino || cache.offset > cursor.offset) {
    cache = { version, runtime: options.runtime, dev: cursor.dev, ino: cursor.ino, offset: 0, base: '', developer: [], world: {} };
  }
  const inspected = cache;
  const clean = (text: string) => {
    const value = redact(text);
    if (value !== text) inspected.incomplete ??= 'Source policy contains withheld or redacted text.';
    return value;
  };
  const appendDeveloper = (text: string) => {
    if (!text || text.includes('AgentRun context receipt:')) return;
    const value = clean(text);
    if (!inspected.developer.includes(value)) inspected.developer.push(value);
    if (Buffer.byteLength(inspected.developer.join('\n')) > CLI_POLICY_BYTES) {
      inspected.developer.pop(); inspected.incomplete = 'Native developer policy exceeds the supported grading limit.';
    }
  };
  const record = (row: any, recordOffset: number) => {
    if (!object(row)) return;
    if (options.runtime === 'claude-code') {
      if (row.isSidechain === true || row.agentId || (options.sessionId && row.sessionId && row.sessionId !== options.sessionId)) return;
      inspected.claudeWire = updateClaudeWire(inspected.claudeWire, row, { promptId: inspected.claudePrompt, redact: clean, recordOffset });
      if (['api-request-shape', 'api-request-blob', 'api-request'].includes(row.type)) {
        const current = inspected.claudeWire.current;
        if (row.type === 'api-request' && current && current.prompt === inspected.claudePrompt && !current.complete)
          inspected.claudePromptWireIncomplete = current.reason ?? 'Native request policy coverage is incomplete.';
        if (row.type === 'api-request' && inspected.claudeFirst?.wire && current && current.prompt === inspected.claudePrompt
          && (current.stableText ?? current.text) !== (inspected.claudeFirst.wire.stableText ?? inspected.claudeFirst.wire.text)) inspected.claudePromptChanged = true;
        return;
      }
      // Native stop-hook summaries are real parent-chain nodes between ordinary prompts.
      // Follow their identity without importing their contents as source instructions.
      if ((['user', 'assistant', 'attachment'].includes(row.type) || (row.type === 'system' && row.subtype === 'stop_hook_summary')) && typeof row.uuid === 'string') {
        if (inspected.claudeLeaf && row.uuid !== inspected.claudeLeaf && Object.hasOwn(row, 'parentUuid') && row.parentUuid !== inspected.claudeLeaf) {
          inspected.incomplete ??= 'Native Claude policy ancestry branched or is incomplete.';
        }
        inspected.claudeLeaf = row.uuid;
      }
      const promptId = row.promptId ?? row.prompt_id;
      if (row.type === 'user' && typeof promptId === 'string' && promptId !== inspected.claudePrompt) {
        inspected.claudePrompt = promptId; delete inspected.claudeFirst; inspected.claudePromptChanged = false; delete inspected.claudePromptWireIncomplete;
      }
      if (row.type === 'assistant' && row.message?.role === 'assistant' && inspected.claudePrompt && !inspected.claudeFirst && inspected.claude) {
        inspected.claudeFirst = { prompt: inspected.claudePrompt, systemPrompt: [...inspected.claude.systemPrompt],
          instructions: structuredClone(inspected.claudeInstructions), instructionsComplete: inspected.claudeInstructionsComplete, invalidated: inspected.invalidated,
          ...(inspected.claudeWire?.current?.prompt === inspected.claudePrompt ? { wire: structuredClone(inspected.claudeWire.current) } : {}), context: inspected.claudeContext };
      }
      const attachment = row.attachment;
      if (row.type !== 'attachment' || !object(attachment)) return;
      if (attachment.type === 'session_context') {
        if (row.renderedRole !== 'user' || !Array.isArray(row.rendered) || row.rendered.some((part: any) => !object(part) || typeof part.content !== 'string')) {
          inspected.incomplete ??= 'The native lower-trust session context was not recorded completely.';
        } else {
          inspected.claudeContext = clean(row.rendered.map((part: any) => part.content).join('\n\n'));
          if (inspected.claudeFirst && inspected.claudeFirst.context !== inspected.claudeContext) inspected.claudePromptChanged = true;
        }
      }
      if (attachment.type === 'instructions') {
        const valid = Array.isArray(attachment.files) && attachment.files.every((file: any) => object(file)
          && typeof file.path === 'string' && isAbsolute(file.path) && file.path.length <= 4096
          && typeof file.content === 'string' && typeof file.type === 'string' && file.unverified !== true)
          && (attachment.removed === undefined || (Array.isArray(attachment.removed) && attachment.removed.every((path: unknown) => typeof path === 'string')));
        if (!valid || (attachment.changed === true && !inspected.claudeInstructionsComplete)) {
          inspected.incomplete ??= 'Native Claude loaded instructions have incomplete coverage.';
        } else {
          if (attachment.changed !== true) { inspected.claudeInstructions = {}; inspected.claudeInstructionsComplete = true; }
          for (const file of attachment.files) inspected.claudeInstructions![clean(file.path)] = { type: clean(file.type), content: clean(file.content) };
          for (const path of attachment.removed ?? []) delete inspected.claudeInstructions![clean(path)];
          if (Buffer.byteLength(JSON.stringify(inspected.claudeInstructions)) > CLI_POLICY_BYTES) {
            inspected.claudeInstructions = {}; inspected.claudeInstructionsComplete = false;
            inspected.incomplete ??= 'Native Claude loaded instructions exceed the grading limit.';
          }
        }
      }
      if (attachment.type === 'prompt_render_point') inspected.invalidated = true;
      if (attachment.type === 'prompt_snapshot' && Array.isArray(attachment.systemPrompt) && attachment.systemPrompt.every((value: unknown) => typeof value === 'string')) {
        const systemPrompt: string[] = attachment.systemPrompt.map(clean);
        if (Buffer.byteLength(systemPrompt.join('\n')) > CLI_POLICY_BYTES) { inspected.incomplete = 'Native Claude system policy exceeds the supported grading limit.'; return; }
        inspected.claude = { systemPrompt, ...(typeof row.uuid === 'string' ? { uuid: row.uuid } : {}), ...(typeof row.parentUuid === 'string' ? { parentUuid: row.parentUuid } : {}) };
        inspected.invalidated = false;
      }
      if (inspected.claudeFirst && ['instructions', 'prompt_snapshot'].includes(attachment.type)) {
        const ordered = (files: Record<string, { type: string; content: string }> | undefined) => Object.entries(files ?? {}).sort(([a], [b]) => a.localeCompare(b));
        if (JSON.stringify(inspected.claudeFirst.systemPrompt) !== JSON.stringify(inspected.claude?.systemPrompt)
          || JSON.stringify(ordered(inspected.claudeFirst.instructions)) !== JSON.stringify(ordered(inspected.claudeInstructions))) inspected.claudePromptChanged = true;
      }
      return;
    }
    const payload = row.payload;
    if (!object(payload)) return;
    if (row.type === 'session_meta') {
      if (options.sessionId && (payload.id ?? payload.session_id) !== options.sessionId) { inspected.incomplete = 'Native policy metadata belongs to another session.'; return; }
      const base = typeof payload.base_instructions === 'string' ? payload.base_instructions : payload.base_instructions?.text;
      if (typeof base === 'string' && Buffer.byteLength(base) <= CLI_POLICY_BYTES) inspected.base = clean(base);
      else inspected.incomplete = 'Codex native system policy is missing or exceeds the grading limit.';
    } else if (row.type === 'response_item') appendDeveloper(policyMessage(payload));
    else if (row.type === 'compacted' && Array.isArray(payload.replacement_history)) {
      // Replacement history is the native retained context, not a guessed summary of old conversation.
      inspected.developer = [];
      for (const item of payload.replacement_history) appendDeveloper(policyMessage(item));
      if (inspected.decodeFault) inspected.decodeFault.replacement = true;
    } else if (row.type === 'world_state' && object(payload.state)) {
      if (payload.full) {
        inspected.world = {};
        if (inspected.decodeFault) inspected.decodeFault.world = true;
      }
      const state = payload.state;
      for (const [name, field] of [['agents_md', 'text'], ['permissions', 'instructions'], ['model', 'instructions'], ['collaboration_mode', 'instructions']] as const) {
        if (!(name in state)) continue;
        const text = state[name]?.[field];
        if (typeof text === 'string') inspected.world[name] = clean(text);
        else if (text === null || state[name] === null) delete inspected.world[name];
      }
      if ('managed_developer_instructions' in state) {
        const value = state.managed_developer_instructions;
        if (Array.isArray(value) && value.every(item => typeof item === 'string')) inspected.world.managed = clean(value.join('\n'));
        else if (value && Object.keys(value).length) inspected.incomplete = 'Native host developer policy uses an unsupported metadata shape.';
      }
    }
    // A full native compaction records the retained developer context; a subsequent full world
    // snapshot records effective policy layers. Together they recover current policy after an
    // old malformed record, without recovering or importing any historical conversation.
    if (inspected.base && inspected.decodeFault?.replacement && inspected.decodeFault.world) delete inspected.decodeFault;
  };
  let unfinished = false;
  try {
    const file = await open(cursor.path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== cursor.dev || info.ino !== cursor.ino || info.size < cursor.offset) throw new Error('changed');
    } finally { await file.close(); }
    if (inspected.offset < cursor.offset) {
      const started = Date.now(), deadline = options.budgetMs ?? 1500;
      const replayFrom = options.runtime === 'claude-code' ? inspected.claudeWire?.replayFrom : undefined;
      if (Number.isSafeInteger(replayFrom) && replayFrom! >= 0 && replayFrom! < inspected.offset) {
        if (inspected.offset - replayFrom! > 64 * 1024 * 1024) throw new Error('native-replay-limit');
        // Native request logs omit blobs already represented by ordinary transcript messages.
        // Rehydrate only the pending canonical hash across a checkpoint, never persisted dialogue.
        const replay = createReadStream(cursor.path, { start: replayFrom!, end: inspected.offset - 1, highWaterMark: 64 * 1024 });
        let bytes = Buffer.alloc(0), offset = replayFrom!;
        try {
          for await (const chunk of replay) {
            bytes = Buffer.concat([bytes, chunk as Buffer]);
            let newline: number;
            while ((newline = bytes.indexOf(10)) >= 0) {
              const line = bytes.subarray(0, newline);
              if (line.length > 16 * 1024 * 1024) throw new Error('oversized');
              if (line.length) {
                const row = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(line));
                if (object(row) && !row.isSidechain && !row.agentId && (!options.sessionId || !row.sessionId || row.sessionId === options.sessionId)
                  && ['user', 'assistant', 'attachment'].includes(row.type))
                  inspected.claudeWire = updateClaudeWire(inspected.claudeWire, row, { promptId: inspected.claudePrompt, redact: clean, recordOffset: offset });
              }
              offset += newline + 1; bytes = bytes.subarray(newline + 1);
            }
            if (bytes.length > 16 * 1024 * 1024) throw new Error('oversized');
            if (Date.now() - started >= deadline) { unfinished = offset < inspected.offset; break; }
          }
          if (bytes.length) unfinished = true;
        } finally { replay.destroy(); }
      }
      const stream = createReadStream(cursor.path, { start: inspected.offset, end: cursor.offset - 1, highWaterMark: 64 * 1024 });
      let pending = Buffer.alloc(0), skipped = 0;
      try {
        for await (const chunk of stream) {
          if (unfinished) break;
          pending = Buffer.concat([pending, chunk as Buffer]);
          let newline: number;
          while ((newline = pending.indexOf(10)) >= 0) {
            const line = pending.subarray(0, newline);
            if (!skipped && line.length) {
              try { record(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(line)), inspected.offset); }
              catch {
                if (options.runtime === 'codex') inspected.decodeFault = { replacement: false, world: false };
                else inspected.incomplete = 'A native policy transcript record could not be decoded.';
              }
            }
            inspected.offset += skipped + newline + 1;
            skipped = 0;
            pending = pending.subarray(newline + 1);
          }
          if (pending.length > 16 * 1024 * 1024) {
            skipped += pending.length; pending = Buffer.alloc(0);
            inspected.incomplete = 'A native policy transcript record exceeds the inspection limit.';
          }
          if (Date.now() - started >= deadline) { unfinished = inspected.offset < cursor.offset; break; }
        }
      } finally { stream.destroy(); }
      if (pending.length || skipped) unfinished = true;
    }
  } catch (error) { inspected.incomplete = error instanceof Error && error.message === 'native-replay-limit'
    ? 'Native pending message reconstruction exceeds the 64 MiB inspection limit.' : 'Native session policy metadata could not be read.'; }
  if (options.cachePath) await writePrivateJson(options.cachePath, inspected);
  let text: string;
  let incomplete = inspected.incomplete ?? (inspected.decodeFault ? 'A native policy transcript record could not be decoded and current policy has not been restored.' : undefined);
  let instructionsCaptured = inspected.claudeInstructionsComplete, wireCaptured = false;
  if (options.runtime === 'claude-code') {
    const first = options.turnId && inspected.claudeFirst?.prompt === options.turnId ? inspected.claudeFirst : undefined;
    const currentWire = inspected.claudeWire?.current;
    const wire = first ? first.wire : currentWire && currentWire.prompt === inspected.claudePrompt ? currentWire : undefined;
    wireCaptured = wire?.complete === true && !inspected.claudePromptWireIncomplete;
    const system = first?.systemPrompt ?? inspected.claude?.systemPrompt;
    const instructionFiles = first ? first.instructions : inspected.claudeInstructions;
    instructionsCaptured = first ? first.instructionsComplete : inspected.claudeInstructionsComplete;
    text = system ? `Native Claude system policy (recorded prompt snapshot):\n${system.join('\n\n')}` : '';
    if (wireCaptured) text = !inspected.claudePromptChanged && currentWire?.complete && currentWire.prompt === options.turnId
      ? currentWire.text : wire!.text;
    if (options.requireWire && !wireCaptured) incomplete ??= inspected.claudePromptWireIncomplete ?? wire?.reason ?? 'The native request system/developer policy was not recorded completely.';
    const context = first ? first.context : inspected.claudeContext;
    if (context) text += `\n\nNative lower-trust session context (user role, not standing system instructions):\n${context}`;
    if (instructionsCaptured) text += '\n\n' + Object.entries(instructionFiles ?? {}).map(([path, file]) => `Native loaded ${file.type} instructions (${path}):\n${file.content}`).join('\n\n');
    if (!system || inspected.invalidated || first?.invalidated) incomplete ??= CLAUDE_SNAPSHOT_PENDING;
    if (options.turnId && inspected.claudePromptChanged) incomplete ??= 'Native loaded policy changed during this prompt; automatic promotion is disabled.';
    if (options.turnId && inspected.claudePrompt !== options.turnId) incomplete ??= 'Native Claude policy does not belong to the completed prompt.';
  } else {
    text = [`Native Codex system policy:\n${inspected.base}`, ...inspected.developer.map(text => `Native developer policy:\n${text}`), ...Object.entries(inspected.world).map(([name, text]) => `Native ${name} policy:\n${text}`)].join('\n\n');
    if (!inspected.base) incomplete ??= 'Codex native system policy was not recorded in the transcript.';
  }
  if ((unfinished || inspected.offset < cursor.offset) && !inspected.incomplete) incomplete = 'Native policy inspection is checkpointed and not yet complete.';
  return { text, scannedBytes: inspected.offset, totalBytes: cursor.offset, ...(incomplete ? { incomplete } : {}), ...(instructionsCaptured ? { instructionsCaptured: true } : {}), ...(wireCaptured ? { wireCaptured: true } : {}) };
}

/** Existing native discovery checks imports/configuration coverage. The active transcript supplies the actual
 * session policy, including CLI-only system overrides, without uploading config values or historical conversation. */
export async function captureSourcePolicy(options: {
  runtime: CliLearningRuntime; project: string; cursor: TranscriptCursor | null;
  env: NodeJS.ProcessEnv; redact: (text: string) => string; sessionId?: string; turnId?: string; cachePath?: string;
  pinnedStanding?: NativeInstructionSnapshot;
}): Promise<NativeInstructionSnapshot & { sourceStanding: NativeInstructionSnapshot }> {
  let withheld = false;
  const redact = (text: string) => { const value = options.redact(text); withheld ||= value !== text; return value; };
  let standing = options.pinnedStanding;
  if (!standing) {
    const target = (await discoverNative({ runtime: options.runtime, project: options.project, env: options.env })).targets.find(target => target.selector.kind === 'project');
    if (!target) throw new Error('The source CLI project could not be discovered.');
    standing = await snapshotNativeInstructions(target, redact);
  }
  const recorded = await readTranscriptPolicy({ runtime: options.runtime, cursor: options.cursor, sessionId: options.sessionId, turnId: options.turnId, requireWire: options.runtime === 'claude-code' && Boolean(options.turnId), cachePath: options.cachePath, redact });
  // The active Codex system/developer envelopes cover CLI configuration-supplied prompt text. Other
  // discovery failures (unreadable files or unresolved sources) remain explicit refusal conditions.
  const coveredOverride = !recorded.incomplete && options.runtime === 'codex'
    && standing.incomplete === 'Codex configuration can supply custom policy outside the captured standing instruction files.';
  const coveredImports = options.runtime === 'claude-code' && recorded.instructionsCaptured && !recorded.incomplete
    && standing.incomplete === CLAUDE_IMPORTS_PENDING;
  // Claude's typed instruction attachments are what its native renderer actually loaded. This
  // includes imports and exact per-session revisions, without reading unrelated settings values.
  const standingText = coveredImports ? 'Native loaded instructions below are source policy evidence for the learning grader.' : coveredOverride ? standing.text.replace(`\n\n[Incomplete native instruction evidence: ${standing.incomplete} Automatic learning cannot promote a proposal from this snapshot.]`, '') : standing.text;
  const text = [standingText, recorded.text].filter(Boolean).join('\n\n');
  const incomplete = (coveredOverride || coveredImports ? undefined : standing.incomplete) ?? recorded.incomplete
    ?? (withheld ? 'Source policy contains withheld or redacted text.' : undefined);
  const oversized = Buffer.byteLength(text) > CLI_POLICY_BYTES;
  return { ...standing, sourceStanding: standing, text: oversized ? 'The source policy exceeds the CLI grading limit; automatic promotion is disabled.' : text,
    truncated: standing.truncated || oversized, incomplete };
}

export async function readCodexPolicy(cursor: TranscriptCursor | null) {
  return readTranscriptPolicy({ runtime: 'codex', cursor });
}
