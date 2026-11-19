import type { SessionReader } from 'eve/sessions';
import { createHash } from 'node:crypto';
import { callOutputSource, calls, emptySessionView, foldEvents, parts, reply, runs, turn } from 'eve/events';
import type { SdkLearningEvent, SdkLearningOutcome } from '@parcha/agentrun-client/learning';
import { readWorkflowResult, type WorkflowEvidenceScope, type WorkflowToolResult } from './workflow-evidence.js';

export interface TurnEvidence {
  settled: boolean;
  events: SdkLearningEvent[];
  /** Original tool payloads for shadow comparison only; never upload these as telemetry. */
  nativeEvents?: SdkLearningEvent[];
  outcome?: SdkLearningOutcome;
  complete: boolean;
  reason?: string;
}
type ReaderEvent = ReturnType<SessionReader['stream']> extends AsyncIterable<infer Event> ? Event : never;
const MAX_EVENTS = 10_000, MAX_HISTORY_BYTES = 4_000_000, MAX_TEXT = 128_000, READ_MS = 10_000;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Read recorded facts only; this never follows live work or launches an Eve task. */
export async function collectTurn(reader: SessionReader, turnId: string, startIndex = 0, workflow?: WorkflowEvidenceScope, captureNative = false): Promise<TurnEvidence> {
  if (!identifier(reader.id) || !identifier(turnId) || !Number.isSafeInteger(startIndex) || startIndex < 0)
    return unavailable('invalid_history_request');
  const records: ReaderEvent[] = [];
  const seen = new Map<string, string>();
  const controller = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('history_timeout')), { once: true });
  });
  // A synchronous stream-construction failure can precede the first race's subscription.
  void timeout.catch(() => undefined);
  const timer = setTimeout(() => controller.abort(), READ_MS);
  let iterator: AsyncIterator<ReaderEvent> | undefined;
  let bytes = 0, readCount = 0, reason: string | undefined;
  let expectedLine = startIndex, lastLine = -1, lastIndex = -1;
  const incomplete = (why: string) => { reason ??= why; };
  try {
    iterator = reader.stream({ startIndex, follow: false, signal: controller.signal })[Symbol.asyncIterator]();
    while (true) {
      const item = await Promise.race([iterator.next(), timeout]);
      if (item.done) break;
      const event = item.value;
      const encoded = JSON.stringify(event);
      bytes += Buffer.byteLength(encoded);
      if (bytes > MAX_HISTORY_BYTES || ++readCount > MAX_EVENTS) return unavailable('history_limit');
      const { line, index } = event.meta.position;
      if (!Number.isSafeInteger(line) || line < startIndex || !Number.isSafeInteger(index) || index < 0)
        return unavailable('invalid_history_position');
      const key = `${line}:${index}`, digest = createHash('sha256').update(encoded).digest('hex');
      const prior = seen.get(key);
      if (prior) {
        if (prior !== digest) return unavailable('conflicting_history');
        continue;
      }
      seen.set(key, digest);
      if (line < lastLine || line === lastLine && index <= lastIndex) return unavailable('unordered_history');
      if (line > expectedLine || line !== lastLine && index !== 0 || line === lastLine && index !== lastIndex + 1)
        incomplete('history_gap');
      if (line !== lastLine && records.at(-1)?.meta.endOfLine === false) incomplete('partial_history_commit');
      lastLine = line; lastIndex = index;
      const terminal = event.type === 'turn.settled' && event.data.turnId === turnId;
      // Eve closes model/tool work before turn.settled; delivery housekeeping can follow on this same
      // line. Fold that finite turn prefix without waiting for housekeeping or changing the source fact.
      records.push(terminal ? { ...event, meta: { ...event.meta, endOfLine: true } } : event);
      expectedLine = event.meta.endOfLine === false ? line : Math.max(line + 1, event.meta.next ?? line + 1);
      if (terminal) break;
    }
  } catch {
    return unavailable(controller.signal.aborted ? 'history_timeout' : 'history_unavailable');
  } finally {
    clearTimeout(timer);
    controller.abort();
    // A reader ignoring cancellation must not hold this bounded collection open.
    try { void iterator?.return?.().catch(() => undefined); } catch { /* Cleanup cannot replace the evidence result. */ }
  }
  if (records.at(-1)?.meta.endOfLine === false) incomplete('partial_history_commit');
  const view = foldEvents(emptySessionView(), records);
  const recorded = turn(view, turnId);
  const starts = records.filter(event => event.type === 'turn.started' && event.data.turnId === turnId);
  if (starts.length !== 1) incomplete(starts.length ? 'duplicate_turn_start' : 'missing_turn_start');
  for (const event of starts) if (event.type === 'turn.started' && event.data.follows !== null) incomplete('prior_context_unsupported');
  const settled = recorded?.status === 'settled';
  if (!settled) incomplete('missing_turn_settlement');
  const turnRuns = runs(view, { turnId }), runIds = new Set(turnRuns.map(run => run.runId));
  const turnCalls = calls(view, { turnId }), callById = new Map(turnCalls.map(call => [call.callId, call]));
  const bridged = new Map<string, WorkflowToolResult>();
  if (workflow) for (const call of turnCalls) {
    try {
      const result = readWorkflowResult(callOutputSource(view, call.callId)?.output, workflow, call.callId);
      if (result) {
        if (call.name !== workflow.toolName) throw new Error('invalid_workflow_evidence');
        bridged.set(call.callId, result);
        if (!result.agentrun.complete || result.isError || call.outcome !== 'completed') incomplete('workflow_incomplete');
      } else if (call.name === workflow.toolName) incomplete('workflow_evidence_unavailable');
    } catch { incomplete('workflow_evidence_invalid'); }
  }
  const textById = new Map(parts(view, { turnId, kind: 'text' }).map(part => [part.partId, part]));
  const events: SdkLearningEvent[] = [{ type: 'session', session_id: reader.id }];
  const nativeEvents: SdkLearningEvent[] = [];
  const inputs = new Map(records.flatMap(event => event.type === 'call.requested' && !event.data.inputRef ? [[event.data.callId, event.data.input] as const] : []));
  const models = new Set<string>();
  const requestedCalls = new Set<string>(), startedCalls = new Set<string>(), finishedCalls = new Set<string>();
  let deliveries = 0, textLength = 0;
  const startsByRun = new Map<string, number>();
  const usageByRun = new Map<string, Array<Partial<Record<'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd', number>>>>();
  for (const event of records) {
    const owned = event.scope?.turnId === turnId;
    if (event.type === 'session.started' && event.data.parent) incomplete('child_work_unsupported');
    if (owned && (event.type === 'child.opened' || event.type === 'task.started' && event.data.kind !== 'tool')) incomplete('child_work_unsupported');
    if (event.type === 'call.requested' && callById.has(event.data.callId)) {
      requestedCalls.add(event.data.callId);
      if ('callId' in event.data.owner) incomplete('child_work_unsupported');
      if (event.data.inputRef) incomplete('tool_payload_unavailable');
    }
    if (event.type === 'delivery.consumed' && event.data.turnId === turnId) {
      if (++deliveries > 1) incomplete('steering_unsupported');
      if (event.data.history?.length || event.data.parts.some(part => part.kind !== 'text')) incomplete('input_context_unsupported');
    }
    if (event.type === 'model.started' && runIds.has(event.data.runId)) {
      if (identifier(event.data.modelId)) models.add(event.data.modelId); else incomplete('invalid_model');
      startsByRun.set(event.data.runId, (startsByRun.get(event.data.runId) ?? 0) + 1);
    }
    if (event.type === 'usage.recorded' && event.data.owner && 'runId' in event.data.owner && runIds.has(event.data.owner.runId)) {
      const id = event.data.owner.runId;
      usageByRun.set(id, [...usageByRun.get(id) ?? [], event.data.usage]);
    }
    if (event.type === 'call.started' || event.type === 'call.settled') {
      const call = callById.get(event.data.callId);
      if (!call) { if (owned) incomplete('tool_lifecycle_incomplete'); continue; }
      if (call.kind !== 'tool') { incomplete('child_work_unsupported'); continue; }
      if (!identifier(call.callId) || !identifier(call.name)) { incomplete('invalid_tool_identity'); continue; }
      const seen = event.type === 'call.started' ? startedCalls : finishedCalls;
      if (seen.has(call.callId)) { incomplete('tool_lifecycle_incomplete'); continue; }
      seen.add(call.callId);
      if (event.type === 'call.settled' && event.data.outcome === 'completed' && !startedCalls.has(call.callId)) incomplete('tool_lifecycle_incomplete');
      if (event.type === 'call.settled' && (event.data.outcome === 'interrupted' || event.data.outcome === 'abandoned')) incomplete('tool_outcome_unknown');
      if (event.type === 'call.settled') {
        const source = callOutputSource(view, call.callId);
        if (event.data.outputRef || event.data.outputOf && (!source || source.outcome !== 'completed' || source.outputRef)) incomplete('tool_payload_unavailable');
      }
      const bridge = bridged.get(call.callId);
      if (bridge) {
        // Keep the native interval, replacing only the positively attested bridge envelope with
        // the original MCP parent/child lifecycle. Arguments/results remain in eve, not telemetry.
        const trace = bridge.agentrun.events;
        events.push(...(event.type === 'call.started' ? trace.slice(0, 1) : trace.slice(1)));
      } else {
        const name = workflow?.aliases.find(alias => alias.nativeName === call.name)?.name ?? call.name;
        const fact: SdkLearningEvent = { type: 'tool', id: call.callId, name,
          status: event.type === 'call.started' ? 'started' : event.data.outcome === 'completed' ? 'completed' : 'failed' };
        events.push(fact);
        const output = event.type === 'call.settled' ? callOutputSource(view, call.callId)?.output : undefined;
        if (captureNative) nativeEvents.push({ ...fact, ...(inputs.has(call.callId) ? { input: inputs.get(call.callId) } : {}),
          ...(output === undefined ? {} : { output }) });
      }
    }
    if (event.type === 'content.completed' && textById.has(event.data.partId)) {
      const part = textById.get(event.data.partId)!;
      if (part.valueRef || typeof part.value !== 'string') { incomplete('text_unavailable'); continue; }
      textLength += part.value.length;
      if (textLength > MAX_TEXT) { incomplete('text_limit'); continue; }
      events.push({ type: 'text', text: part.value });
    }
  }
  if (!deliveries) incomplete('missing_turn_input');
  for (const run of turnRuns) if (!startsByRun.has(run.runId) || run.status !== 'settled') incomplete('model_lifecycle_incomplete');
  for (const call of turnCalls) if (!requestedCalls.has(call.callId) || !finishedCalls.has(call.callId)) incomplete('tool_lifecycle_incomplete');
  const terminal = records.find(event => event.type === 'turn.settled' && event.data.turnId === turnId);
  const selected = reply(view, turnId);
  if (terminal?.type === 'turn.settled' && selected.length !== (terminal.data.reply?.length ?? 0)) incomplete('reply_unavailable');
  let answer = '';
  for (const part of selected) {
    if (part.kind !== 'text' || part.valueRef || part.interrupted || typeof part.value !== 'string') { incomplete('reply_unavailable'); continue; }
    answer += (answer ? '\n' : '') + part.value;
  }
  if (answer.length > MAX_TEXT) { answer = ''; incomplete('answer_limit'); }
  if (recorded?.outcome === 'completed' && !selected.length) incomplete('missing_reply');
  const allUsage = turnRuns.flatMap(run => usageByRun.get(run.runId) ?? []);
  const usageCovered = turnRuns.length > 0 && turnRuns.every(run => (usageByRun.get(run.runId)?.length ?? 0) >= (startsByRun.get(run.runId) ?? 1));
  const counter = (key: keyof (typeof allUsage)[number], decimal = false) => {
    if (!usageCovered || !allUsage.length || allUsage.some(row => row[key] === undefined)) return null;
    const values = allUsage.map(row => row[key]!);
    if (values.some(value => !Number.isFinite(value) || value < 0 || !decimal && !Number.isSafeInteger(value))) { incomplete('invalid_usage'); return null; }
    const sum = values.reduce((total, value) => total + value, 0);
    if (!Number.isFinite(sum) || !decimal && !Number.isSafeInteger(sum)) { incomplete('invalid_usage'); return null; }
    return sum;
  };
  const input = counter('inputTokens'), read = counter('cacheReadTokens'), write = counter('cacheWriteTokens');
  const uncached = input !== null && read !== null && write !== null && input >= read + write ? input - read - write : null;
  if (input !== null && read !== null && write !== null && input < read + write) incomplete('invalid_usage');
  const usage = { input_tokens: uncached, output_tokens: counter('outputTokens'), cache_read_tokens: read,
    cache_write_tokens: write, cost_usd: counter('costUsd', true) };
  if (!settled) return { settled: false, complete: false, events, reason };
  const status = recorded.outcome;
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') incomplete('unknown_turn_outcome');
  return { settled: true, complete: reason === undefined, events, ...(captureNative ? { nativeEvents } : {}),
    ...(reason ? { reason } : {}),
    outcome: { status: status === 'completed' || status === 'cancelled' ? status : 'failed', answer, session_id: reader.id,
      ...(status === 'failed' ? { error: 'The original Eve turn failed. Inspect its source session.' } : {}),
      ...(models.size === 1 ? { model: [...models][0] } : {}),
      usage } };
}

function unavailable(reason: string): TurnEvidence {
  return { settled: false, events: [], complete: false, reason };
}
