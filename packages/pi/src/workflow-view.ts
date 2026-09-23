import { inspectWorkflow, type WorkflowDeps } from '@parcha/agentrun-dsl';
import type { ExtensionRunReport } from './extension-service.js';
import { cleanText } from './presentation.js';
import { types as utilTypes } from 'node:util';

type Event = Parameters<NonNullable<WorkflowDeps['onEvent']>>[0];
type JudgeRequest = Parameters<NonNullable<WorkflowDeps['runJudge']>>[0];
export interface WorkflowViewNode {
  path: string; label: string; kind: string; status: string; summary: string; details: string[];
}
export interface WorkflowView {
  title: string; digest: string; status: string; summary: string[]; nodes: WorkflowViewNode[]; output?: string[];
}
export interface DecisionEvidence {
  path: string; label: string; questions: string; evidence: string;
  answer?: string; accepted?: boolean;
}
export interface RunObservation {
  steps: Record<string, { label: string; kind: string; status: string }>;
  decisions: DecisionEvidence[];
  notes: Record<string, string>;
  omitted: number;
  routes?: Record<string, string>;
}

/** Display limits never admit, cancel, or modify execution. */
export function readable(value: unknown, max = 12_000): string {
  let text: string;
  let excerpt = false;
  try {
    if (typeof value === 'string') text = value;
    // The controller explicitly requests complete expanded output; its structured
    // report remains authoritative. Normal observation never uses this path.
    else if (max === Number.MAX_SAFE_INTEGER) text = JSON.stringify(value, null, 2) ?? '';
    else {
      let remaining = max, values = 0;
      const seen = new Set<object>();
      const visit = (item: unknown, depth: number): unknown => {
        if (++values > 2_000 || remaining <= 0 || depth > 16) { excerpt = true; return '[Display excerpt]'; }
        if (typeof item === 'string') { const part = item.slice(0, remaining); remaining -= part.length; if (part.length < item.length) excerpt = true; return part; }
        remaining -= 8;
        if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
        if (!item || typeof item !== 'object' || utilTypes.isProxy(item)) return '[Non-JSON value]';
        if (seen.has(item)) return '[Repeated reference]';
        const proto = Object.getPrototypeOf(item);
        if (proto !== null && proto !== Object.prototype && proto !== Array.prototype) return '[Non-JSON value]';
        seen.add(item);
        const result: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : Object.create(null);
        if (Array.isArray(item)) {
          const length = Math.min(item.length, 2_000);
          for (let index = 0; index < length; index++) {
            if (remaining <= 0 || values >= 2_000) { excerpt = true; break; }
            const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
            (result as unknown[]).push(descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Unavailable element]');
          }
          if ((result as unknown[]).length < item.length) excerpt = true;
          seen.delete(item); return result;
        }
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          if (remaining <= 0 || values >= 2_000) { excerpt = true; break; }
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          remaining -= key.length;
          Object.defineProperty(result, key, { value: 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Accessor not read]', enumerable: true, configurable: true });
        }
        seen.delete(item);
        return result;
      };
      text = JSON.stringify(visit(value, 0), null, 2) ?? '';
    }
  }
  catch { return '[Not available as JSON]'; }
  const clipped = text.length > max || excerpt;
  return cleanText(text.slice(0, max)) + (clipped ? '\n… Display excerpt; additional content omitted.' : '');
}
const definitionPath = (path: string): string => path.replace(/\/items\/\d+\/body/g, '/body').replace(/\/iterations\/\d+(?=\/|$)/g, '');
const at = (value: any, path: string): any => path.split('/').slice(1).reduce((item, key) =>
  item && Object.hasOwn(item, key.replace(/~1/g, '/').replace(/~0/g, '~')) ? item[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined, value);

export class WorkflowObservation {
  readonly data: RunObservation = { steps: {}, decisions: [], notes: {}, routes: {}, omitted: 0 };
  private decisionBytes = 0;

  record(event: Event): void {
    try { this.recordSafe(event); } catch { this.data.omitted++; }
  }
  private recordSafe(event: Event): void {
    const path = event.executionPath ?? `/label/${event.label}`;
    const detail = event.detail as Record<string, any> | undefined;
    if (event.type === 'node.start' || event.type === 'node.end') {
      if (!Object.hasOwn(this.data.steps, path) && Object.keys(this.data.steps).length >= 2_000) { this.data.omitted++; return; }
      this.data.steps[path] = { label: cleanText(event.label), kind: String(detail?.kind ?? 'step'),
        status: event.type === 'node.start' ? 'running' : detail?.status === 'ok' ? 'succeeded' : detail?.status === 'escalated' ? 'needs attention' : 'failed' };
    }
    // Escalation emits an evaluation event, not node.start/node.end. Project that
    // existing interpreter evidence so the selected branch cannot look untouched.
    if (event.type === 'escalate.evaluated') {
      if (!Object.hasOwn(this.data.steps, path) && Object.keys(this.data.steps).length >= 2_000) { this.data.omitted++; return; }
      this.data.steps[path] = { label: cleanText(event.label), kind: 'escalate',
        status: detail?.fired === true ? 'needs attention' : 'condition not met' };
    }
    if (event.type === 'judge.answered' || event.type === 'route.chosen' || event.type === 'ask.evaluated') {
      const decision = this.data.decisions.findLast(item => item.path === path && item.accepted === undefined);
      if (decision) decision.accepted = true;
    }
    if (event.type === 'route.chosen' || event.type === 'loop.exited' || event.type === 'map.failed' || event.type === 'map.escalated') {
      if (!Object.hasOwn(this.data.notes, path) && Object.keys(this.data.notes).length >= 200) { this.data.omitted++; return; }
      this.data.notes[path] = event.type === 'route.chosen' ? `Selected branch: ${readable(detail?.value, 500)}`
        : event.type === 'loop.exited' ? `${detail?.iterations} iterations · ${detail?.reason === 'condition_met' ? 'stop condition met' : 'iteration bound reached; not proof of success'}`
        : `${detail?.completed} of ${detail?.of} items completed · ${event.type === 'map.failed' ? 'failed' : 'needs attention'}`;
      if (event.type === 'route.chosen' && typeof detail?.value?.taken === 'string') this.data.routes![path] = detail.value.taken;
    }
  }

  /** Capture the exact supplied questions/state, not an explanation invented afterward. */
  requested(request: JudgeRequest): DecisionEvidence | undefined {
    if (this.data.decisions.length >= 32 || this.decisionBytes >= 128_000) { this.data.omitted++; return; }
    const item: DecisionEvidence = { path: request.executionPath ?? `/label/${request.label}`, label: cleanText(request.label),
      questions: readable(request.questions, 8_000), evidence: readable(request.state, 8_000) };
    this.decisionBytes += item.questions.length + item.evidence.length;
    this.data.decisions.push(item);
    return item;
  }

  observe(deps: WorkflowDeps): WorkflowDeps {
    if (!deps.runJudge) return deps;
    const runJudge = deps.runJudge;
    return { ...deps, runJudge: async request => {
      let record: DecisionEvidence | undefined;
      try { record = this.requested(request); } catch { this.data.omitted++; }
      const result = await runJudge(request);
      // A transport response is not acceptance; interpreter events confirm it later.
      try { if (record) record.answer = readable(result.answers, 8_000); } catch { this.data.omitted++; }
      return result;
    } };
  }
}

export function progressLines(observation: RunObservation, terminalStatus?: string): string[] {
  const steps = Object.values(observation.steps).map(step => terminalStatus && step.status === 'running'
    ? { ...step, status: ['interrupted', 'cancelled'].includes(terminalStatus) ? 'interrupted' : 'completion not observed' } : step);
  const count = (status: string) => steps.filter(step => step.status === status).length;
  const active = steps.filter(step => step.status === 'running');
  return [
    `${count('succeeded')} succeeded · ${active.length} active · ${count('failed')} failed · ${count('needs attention')} need attention`,
    ...(count('interrupted') ? [`${count('interrupted')} interrupted; completion not observed.`] : []),
    ...(count('completion not observed') ? [`${count('completion not observed')} steps have no observed completion.`] : []),
    ...active.slice(0, 3).map(step => `Working: ${step.label}`),
    ...(active.length > 3 ? [`… ${active.length - 3} more active steps`] : []),
    ...(observation.omitted ? ['Observation is partial; omitted details do not stop execution.'] : []),
  ];
}

export function workflowView(workflow: unknown, options: {
  input?: Record<string, unknown>; observation?: RunObservation; report?: ExtensionRunReport;
  running?: boolean; mode?: string; model?: string; limits?: Record<string, number | null>;
  availableTools?: string[]; savedName?: string;
} = {}): WorkflowView {
  const inspection = inspectWorkflow(workflow);
  const definition = workflow as any;
  const observed = options.observation;
  const status = options.running ? 'running' : options.report?.status ?? 'draft';
  const required = definition.input ? definition.schemas[definition.input.schemaId]?.required ?? [] : [];
  const missing = required.filter((key: string) => !Object.hasOwn(options.input ?? {}, key));
  const tools = inspection.requires.tools;
  const unavailable = options.availableTools ? tools.filter(name => !options.availableTools!.includes(name)) : [];
  const nodes = inspection.nodes.map(node => {
    const source = at(definition, node.path) ?? {};
    const childRoot = node.path.lastIndexOf('/workflow/root');
    const owner = childRoot < 0 ? definition : at(definition, node.path.slice(0, childRoot + '/workflow'.length));
    const instances = Object.entries(observed?.steps ?? {}).filter(([path]) => definitionPath(path) === node.path);
    const events = Object.entries(observed?.notes ?? {}).filter(([path]) => definitionPath(path) === node.path);
    const decisions = observed?.decisions.filter(item => definitionPath(item.path) === node.path) ?? [];
    const descendants = Object.entries(observed?.steps ?? {}).filter(([path]) => definitionPath(path).startsWith(`${node.path}/`));
    const structural = ['chain', 'map', 'parallel', 'loop'].includes(node.kind);
    const statuses = (instances.length ? instances : structural ? descendants : []).map(([, item]) => item.status);
    const final = !!options.report && !options.running;
    const skipped = final && !observed?.omitted && Object.entries(observed?.routes ?? {}).some(([routePath]) => {
      const parent = definitionPath(routePath);
      if (!node.path.startsWith(`${parent}/branches/`)) return false;
      const branch = node.path.slice(`${parent}/branches/`.length).split('/')[0];
      const choices = Object.entries(observed?.routes ?? {}).filter(([path]) => definitionPath(path) === parent);
      return choices.length > 0 && choices.every(([, taken]) => taken.replace(/~/g, '~0').replace(/\//g, '~1') !== branch);
    });
    const nodeStatus = statuses.includes('running') ? final ? ['interrupted', 'cancelled'].includes(status) ? 'interrupted' : 'completion not observed' : 'running' : statuses.includes('failed') ? 'failed'
      : statuses.some(value => ['interrupted', 'cancelled'].includes(value)) ? 'interrupted'
      : statuses.includes('needs attention') ? 'needs attention'
      : structural && !instances.length && observed?.omitted ? 'completion not observed'
      : statuses.length && statuses.every(value => value === 'condition not met') ? 'condition not met'
      : statuses.length && statuses.every(value => value === 'succeeded' || value === 'condition not met') ? 'succeeded'
      : statuses.length ? 'completion not observed'
      : events.length ? 'observed' : status === 'draft' ? 'planned' : skipped ? 'skipped (branch not selected)' : 'not observed';
    const displayedStatus = structural && !instances.length && nodeStatus === 'succeeded' ? 'observed work succeeded' : nodeStatus;
    const counts = instances.length > 1 ? `${statuses.filter(s => s === 'succeeded').length}/${instances.length} observed executions succeeded` : '';
    const detail: string[] = [
      `Step: ${node.label} [${node.kind}]`, `Definition: ${node.path}`, `State: ${displayedStatus}`,
      ...(source.requires?.length ? [`Requires: ${source.requires.join(', ')}`] : []),
      ...(source.state !== undefined ? ['Input binding:', readable(source.state)] : []),
      ...(source.instructions ? ['Instructions:', readable(source.instructions)] : []),
      ...(source.tools?.length ? [`Tools: ${source.tools.join(', ')}`] : []),
      ...(source.tool ? [`Tool: ${source.tool}`] : []),
      ...(source.args ? ['Tool arguments:', readable(source.args)] : []),
      ...(source.code ? ['Code (not executed by inspection):', readable(source.code)] : []),
      ...(source.until ? ['Stop condition:', readable(source.until), `Maximum iterations: ${source.maxIters ?? 'none configured'}`] : []),
      ...(source.when ? ['Condition:', readable(source.when)] : []),
      ...(source.out ? [`Output schema: ${source.out}`, readable(owner?.schemas?.[source.out])] : []),
      ...(node.writes ? [`Writes: ${node.writes}`] : []),
      ...(source.branches && !Array.isArray(source.branches) ? ['Branch rules:', readable(Object.fromEntries(Object.entries(source.branches).map(([name, value]: [string, any]) => [name, value.when ?? value.criteria ?? value.description ?? name])))] : []),
      ...events.map(([path, note]) => `${path}: ${note}`),
      ...decisions.flatMap((item, index) => [`Decision ${index + 1} · ${item.path}`, 'Actual questions and criteria:', item.questions,
        'Actual evidence supplied:', item.evidence, item.accepted ? 'Interpreter accepted the answer:' : 'Response (acceptance not observed):', item.answer ?? 'No answer observed.',
        'Confidence describes this judgment, not whole-workflow correctness.']),
    ];
    return { path: node.path, label: cleanText(node.label), kind: node.kind, status: displayedStatus,
      summary: [counts, ...events.map(([, note]) => note)].filter(Boolean).join(' · '), details: detail.map(cleanText) };
  });
  return {
    title: cleanText(inspection.name), digest: inspection.sha256, status,
    summary: [
      `${options.savedName ? `Saved: ${cleanText(options.savedName)} · ` : ''}Revision: ${inspection.sha256.slice(0, 12)} · ${options.mode ?? 'live adapters'}`,
      `Input: ${inspection.inputSchema ?? 'object'} → Output: ${inspection.outputSchema}${inspection.outputPath ? ` (${inspection.outputPath})` : ''}`,
      ...(missing.length ? [`Missing input: ${missing.join(', ')}`] : []),
      `Tools: ${tools.join(', ') || 'none'}`,
      ...(unavailable.length ? [`Unavailable without host configuration or approval: ${unavailable.join(', ')}`] : []),
      ...(inspection.requires.executableCode ? ['Approval: code requires /agentrun run --trusted for each run (unsandboxed).'] : []),
      ...(options.model && !options.mode?.startsWith('scripted') && inspection.requires.adapters.includes('runNode') ? [`Agent model: ${options.model}`] : []),
      ...(options.limits ? [`Host limits: ${Object.entries(options.limits).map(([key, value]) => `${key}=${value ?? 'disabled'}`).join(', ')}`] : []),
      ...(observed ? progressLines(observed, options.report && !options.running ? status : undefined) : ['Preflight checks syntax and admission; it does not prove task correctness.']),
      ...(options.report?.error ? [`Failure: ${options.report.error.stage ?? 'workflow'} · ${options.report.error.message}`] : []),
      ...(options.report?.uncertainEffects?.length ? ['Unknown tool outcomes: reconcile before restarting.'] : []),
      ...(options.report?.traceTruncated ? ['Retained event trace is partial.'] : []),
    ].map(cleanText), nodes,
    ...(options.report?.output !== undefined ? { output: ['Output:', readable(options.report.output)] } : {}),
  };
}

export function formatWorkflowView(view: WorkflowView): string {
  return cleanText([`${view.title} · ${view.status}`, ...view.summary, '',
    ...view.nodes.map(node => `${'  '.repeat(Math.min(5, node.path.split('/').length - 2))}${node.label} [${node.kind}] · ${node.status}${node.summary ? ` · ${node.summary}` : ''}`),
    ...(view.output ? ['', ...view.output] : []),
    '', 'Inspect a step for criteria, evidence, and observed decisions. Restart reruns the whole workflow; it is not resume.',
  ].join('\n'));
}
