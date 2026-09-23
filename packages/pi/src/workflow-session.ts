import { types } from 'node:util';
import { inspectWorkflow, validateWorkflow, type Workflow } from '@parcha/agentrun-dsl';
import type { ExtensionRunReport } from './extension-service.js';
import type { RunObservation } from './workflow-view.js';
import { demoWorkflow } from './demo.js';
import { supportTriageWorkflow } from './triage-demo.js';

export interface WorkflowSessionSnapshot {
  version: 1;
  workflow: Workflow;
  input: Record<string, unknown>;
  savedName?: string;
  demo?: 'scripted' | 'empty' | 'triage' | 'triage-failure';
  report?: ExtensionRunReport;
  observation?: RunObservation;
  running?: boolean;
  runId?: string;
  createdAt: string;
}

const MAX_BYTES = 8 * 1024 * 1024;
const object = (v: any): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, any>, keys: string[]): boolean => Object.keys(v).every(key => keys.includes(key));
const count = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const textFields = (v: Record<string, any>, required: string[], optional: string[] = []): boolean =>
  required.every(key => typeof v[key] === 'string') && optional.every(key => v[key] === undefined || typeof v[key] === 'string');

/** Copy data without invoking accessors, proxy traps, toJSON or authored code. */
function jsonSnapshot(value: unknown): any {
  const ancestors = new Set<object>();
  let values = 0, bytes = 0;
  const visit = (item: unknown, depth: number): any => {
    if (++values > 200_000 || depth > 128 || bytes > MAX_BYTES) throw new Error('snapshot bounds');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') { bytes += Buffer.byteLength(item); if (bytes > MAX_BYTES) throw new Error('snapshot bounds'); return item; }
    if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) throw new Error('snapshot data');
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== (Array.isArray(item) ? Array.prototype : Object.prototype) && prototype !== null) throw new Error('snapshot prototype');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length || Object.values(descriptors).some(d => !('value' in d))) throw new Error('snapshot descriptors');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(descriptors).some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)) || item.length > 200_000) throw new Error('snapshot array');
        return Array.from({ length: item.length }, (_, index) => visit(descriptors[index]?.value, depth + 1));
      }
      return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => {
        if (!descriptor.enumerable) throw new Error('snapshot hidden data');
        bytes += Buffer.byteLength(key);
        return [key, visit(descriptor.value, depth + 1)];
      }));
    } finally { ancestors.delete(item); }
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new Error('snapshot bounds');
  return result;
}

function validReport(r: any, digest: string): boolean {
  if (!object(r) || !only(r, ['digest', 'status', 'calls', 'events', 'output', 'escalation', 'error', 'uncertainEffects', 'traceTruncated', 'trace'])
    || r.digest !== digest || !['complete', 'escalated', 'failed', 'interrupted'].includes(r.status)
    || !object(r.calls) || !only(r.calls, ['agent', 'judge', 'tool']) || !['agent', 'judge', 'tool'].every(k => count(r.calls[k]))
    || !Array.isArray(r.events) || !r.events.every((e: any) => object(e) && textFields(e, ['type', 'label'], ['executionPath']))
    || r.traceTruncated !== undefined && typeof r.traceTruncated !== 'boolean') return false;
  if (r.error !== undefined && (!object(r.error) || !only(r.error, ['code', 'message', 'stage', 'path', 'reason', 'status', 'problems', 'stateBytes', 'maxStateBytes'])
    || !textFields(r.error, ['code', 'message'], ['stage', 'path', 'reason'])
    || ['status', 'stateBytes', 'maxStateBytes'].some(k => r.error[k] !== undefined && !count(r.error[k]))
    || r.error.problems !== undefined && (!Array.isArray(r.error.problems) || !r.error.problems.every((p: unknown) => typeof p === 'string')))) return false;
  if (r.escalation !== undefined && (!object(r.escalation) || !only(r.escalation, ['kind', 'stage', 'summary', 'label', 'executionPath'])
    || !textFields(r.escalation, ['kind', 'stage', 'summary'], ['label', 'executionPath']))) return false;
  if (r.uncertainEffects !== undefined && (!Array.isArray(r.uncertainEffects) || !r.uncertainEffects.every((e: any) => object(e)
    && only(e, ['idempotencyKey', 'executionPath', 'outcome']) && textFields(e, ['idempotencyKey'], ['executionPath']) && e.outcome === 'unknown'))) return false;
  if (r.trace !== undefined) {
    const fields = ['receivedEvents', 'receivedBytes', 'rejectedEvents', 'retainedEvents', 'retainedBytes', 'droppedEvents', 'droppedBytes'];
    if (!object(r.trace) || !only(r.trace, ['policy', ...fields]) || r.trace.policy !== 'tail' || !fields.every(k => count(r.trace[k]))) return false;
  }
  return true;
}

function validObservation(o: any): boolean {
  return object(o) && only(o, ['steps', 'decisions', 'notes', 'routes', 'omitted']) && count(o.omitted)
    && object(o.steps) && Object.values(o.steps).every(s => object(s) && only(s, ['label', 'kind', 'status']) && textFields(s, ['label', 'kind', 'status']))
    && object(o.notes) && Object.values(o.notes).every(n => typeof n === 'string')
    && (o.routes === undefined || object(o.routes) && Object.values(o.routes).every(n => typeof n === 'string'))
    && Array.isArray(o.decisions) && o.decisions.every((d: any) => object(d) && only(d, ['path', 'label', 'questions', 'evidence', 'answer', 'accepted'])
      && textFields(d, ['path', 'label', 'questions', 'evidence'], ['answer']) && (d.accepted === undefined || typeof d.accepted === 'boolean'));
}

function snapshotEntry(entry: unknown): WorkflowSessionSnapshot | undefined {
  try {
    if (!object(entry) || types.isProxy(entry) || ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) return;
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (descriptors.type?.value !== 'custom' || descriptors.customType?.value !== 'agentrun:snapshot' || !('value' in (descriptors.data ?? {}))) return;
    const s = jsonSnapshot(descriptors.data.value);
    if (!object(s) || !only(s, ['version', 'workflow', 'input', 'savedName', 'demo', 'report', 'observation', 'running', 'runId', 'createdAt'])
      || s.version !== 1 || !object(s.input) || typeof s.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s.createdAt)
      || !Number.isFinite(Date.parse(s.createdAt)) || new Date(s.createdAt).toISOString() !== s.createdAt
      || s.savedName !== undefined && (typeof s.savedName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s.savedName))
      || s.runId !== undefined && (typeof s.runId !== 'string' || !s.runId.length || s.runId.length > 200)
      || s.running !== undefined && typeof s.running !== 'boolean') return;
    const inspection = inspectWorkflow(s.workflow);
    // Input remains an exact draft, including incomplete form values; run preflight owns it.
    if (!validateWorkflow(s.workflow as Workflow, { executeCode: false }).ok) return;
    if (s.report !== undefined && !validReport(s.report, inspection.sha256)) return;
    if (s.observation !== undefined && !validObservation(s.observation)) return;
    if (s.demo !== undefined) {
      const bundled = s.demo === 'scripted' || s.demo === 'empty' ? demoWorkflow
        : s.demo === 'triage' || s.demo === 'triage-failure' ? supportTriageWorkflow : undefined;
      if (!bundled || inspectWorkflow(bundled).sha256 !== inspection.sha256) delete s.demo;
    }
    return s as unknown as WorkflowSessionSnapshot;
  } catch { return undefined; }
}

function interrupted(s: WorkflowSessionSnapshot): WorkflowSessionSnapshot {
  if (!s.running) return s;
  s.running = false;
  s.report = { digest: inspectWorkflow(s.workflow).sha256, status: 'interrupted',
    calls: s.report?.calls ?? { agent: 0, judge: 0, tool: 0 }, events: s.report?.events ?? [],
    ...(s.report?.uncertainEffects ? { uncertainEffects: s.report.uncertainEffects } : {}),
    error: { code: 'session_interrupted', message: 'This run has no retained completion record. It was not restarted. Recorded counts may be incomplete; reconcile any admitted effects before starting a new run.' } };
  if (s.observation) for (const step of Object.values(s.observation.steps)) if (step.status === 'running') step.status = 'interrupted';
  return s;
}

/** Caller supplies Pi's active branch, not the complete session tree. */
export function restoreWorkflowSession(branch: readonly unknown[]): WorkflowSessionSnapshot | undefined {
  if (!Array.isArray(branch) || types.isProxy(branch)) return undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const snapshot = snapshotEntry(Object.getOwnPropertyDescriptor(branch, String(i))?.value);
    if (snapshot) return interrupted(snapshot);
  }
  return undefined;
}

/** Newest first, one terminal record per run; unmatched starts are interruptions. */
export function workflowRunHistory(branch: readonly unknown[]): WorkflowSessionSnapshot[] {
  const results: WorkflowSessionSnapshot[] = [], seen = new Set<string>();
  if (!Array.isArray(branch) || types.isProxy(branch)) return results;
  for (let i = branch.length - 1; i >= 0 && results.length < 20; i--) {
    const snapshot = snapshotEntry(Object.getOwnPropertyDescriptor(branch, String(i))?.value);
    if (!snapshot || !snapshot.report && !snapshot.running) continue;
    const key = snapshot.runId ?? `entry:${i}`;
    if (seen.has(key)) continue;
    seen.add(key); results.push(interrupted(snapshot));
  }
  return results;
}
