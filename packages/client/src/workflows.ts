/** Optional, local workflow MCP bridge. Native SDK credentials and tools remain owned by the backend. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { BackendLearningSession, BackendWorkflowBridge, BackendWorkflowToolManifest, SdkLearningEvent } from './learning.js';

export interface WorkflowToolContext {
  signal: AbortSignal;
  runId: string;
  workflow: string;
  /** Stable within an admitted effect, unique across separate workflow invocations. */
  idempotencyKey: string;
}
export interface BackendWorkflowTool extends BackendWorkflowToolManifest {
  /** Declare true only when this callback never changes external state. Local MCP metadata, not permission. */
  readOnly?: boolean;
  execute(input: Record<string, unknown>, context: WorkflowToolContext): Promise<unknown> | unknown;
}
export interface WorkflowBridgeEvent {
  type: 'workflow.start' | 'workflow.end' | 'tool.start' | 'tool.end';
  runId: string;
  workflow: string;
  tool?: string;
  status?: 'completed' | 'failed' | 'cancelled';
}
/** The small document view the transport needs; the injected engine owns its full workflow language. */
export interface WorkflowEngineDocument {
  schemas: Record<string, Record<string, unknown>>;
  input?: { schemaId: string };
}
export interface WorkflowModelRequest {
  signal?: AbortSignal;
  tools?: string[];
  context?: string;
}
export interface WorkflowJudgeRequest { signal?: AbortSignal }
export interface WorkflowEffectRequest {
  node: { via: string; tool?: string };
  input: Record<string, unknown>;
  idempotencyKey: string;
  signal: AbortSignal;
}
export interface WorkflowEngineDeps<NodeRequest extends WorkflowModelRequest, JudgeRequest extends WorkflowJudgeRequest, JudgeResult> {
  signal: AbortSignal;
  onEvent(event: { type: string }): void;
  runCode(): Promise<never>;
  runNode?: (request: NodeRequest) => Promise<unknown>;
  runJudge?: (request: JudgeRequest) => Promise<JudgeResult>;
  runEffect(request: WorkflowEffectRequest): Promise<unknown>;
}
/** Trusted host-owned interpreter functions. The bridge supplies every guarded execution callback; the engine must
 * use those callbacks for effects and model work. Generic requests preserve the host engine's own adapter types. */
export interface WorkflowEngine<
  Document extends WorkflowEngineDocument,
  NodeRequest extends WorkflowModelRequest,
  JudgeRequest extends WorkflowJudgeRequest,
  JudgeResult,
> {
  inspectWorkflow(value: unknown): {
    nodes: readonly { path: string }[];
    requires: { adapters: readonly ('runNode' | 'runJudge' | 'runEffect')[]; tools: readonly string[]; sopSections: readonly string[]; executableCode: boolean };
  };
  runWorkflow(workflow: Document, input: Record<string, unknown>, deps: WorkflowEngineDeps<NodeRequest, JudgeRequest, JudgeResult>): Promise<{ status: string; output?: unknown }>;
  resolveSchemaForWorkflow(workflow: Document, schema: Record<string, unknown>): Record<string, unknown>;
}

export interface WorkflowMcpBridgeOptions<
  Document extends WorkflowEngineDocument = WorkflowEngineDocument,
  NodeRequest extends WorkflowModelRequest = WorkflowModelRequest,
  JudgeRequest extends WorkflowJudgeRequest = WorkflowJudgeRequest,
  JudgeResult = unknown,
> {
  /** Explicit workflow engine supplied by the backend. This transport imports no workflow interpreter. */
  engine: WorkflowEngine<Document, NodeRequest, JudgeRequest, JudgeResult>;
  /** The exact MCP server name the host configures on its native SDK. Enables receipt-based envelope correlation;
   *  omit when that identity is unavailable, in which case all native tool evidence is retained. */
  nativeMcpServerName?: string;
  tools: readonly BackendWorkflowTool[];
  /** Checked immediately before every effect. An ask decision is refused; the host must approve outside this bridge. */
  policy(name: string, input: Record<string, unknown>, context: WorkflowToolContext): 'allow' | 'ask' | 'deny' | Promise<'allow' | 'ask' | 'deny'>;
  /** Explicit host adapters only. The host owns their model selection, credentials, permissions and spending limits. */
  runNode?: (request: NodeRequest) => Promise<unknown>;
  runJudge?: (request: JudgeRequest) => Promise<JudgeResult>;
  /** Total calls across the entire native task (default 32, maximum 256). */
  maxToolCalls?: number;
  /** Total dynamic node starts across the entire native task (default 256, maximum 2048). */
  maxNodeSteps?: number;
  /** Per workflow invocation, including host callbacks (default 60000 ms, maximum 300000 ms). */
  maxDurationMs?: number;
  /** Capability lifetime; completed/cancelled native runs revoke it earlier (default one hour). */
  leaseDurationMs?: number;
  /** Local metadata only; callback inputs/results and capability tokens are never emitted. */
  onEvent?(event: WorkflowBridgeEvent): void;
}
export interface WorkflowMcpBridge extends BackendWorkflowBridge {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

const canonicalTool = /^mcp:[a-z][a-z0-9-]{0,31}\/[A-Za-z0-9_-]{1,64}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const limit = (value: number | undefined, fallback: number, max: number, name: string) => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > max)) throw new TypeError(`${name} must be an integer between 1 and ${max}.`);
  return value ?? fallback;
};
class Refused extends Error {}
const refuse = (message: string): never => { throw new Refused(message); };
const pointer = (value: unknown, path: string) => path.split('/').slice(1).reduce<unknown>((node, key) => object(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined, value);
const toolResult = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });

/** Race work with cancellation without pretending an uncooperative callback can be rolled back. */
async function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason ?? new Error('Workflow cancelled.'));
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    })]);
  } finally { signal.removeEventListener('abort', stop); }
}

type Lease = {
  session: BackendLearningSession;
  workflows: NonNullable<BackendLearningSession['workflows']>;
  controller: AbortController;
  active: boolean;
  blocked: boolean;
  calls: number;
  nodes: number;
  invocations: number;
  receipts: { input: string; status?: 'completed' | 'failed'; output?: string; used?: true }[];
  close(): void;
};

/** Start once, explicitly configure this endpoint on the original native SDK, then pass the bridge to its wrapper.
 * The endpoint never executes a workflow supplied by a model: only the server's checked, pinned run snapshot.
 * Nothing is installed into the backend or executed through a new hidden native SDK session. */
export async function createWorkflowMcpBridge<
  Document extends WorkflowEngineDocument,
  NodeRequest extends WorkflowModelRequest,
  JudgeRequest extends WorkflowJudgeRequest,
  JudgeResult,
>(options: WorkflowMcpBridgeOptions<Document, NodeRequest, JudgeRequest, JudgeResult>): Promise<WorkflowMcpBridge> {
  if (!options.engine || typeof options.engine.inspectWorkflow !== 'function' || typeof options.engine.runWorkflow !== 'function' || typeof options.engine.resolveSchemaForWorkflow !== 'function')
    throw new TypeError('Provide an explicit host workflow engine with inspection, execution and schema resolution.');
  if (typeof options.policy !== 'function') throw new TypeError('A live backend policy callback is required.');
  if (options.nativeMcpServerName !== undefined && (typeof options.nativeMcpServerName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(options.nativeMcpServerName)))
    throw new TypeError('nativeMcpServerName must be the exact native MCP server name (1-64 letters, digits, underscores or hyphens).');
  const nativeServer = options.nativeMcpServerName;
  if (!Array.isArray(options.tools) || options.tools.length > 64) throw new TypeError('Provide at most 64 explicit backend tools.');
  const maxCalls = limit(options.maxToolCalls, 32, 256, 'maxToolCalls');
  const maxNodes = limit(options.maxNodeSteps, 256, 2048, 'maxNodeSteps');
  const maxDuration = limit(options.maxDurationMs, 60_000, 300_000, 'maxDurationMs');
  const leaseDuration = limit(options.leaseDurationMs, 3_600_000, 86_400_000, 'leaseDurationMs');
  // Capture callbacks and schemas once: later caller mutation cannot silently expand this bridge's authority.
  const { inspectWorkflow, runWorkflow, resolveSchemaForWorkflow } = options.engine;
  const policy = options.policy, runNode = options.runNode, runJudge = options.runJudge, observer = options.onEvent;
  const validator = new AjvJsonSchemaValidator();
  const registered = new Map<string, { manifest: BackendWorkflowToolManifest; readOnly: boolean; execute: BackendWorkflowTool['execute']; input: ReturnType<AjvJsonSchemaValidator['getValidator']>; output?: ReturnType<AjvJsonSchemaValidator['getValidator']> }>();
  for (const tool of options.tools) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !canonicalTool.test(tool.name) || registered.has(tool.name) ||
      typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 4000 ||
      !object(tool.input_schema) || (tool.output_schema !== undefined && !object(tool.output_schema)) ||
      !['allow', 'ask', 'deny'].includes(tool.permission) || typeof tool.execute !== 'function' ||
      (tool.readOnly !== undefined && typeof tool.readOnly !== 'boolean') ||
      (tool.price_usd !== undefined && (typeof tool.price_usd !== 'number' || !Number.isFinite(tool.price_usd) || tool.price_usd < 0))) throw new TypeError('Invalid or duplicate backend workflow tool.');
    const manifest = freeze(copy({ name: tool.name, description: tool.description, input_schema: tool.input_schema,
      ...(tool.output_schema ? { output_schema: tool.output_schema } : {}), permission: tool.permission,
      ...(tool.price_usd !== undefined ? { price_usd: tool.price_usd } : {}) }));
    registered.set(tool.name, { manifest, readOnly: tool.readOnly === true, execute: tool.execute, input: validator.getValidator(manifest.input_schema),
      ...(manifest.output_schema ? { output: validator.getValidator(manifest.output_schema) } : {}) });
  }
  const catalog = freeze([...registered.values()].map(tool => tool.manifest));
  if (Buffer.byteLength(JSON.stringify(catalog)) > 65_536) throw new TypeError('The workflow tool manifest exceeds 64 KiB.');
  const adapters = Object.freeze([...(runNode ? ['runNode' as const] : []), ...(runJudge ? ['runJudge' as const] : [])]);
  // A model adapter may perform work outside this callback catalog. Do not label its workflows read-only.
  // Ask/deny callbacks cannot execute; allowing a callback later requires constructing a new bridge.
  const readOnlyHint = !runNode && !runJudge && [...registered.values()].every(tool => tool.manifest.permission !== 'allow' || tool.readOnly);
  const authorization = `Bearer ${randomBytes(32).toString('hex')}`;
  const leases = new Map<string, Lease>();
  const connections = new Set<Server>();
  let closed = false;
  const emit = (event: WorkflowBridgeEvent) => { try { observer?.(Object.freeze(event)); } catch { /* Observers cannot change execution. */ } };
  const evidence = async (lease: Lease, event: SdkLearningEvent) => { await lease.session.event(event).catch(() => undefined); };

  const checked = (text: string): Document => {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 262_144) refuse('The pinned workflow is too large.');
    let workflow: Document;
    try { workflow = JSON.parse(text); } catch { return refuse('The pinned workflow is invalid JSON.'); }
    const inspection = inspectWorkflow(workflow);
    if (inspection.requires.executableCode || inspection.requires.sopSections.length || inspection.nodes.length > 128)
      refuse('This bridge refuses code, shell, executor, SOP-dependent or oversized workflows.');
    for (const adapter of inspection.requires.adapters) {
      if (adapter !== 'runEffect' && !adapters.includes(adapter)) refuse(`The backend has not provided ${adapter}.`);
    }
    for (const name of inspection.requires.tools) if (registered.get(name)?.manifest.permission !== 'allow') refuse('A required tool is not allowed by this backend.');
    for (const entry of inspection.nodes) {
      const node = pointer(workflow, entry.path) as Record<string, unknown>;
      if ((Array.isArray(node.tools) && node.tools.length) || node.context === 'fork') refuse('Workflow model nodes cannot gain native tools or fork the native conversation.');
      if (node.node === 'call' && (node.via !== 'tool' || object(node.retry) && Number(node.retry.attempts) > 1)) refuse('Only explicitly delegated tool effects without automatic retries are supported.');
    }
    return workflow;
  };

  const execute = async (args: Record<string, unknown> | undefined, requestSignal: AbortSignal) => {
    const capability = args?.capability;
    const lease = typeof capability === 'string' ? leases.get(capability) : undefined;
    if (!lease || lease.controller.signal.aborted || closed) return toolResult('This workflow capability is unavailable or expired. Start a fresh native task.', true);
    if (!args || Object.keys(args).some(key => !['capability', 'name', 'input'].includes(key)) || typeof args.name !== 'string' || !object(args.input)) return toolResult('Provide capability, workflow name, and an input object.', true);
    if (lease.active || lease.blocked || lease.invocations >= 16) return toolResult('This native task cannot admit another workflow invocation. Do not retry an uncertain effect.', true);
    const accepted = lease.workflows.find(workflow => workflow.name === args.name);
    if (!accepted) return toolResult('That workflow is not in this native task\'s checked snapshot.', true);
    let workflow: Document;
    try { workflow = checked(accepted.workflow); } catch (error) { return toolResult(error instanceof Refused ? error.message : 'The pinned workflow failed structural admission.', true); }
    lease.active = true; lease.invocations++;
    const invocation = randomUUID(), controller = new AbortController();
    const receipt: Lease['receipts'][number] = { input: JSON.stringify(args) };
    lease.receipts.push(receipt);
    const signal = AbortSignal.any([lease.controller.signal, controller.signal, requestSignal, AbortSignal.timeout(maxDuration)]);
    const context = { runId: lease.session.runId, workflow: accepted.name };
    let pending = 0;
    const record = (name: string, id: string, status: 'started' | 'completed' | 'failed') => evidence(lease, {
      type: 'tool', name, id, status, ...(id !== invocation ? { parent_tool_use_id: invocation } : {}),
    });
    emit({ ...context, type: 'workflow.start' });
    await evidence(lease, { type: 'tool', id: invocation, name: 'learned_workflow', status: 'started', input: { name: accepted.name } });
    try {
      signal.throwIfAborted();
      const result = await cancellable(runWorkflow(workflow, copy(args.input), {
        signal,
        onEvent(event) { if (event.type === 'node.start' && ++lease.nodes > maxNodes) controller.abort(new Refused('The workflow node limit was reached.')); },
        runCode: async () => refuse('Code execution is not permitted by this bridge.'),
        ...(runNode ? { runNode: async (request: NodeRequest) => {
          signal.throwIfAborted();
          if (request.tools?.length || request.context === 'fork') refuse('Native tools and transcript forks are not delegated to model nodes.');
          pending++;
          try { return await runNode({ ...request, signal: AbortSignal.any([signal, ...(request.signal ? [request.signal] : [])]) }); }
          finally { pending--; }
        } } : {}),
        ...(runJudge ? { runJudge: async (request: JudgeRequest) => {
          signal.throwIfAborted(); pending++;
          try { return await runJudge({ ...request, signal: AbortSignal.any([signal, ...(request.signal ? [request.signal] : [])]) }); }
          finally { pending--; }
        } } : {}),
        runEffect: async request => {
          signal.throwIfAborted();
          const name = request.node.via === 'tool' ? request.node.tool : undefined;
          const tool = name ? registered.get(name) : undefined;
          if (!name || !tool || tool.manifest.permission !== 'allow') return refuse('This tool was not explicitly delegated.');
          if (++lease.calls > maxCalls) return refuse('The native task\'s workflow tool call limit was reached.');
          const input = copy(request.input);
          if (!tool.input(input).valid) return refuse('Workflow arguments do not match the original backend tool schema.');
          const ctx: WorkflowToolContext = { ...context, signal: AbortSignal.any([signal, request.signal]), idempotencyKey: `${invocation}:${request.idempotencyKey}` };
          ctx.signal.throwIfAborted();
          const id = randomUUID();
          await record(name, id, 'started');
          ctx.signal.throwIfAborted();
          emit({ ...context, type: 'tool.start', tool: name });
          pending++;
          try {
            // Evidence transport can take time. Ask the live policy at dispatch, after that wait.
            if (await cancellable(Promise.resolve(policy(name, copy(input), ctx)), ctx.signal) !== 'allow') return refuse('The backend policy did not allow this tool call.');
            ctx.signal.throwIfAborted();
            const output = await tool.execute(input, ctx);
            ctx.signal.throwIfAborted();
            if (tool.output && !tool.output(output).valid) refuse('A tool result did not match its backend output schema.');
            await record(name, id, 'completed');
            emit({ ...context, type: 'tool.end', tool: name, status: 'completed' });
            return output;
          } catch (error) {
            await record(name, id, 'failed');
            emit({ ...context, type: 'tool.end', tool: name, status: ctx.signal.aborted ? 'cancelled' : 'failed' });
            throw error;
          } finally { pending--; }
        },
      }), signal);
      signal.throwIfAborted();
      if (result.status !== 'complete') throw new Refused('The workflow escalated without completing. Inspect its result before another run.');
      // Match the hosted learned_workflow handoff: one textual answer stays text, not an extra JSON wrapper.
      const values = object(result.output) ? Object.values(result.output) : [];
      const output = typeof result.output === 'string' ? result.output : values.length === 1 && typeof values[0] === 'string' ? values[0] : JSON.stringify(result.output ?? null);
      if (Buffer.byteLength(output) > 65_536) refuse('The workflow output exceeds the bridge response limit. Do not rerun its effects to recover the output.');
      await record('learned_workflow', invocation, 'completed');
      emit({ ...context, type: 'workflow.end', status: 'completed' });
      receipt.status = 'completed'; receipt.output = output;
      return toolResult(output);
    } catch (error) {
      lease.blocked = true;
      if (pending) {
        try { lease.session.markEvidenceIncomplete('A workflow callback was still pending at interruption; its effects may be uncertain.'); } catch { /* Completion already closed the run. */ }
      }
      const cancelled = signal.aborted;
      controller.abort();
      await record('learned_workflow', invocation, 'failed');
      emit({ ...context, type: 'workflow.end', status: cancelled ? 'cancelled' : 'failed' });
      // Callback exceptions may contain credentials. Keep their details in the caller's own instrumentation.
      const output = error instanceof Refused ? error.message : 'The workflow did not complete. Inspect the backend outcome; do not automatically retry its effects.';
      receipt.status = 'failed'; receipt.output = output;
      return toolResult(output, true);
    } finally { lease.active = false; }
  };

  let expectedHost = '';
  const http = createServer(async (request, response) => {
    const reply = (status: number) => { response.writeHead(status, { 'content-type': 'text/plain' }); response.end('Request refused.'); };
    const bearer = Buffer.from(request.headers.authorization ?? '');
    const allowed = Buffer.from(authorization);
    if (request.headers.host !== expectedHost || (request.headers.origin !== undefined && request.headers.origin !== `http://${expectedHost}`) ||
      request.socket.remoteAddress !== '127.0.0.1' || bearer.length !== allowed.length || !timingSafeEqual(bearer, allowed)) return reply(403);
    if (request.url !== '/mcp') return reply(404);
    if (request.method !== 'POST') return reply(405);
    let size = 0;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) { size += chunk.length; if (size > 131_072) return reply(413); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (connections.size >= 64 || closed) return reply(503);
      const server = new Server({ name: 'agentrun-workflows', version: '1.0.0' }, { capabilities: { tools: {} } });
      connections.add(server);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'learned_workflow',
        description: 'Run an approved workflow using this backend\'s existing tools, with the current task\'s workflow name, capability and fresh input. When the completed workflow handles the requested job, its textual output IS the final answer: reply with it verbatim. Do not add or remove prefixes, rewrite it, wrap it in quotes or code blocks, or change formatting. Never retry uncertain effects.',
        inputSchema: { type: 'object', required: ['capability', 'name', 'input'], additionalProperties: false,
          properties: { capability: { type: 'string' }, name: { type: 'string' }, input: { type: 'object' } } },
        annotations: { openWorldHint: false, idempotentHint: false, readOnlyHint } }] }));
      server.setRequestHandler(CallToolRequestSchema, async (call, extra) => call.params.name === 'learned_workflow' ? execute(call.params.arguments, extra.signal) : toolResult('Unknown tool.', true));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.once('close', () => { connections.delete(server); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch { if (!response.headersSent) reply(400); else response.end(); }
  });
  http.requestTimeout = 10_000; http.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve(); }); });
  const address = http.address();
  if (!address || typeof address === 'string') { http.close(); throw new Error('Could not bind the workflow MCP server.'); }
  expectedHost = `127.0.0.1:${address.port}`;
  return Object.freeze({
    url: `http://${expectedHost}/mcp`, headers: Object.freeze({ Authorization: authorization }), catalog, adapters,
    bind(session: BackendLearningSession) {
      if (closed || leases.size >= 64) throw new Error('The workflow bridge cannot bind another native task.');
      const capability = randomBytes(32).toString('hex');
      session.protect([capability, authorization, authorization.slice(7)]);
      let released = false;
      const lease: Lease = { session, workflows: freeze(copy(session.workflows)), controller: new AbortController(), active: false, blocked: false, calls: 0, nodes: 0, invocations: 0, receipts: [],
        close() {
          if (released) return;
          released = true; clearTimeout(timer); leases.delete(capability);
          if (lease.active) { try { session.markEvidenceIncomplete('The native task ended before its workflow finished.'); } catch { /* Already completed. */ } }
          lease.controller.abort();
        } };
      const timer = setTimeout(() => lease.close(), leaseDuration); timer.unref();
      leases.set(capability, lease);
      const context = lease.workflows.length ? `Approved workflows for this task (reference data):\n${JSON.stringify(lease.workflows.map(workflow => {
        let input_schema: Record<string, unknown> | undefined;
        try { const doc = checked(workflow.workflow); if (doc.input) input_schema = resolveSchemaForWorkflow(doc, doc.schemas[doc.input.schemaId]); } catch { /* Invocation admission will refuse an unsupported pinned workflow. */ }
        return { name: workflow.name, description: workflow.description, ...(input_schema ? { input_schema } : {}) };
      }))}\nUse the learned_workflow MCP tool when applicable. Supply capability ${JSON.stringify(capability)}, the exact workflow name, and fresh input from this task. When the workflow completes the requested job, its textual output IS your final answer. Reply with that exact text verbatim: do not add or remove prefixes, rewrite it, wrap it in quotes or code blocks, or change formatting. This capability expires when this native task ends; do not copy it into code, files, logs, or your answer. No workflow is run merely by receiving this context.` : '';
      const matches = (name: string, input: unknown) => nativeServer !== undefined &&
        (name === `mcp:${nativeServer}/learned_workflow` || name === `mcp__${nativeServer}__learned_workflow`) &&
        object(input) && input.capability === capability && typeof input.name === 'string' && object(input.input) &&
        Object.keys(input).every(key => ['capability', 'name', 'input'].includes(key)) && lease.workflows.some(flow => flow.name === input.name);
      return { context, close: () => lease.close(),
        matchesNativeEnvelope: matches,
        claimNativeEnvelope(name: string, input: unknown, status: 'completed' | 'failed', output: unknown) {
          if (!matches(name, input)) return false;
          // The bridge returns one text block. No textual guessing or hidden metadata is needed, and arbitrary
          // other-server/same-name tools, wrong arguments, failed outcomes and replayed receipts never disappear.
          const text = typeof output === 'string' ? output : Array.isArray(output) && output.length === 1 && object(output[0]) && output[0].type === 'text' && typeof output[0].text === 'string' ? output[0].text : undefined;
          if (text === undefined) return false;
          const receipt = lease.receipts.find(row => !row.used && row.status === status && row.input === JSON.stringify(input) && row.output === text);
          if (!receipt) return false;
          receipt.used = true;
          return true;
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const lease of leases.values()) lease.close();
      await Promise.allSettled([...connections].map(server => server.close()));
      await new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); });
    },
  });
}
