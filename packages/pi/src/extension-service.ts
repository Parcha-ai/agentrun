import { types as utilTypes } from 'node:util';
import { JevError, isJevResponseReason } from '@parcha/agentrun-jev';
import { PiRunError } from './runner.js';
import { ToolInputValidationError } from './tool-input-error.js';
import {
  inspectWorkflow, runWorkflow, validateWorkflow, candidatePolicyErrors, EffectOutcomeUnknownError,
  WorkflowInvalidError, WorkflowInputInvalidError, WorkflowOutputInvalidError, WorkflowCodeError, WorkflowStateError, EffectDeadlineExceededError,
  type Workflow, type WorkflowDeps, type WorkflowInspection, type Escalation,
} from '@parcha/agentrun-dsl';

type Event = Parameters<NonNullable<WorkflowDeps['onEvent']>>[0];
type Counts = { agent: number; judge: number; tool: number };
export interface ExtensionServiceLimits {
  /** null disables a host admission/deadline limit; omission retains defaults. */
  deadlineMs: number | null;
  maxAgentCalls: number | null;
  maxJudgeCalls: number | null;
  maxToolCalls: number | null;
  maxConcurrency: number;
  /** Retained sanitized event bytes, not an execution limit. Old events may be omitted. */
  maxTraceBytes: number;
  /** Independent per-event JSON safety limit; exceeding it fails closed. */
  maxEventBytes: number;
}
export interface ExtensionServiceOptions {
  allowedTools?: readonly string[];
  rubricSections?: Record<string, string>;
  limits?: Partial<ExtensionServiceLimits>;
}
export interface PreparedWorkflow {
  digest: string;
  inspection: WorkflowInspection;
  workflow: Workflow;

  executableAuthorized: boolean;
}
export interface ExtensionRunReport {
  digest: string;
  status: 'complete' | 'escalated' | 'failed' | 'interrupted';
  calls: Counts;
  events: Event[];
  output?: unknown;
  escalation?: Pick<Escalation, 'kind' | 'stage' | 'summary' | 'label' | 'executionPath'>;
  error?: { code: string; message: string; stage?: string; path?: string; reason?: string; status?: number; problems?: string[]; stateBytes?: number; maxStateBytes?: number };
  uncertainEffects?: { idempotencyKey: string; executionPath?: string; outcome: 'unknown' }[];
  traceTruncated?: boolean;
  /** Received counts include validated events only; rejected events have no safe byte size. */
  trace?: {
    policy: 'tail';
    receivedEvents: number;
    receivedBytes: number;
    rejectedEvents: number;
    retainedEvents: number;
    retainedBytes: number;
    droppedEvents: number;
    droppedBytes: number;
  };
}
export interface ExtensionRunOptions {
  deps: WorkflowDeps;
  signal?: AbortSignal;
  /** Best-effort UI observation; suppressed after cancellation/disposal. */
  onEvent?: (event: Event) => unknown;
  /** Full sanitized valid stream, including cleanup before closure. Nonfatal;
   * host owns persistence failures and any asynchronous queue/drain. */
  onTraceEvent?: (event: Event) => unknown;
}
export class ExtensionServiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ExtensionServiceError'; }
}
const ceilings = {
  deadlineMs: 600_000, maxAgentCalls: 50, maxJudgeCalls: 100, maxToolCalls: 100,
  maxConcurrency: 8, maxTraceBytes: 2 * 1024 * 1024, maxEventBytes: 2 * 1024 * 1024,
} satisfies ExtensionServiceLimits;
const defaults: ExtensionServiceLimits = { ...ceilings, deadlineMs: 120_000, maxConcurrency: 4, maxTraceBytes: 1024 * 1024, maxEventBytes: 1024 * 1024 };
export const extensionStructuralLimits = Object.freeze({ maxNodes: 200, maxMapConcurrency: 8, maxParallelBranches: 8 });

// Never expose arbitrary error.message/cause, provider bodies or submitted values.
class AdapterDiagnosticError extends Error {
  constructor(readonly diagnostic: NonNullable<ExtensionRunReport['error']>) {
    super(diagnostic.message);
    this.name = 'AdapterDiagnosticError';
  }
}
async function withAdapterDiagnostic<T>(stage: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    let diagnostic: ExtensionRunReport['error'];
    if (error instanceof JevError) {
      switch (error.code) {
        case 'invalid_response': diagnostic = { code: 'jev_invalid_response', message: 'Jev returned a response that failed the adapter contract. No judgment was accepted; provider details are omitted.' }; break;
        case 'http': diagnostic = { code: 'jev_http', message: 'Jev returned an HTTP failure. No judgment was accepted; provider details are omitted.' }; break;
        case 'connection': diagnostic = { code: 'jev_connection', message: 'Jev transport failed before an accepted judgment. Provider details are omitted.' }; break;
        case 'timeout': diagnostic = { code: 'jev_timeout', message: 'The Jev adapter deadline expired before an accepted judgment. Provider details are omitted.' }; break;
      }
      if (diagnostic) {
        const reason = error.responseDiagnostic?.reason;
        if (error.code === 'invalid_response' && isJevResponseReason(reason) && reason !== 'max_tokens_exceeded') diagnostic.reason = reason;
        if (error.code === 'http') {
          if (Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599) diagnostic.status = error.status;
          if (reason === 'max_tokens_exceeded') diagnostic.reason = reason;
        }
      }
    } else if (error instanceof PiRunError) {
      switch (error.reason) {
        case 'model_error': diagnostic = { code: 'model_response_failed', message: 'The model session reported a response failure before an accepted submission. Provider details are omitted.' }; break;
        case 'timeout': diagnostic = { code: 'pi_timeout', message: 'The Pi node deadline expired before an accepted submission. Check slow tools or increase the host node timeout.' }; break;
        case 'turn_limit': diagnostic = { code: 'pi_turn_limit', message: 'The Pi node reached its turn limit before an accepted submission. Simplify the task or increase the host node turn limit.' }; break;
        case 'submission_limit': diagnostic = { code: 'pi_submission_limit', message: 'The Pi node exhausted its submission attempts. Correct schema or review rejections before retrying.' }; break;
        case 'no_submission': diagnostic = { code: 'pi_no_submission', message: 'The Pi node ended without an accepted submission. The model must call submit with a result that passes the schema and review.' }; break;
        case 'aborted': diagnostic = { code: 'pi_aborted', message: 'The Pi node was cancelled before an accepted submission. Check any effects already started before retrying.' }; break;
      }
    }
    if (diagnostic) throw new AdapterDiagnosticError({ ...diagnostic, stage: stage.slice(0, 200) });
    // Adapter-created runtime errors are not interpreter-owned diagnostics.
    if (error instanceof WorkflowInputInvalidError || error instanceof WorkflowOutputInvalidError
      || error instanceof WorkflowInvalidError || error instanceof WorkflowStateError || error instanceof WorkflowCodeError) {
      throw new Error('Host adapter failed.', { cause: error });
    }
    throw error;
  }
}
function localDiagnostic(error: unknown): ExtensionRunReport['error'] {
  if (error instanceof AggregateError) return error.errors.slice(0, 100).map(localDiagnostic).find(Boolean);
  if (error instanceof AdapterDiagnosticError) return error.diagnostic;
  if (error instanceof ToolInputValidationError) return {
    code: error.code, stage: error.stage,
    message: 'Tool arguments do not satisfy the registered input schema. Correct the listed schema problems before retrying; the tool implementation was not called.',
    problems: error.problems,
  };
  if (error instanceof WorkflowStateError) {
    const messages: Record<WorkflowStateError['reason'], string> = {
      required_nonempty: 'A required state path is missing or has no concrete value. requires is a nonempty-evidence guard, not just a field-existence check. Handle empty evidence explicitly.',
      missing_interpolation: 'An interpolation path is absent. Check the upstream output schema and as/resultPath wrapping; no adapter was called for this failed binding.',
      expected_list: 'The selected state path must contain an array. Check the upstream output and map resultPath.',
      empty_selection: 'The selection list is empty and none is not allowed. Handle missing evidence explicitly.',
      missing_map_result: 'A map body did not produce its resultPath. Select a path in the completed body state; a body with as is collected automatically when resultPath is omitted.',
      parallel_write_conflict: 'Parallel branches changed the same top-level state key. Give independent branches distinct output keys and combine them after the parallel node.',
      reserved_state_key: 'A node or host hook wrote an engine-owned "$"-prefixed state key such as $host. Choose another state key; host state is written only through decodeSubmission.',
    };
    return { code: error.code, stage: error.stage.slice(0, 200),
      // Parallel patch keys may be computed from source values, unlike authored paths.
      ...(error.reason === 'parallel_write_conflict' ? {} : { path: error.path.slice(0, 500) }),
      reason: error.reason, message: messages[error.reason] };
  }
  if (error instanceof JevError && error.code === 'invalid_request' && error.attempts === 0 && error.requestDiagnostic) {
    const { reason, label, stateBytes, maxStateBytes } = error.requestDiagnostic;
    const stage = typeof label === 'string' ? label.slice(0, 200) : 'judge';
    if (reason === 'state_too_large' && Number.isSafeInteger(stateBytes) && Number.isSafeInteger(maxStateBytes)
      && stateBytes! > maxStateBytes! && maxStateBytes! > 0) return {
      code: 'jev_state_too_large', stage, stateBytes, maxStateBytes,
      message: `Jev state at ${stage} is ${stateBytes} UTF-8 bytes; configured host limit is ${maxStateBytes}. No request was sent. A sift batches every item in one state; select original context explicitly or use per-item judgments without losing headers or qualifiers.` };
    if (reason === 'invalid_state' || reason === 'invalid_questions') return { code: `jev_${reason}`, stage,
      message: reason === 'invalid_state' ? 'Jev state must be JSON-serializable text, an object, an array or null. No request was sent.'
        : 'Jev needs a nonempty JSON question map. No request was sent.' };
  }
  // Trusted validation can invoke authored factories; its free-form problems may contain thrown text.
  if (error instanceof WorkflowInvalidError) return { code: error.code, stage: error.stage,
    message: 'Workflow validation failed. Inspect the graph for contract errors; trusted factory error details are omitted.' };
  if (error instanceof WorkflowOutputInvalidError) {
    return { code: error.code, stage: error.stage.slice(0, 200),
      message: `Workflow contract failed at ${error.stage.slice(0, 200)}. Correct the listed contract problems before retrying.`,
      problems: error.problems.slice(0, 8).map(problem => problem.slice(0, 500)) };
  }
  if (error instanceof WorkflowCodeError) return { code: error.code, stage: error.stage.slice(0, 200),
    message: `Code transform failed at ${error.stage.slice(0, 200)}. Check state paths, synchronous function syntax and supported globals; thrown details are omitted.` };
  if (error instanceof EffectDeadlineExceededError || error instanceof EffectOutcomeUnknownError) return {
    code: error.code, stage: error.stage.slice(0, 200), message: 'A tool effect exceeded its deadline or did not settle. Reconcile its outcome before retrying.' };
  return undefined;
}

function snapshot(value: unknown, maxBytes = 512 * 1024): any {
  const ancestors = new Set<object>();
  let values = 0, bytes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++values > 100_000 || depth > 128) throw new ExtensionServiceError('bounds', 'JSON data exceeds the depth or value limit.');
    if (typeof item === 'string') bytes += Buffer.byteLength(item, 'utf8');
    else bytes += 8;
    if (bytes > maxBytes) throw new ExtensionServiceError('bounds', 'JSON data exceeds the byte limit.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || utilTypes.isProxy(item)) throw new ExtensionServiceError('data', 'Only plain JSON data is accepted.');
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) throw new ExtensionServiceError('data', 'Only plain JSON objects and arrays are accepted.');
    if (ancestors.has(item)) throw new ExtensionServiceError('data', 'JSON data cannot contain cycles.');
    if (Object.getOwnPropertySymbols(item).length) throw new ExtensionServiceError('data', 'JSON data cannot contain symbols.');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some(entry => entry.get || entry.set)) throw new ExtensionServiceError('data', 'JSON data cannot contain accessors.');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > 100_000) throw new ExtensionServiceError('bounds', 'Array exceeds the value limit.');
        return Array.from({ length: item.length }, (_, index) => visit(descriptors[index]?.value, depth + 1));
      }
      return Object.fromEntries(Object.entries(descriptors).filter(([, entry]) => entry.enumerable).map(([key, entry]) => {
        bytes += Buffer.byteLength(key, 'utf8');
        return [key, visit(entry.value, depth + 1)];
      }));
    } finally { ancestors.delete(item); }
  };
  return visit(value, 0);
}
function freeze(value: any): any {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// Events are independently bounded before retention. Reapplying the input's
// depth/value-count limits to their aggregate would reintroduce a cumulative
// execution limit even when retained bytes fit.
function snapshotReport(report: ExtensionRunReport, maxEventBytes: number): ExtensionRunReport {
  const { events, ...rest } = report;
  return { ...snapshot(rest, 4 * 1024 * 1024), events: events.map(event => snapshot(event, maxEventBytes)) };
}
const secretKey = /^(?:error|message|cause|stack|headers|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credentials?|model)$/i;
function sanitize(value: any): any {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, entry]) => [key, sanitize(entry)]));
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export class WorkflowExtensionService {
  private readonly allowedTools: ReadonlySet<string>;
  private readonly rubricSections: Record<string, string>;
  private readonly limits: ExtensionServiceLimits;
  private current?: PreparedWorkflow;
  private lastReport?: ExtensionRunReport;
  private disposed = false;
  private active?: { controller: AbortController; done: Promise<void> };

  constructor(options: ExtensionServiceOptions = {}) {
    const tools = options.allowedTools ?? [];
    if (!Array.isArray(tools) || tools.length > 100 || tools.some(tool => typeof tool !== 'string' || !tool.trim() || tool.length > 200)) throw new ExtensionServiceError('configuration', 'Provide at most 100 registered tool names.');
    this.allowedTools = new Set(tools);
    this.rubricSections = freeze(snapshot(options.rubricSections ?? {}));
    if (Object.entries(this.rubricSections).some(([name, text]) => !name.trim() || typeof text !== 'string' || !text.trim())) throw new ExtensionServiceError('configuration', 'Rubric sections require nonempty names and text.');
    this.limits = { ...defaults, ...options.limits };
    for (const key of Object.keys(ceilings) as (keyof ExtensionServiceLimits)[]) {
      const value = this.limits[key];
      if (value === null && ['deadlineMs', 'maxAgentCalls', 'maxJudgeCalls', 'maxToolCalls'].includes(key)) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > ceilings[key]) throw new ExtensionServiceError('configuration', `${key} must be an integer from 1 to ${ceilings[key]}, or null for a deadline/call limit.`);
    }
  }
  private available(): void { if (this.disposed) throw new ExtensionServiceError('disposed', 'This workflow session is disposed.'); }
  private idle(): void { this.available(); if (this.active) throw new ExtensionServiceError('busy', 'Stop the current workflow before starting or preparing another.'); }

  private check(value: unknown, options: { allowExecutableCandidates?: boolean; executeCode?: boolean; input?: Record<string, unknown> }): { workflow: Workflow; inspection: WorkflowInspection } {
    const workflow = snapshot(value) as Workflow;
    const inspection = inspectWorkflow(workflow);
    if (inspection.nodes.length > extensionStructuralLimits.maxNodes) throw new ExtensionServiceError('bounds', 'A workflow may contain at most 200 nodes.');
    const errors = candidatePolicyErrors(workflow, { allowExecutableCandidates: options.allowExecutableCandidates === true, rubricSections: this.rubricSections, allowedEffectTools: [...this.allowedTools] });
    for (const entry of inspection.nodes) {
      const node = entry.path.split('/').slice(1).reduce<any>((item, key) => item[key.replace(/~1/g, '/').replace(/~0/g, '~')], workflow);
      if (node.node === 'artifact') errors.push('Artifact delivery is not available in this extension.');
      if (node.node === 'call' && (node.via !== 'tool' || !this.allowedTools.has(node.tool))) errors.push('Effects must use a registered host tool; shell and executor calls are unavailable.');
      if (node.node === 'map' && (node.maxConcurrency ?? 4) > extensionStructuralLimits.maxMapConcurrency) errors.push('Map concurrency must not exceed 8.');
      if (node.node === 'parallel' && node.branches.length > extensionStructuralLimits.maxParallelBranches) errors.push('Parallel nodes must not exceed 8 branches.');
      if (Array.isArray(node.tools) && node.tools.some((name: string) => !this.allowedTools.has(name))) errors.push('Agent tools must be explicitly registered by the host.');
    }
    if (errors.length) throw new ExtensionServiceError('admission', errors.slice(0, 8).join(' '));

    const valid = validateWorkflow(workflow, { executeCode: options.executeCode, ...(options.input === undefined ? {} : { input: options.input }) });
    if (!valid.ok) throw new ExtensionServiceError('invalid_workflow', valid.errors.slice(0, 8).join(' '));
    return { workflow, inspection };
  }
  /** Admission and syntax feedback only: never executes code or authorizes a run. */
  preflight(value: unknown, input?: Record<string, unknown>): WorkflowInspection {
    this.available();
    return this.check(value, { allowExecutableCandidates: true, executeCode: false, input }).inspection;
  }
  prepare(value: unknown, options: { allowExecutableCandidates?: boolean } = {}): PreparedWorkflow {
    this.idle();
    const { workflow, inspection } = this.check(value, options);
    this.current = freeze({ digest: inspection.sha256, inspection, workflow, executableAuthorized: options.allowExecutableCandidates === true });
    this.lastReport = undefined;
    return snapshot(this.current);
  }
  inspect(): { current?: PreparedWorkflow; lastReport?: ExtensionRunReport } {
    this.available();
    return { ...(this.current ? { current: snapshot(this.current, 4 * 1024 * 1024) } : {}),
      ...(this.lastReport ? { lastReport: snapshotReport(this.lastReport, this.limits.maxEventBytes) } : {}) };
  }
  stop(): void { this.active?.controller.abort(new ExtensionServiceError('cancelled', 'Workflow stopped.')); }
  async dispose(): Promise<void> { this.disposed = true; this.stop(); await this.active?.done; this.current = undefined; }

  async run(input: Record<string, unknown>, options: ExtensionRunOptions): Promise<ExtensionRunReport> {
    this.idle();
    if (!this.current) throw new ExtensionServiceError('not_prepared', 'Prepare a workflow first.');
    if (!options?.deps || typeof options.deps !== 'object') throw new ExtensionServiceError('configuration', 'Host execution adapters are required.');
    const prepared = this.current;
    const initial = freeze(snapshot(input));
    if (!initial || typeof initial !== 'object' || Array.isArray(initial)) throw new ExtensionServiceError('input', 'Workflow input must be a JSON object.');
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    this.active = { controller, done };
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : []), ...(options.deps.signal ? [options.deps.signal] : [])]);
    const timer = this.limits.deadlineMs === null ? undefined : setTimeout(() => controller.abort(new ExtensionServiceError('deadline', 'Workflow exceeded its deadline.')), this.limits.deadlineMs);
    const calls: Counts = { agent: 0, judge: 0, tool: 0 }, admitted: Counts = { agent: 0, judge: 0, tool: 0 };
    const events: Event[] = [];
    let bytes = 0, closed = false, traceTruncated = false, occupied = 0;
    const eventSizes: number[] = [];
    let receivedEvents = 0, receivedBytes = 0, droppedEvents = 0, droppedBytes = 0, rejectedEvents = 0;
    const queue: (() => void)[] = [];
    const limit = (message: string): never => { const error = new ExtensionServiceError('limit', message); controller.abort(error); throw error; };
    const acquire = async (localSignal: AbortSignal) => {
      localSignal.throwIfAborted();
      if (occupied < this.limits.maxConcurrency) { occupied++; return; }
      await new Promise<void>((resolve, reject) => {
        const enter = () => { localSignal.removeEventListener('abort', cancel); occupied++; resolve(); };
        const cancel = () => {
          const index = queue.indexOf(enter); if (index >= 0) queue.splice(index, 1);
          localSignal.removeEventListener('abort', cancel); reject(localSignal.reason);
        };
        queue.push(enter); localSignal.addEventListener('abort', cancel, { once: true });
        if (localSignal.aborted) cancel();
      });
    };
    const dispatch = async <T>(kind: keyof Counts, localSignal: AbortSignal | undefined, run: () => Promise<T>, race: boolean): Promise<T> => {
      const activeSignal = localSignal ? AbortSignal.any([signal, localSignal]) : signal;
      activeSignal.throwIfAborted();
      const maximum = kind === 'agent' ? this.limits.maxAgentCalls : kind === 'judge' ? this.limits.maxJudgeCalls : this.limits.maxToolCalls;
      admitted[kind]++;
      if (maximum !== null && admitted[kind] > maximum) limit(`Workflow exceeded its ${kind} admission limit.`);
      await acquire(activeSignal);
      try { activeSignal.throwIfAborted(); calls[kind]++; const promise = run(); return await (race ? abortable(promise, activeSignal) : promise); }
      finally { occupied--; queue.shift()?.(); }
    };
    const rejectTrace = (error: unknown) => {
      rejectedEvents++; traceTruncated = true;
      if (!signal.aborted) {
        // Snapshot rejects unsafe/non-JSON values separately from resource bounds.
        // Keep fail-closed cancellation; never echo values or arbitrary error text.
        const diagnostic = error instanceof ExtensionServiceError && error.code === 'data'
          ? new ExtensionServiceError('trace_invalid_data', 'Workflow trace contains non-JSON data. Numbers must be finite; objects and arrays must be plain, acyclic and free of accessors or symbols.')
          : error instanceof ExtensionServiceError && error.code === 'bounds'
            ? new ExtensionServiceError('limit', 'Workflow trace exceeded its JSON byte, depth or value-count limit.')
            : new ExtensionServiceError('trace_capture_failed', 'Workflow trace capture failed. Unsafe event details are omitted.');
        controller.abort(diagnostic);
      }
    };
    const prepareEvent = (event: Event): Event | undefined => {
      if (closed) return { type: event.type, label: event.label };
      try { return snapshot(event, this.limits.maxEventBytes) as Event; }
      catch (error) { rejectTrace(error); return undefined; }
    };
    const onEvent = (event: Event) => {
      if (closed) return;
      try {
        const clean = sanitize(event) as Event;
        const size = Buffer.byteLength(JSON.stringify(clean));
        if (size > this.limits.maxEventBytes) throw new ExtensionServiceError('bounds', 'Workflow event exceeds its serialized byte limit.');
        receivedEvents++; receivedBytes += size;
        // Retain recent fitting events; a valid event larger than the retention
        // budget is omitted but still observed. Retention never cancels execution.
        if (size > this.limits.maxTraceBytes) {
          droppedEvents++; droppedBytes += size; traceTruncated = true;
        } else {
          while (bytes + size > this.limits.maxTraceBytes) {
            const removed = eventSizes.shift()!; events.shift();
            bytes -= removed; droppedEvents++; droppedBytes += removed; traceTruncated = true;
          }
          bytes += size; events.push(clean); eventSizes.push(size);
        }
        if (options.onTraceEvent) {
          try { void Promise.resolve(options.onTraceEvent(snapshot(clean, this.limits.maxEventBytes))).catch(() => {}); }
          catch { /* Host observation is not execution. */ }
        }
        if (!this.disposed && !signal.aborted && options.onEvent) {
          try { void Promise.resolve(options.onEvent(snapshot(clean, this.limits.maxEventBytes))).catch(() => {}); } catch { /* UI observation is not execution. */ }
        }
      } catch (error) {
        rejectTrace(error);
      }
    };
    const sections = Object.entries(this.rubricSections);
    const deps: WorkflowDeps = {
      signal, onEvent, prepareEvent,
      ...(options.deps.skill ? { skill: options.deps.skill } : {}),
      ...(sections.length ? { sop: sections.map(([name, text]) => `## ${name}\n${text}`).join('\n\n') } : options.deps.sop ? { sop: options.deps.sop } : {}),
      ...(options.deps.maxQuestionsPerRequest ? { maxQuestionsPerRequest: options.deps.maxQuestionsPerRequest } : {}),
      ...(options.deps.runNode ? { runNode: params => dispatch('agent', params.signal, () => withAdapterDiagnostic(params.label, () => options.deps.runNode!({ ...params, tools: params.tools ?? [...this.allowedTools] })), true) } : {}),
      ...(options.deps.runJudge ? { runJudge: params => dispatch('judge', params.signal, () => withAdapterDiagnostic(params.label, () => options.deps.runJudge!(params)), true) } : {}),
      ...(options.deps.runEffect ? { runEffect: params => dispatch('tool', params.signal, () => {
        if (params.node.via !== 'tool' || !this.allowedTools.has(params.node.tool!)) throw new ExtensionServiceError('admission', 'Effect is not a registered host tool.');
        return withAdapterDiagnostic(params.node.label, () => options.deps.runEffect!(params));
      }, false) } : {}),
    };
    let report: ExtensionRunReport;
    try {
      signal.throwIfAborted();
      const result = await runWorkflow(prepared.workflow, initial, deps);
      signal.throwIfAborted();
      report = { digest: prepared.digest, status: result.status, calls, events,
        ...(result.status === 'complete' ? { output: snapshot(result.output) } : { escalation: Object.fromEntries(Object.entries(result.escalation).filter(([key]) => key !== 'state' && result.escalation[key as keyof Escalation] !== undefined)) as ExtensionRunReport['escalation'] }) };
    } catch (error) {
      const reason = controller.signal.aborted && controller.signal.reason instanceof ExtensionServiceError ? controller.signal.reason : error;
      const owned = controller.signal.aborted && reason === controller.signal.reason && reason instanceof ExtensionServiceError;
      const invalidInput = error instanceof WorkflowInputInvalidError && events.length === 0
        && calls.agent + calls.judge + calls.tool === 0;
      const code = owned ? reason.code : signal.aborted ? 'cancelled' : invalidInput ? 'input_invalid' : 'execution_failed';
      const unknown: NonNullable<ExtensionRunReport['uncertainEffects']> = [];
      const collect = (failure: unknown) => {
        if (failure instanceof EffectOutcomeUnknownError) unknown.push({ idempotencyKey: failure.idempotencyKey, ...(failure.executionPath ? { executionPath: failure.executionPath } : {}), outcome: 'unknown' });
        else if (failure instanceof AggregateError) failure.errors.slice(0, 100).forEach(collect);
      };
      collect(error);
      const failedStep = events.findLast(event => event.type === 'node.end' && (event.detail as { status?: string })?.status === 'failed');
      const failedPath = failedStep?.executionPath;
      const toolFailed = failedStep && (failedStep.detail as { kind?: string })?.kind === 'call'
        && events.some(event => event.type === 'effect.failed' && event.executionPath === failedPath);
      const observedStage = failedStep?.label.slice(0, 200);
      report = { digest: prepared.digest, status: code === 'cancelled' || code === 'deadline' ? 'interrupted' : 'failed', calls, events,
        error: !owned && !signal.aborted && !invalidInput && localDiagnostic(error) || { code,
          ...(invalidInput ? { stage: 'input', problems: error.problems.slice(0, 8).map(problem => problem.slice(0, 500)) } : observedStage ? { stage: observedStage } : {}),
          message: owned ? reason.message : signal.aborted ? 'Workflow interrupted.' : invalidInput ? 'Input does not match this workflow. Pass input with action run, or inspect the workflow with its input before running.'
            : toolFailed ? 'A registered tool call failed. Inspect the tool step and reconcile any effect before a new run. Underlying error text is omitted.'
              : 'Workflow failed. Inspect the affected step, input contracts and host adapters. Underlying error text is omitted.' },
        ...(unknown.length ? { uncertainEffects: unknown } : {}), ...(traceTruncated ? { traceTruncated: true } : {}) };
    } finally { closed = true; clearTimeout(timer); this.active = undefined; finish(); }
    report.trace = { policy: 'tail', receivedEvents, receivedBytes, rejectedEvents,
      retainedEvents: events.length, retainedBytes: bytes, droppedEvents, droppedBytes };
    if (traceTruncated) report.traceTruncated = true;
    const retained = snapshotReport(report, this.limits.maxEventBytes);
    this.lastReport = freeze(retained);
    return snapshotReport(retained, this.limits.maxEventBytes);
  }
}
