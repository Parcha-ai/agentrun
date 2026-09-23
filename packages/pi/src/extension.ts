import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Compile } from 'typebox/compile';
import { Text } from '@earendil-works/pi-tui';
import {
  createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  VERSION as PI_VERSION, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  formatWorkflowTree, inspectWorkflow, AUTHOR_SKILL_NAME, loadAuthorReference, renderAuthorHostAddendum, type WorkflowDeps,
} from '@parcha/agentrun-dsl';
import { createJevRunner } from '@parcha/agentrun-jev';
import { createPiHostRunner, PI_MODEL_SETUP_MESSAGE } from './host-session.js';
import { PI_HOST_ADDENDUM } from './host-addendum.js';
import type { PiHostContext, PiToolDefinition } from './types.js';
import { WorkflowExtensionService, ExtensionServiceError, extensionStructuralLimits, type ExtensionRunReport } from './extension-service.js';
import { demoInput, demoSearchTool, demoWorkflow, scriptedDemoDeps } from './demo.js';
import { cleanText as safe, formatRunReport, modelJson } from './presentation.js';
import { ToolInputValidationError, toolInputProblems } from './tool-input-error.js';
import { WorkflowStore, WorkflowStoreError } from './workflow-store.js';
import { WorkflowObservation, workflowView, formatWorkflowView, progressLines, readable, type RunObservation } from './workflow-view.js';
import { showWorkflowInspector } from './workflow-inspector.js';
import { supportTriageWorkflow, supportTriageInputs, supportTriageTools, scriptedSupportTriageDeps } from './triage-demo.js';
import { restoreWorkflowSession, workflowRunHistory, type WorkflowSessionSnapshot } from './workflow-session.js';

const constructors = {
  read: createReadToolDefinition, bash: createBashToolDefinition, edit: createEditToolDefinition,
  write: createWriteToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition,
};
const mutatingTools = new Set(['bash', 'edit', 'write']);
const help = 'Describe a task: /agentrun <what you want done>\nTry support triage: /agentrun triage (fictional, no model calls)\nInspect: /agentrun · Change input: /agentrun input\nSave: /agentrun save <name> · Load: /agentrun load <name>\nLibrary: /agentrun list · History: /agentrun history\nRun: /agentrun run · Setup: /agentrun status\nStop: /agentrun stop (closing the inspector does not stop a run)\nOther examples: /agentrun demo | demo empty | demo live';
const textResult = (text: string, details: unknown = {}) => ({ content: [{ type: 'text' as const, text: safe(text) }], details });
function singleTextInput(workflow: unknown): string | undefined {
  const source = workflow as { input?: { schemaId?: string }; schemas?: Record<string, any> } | undefined;
  const schema = source?.input?.schemaId && source.schemas?.[source.input.schemaId];
  if (schema?.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') return;
  const keys = Object.keys(schema.properties);
  return keys.length === 1 && schema.required?.length === 1 && schema.required[0] === keys[0]
    && schema.properties[keys[0]]?.type === 'string' ? keys[0] : undefined;
}
const nativeLimits = Object.freeze({ deadlineMs: 600_000, modelRequests: 50, judgeCalls: 100, toolAttempts: 100,
  nodeMaxTurns: 8, nodeMaxSubmissions: 3, nodeTimeoutMs: 120_000 });
export type AgentRunRuntimeLimits = { [Key in keyof typeof nativeLimits]: number | null };

export interface AgentRunWorkflowEvent {
  workflowDigest: string;
  /** Monotonic within this extension registration, including across session changes. */
  runOrdinal: number;
  sequence: number;
  event: Parameters<NonNullable<WorkflowDeps['onEvent']>>[0];
}

type Session = {
  key: string; clearStatus: () => void; service: WorkflowExtensionService; tools: PiToolDefinition[]; toolNames: string[];
  draft?: unknown; demo?: 'scripted' | 'empty' | 'triage' | 'triage-failure'; input: Record<string, unknown>; busy: boolean; closed: boolean; controller?: AbortController;
  inFlight?: Promise<void>;
  savedName?: string; observation?: RunObservation; report?: ExtensionRunReport;
  runId?: string; persistenceWarning?: string;
  sessionFile: () => string | undefined;
};

export interface AgentRunExtensionOptions {
  /** Complete host-owned tool allowlist, replacing demo and built-in tools. */
  hostTools?: (ctx: ExtensionContext) => readonly PiToolDefinition[];
  /** Host-owned Jev transport; called only when the inspected graph needs it. */
  createJudge?: (options: { signal: AbortSignal }) => NonNullable<WorkflowDeps['runJudge']>;
  /** Synchronous host admission before each direct or native child tool attempt. */
  onToolAttempt?: () => void;
  /** Sanitized, isolated execution events, independent of report retention and UI.
   * Observation cannot change execution. The host owns persistence failures and async draining. */
  onWorkflowEvent?: (frame: AgentRunWorkflowEvent) => unknown;
  /** Explicit null disables an execution limit; omitted fields retain finite defaults. */
  runtimeLimits?: Partial<AgentRunRuntimeLimits>;
}

/** Configure the native extension without granting configuration to workflow authors. */
export function createAgentRunExtension(options: AgentRunExtensionOptions = {}): (pi: ExtensionAPI) => void {
  if (options.hostTools !== undefined && typeof options.hostTools !== 'function') throw new Error('hostTools must be a host callback');
  if (options.createJudge !== undefined && typeof options.createJudge !== 'function') throw new Error('createJudge must be a host callback');
  if (options.onToolAttempt !== undefined && typeof options.onToolAttempt !== 'function') throw new Error('onToolAttempt must be a host callback');
  if (options.onWorkflowEvent !== undefined && typeof options.onWorkflowEvent !== 'function') throw new Error('onWorkflowEvent must be a host callback');
  const limits = { ...nativeLimits, ...options.runtimeLimits } as AgentRunRuntimeLimits;
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in nativeLimits) || value !== null && (!Number.isSafeInteger(value) || value < 1 || value > nativeLimits[key as keyof typeof nativeLimits])) {
      throw new Error('runtimeLimits must use known fields with positive bounded integers or explicit null');
    }
  }
  const configured = { hostTools: options.hostTools, createJudge: options.createJudge, onToolAttempt: options.onToolAttempt, onWorkflowEvent: options.onWorkflowEvent,
    runtimeLimits: Object.freeze(limits) };
  return pi => registerExtension(pi, configured);
}

export default function agentRunExtension(pi: ExtensionAPI): void {
  registerExtension(pi, {});
}

function registerExtension(pi: ExtensionAPI, configuration: AgentRunExtensionOptions): void {
  const limits: AgentRunRuntimeLimits = { ...nativeLimits, ...configuration.runtimeLimits };
  const serviceLimits = { deadlineMs: limits.deadlineMs, maxAgentCalls: limits.modelRequests,
    maxJudgeCalls: limits.judgeCalls, maxToolCalls: limits.toolAttempts };
  let current: Session | undefined;
  let runOrdinal = 0;
  const toolSet = (ctx: ExtensionContext, trusted = false): PiToolDefinition[] => {
    if (configuration.hostTools) {
      const supplied = configuration.hostTools(ctx);
      if (!Array.isArray(supplied) || supplied.length > 100) throw new Error('Host must supply at most 100 explicit tool definitions');
      const names = new Set<string>();
      return supplied.map(tool => {
        if (!tool || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 200
          || ['agentrun', 'submit'].includes(tool.name) || names.has(tool.name)) throw new Error('Host tools contain an invalid, reserved or duplicate name');
        if (typeof tool.execute !== 'function' || !tool.parameters || typeof tool.parameters !== 'object') throw new Error('Host tools require an executable definition and parameter schema');
        Compile(tool.parameters as never);
        if (tool.resultSchema) Compile(tool.resultSchema as never);
        names.add(tool.name);
        return { ...tool, parameters: structuredClone(tool.parameters), ...(tool.resultSchema ? { resultSchema: structuredClone(tool.resultSchema) } : {}) };
      });
    }
    const active = new Set(pi.getActiveTools());
    const builtins = new Set(pi.getAllTools().filter(t => t.sourceInfo.source === 'builtin').map(t => t.name));
    const definitions = Object.entries(constructors).filter(([name]) => active.has(name) && builtins.has(name) && (trusted || !mutatingTools.has(name)))
      .map(([, factory]) => factory(ctx.cwd) as ToolDefinition<any>);
    return [demoSearchTool(), ...supportTriageTools(), ...definitions as unknown as PiToolDefinition[]];
  };
  const state = async (ctx: ExtensionContext): Promise<Session> => {
    const key = `${ctx.sessionManager.getSessionId()}:${ctx.cwd}`;
    if (current && current.key === key && !current.closed) return current;
    if (current) {
      const old = current; old.clearStatus(); old.closed = true; old.controller?.abort();
      await old.service.dispose(); await old.inFlight;
    }
    const tools = toolSet(ctx);
    current = { key, sessionFile: () => ctx.sessionManager.getSessionFile(), clearStatus: () => { if (ctx.hasUI) { ctx.ui.setStatus('agentrun', undefined); ctx.ui.setWidget('agentrun', undefined); } }, tools, toolNames: tools.map(t => t.name), input: {}, busy: false, closed: false,
      service: new WorkflowExtensionService({ allowedTools: tools.map(t => t.name), limits: serviceLimits }) };
    const restored = restoreWorkflowSession(ctx.sessionManager.getBranch());
    if (restored) {
      current.draft = restored.workflow; current.input = restored.input; current.demo = restored.demo;
      current.savedName = restored.savedName; current.report = restored.report; current.observation = restored.observation; current.runId = restored.runId;
    }
    return current;
  };
  const persist = (s: Session, running = false, closing = false) => {
    if (current !== s || s.closed && !closing || !s.draft) return;
    const record: WorkflowSessionSnapshot = { version: 1, workflow: s.draft as WorkflowSessionSnapshot['workflow'],
      input: s.input, running, createdAt: new Date().toISOString(),
      ...(s.savedName ? { savedName: s.savedName } : {}), ...(s.demo ? { demo: s.demo } : {}),
      ...(s.runId ? { runId: s.runId } : {}), ...(s.report ? { report: s.report } : {}),
      ...(s.observation ? { observation: s.observation } : {}),
    };
    try {
      const data = structuredClone(record);
      // Never advertise history that this release cannot restore (including
      // non-JSON or oversized receipts). Display/retention limits are not run limits.
      if (!restoreWorkflowSession([{ type: 'custom', customType: 'agentrun:snapshot', data }])) throw new Error('Unrestorable workflow receipt');
      pi.appendEntry('agentrun:snapshot', data);
      const file = s.sessionFile();
      s.persistenceWarning = file && existsSync(file) ? undefined : 'Run receipts are in memory only: Pi has not yet persisted this session. Named procedure saves are durable; begin a normal Pi conversation to persist native session history.';
    }
    catch { s.persistenceWarning = 'Run state could not be retained in the Pi session. Keep this session open; named workflow saving is separate.'; }
  };
  const readiness = (ctx: ExtensionContext, s: Session) => ({
    skill: pi.getCommands().some(item => item.name === `skill:${AUTHOR_SKILL_NAME}` && item.source === 'skill'),
    pi: !!ctx.model && ctx.modelRegistry.getAll().some(model => model.id === ctx.model?.id && model.provider === ctx.model?.provider && model.api === ctx.model?.api),
    jev: !!configuration.createJudge || !!process.env.TYPESAFE_API_KEY?.trim(), sop: false, running: s.busy, workflow: !!s.draft,
    mode: s.draft ? s.demo ? 'scripted' : 'live' : undefined,
  });
  const show = (s: Session, content: string, details: unknown = {}) => {
    if (current !== s || s.closed) return;
    pi.sendMessage({ customType: 'agentrun', content: safe(content), display: true, details });
  };
  const commandError = (s: Session, error: unknown) => {
    const message = error instanceof Error && (error instanceof WorkflowStoreError || error.name === 'ExtensionServiceError' || /^(No workflow|Inspect a workflow|A workflow|Cannot inspect|Workflow|Code|Executable|Unsupported|Invalid workflow|AgentRun requires|AgentRun authoring|The active Pi|Saved workflow)/.test(error.message))
      ? error.message.slice(0, 2000) : 'AgentRun could not complete this operation. Use /agentrun status to check setup and /agentrun to inspect the workflow. No fallback was selected.';
    show(s, message);
  };
  const stage = (ctx: ExtensionContext, s: Session, line?: string) => {
    if (current !== s || s.closed || !ctx.hasUI) return;
    ctx.ui.setStatus('agentrun', line ? safe(line).slice(0, 140) : undefined);
  };
  const inspect = (ctx: ExtensionContext, s: Session, workflow?: unknown, input?: Record<string, unknown>) => {
    if (s.busy && (workflow !== undefined || input !== undefined)) throw new Error('A workflow is running. Stop it before changing its definition or input.');
    const candidate = workflow === undefined ? s.draft : workflow;
    if (candidate === undefined) throw new Error('No workflow yet. Describe a task with /agentrun <task>.');
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Cannot inspect workflow: workflow must be a JSON object, not a JSON-encoded string or array. Pass the complete object directly.');
    }
    // Include active tools available only with operator trust, without granting that trust.
    // Execution rechecks the actual per-run permissions and captures implementations.
    const checker = new WorkflowExtensionService({ allowedTools: toolSet(ctx, true).map(tool => tool.name), limits: serviceLimits });
    let inspection;
    try {
      inspection = checker.preflight(candidate, input);
      if (inspection.requires.sopSections.length) throw new Error('Native Pi does not supply SOP text in V1; use a configured SDK host. Keep the required sections intact.');
    } catch (error) {
      throw new Error(`Cannot inspect workflow: ${error instanceof Error ? error.message : 'Invalid workflow'}`);
    }
    // Stage the definition and input together only after nonexecuting checks succeed.
    const nextDraft = workflow === undefined ? s.draft : structuredClone(workflow);
    const changed = !s.draft || inspectWorkflow(s.draft).sha256 !== inspection.sha256;
    const nextInput = input === undefined ? changed ? {} : s.input : structuredClone(input);
    s.draft = nextDraft;
    if (changed) { s.demo = undefined; s.savedName = undefined; s.observation = undefined; s.report = undefined; s.runId = undefined; }
    if (input !== undefined) { s.observation = undefined; s.report = undefined; s.runId = undefined; }
    s.input = nextInput;
    if (workflow !== undefined || input !== undefined) persist(s);
    return { inspection, tree: formatWorkflowTree(inspection) };
  };
  const view = (ctx: ExtensionContext, s: Session) => {
    const result = workflowView(s.draft, { input: s.input,
    observation: s.observation, report: s.report, running: s.busy, savedName: s.savedName,
    mode: s.demo ? 'scripted · fictional · no model calls' : 'live adapters',
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'not selected', limits,
    availableTools: toolSet(ctx).map(tool => tool.name),
    });
    if (s.persistenceWarning) result.summary.push(s.persistenceWarning);
    return result;
  };
  const depsFor = (ctx: ExtensionContext, s: Session, signal: AbortSignal): WorkflowDeps => {
    let modelCalls = 0, toolCalls = 0;
    const countTool = () => {
      signal.throwIfAborted();
      toolCalls++;
      if (limits.toolAttempts !== null && toolCalls > limits.toolAttempts) throw new Error('Workflow tool-call limit reached');
      configuration.onToolAttempt?.();
      signal.throwIfAborted();
    };
    const tools = s.tools.map(tool => ({ ...tool, execute: async (...args: Parameters<PiToolDefinition['execute']>) => {
      const validator = Compile(tool.parameters as never);
      if (!validator.Check(args[1])) throw new ToolInputValidationError(tool.name, tool.name, toolInputProblems(validator.Errors(args[1])));
      return tool.execute(...args);
    } }));
    const host: PiHostContext = {
      ...ctx, thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
      modelRegistry: {
        getAll: () => ctx.modelRegistry.getAll(),
        streamSimple: (model, transcript, options) => {
          signal.throwIfAborted();
          modelCalls++;
          if (limits.modelRequests !== null && modelCalls > limits.modelRequests) throw new Error('Workflow model-request limit reached');
          return ctx.modelRegistry.streamSimple(model as Parameters<typeof ctx.modelRegistry.streamSimple>[0],
            transcript as Parameters<typeof ctx.modelRegistry.streamSimple>[1], { ...options, reasoning: options?.reasoning === 'off' ? undefined : options?.reasoning, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal });
        },
      },
    };
    const adapters = inspectWorkflow(s.draft).requires.adapters;
    const runner = adapters.includes('runNode') ? createPiHostRunner(host, { tools, signal, maxTurns: limits.nodeMaxTurns,
      maxSubmissions: limits.nodeMaxSubmissions, timeoutMs: limits.nodeTimeoutMs,
      onEvent: event => { if (event.type === 'tool_execution_start') countTool(); },
    }) : undefined;
    let judge: NonNullable<WorkflowDeps['runJudge']> | undefined;
    if (adapters.includes('runJudge')) {
      if (configuration.createJudge) {
        judge = configuration.createJudge({ signal });
        if (typeof judge !== 'function') throw new Error('Host judge factory must return a runner');
      } else {
        try { judge = createJevRunner({ signal, maxAttempts: 1 }); }
        catch { throw new Error('AgentRun requires TypeSafe configuration for this workflow. Set TYPESAFE_API_KEY and, for a gateway, TYPESAFE_BASE_URL before running.'); }
      }
    }
    return {
      runNode: request => {
        if (!runner) throw new Error('Workflow agent adapter was not admitted');
        return runner(request);
      },
      runJudge: request => {
        if (!judge) throw new Error('Workflow Jev adapter was not admitted');
        return judge(request);
      },
      runEffect: async ({ node, input, signal: effectSignal }) => {
        countTool();
        const tool = tools.find(tool => tool.name === node.tool);
        if (!tool || node.via !== 'tool') throw new Error('Workflow requested an unavailable tool');
        let result;
        try { result = await tool.execute('agentrun-effect', input, effectSignal, undefined, ctx); }
        catch (error) {
          if (error instanceof ToolInputValidationError) throw new ToolInputValidationError(node.label, tool.name, error.problems);
          throw error;
        }
        return !configuration.hostTools && ['search', 'support_demo_lookup', 'support_demo_handoff'].includes(node.tool ?? '') ? result.details : { content: result.content, ...(result.details === undefined ? {} : { details: result.details }) };
      },
    };
  };
  const execute = async (ctx: ExtensionContext, s: Session, input: Record<string, unknown>, options: {
    signal?: AbortSignal; trusted?: boolean; modelResult?: boolean;
    update?: (result: ReturnType<typeof textResult>) => void;
  } = {}) => {
    if (s.busy) throw new Error('A workflow is already running. Use /agentrun stop first.');
    if (!s.draft) throw new Error('Inspect a workflow first. Try /agentrun demo, or describe a task with /agentrun <task>.');
    const scripted = s.demo !== undefined;
    s.busy = true; s.controller = new AbortController();
    const signals = [s.controller.signal, options.signal, ctx.signal].filter((v): v is AbortSignal => !!v);
    const signal = AbortSignal.any(signals);
    try {
      if (inspectWorkflow(s.draft).requires.sopSections.length) throw new Error('Workflow requires SOP text. Native Pi does not supply SOP text in V1; use a configured SDK host. Keep the required sections intact.');
      signal.throwIfAborted();
      const available = toolSet(ctx, options.trusted);
      if (available.map(t => t.name).join(',') !== s.toolNames.join(',')) {
        await s.service.dispose(); signal.throwIfAborted(); s.tools = available; s.toolNames = available.map(t => t.name);
        s.service = new WorkflowExtensionService({ allowedTools: s.toolNames, limits: serviceLimits });
      }
      // Resolve implementations from the execution context even if names are unchanged.
      s.tools = available;
      // Validate the actual input before asking for model credentials or executing code probes.
      s.service.preflight(s.draft, input);
      const prepared = s.service.prepare(s.draft, { allowExecutableCandidates: options.trusted ?? false });
      // Adapter admission is not a run. Failed setup must not leave a running receipt.
      const deps = scripted
        ? s.demo === 'triage' || s.demo === 'triage-failure' ? scriptedSupportTriageDeps({ failLookup: s.demo === 'triage-failure' }) : scriptedDemoDeps(s.demo === 'empty')
        : depsFor(ctx, s, signal);
      s.input = structuredClone(input);
      const tree = formatWorkflowTree(inspectWorkflow(s.draft));
      const label = scripted ? 'Scripted demo — fictional sources; no model calls.' : `Running with Pi · ${limits.deadlineMs === null ? 'no workflow deadline; operator cancellation remains available' : `${limits.deadlineMs / 1000}-second workflow deadline`}. Jev is used only for system one nodes.`;
      options.update?.(textResult(`${label}\n\n${tree}`));
      stage(ctx, s, 'agent.run() · starting');
      const observation = new WorkflowObservation();
      s.observation = observation.data; s.report = undefined; s.runId = randomUUID();
      persist(s, true);
      const ordinal = ++runOrdinal;
      let sequence = 0;
      const report = await s.service.run(s.input, {
        deps: observation.observe(deps), signal,
        ...(configuration.onWorkflowEvent ? { onTraceEvent: (event: AgentRunWorkflowEvent['event']) =>
          configuration.onWorkflowEvent!({ workflowDigest: prepared.digest, runOrdinal: ordinal, sequence: ++sequence, event }) } : {}),
        onEvent: event => {
          observation.record(event);
          if (current !== s || s.closed) return;
          const progress = progressLines(observation.data);
          if (ctx.mode === 'tui') ctx.ui.setWidget('agentrun', [safe(prepared.inspection.name), ...progress.map(safe), '/agentrun inspect · /agentrun stop']);
          else options.update?.(textResult(`${label}\n\n${progress.join('\n')}`));
        },
      });
      s.report = report;
      persist(s);
      const summary = formatRunReport(report, scripted);
      const { events: _events, ...modelReport } = report;
      const mode = scripted ? 'scripted' : 'live';
      return textResult(options.modelResult ? modelJson({ mode, ...modelReport }) : summary + (s.persistenceWarning ? `\n${s.persistenceWarning}` : ''), { mode, ...report,
        // Failure diagnostics must not echo rejected raw arguments. The operator
        // can inspect the retained draft explicitly; the error receipt stays sanitized.
        ...(report.error ? {} : { view: workflowView(s.draft, { input: s.input, observation: s.observation, report, mode }) }) });
    } catch (error) {
      if (error instanceof ExtensionServiceError && error.code === 'admission' && error.message.includes('code requires allowExecutableCandidates')) {
        throw new ExtensionServiceError(error.code, error.message.replaceAll('code requires allowExecutableCandidates',
          'Code requires the user command /agentrun run --trusted for each run. This permits local, unsandboxed execution.'));
      }
      throw error;
    } finally { s.busy = false; s.controller = undefined; stage(ctx, s); if (current === s && !s.closed && ctx.hasUI) ctx.ui.setWidget('agentrun', undefined); }
  };

  const launch = async (ctx: ExtensionContext, s: Session, input: Record<string, unknown>, trusted = false) => {
    if (s.busy) throw new Error('A workflow is already running. Use /agentrun stop first.');
    // Capture host selection and permission before yielding the interactive command loop.
    const runContext = { ...ctx, model: ctx.model, thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel() };
    const pending = execute(runContext, s, structuredClone(input), { trusted })
      .then(result => show(s, result.content[0].text, result.details), error => commandError(s, error));
    s.inFlight = pending;
    const clear = () => { if (s.inFlight === pending) s.inFlight = undefined; };
    void pending.then(clear, clear);
    // Headless callers await the report. Interactive Pi must regain its input
    // loop so status/stop can be dispatched while a child Agent is running.
    if (!ctx.hasUI) await pending;
  };

  pi.registerTool({
    name: 'agentrun', label: 'AgentRun workflow',
    description: `Use the ${AUTHOR_SKILL_NAME} skill to compose workflows.` + ' Describe lists available tools and their schemas. Inspect or run an AgentRun DSL workflow in this Pi session. First inspect to show its graph. Agent nodes capture the active Pi model when execution starts. Code needs the user command /agentrun run --trusted for each run. ' + (configuration.hostTools
      ? 'Only the explicit host-configured tools are available, including during trusted runs. Outer permission hooks are not inherited. '
      : 'Enabled read-only Pi built-ins are available to declared steps. Shell/write/edit need the trusted command for each run; custom extension tools and permission hooks are not inherited. The search and support_demo tools use fictional supplied sources only. ') + 'Save stores a named procedure revision, not its input or permission. Load preflights current host capabilities. Run always restarts; there is no checkpoint resume. Scripted demos stay scripted on rerun.',
    parameters: Type.Object({ action: Type.Union(['describe', 'inspect', 'run', 'save', 'load', 'list'].map(value => Type.Literal(value))),
      name: Type.Optional(Type.String({ description: 'Saved procedure name: lowercase letters, digits, hyphens or underscores.' })),
      digest: Type.Optional(Type.String({ description: 'Optional exact saved SHA-256 revision to load.' })),
      workflow: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: 'The complete AgentRun workflow JSON object. Pass the object directly, not a JSON-encoded string. Inspection validates its DSL structure.',
      })), input: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    executionMode: 'sequential',
    renderResult(result, options) {
      const details = result.details as (ExtensionRunReport & { mode?: string; view?: ReturnType<typeof workflowView> }) | undefined;
      const text = details?.status && details.calls ? options?.expanded
        ? details.view ? formatWorkflowView({ ...details.view, output: undefined }) + (details.output === undefined ? '' : `\n\nOutput:\n${readable(details.output, Number.MAX_SAFE_INTEGER)}`) : formatRunReport(details, details.mode === 'scripted') : formatRunReport(details, details.mode === 'scripted')
        : details?.view ? formatWorkflowView(details.view) : result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      return new Text(safe(text), 0, 0);
    },
    async execute(_id, args, signal, onUpdate, ctx) {
      const s = await state(ctx);
      const store = new WorkflowStore(ctx.cwd);
      if (args.action === 'save') {
        if (s.busy) throw new Error('A workflow is running. Save after it stops.');
        if (!s.draft) throw new Error('No workflow to save. Inspect a workflow first.');
        const saved = await store.save(args.name ?? '', s.draft); s.savedName = saved.name; persist(s);
        return textResult(`Saved ${saved.name} · ${saved.digest.slice(0, 12)}. Input and execution permission are not saved.\nLoad this revision: /agentrun load ${saved.name} ${saved.digest}${s.demo ? '\nScripted demo adapters are not saved. Loading this definition uses live adapters.' : ''}`, saved);
      }
      if (args.action === 'list') { const workflows = await store.list(); return textResult(modelJson(workflows), { workflows }); }
      if (args.action === 'load') {
        const saved = await store.load(args.name ?? '', args.digest);
        const result = inspect(ctx, s, saved.workflow, args.input); s.input = structuredClone(args.input ?? {}); s.savedName = saved.name; s.demo = undefined; s.report = undefined; s.observation = undefined; s.runId = undefined; persist(s);
        const preview = view(ctx, s);
        return textResult(modelJson({ preview: formatWorkflowView(preview), workflow: s.draft, input: s.input }), { ...result, saved, view: preview });
      }
      if (args.action === 'describe') {
        const details = { tools: toolSet(ctx).map(t => ({ name: t.name, description: t.description, parameters: t.parameters,
          resultSchema: t.resultSchema ?? { type: 'object', properties: { content: { type: 'array', items: { type: 'object' } }, details: {} }, required: ['content'] },
          resultContract: t.resultSchema ? 'Host-declared direct workflow call result.' : 'Pi result envelope; tool-specific details are not declared. Do not invent fields inside details.',
        })),
          limits: { ...limits }, structuralLimits: { ...extensionStructuralLimits }, ...readiness(ctx, s), authoring: { language: loadAuthorReference('language'), workflow: loadAuthorReference('workflow-format'), jev: loadAuthorReference('jev-decisions'), host: renderAuthorHostAddendum(PI_HOST_ADDENDUM) } };
        return textResult(JSON.stringify(details, null, 2), details);
      }
      if (args.action === 'run' && args.workflow !== undefined) throw new Error('Inspect the workflow first with action inspect, then run without a workflow argument.');
      if (args.action === 'inspect') {
        const result = inspect(ctx, s, args.workflow, args.input);
        const preview = view(ctx, s);
        // The author needs the exact definition when editing a restored procedure.
        // Pi's renderer shows the readable view, not this model-facing JSON.
        return textResult(modelJson({ preview: formatWorkflowView(preview), workflow: s.draft, input: s.input }), { ...result, view: preview, tools: toolSet(ctx).map(t => t.name) });
      }
      return execute(ctx, s, args.input ?? s.input, { signal, update: onUpdate, modelResult: true });
    },
  });

  pi.registerCommand('agentrun', {
    description: 'Describe a task, inspect its workflow, or try /agentrun demo',
    async handler(args, ctx) {
      const s = await state(ctx);
      let raw = args.trim();
      try {
      if ((!raw || raw === 'inspect') && s.draft && ctx.mode === 'tui') {
        const action = await showWorkflowInspector(ctx, () => view(ctx, s));
        if (!action) return;
        if (action === 'save') {
          const name = await ctx.ui.input('Save procedure', s.savedName ?? 'support-triage');
          if (!name) return; raw = `save ${name}`;
        } else if (action === 'load') {
          const stored = await new WorkflowStore(ctx.cwd).list();
          const names = [...new Set(stored.map(item => item.name))];
          if (!names.length) { show(s, 'No saved procedures yet. Use /agentrun save <name>.'); return; }
          const name = await ctx.ui.select('Load procedure', names);
          if (!name) return; raw = `load ${name}`;
        } else if (action === 'edit') {
          const request = await ctx.ui.input('Edit procedure', 'Describe the change; Pi will preview a candidate before running it.');
          if (!request) return;
          pi.sendUserMessage(`/skill:agentrun-author Edit the current procedure: ${request}. Inspect the candidate and explain the change. Do not run it yet.`, { expandPromptTemplates: true }); return;
        } else raw = action;
      }
      const command = /^(help|status|stop|demo|triage|run|inspect)(?:\s|$)/i.test(raw) ? raw.toLowerCase().replace(/\s+/g, ' ') : raw;
      const words = command.split(/\s+/);
      const commandLike = /^(help|status|stop|demo|run)(?:-|$)/i.test(words[0])
        && words.slice(1).every(word => word.startsWith('-') || ['live', 'empty'].includes(word));
        if (command === 'help' || command === '--help' || command === '-h') {
          show(s, help);
        } else if (!command || command === 'inspect') {
          show(s, s.draft ? formatWorkflowView(view(ctx, s)) : help);
        } else if (/^save(?:\s|$)/.test(command)) {
          if (s.busy) throw new Error('A workflow is running. Save after it stops.');
          if (!s.draft) throw new Error('No workflow to save. Inspect a workflow first.');
          const saved = await new WorkflowStore(ctx.cwd).save(command.slice(4).trim(), s.draft); s.savedName = saved.name; persist(s);
          show(s, `Saved ${saved.name} · ${saved.digest.slice(0, 12)}. Input and execution permission are not saved.\nReuse: /agentrun load ${saved.name}\nLoad this revision: /agentrun load ${saved.name} ${saved.digest}${s.demo ? '\nScripted demo adapters are not saved. Loading this definition uses live adapters.' : ''}`, saved);
        } else if (/^load(?:\s|$)/.test(command)) {
          const [, name, digest] = command.split(/\s+/);
          const saved = await new WorkflowStore(ctx.cwd).load(name ?? '', digest);
          inspect(ctx, s, saved.workflow); s.savedName = saved.name; s.input = {}; s.demo = undefined; s.report = undefined; s.observation = undefined; s.runId = undefined; persist(s);
          show(s, `Loaded procedure. Supply new input with /agentrun input. Loading never executes it.\n\n${formatWorkflowView(view(ctx, s))}`);
        } else if (command === 'list') {
          const stored = await new WorkflowStore(ctx.cwd).list();
          show(s, stored.length ? stored.map(item => `${item.name} · ${item.workflowName}\n/agentrun load ${item.name} ${item.digest}`).join('\n') : 'No saved procedures yet. Use /agentrun save <name>.', { workflows: stored });
        } else if (/^history(?:\s|$)/.test(command)) {
          const history = workflowRunHistory(ctx.sessionManager.getBranch());
          if (!history.length) { show(s, 'No retained runs on this Pi session branch yet.'); return; }
          const labels = history.map((run, index) => `${index + 1}. ${inspectWorkflow(run.workflow).name} · ${run.report?.status ?? 'interrupted'} · ${run.createdAt}`);
          let index = Number(command.slice(7).trim()) - 1;
          if (command === 'history' && ctx.mode === 'tui') {
            const selected = await ctx.ui.select('Retained runs on this session branch', labels);
            if (!selected) return; index = labels.indexOf(selected);
          }
          if (!Number.isInteger(index) || index < 0 || index >= history.length) {
            show(s, `${labels.join('\n')}\n\nInspect: /agentrun history <number>`, { runs: history.map(run => ({ runId: run.runId, createdAt: run.createdAt, digest: run.report?.digest, status: run.report?.status })) }); return;
          }
          const run = history[index];
          const receipt = workflowView(run.workflow, { input: run.input, observation: run.observation, report: run.report, mode: run.demo ? 'scripted' : 'live adapters', savedName: run.savedName });
          // History is read-only. It never replaces the active draft or replays a run.
          if (ctx.mode === 'tui') await showWorkflowInspector(ctx, () => ({ ...receipt, readOnly: true }));
          else show(s, formatWorkflowView(receipt), { run });
        } else if (/^input(?:\s|$)/.test(command)) {
          if (!s.draft) throw new Error('No workflow yet. Load or describe a procedure first.');
          if (s.busy) throw new Error('A workflow is running. Stop it before changing its input.');
          let supplied = raw.slice(5).trim();
          if (!supplied && ctx.hasUI) supplied = await ctx.ui.input('New workflow input', 'Describe the new case in plain language, or paste a JSON object.') ?? '';
          if (!supplied) { show(s, 'Use /agentrun input <describe the new case>, or ask Pi to use new input. Nothing was run.'); return; }
          if (supplied.startsWith('{')) {
            let input: unknown;
            try { input = JSON.parse(supplied); } catch { throw new Error('Workflow input must be valid JSON, or describe it in plain language.'); }
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workflow input must be an object.');
            inspect(ctx, s, undefined, input as Record<string, unknown>);
            show(s, `Input updated. Nothing was run.\n\n${formatWorkflowView(view(ctx, s))}`);
          } else {
            const key = singleTextInput(s.draft);
            if (key) {
              inspect(ctx, s, undefined, { [key]: supplied });
              show(s, `Input updated. Nothing was run.\n\n${formatWorkflowView(view(ctx, s))}`);
            } else {
              pi.sendUserMessage(`/skill:agentrun-author Set new input for the current inspected workflow: ${supplied}. Keep the procedure unchanged; inspect with input only. Ask for missing facts instead of inventing them. Do not run yet.`, { expandPromptTemplates: true });
            }
          }
        } else if (/^triage(?:\s|$)/.test(command)) {
          const parts = command.split(/\s+/).slice(1); const live = parts[0] === 'live';
          const name = parts[live ? 1 : 0] ?? 'billing';
          if (!['billing', 'technical', 'ambiguous', 'failure'].includes(name) || parts.length > (live ? 2 : 1) || live && name === 'failure') {
            show(s, 'Use /agentrun triage [billing|technical|ambiguous|failure], or /agentrun triage live [billing|technical|ambiguous].'); return;
          }
          const input = structuredClone(supportTriageInputs[name === 'failure' ? 'billing' : name as keyof typeof supportTriageInputs]);
          inspect(ctx, s, supportTriageWorkflow, input); s.demo = live ? undefined : name === 'failure' ? 'triage-failure' : 'triage';
          show(s, `Fictional support triage · ${live ? 'real model calls' : 'scripted, no model calls'}. No customer actions.\n${formatWorkflowView(view(ctx, s))}`);
          const result = await execute(ctx, s, input); show(s, result.content[0].text, result.details);
        } else if (command === 'status') {
          const ready = readiness(ctx, s);
          show(s, `agent.run() · ${s.busy ? 'running' : 'idle'}\nDemo: ready — /agentrun demo (no keys or model calls)\nWorkflow: ${s.draft ? `${modelJson(inspectWorkflow(s.draft).name)} · ${s.demo ? 'scripted' : 'live adapters'}` : 'none — load a saved procedure, run the demo, or describe a task'}\n\nFor your own workflows:\nPi host: ${PI_VERSION}${PI_VERSION === '0.87.0' ? '' : ' (tested on 0.87.0; use the bundled ./node_modules/.bin/pi)'}\nSkill: ${ready.skill ? 'loaded — /agentrun <task>' : 'missing — enable package skills, then /reload'}\nPi: ${ready.pi ? 'selected model available (connection not tested)' : 'no usable active model — /login to connect a provider, then /model to select it'}\nJev: ${ready.jev ? 'configuration present (connection not tested)' : 'not configured — only needed for system one decisions; set TYPESAFE_API_KEY before starting Pi'}`, ready);
        } else if (command === 'stop') {
          s.controller?.abort(); s.service.stop(); show(s, s.busy ? 'Stop requested. Already-started tool effects may still finish.' : 'Nothing is running.');
        } else if (command === 'demo' || command === 'demo live' || command === 'demo empty') {
          inspect(ctx, s, demoWorkflow);
          s.demo = command === 'demo live' ? undefined : command === 'demo empty' ? 'empty' : 'scripted';
          show(s, `${inspect(ctx, s).tree}\n\n${s.demo ? 'Running scripted demo. No model calls.' : 'Running with your Pi model and Jev.'}`);
          await launch(ctx, s, demoInput);
        } else if (command === 'run' || command === 'run --trusted') {
          await launch(ctx, s, s.input, command === 'run --trusted');
        } else if (commandLike || command.startsWith('-')) {
          show(s, `Unknown AgentRun command: ${raw}\n\n${help}`);
        } else {
          if (s.busy) throw new Error('A workflow is running. Stop it before starting another.');
          if (!pi.getCommands().some(item => item.name === `skill:${AUTHOR_SKILL_NAME}` && item.source === 'skill')) {
            throw new Error('AgentRun authoring skill is unavailable. Enable package skills, then /reload. Run /agentrun status to check discovery.');
          }
          if (!readiness(ctx, s).pi) throw new Error(PI_MODEL_SETUP_MESSAGE);
          pi.sendUserMessage(`/skill:${AUTHOR_SKILL_NAME} ${raw}`, { expandPromptTemplates: true });
        }
      } catch (error) {
        commandError(s, error);
      }
    },
  });
  const closeSession = async (retainFinal = false) => {
    if (!current) return;
    const old = current, wasRunning = old.busy; old.clearStatus(); old.closed = true; old.controller?.abort(); await old.service.dispose();
    await old.inFlight;
    // Only before-switch/shutdown hooks still own the originating branch. A
    // session_tree event is already on another branch and must never receive this receipt.
    if (retainFinal && wasRunning && old.report) persist(old, false, true);
    if (current === old) current = undefined;
  };
  pi.on('session_shutdown', () => closeSession(true));
  pi.on('session_before_switch', () => closeSession(true));
  pi.on('session_before_fork', () => closeSession(true));
  pi.on('session_start', async (_event, ctx) => {
    if (current && current.key !== `${ctx.sessionManager.getSessionId()}:${ctx.cwd}`) await closeSession();
    await state(ctx);
  });
  pi.on('session_tree', async (_event, ctx) => { await closeSession(); await state(ctx); });
  pi.registerEntryRenderer<WorkflowSessionSnapshot>('agentrun:snapshot', (entry, options) => {
    if (entry.data?.running) return undefined;
    const snapshot = restoreWorkflowSession([entry]);
    if (!snapshot) return undefined;
    if (!snapshot.report && !snapshot.running) return undefined;
    return new Text(safe(options.expanded ? formatWorkflowView(workflowView(snapshot.workflow, {
      input: snapshot.input, report: snapshot.report, observation: snapshot.observation, mode: snapshot.demo ? 'scripted' : 'live adapters',
    })) : `AgentRun receipt · ${snapshot.report?.status ?? 'interrupted'} · ${inspectWorkflow(snapshot.workflow).name}`), 0, 0);
  });
}
