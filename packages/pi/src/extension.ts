import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Text } from '@earendil-works/pi-tui';
import {
  createReadToolDefinition, createBashToolDefinition, createEditToolDefinition, createWriteToolDefinition,
  createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  VERSION as PI_VERSION, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { formatWorkflowTree, inspectWorkflow, type WorkflowDeps } from '@parcha/agentrun-dsl';
import { createJevRunner } from '@parcha/agentrun-jev';
import { createPiHostRunner, PI_MODEL_SETUP_MESSAGE } from './host-session.js';
import type { PiHostContext, PiToolDefinition } from './types.js';
import { WorkflowExtensionService, extensionStructuralLimits, type ExtensionRunReport } from './extension-service.js';
import { demoInput, demoSearchTool, demoWorkflow, scriptedDemoDeps } from './demo.js';
import { cleanText as safe, formatRunReport, modelJson } from './presentation.js';
import { loadPiJevGuide, loadPiWorkflowGuide } from './skill-bundle.js';
import { ToolInputValidationError, toolInputProblems } from './tool-input-error.js';

const constructors = {
  read: createReadToolDefinition, bash: createBashToolDefinition, edit: createEditToolDefinition,
  write: createWriteToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition,
};
const mutatingTools = new Set(['bash', 'edit', 'write']);
const help = 'Describe a task: /agentrun <what you want done>\nTry it without keys: /agentrun demo | demo empty\nUse real Pi and Jev calls: /agentrun demo live\nInspect: /agentrun · Rerun: /agentrun run · Setup: /agentrun status\nStop: /agentrun stop (Escape does not cancel slash-started runs)';
const textResult = (text: string, details: unknown = {}) => ({ content: [{ type: 'text' as const, text: safe(text) }], details });
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
  draft?: unknown; demo?: 'scripted' | 'empty'; input: Record<string, unknown>; busy: boolean; closed: boolean; controller?: AbortController;
  inFlight?: Promise<void>;
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
        names.add(tool.name);
        return { ...tool, parameters: structuredClone(tool.parameters) };
      });
    }
    const active = new Set(pi.getActiveTools());
    const builtins = new Set(pi.getAllTools().filter(t => t.sourceInfo.source === 'builtin').map(t => t.name));
    const definitions = Object.entries(constructors).filter(([name]) => active.has(name) && builtins.has(name) && (trusted || !mutatingTools.has(name)))
      .map(([, factory]) => factory(ctx.cwd) as ToolDefinition<any>);
    return [demoSearchTool(), ...definitions as unknown as PiToolDefinition[]];
  };
  const state = async (ctx: ExtensionContext): Promise<Session> => {
    const key = `${ctx.sessionManager.getSessionId()}:${ctx.cwd}`;
    if (current && current.key === key && !current.closed) return current;
    if (current) {
      const old = current; old.clearStatus(); old.closed = true; old.controller?.abort();
      await old.service.dispose(); await old.inFlight;
    }
    const tools = toolSet(ctx);
    current = { key, clearStatus: () => { if (ctx.hasUI) { ctx.ui.setStatus('agentrun', undefined); ctx.ui.setWidget('agentrun', undefined); } }, tools, toolNames: tools.map(t => t.name), input: {}, busy: false, closed: false,
      service: new WorkflowExtensionService({ allowedTools: tools.map(t => t.name), limits: serviceLimits }) };
    return current;
  };
  const readiness = (ctx: ExtensionContext, s: Session) => ({
    skill: pi.getCommands().some(item => item.name === 'skill:agentrun-author' && item.source === 'skill'),
    pi: !!ctx.model && ctx.modelRegistry.getAll().some(model => model.id === ctx.model?.id && model.provider === ctx.model?.provider && model.api === ctx.model?.api),
    jev: !!configuration.createJudge || !!process.env.TYPESAFE_API_KEY?.trim(), sop: false, running: s.busy, workflow: !!s.draft,
    mode: s.draft ? s.demo ? 'scripted' : 'live' : undefined,
  });
  const show = (s: Session, content: string, details: unknown = {}) => {
    if (current !== s || s.closed) return;
    pi.sendMessage({ customType: 'agentrun', content: safe(content), display: true, details });
  };
  const commandError = (s: Session, error: unknown) => {
    const message = error instanceof Error && (error.name === 'ExtensionServiceError' || /^(No workflow|Inspect a workflow|A workflow|Cannot inspect|Workflow|Code|Executable|Unsupported|Invalid workflow|AgentRun requires|AgentRun authoring|The active Pi)/.test(error.message))
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
    if (changed) s.demo = undefined;
    s.input = nextInput;
    return { inspection, tree: formatWorkflowTree(inspection) };
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
        return !configuration.hostTools && node.tool === 'search' ? result.details : { content: result.content, ...(result.details === undefined ? {} : { details: result.details }) };
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
      const prepared = s.service.prepare(s.draft, { allowExecutableCandidates: options.trusted ?? false });
      s.input = structuredClone(input);
      const tree = formatWorkflowTree(inspectWorkflow(s.draft));
      const label = scripted ? 'Scripted demo — fictional sources; no model calls.' : `Running with Pi · ${limits.deadlineMs === null ? 'no workflow deadline; operator cancellation remains available' : `${limits.deadlineMs / 1000}-second workflow deadline`}. Jev is used only for system one nodes.`;
      options.update?.(textResult(`${label}\n\n${tree}`));
      stage(ctx, s, 'agent.run() · starting');
      let completed = 0;
      const active = new Map<string, number>();
      const ordinal = ++runOrdinal;
      let sequence = 0;
      const report = await s.service.run(s.input, {
        deps: scripted ? scriptedDemoDeps(s.demo === 'empty') : depsFor(ctx, s, signal), signal,
        ...(configuration.onWorkflowEvent ? { onTraceEvent: (event: AgentRunWorkflowEvent['event']) =>
          configuration.onWorkflowEvent!({ workflowDigest: prepared.digest, runOrdinal: ordinal, sequence: ++sequence, event }) } : {}),
        onEvent: event => {
          if (current !== s || s.closed || !event.label) return;
          if (event.type === 'node.start') active.set(event.label, (active.get(event.label) ?? 0) + 1);
          else if (event.type === 'node.end') {
            const count = (active.get(event.label) ?? 1) - 1;
            if (count) active.set(event.label, count); else active.delete(event.label);
            completed++;
          } else return;
          const running = [...active].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(', ');
          const progress = `agent.run() · ${completed} finished${running ? ` · ${running}` : ''}`;
          stage(ctx, s, progress);
          if (ctx.hasUI) ctx.ui.setWidget('agentrun', [safe(progress), '/agentrun stop to cancel']);
          options.update?.(textResult(`${label}\n\n${tree}\n\n${progress}`));
        },
      });
      const summary = formatRunReport(report, scripted);
      const { events: _events, ...modelReport } = report;
      const mode = scripted ? 'scripted' : 'live';
      return textResult(options.modelResult ? modelJson({ mode, ...modelReport }) : summary, { mode, ...report });
    } finally { s.busy = false; s.controller = undefined; stage(ctx, s); if (current === s && !s.closed && ctx.hasUI) ctx.ui.setWidget('agentrun', undefined); }
  };

  pi.registerTool({
    name: 'agentrun', label: 'AgentRun workflow',
    description: 'Use the agentrun-author skill to compose workflows. Describe lists available tools and their schemas. Inspect or run an AgentRun DSL workflow in this Pi session. First inspect to show its graph. Agent nodes capture the active Pi model when execution starts. Code needs the user command /agentrun run --trusted for each run. ' + (configuration.hostTools
      ? 'Only the explicit host-configured tools are available, including during trusted runs. Outer permission hooks are not inherited. '
      : 'Enabled read-only Pi built-ins are available to declared steps. Shell/write/edit need the trusted command for each run; custom extension tools and permission hooks are not inherited. The search tool reads fictional demo sources only. ') + 'Scripted demos stay scripted on rerun; use /agentrun demo live to switch. Saving workflows is not part of v1.',
    parameters: Type.Object({ action: Type.Union([Type.Literal('describe'), Type.Literal('inspect'), Type.Literal('run')]),
      workflow: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: 'The complete AgentRun workflow JSON object. Pass the object directly, not a JSON-encoded string. Inspection validates its DSL structure.',
      })), input: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
    executionMode: 'sequential',
    renderResult(result, options) {
      const details = result.details as (ExtensionRunReport & { mode?: string }) | undefined;
      const text = details?.status && details.calls ? options?.expanded
        ? JSON.stringify(details, null, 2) : formatRunReport(details, details.mode === 'scripted')
        : result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      return new Text(safe(text), 0, 0);
    },
    async execute(_id, args, signal, onUpdate, ctx) {
      const s = await state(ctx);
      if (args.action === 'describe') {
        const details = { tools: toolSet(ctx).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
          limits: { ...limits }, structuralLimits: { ...extensionStructuralLimits }, ...readiness(ctx, s), authoring: { workflow: loadPiWorkflowGuide(), jev: loadPiJevGuide() } };
        return textResult(JSON.stringify(details, null, 2), details);
      }
      if (args.action === 'run' && args.workflow !== undefined) throw new Error('Inspect the workflow first with action inspect, then run without a workflow argument.');
      if (args.action === 'inspect') {
        const result = inspect(ctx, s, args.workflow, args.input);
        return textResult(result.tree, { ...result, tools: toolSet(ctx).map(t => t.name) });
      }
      return execute(ctx, s, args.input ?? s.input, { signal, update: onUpdate, modelResult: true });
    },
  });

  pi.registerCommand('agentrun', {
    description: 'Describe a task, inspect its workflow, or try /agentrun demo',
    async handler(args, ctx) {
      const s = await state(ctx);
      const raw = args.trim();
      const command = /^(help|status|stop|demo|run)(?:\s|$)/i.test(raw) ? raw.toLowerCase().replace(/\s+/g, ' ') : raw;
      const words = command.split(/\s+/);
      const commandLike = /^(help|status|stop|demo|run)(?:-|$)/i.test(words[0])
        && words.slice(1).every(word => word.startsWith('-') || ['live', 'empty'].includes(word));
      try {
        if (command === 'help' || command === '--help' || command === '-h') {
          show(s, help);
        } else if (!command) {
          show(s, s.draft ? `${inspect(ctx, s).tree}\n\n${s.busy ? 'Running. /agentrun stop to cancel.' : s.demo ? 'Replay: /agentrun run (scripted, no model calls). Switch to real models: /agentrun demo live.' : 'Run: /agentrun run. Ask Pi to change this workflow.'}` : help);
        } else if (command === 'status') {
          const ready = readiness(ctx, s);
          show(s, `agent.run() · ${s.busy ? 'running' : 'idle'}\nDemo: ready — /agentrun demo (no keys or model calls)\nWorkflow: ${s.draft ? `${modelJson(inspectWorkflow(s.draft).name)} · ${s.demo ? 'scripted' : 'live adapters'}` : 'none — run the demo or describe a task; /reload clears the previous workflow'}\n\nFor your own workflows:\nPi host: ${PI_VERSION}${PI_VERSION === '0.87.0' ? '' : ' (tested on 0.87.0; use the bundled ./node_modules/.bin/pi)'}\nSkill: ${ready.skill ? 'loaded — /agentrun <task>' : 'missing — enable package skills, then /reload'}\nPi: ${ready.pi ? 'selected model available (connection not tested)' : 'no usable active model — /login to connect a provider, then /model to select it'}\nJev: ${ready.jev ? 'configuration present (connection not tested)' : 'not configured — only needed for system one decisions; set TYPESAFE_API_KEY before starting Pi'}`, ready);
        } else if (command === 'stop') {
          s.controller?.abort(); s.service.stop(); show(s, s.busy ? 'Stop requested. Already-started tool effects may still finish.' : 'Nothing is running.');
        } else if (command === 'demo' || command === 'demo live' || command === 'demo empty') {
          inspect(ctx, s, demoWorkflow);
          s.demo = command === 'demo live' ? undefined : command === 'demo empty' ? 'empty' : 'scripted';
          show(s, `${inspect(ctx, s).tree}\n\n${s.demo ? 'Running scripted demo. No model calls.' : 'Running with your Pi model and Jev.'}`);
          const result = await execute(ctx, s, demoInput);
          show(s, result.content[0].text, result.details);
        } else if (command === 'run' || command === 'run --trusted') {
          if (s.busy) throw new Error('A workflow is already running. Use /agentrun stop first.');
          // Capture host selection and permission before yielding the interactive command loop.
          const runContext = { ...ctx, model: ctx.model, thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel() };
          const pending = execute(runContext, s, structuredClone(s.input), { trusted: command === 'run --trusted' })
            .then(result => show(s, result.content[0].text, result.details), error => commandError(s, error));
          s.inFlight = pending;
          const clear = () => { if (s.inFlight === pending) s.inFlight = undefined; };
          void pending.then(clear, clear);
          // Headless callers rely on the report being available when this handler resolves.
          // Interactive Pi must regain its input loop so status/stop can be dispatched.
          if (!ctx.hasUI) await pending;
        } else if (commandLike || command.startsWith('-')) {
          show(s, `Unknown AgentRun command: ${raw}\n\n${help}`);
        } else {
          if (s.busy) throw new Error('A workflow is running. Stop it before starting another.');
          if (!pi.getCommands().some(item => item.name === 'skill:agentrun-author' && item.source === 'skill')) {
            throw new Error('AgentRun authoring skill is unavailable. Enable package skills, then /reload. Run /agentrun status to check discovery.');
          }
          if (!readiness(ctx, s).pi) throw new Error(PI_MODEL_SETUP_MESSAGE);
          pi.sendUserMessage(`/skill:agentrun-author ${raw}`, { expandPromptTemplates: true });
        }
      } catch (error) {
        commandError(s, error);
      }
    },
  });
  const closeSession = async () => {
    if (!current) return;
    const old = current; old.clearStatus(); current = undefined; old.closed = true; old.controller?.abort(); await old.service.dispose();
    await old.inFlight;
  };
  pi.on('session_shutdown', closeSession);
  pi.on('session_before_switch', closeSession);
  pi.on('session_before_fork', closeSession);
  pi.on('session_start', async (_event, ctx) => {
    if (current && current.key !== `${ctx.sessionManager.getSessionId()}:${ctx.cwd}`) await closeSession();
  });
}
