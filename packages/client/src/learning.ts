// The application still owns its SDK, tools, credentials and job triggering. These helpers send only the source
// policy, task and selected execution evidence to AgentRun; reflection and checked learning run on the server.
import { AgentRun, type ClientOptions } from './client.js';
import { AgentRunRefused, AgentRunTimeout, AgentRunUsage } from './errors.js';

export type BackendSdkRuntime = 'claude-agent-sdk' | 'codex-sdk';

export interface BackendWorkflowToolManifest {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  permission: 'allow' | 'ask' | 'deny';
  price_usd?: number;
}
export interface BackendWorkflowBinding {
  context: string;
  close(): void;
  /** Optional explicit host binding: only this native MCP envelope can be a duplicate of bridge evidence. */
  matchesNativeEnvelope?(name: string, input: unknown): boolean;
  /** Consume one actual bridge completion with identical arguments, status and result. No match keeps native evidence. */
  claimNativeEnvelope?(name: string, input: unknown, status: 'completed' | 'failed', output: unknown): boolean;
}
/** Structural seam: importing the base client does not load the optional workflow interpreter or MCP server. */
export interface BackendWorkflowBridge {
  readonly catalog: readonly BackendWorkflowToolManifest[];
  readonly adapters: readonly ('runNode' | 'runJudge')[];
  bind(session: BackendLearningSession): BackendWorkflowBinding;
}

export interface BackendLearningConfig extends ClientOptions {
  /** A stable agent id, shared by fresh runs of the same backend agent. */
  agentId: string;
  name?: string;
  /** The backend's standing policy. Wrappers add their explicit SDK system instructions to the source snapshot. */
  instructions?: string;
  /** Opt in when this wrapper first registers a missing agent (default false). Never changes an existing agent. */
  learning?: boolean;
  /** Explicit local MCP bridge over the backend's existing approved tool callbacks. */
  workflows?: BackendWorkflowBridge;
  /** Poll interval while waiting for checked learning (default 250 ms). */
  pollIntervalMs?: number;
  /** Maximum wait after completion for checked learning (default 120000 ms). The server continues after a timeout. */
  learningTimeoutMs?: number;
}

export interface BackendLearningStart {
  runtime: BackendSdkRuntime;
  input: string;
  instructions: string;
  model?: string;
}

export type SdkLearningEvent =
  | { type: 'text'; text: string }
  | { type: 'session'; session_id: string }
  | { type: 'tool'; id: string; name: string; status: 'started' | 'completed' | 'failed'; input?: unknown; output?: unknown; parent_tool_use_id?: string };

export interface SdkLearningUsage {
  /** Uncached input only. Cache reads and writes have their own counters; unknown splits remain null. */
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  cost_usd?: number | null;
}

export interface SdkLearningOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  answer: string;
  error?: string;
  model?: string;
  session_id?: string;
  usage?: SdkLearningUsage;
}

export interface BackendLearningSnapshot {
  learningEnabled: boolean;
  revision: string | null;
  context: string;
  skills: ReadonlyArray<{ name: string; files: Readonly<Record<string, string>> }>;
  workflows?: ReadonlyArray<{ name: string; workflow: string; description: string }>;
  workflowContext?: string;
}

export interface BackendLearningStatus {
  run_id: string;
  state: 'running' | 'processing' | 'completed' | 'failed' | 'cancelled';
  learning_run_id?: string;
  learning?: { state: string; reason?: string | null } | null;
}

/** A persistence or grading failure, separate from the application's original SDK result or error. */
export class BackendLearningError extends Error {
  constructor(readonly runId: string, readonly reason: string) {
    super(`AgentRun could not finish checked learning for run ${runId}: ${reason}.`);
    this.name = 'BackendLearningError';
  }
}

const uuid = () => globalThis.crypto.randomUUID();
const duration = (value: number | undefined, fallback: number, name: string) => {
  if (value !== undefined && (!Number.isFinite(value) || value < 1)) throw new AgentRunUsage(`${name} must be at least 1 ms.`);
  return value ?? fallback;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const size = (text: string) => new TextEncoder().encode(text).byteLength;
const statusOf = (value: unknown, runId: string): BackendLearningStatus => {
  const row = value as Partial<BackendLearningStatus> | null;
  if (!row || row.run_id !== runId || !['running', 'processing', 'completed', 'failed', 'cancelled'].includes(row.state ?? '')) {
    throw new AgentRunUsage('The SDK run status response is invalid.');
  }
  const learning = row.learning;
  if (learning !== undefined && learning !== null && (typeof learning !== 'object' || typeof learning.state !== 'string' || (learning.reason !== undefined && learning.reason !== null && typeof learning.reason !== 'string'))) {
    throw new AgentRunUsage('The SDK run learning response is invalid.');
  }
  return row as BackendLearningStatus;
};
const reject = (error: unknown): Promise<never> => {
  const promise = Promise.reject(error);
  void promise.catch(() => undefined);
  return promise;
};

/** Coordinates registration and background persistence without changing the SDK's own result/error contract. */
export class BackendLearningClient {
  readonly #owner: AgentRun;
  readonly #config: BackendLearningConfig;
  readonly #pending = new Set<Promise<void>>();
  readonly #errors: unknown[] = [];
  #registration?: Promise<void>;
  #runtime?: BackendSdkRuntime;

  constructor(config: BackendLearningConfig) {
    if (typeof config.agentId !== 'string' || !config.agentId.trim()) throw new AgentRunUsage('agentId must be a stable, nonempty agent id.');
    duration(config.pollIntervalMs, 250, 'pollIntervalMs');
    duration(config.learningTimeoutMs, 120_000, 'learningTimeoutMs');
    this.#config = { ...config };
    this.#owner = new AgentRun(config);
  }

  async begin(source: BackendLearningStart): Promise<BackendLearningSession> {
    if (source.runtime !== 'claude-agent-sdk' && source.runtime !== 'codex-sdk') throw new AgentRunUsage('Unsupported backend SDK runtime.');
    if (typeof source.input !== 'string' || typeof source.instructions !== 'string') throw new AgentRunUsage('SDK input and source instructions must be strings.');
    // Freeze the source before the registration request: caller mutation cannot change the policy after validation.
    const start = clone({ ...source, ...(this.#config.workflows ? { workflow_tools: [...this.#config.workflows.catalog], workflow_adapters: [...this.#config.workflows.adapters] } : {}) });
    if (this.#runtime !== undefined && this.#runtime !== start.runtime) throw new AgentRunUsage('A backend learning client belongs to one SDK runtime.');
    this.#runtime = start.runtime;
    this.#registration ??= this.#register(start).catch(error => { this.#registration = undefined; throw error; });
    await this.#registration;
    const receipt = await this.#owner.sdkRuns.start(this.#config.agentId, start, { 'Idempotency-Key': uuid() });
    if (!receipt || typeof receipt.run_id !== 'string' || typeof receipt.token !== 'string' || receipt.agent_id !== this.#config.agentId || !receipt.learning) {
      throw new AgentRunUsage('The SDK start response is missing its scoped run receipt.');
    }
    const scoped = new AgentRun({
      baseUrl: this.#owner.baseUrl, apiKey: receipt.token,
      fetch: this.#config.fetch, timeoutMs: this.#config.timeoutMs, maxRetries: this.#config.maxRetries,
    });
    try {
      return new BackendLearningSession(scoped, {
        runId: receipt.run_id, consoleUrl: receipt.console_url,
        learningEnabled: receipt.learning.enabled, revision: receipt.learning.revision,
        context: receipt.learning.context, skills: receipt.learning.skills,
        workflows: receipt.learning.workflows ?? [],
      }, this.#config);
    } catch (error) {
      // Registration happened, but no native task was dispatched. Close its receipt rather than leaving it live.
      await scoped.sdkRuns.complete(receipt.run_id, { status: 'failed', answer: '', evidence_complete: false,
        error: 'The backend workflow bridge could not bind this task.' }, { 'Idempotency-Key': `${receipt.run_id}:bind-failed` }).catch(() => undefined);
      throw error;
    }
  }

  async #register(source: BackendLearningStart): Promise<void> {
    const { agentId } = this.#config;
    const read = () => this.#owner.agents.get(agentId);
    let agent;
    try { agent = (await read()).body; }
    catch (error) {
      if (!(error instanceof AgentRunRefused) || error.status !== 404) throw error;
      const definition = {
        id: agentId, name: this.#config.name ?? agentId, instructions: source.instructions,
        sdk: { runtime: source.runtime }, learning: this.#config.learning === true ? (this.#config.workflows ? true as const : 'notes' as const) : false as const,
      };
      try { await this.#owner.agents.create({ definition }, { 'Idempotency-Key': uuid() }); }
      catch (conflict) {
        // Another backend process may have registered the same stable agent while this one was looking it up.
        if (!(conflict instanceof AgentRunRefused) || conflict.status !== 409) throw conflict;
      }
      agent = (await read()).body;
    }
    if (agent.definition.sdk?.runtime !== source.runtime) throw new AgentRunUsage('The existing agent uses a different runtime; choose its matching SDK wrapper or a new agentId.');
  }

  /** Observe completion immediately; the original SDK call can return without waiting for reflection/grading. */
  track(promise: Promise<unknown>): void {
    const observed = promise.then(() => undefined, error => { this.#errors.push(error); });
    this.#pending.add(observed);
    void observed.finally(() => this.#pending.delete(observed));
  }

  /** Wait for tracked writes and checked learning. Does not retry or re-run the caller's SDK task. */
  async flushLearning(): Promise<void> {
    while (this.#pending.size) await Promise.all([...this.#pending]);
    if (this.#errors.length === 1) throw this.#errors.shift();
    if (this.#errors.length) throw new AggregateError(this.#errors.splice(0), 'AgentRun could not finish one or more SDK learning runs.');
  }
}

/** One immutable source/seed snapshot and its ordered evidence. The scoped token is never exposed to the wrapper. */
export class BackendLearningSession implements BackendLearningSnapshot {
  readonly runId: string;
  readonly consoleUrl: string;
  readonly learningEnabled: boolean;
  readonly revision: string | null;
  readonly context: string;
  readonly skills: BackendLearningSnapshot['skills'];
  readonly workflows: NonNullable<BackendLearningSnapshot['workflows']>;
  readonly workflowContext: string;
  #workflowBinding?: BackendWorkflowBinding;
  readonly #workflowEvidenceBinding?: BackendWorkflowBinding;
  readonly #nativeEnvelopes = new Map<string, { event: SdkLearningEvent; input: unknown; serialized: string }>();
  readonly #protected = new Set<string>();
  readonly #abortCleanups: (() => void)[] = [];
  readonly #scoped: AgentRun;
  readonly #pollIntervalMs: number;
  readonly #learningTimeoutMs: number;
  #queue: Promise<void> = Promise.resolve();
  #sequence = 0;
  #pending = 0;
  #evidenceBytes = 0;
  #evidenceError?: unknown;
  #completion?: Promise<void>;
  #outcome?: string;
  #status?: BackendLearningStatus;

  constructor(scoped: AgentRun, snapshot: BackendLearningSnapshot & { runId: string; consoleUrl: string }, config: Pick<BackendLearningConfig, 'pollIntervalMs' | 'learningTimeoutMs' | 'workflows'>) {
    this.#scoped = scoped;
    this.runId = snapshot.runId;
    this.consoleUrl = snapshot.consoleUrl;
    this.learningEnabled = snapshot.learningEnabled;
    this.revision = snapshot.revision;
    this.context = snapshot.context;
    this.skills = clone(snapshot.skills);
    this.workflows = clone(snapshot.workflows ?? []);
    this.#pollIntervalMs = duration(config.pollIntervalMs, 250, 'pollIntervalMs');
    this.#learningTimeoutMs = duration(config.learningTimeoutMs, 120_000, 'learningTimeoutMs');
    if (this.learningEnabled && config.workflows) this.#workflowBinding = config.workflows.bind(this);
    this.#workflowEvidenceBinding = this.#workflowBinding;
    this.workflowContext = this.#workflowBinding?.context ?? '';
  }

  /** Keep ephemeral bridge capabilities out of stored evidence without changing native SDK results. */
  protect(values: readonly string[]): void { for (const value of values) if (value) this.#protected.add(value); }
  #safe<T>(value: T): T {
    const visit = (item: unknown): unknown => typeof item === 'string' ? [...this.#protected].reduce((text, secret) => text.split(secret).join('[withheld]'), item)
      : Array.isArray(item) ? item.map(visit) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, v]) => [key, visit(v)])) : item;
    return visit(clone(value)) as T;
  }

  /** Stop admitting work immediately; evidence can still drain before durable completion. */
  closeWorkflows(): void {
    const binding = this.#workflowBinding;
    this.#workflowBinding = undefined;
    binding?.close();
  }

  /** Revoke workflow capabilities as soon as the native SDK cancels, including an idle stream. */
  followAbort(signal?: AbortSignal): void {
    if (!signal || !this.#workflowBinding) return;
    const stop = () => this.closeWorkflows();
    if (signal.aborted) stop();
    else {
      signal.addEventListener('abort', stop, { once: true });
      this.#abortCleanups.push(() => signal.removeEventListener('abort', stop));
    }
  }

  get status(): BackendLearningStatus | undefined { return this.#status; }

  /** Keep the native task outcome, but refuse to learn from evidence the wrapper cannot faithfully capture. */
  markEvidenceIncomplete(reason: string): void {
    if (this.#completion) throw new AgentRunUsage('Cannot change SDK evidence after completion.');
    this.#evidenceError ??= new AgentRunUsage(reason);
  }

  /** Observe native SDK tools without counting a positively correlated bridge envelope twice. Candidate starts wait
   *  for their result; every unmatched or unfinished candidate is still ordinary top-level evidence. Raw arguments
   *  and results stay local, and at most sixteen bounded candidates (the bridge's invocation bound) are retained. */
  nativeEvent(event: SdkLearningEvent, detail: { input?: unknown; output?: unknown } = {}): Promise<void> {
    if (this.#completion) return reject(new AgentRunUsage('Cannot add SDK evidence after completion.'));
    if (event.type !== 'tool') return this.event(event);
    const pending = this.#nativeEnvelopes.get(event.id), binding = this.#workflowEvidenceBinding;
    if (event.status === 'started' && !pending && this.#nativeEnvelopes.size < 16) {
      try {
        if (binding?.matchesNativeEnvelope?.(event.name, detail.input)) {
          const serialized = JSON.stringify(detail.input);
          if (size(serialized) <= 131_072) {
            this.#nativeEnvelopes.set(event.id, { event: clone(event), input: clone(detail.input), serialized });
            return Promise.resolve();
          }
        }
      } catch { /* Unavailable correlation never removes evidence. */ }
    }
    if (!pending) return this.event(event);
    this.#nativeEnvelopes.delete(event.id);
    try {
      if (event.status !== 'started' && pending.event.type === 'tool' && event.name === pending.event.name &&
        (detail.input === undefined || JSON.stringify(detail.input) === pending.serialized) &&
        binding?.claimNativeEnvelope?.(event.name, pending.input, event.status, detail.output)) return Promise.resolve();
    } catch { /* A malformed result or binding remains real native tool evidence. */ }
    // Queue both before yielding, so an immediately following completion cannot overtake the retained result.
    return Promise.all([this.event(pending.event), this.event(event)]).then(() => undefined);
  }

  /** Await to apply backpressure. A failed/oversized batch prevents learning from an incomplete transcript. */
  event(event: SdkLearningEvent): Promise<void> {
    if (this.#completion) return reject(new AgentRunUsage('Cannot add SDK evidence after completion.'));
    if (this.#evidenceError !== undefined) return reject(this.#evidenceError);
    let body: { sequence: number; events: SdkLearningEvent[] };
    let bytes: number;
    try {
      const frozen = this.#safe(event);
      body = { sequence: this.#sequence + 1, events: [frozen] };
      bytes = size(JSON.stringify(body));
      // Count the complete persisted batch, reserving room for the final answer and inbox metadata.
      if (bytes > 250_000 || (event.type === 'text' && event.text.length > 128_000) || this.#pending >= 256 || this.#evidenceBytes + bytes > 3_000_000) {
        throw new AgentRunUsage('SDK evidence exceeds its bounded upload queue or transcript size; self-improvement will be skipped.');
      }
    } catch (error) { this.#evidenceError = error; return reject(error); }
    const sequence = ++this.#sequence;
    this.#evidenceBytes += bytes;
    this.#pending++;
    const sent = this.#queue.then(async () => {
      await this.#scoped.sdkRuns.events(this.runId, body, { 'Idempotency-Key': `${this.runId}:events:${sequence}` });
    });
    this.#queue = sent;
    void sent.then(() => { this.#pending--; }, error => { this.#pending--; this.#evidenceError ??= error; });
    return sent;
  }

  /** Persist the caller's outcome, then wait for the server's independent checked-learning verdict. */
  complete(outcome: SdkLearningOutcome): Promise<void> {
    let frozen: SdkLearningOutcome;
    try {
      if (!this.#completion) {
        for (const cleanup of this.#abortCleanups.splice(0)) cleanup();
        this.closeWorkflows();
        for (const pending of this.#nativeEnvelopes.values()) void this.event(pending.event).catch(() => undefined);
        this.#nativeEnvelopes.clear();
      }
      frozen = this.#safe(outcome);
    }
    catch (error) { return reject(error); }
    const serialized = JSON.stringify(frozen);
    if (this.#completion) return serialized === this.#outcome ? this.#completion : reject(new AgentRunUsage('SDK completion is immutable.'));
    this.#outcome = serialized;
    this.#completion = this.#complete(frozen);
    void this.#completion.catch(() => undefined);
    return this.#completion;
  }

  async #complete(outcome: SdkLearningOutcome): Promise<void> {
    await this.#queue.catch(() => undefined);
    if (outcome.answer.length > 128_000) {
      this.#evidenceError ??= new AgentRunUsage('The SDK answer exceeded the AgentRun storage limit; self-improvement was skipped.');
      outcome = { ...outcome, answer: '[The SDK answer exceeded the AgentRun storage limit and was not stored. The original result remains available in the backend.]' };
    }
    const usage = outcome.usage && {
      input_tokens: outcome.usage.input_tokens ?? null, output_tokens: outcome.usage.output_tokens ?? null,
      cache_read_tokens: outcome.usage.cache_read_tokens ?? null, cache_write_tokens: outcome.usage.cache_write_tokens ?? null,
      cost_usd: outcome.usage.cost_usd ?? null,
    };
    await this.#scoped.sdkRuns.complete(this.runId, {
      ...outcome, ...(usage ? { usage } : {}), ...(this.#evidenceError !== undefined ? { evidence_complete: false } : {}),
    }, { 'Idempotency-Key': `${this.runId}:complete` });
    await this.#wait(outcome);
    if (this.#evidenceError !== undefined) throw this.#evidenceError;
  }

  async #wait(outcome: SdkLearningOutcome): Promise<void> {
    const deadline = Date.now() + this.#learningTimeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new AgentRunTimeout(this.runId, this.#learningTimeoutMs, undefined);
      const signal = AbortSignal.timeout(Math.max(1, Math.ceil(left)));
      let status: BackendLearningStatus;
      try { status = statusOf(await this.#scoped.sdkRuns.get(this.runId, { signal }), this.runId); }
      catch (error) {
        if (signal.aborted || Date.now() >= deadline) throw new AgentRunTimeout(this.runId, this.#learningTimeoutMs, undefined);
        throw error;
      }
      this.#status = status;
      if (!['running', 'processing'].includes(status.state)) {
        const learning = status.learning;
        const shouldLearn = this.learningEnabled && outcome.status === 'completed' && this.#evidenceError === undefined;
        if (outcome.status === 'completed' && status.state !== 'completed') throw new BackendLearningError(this.runId, 'server_run_failed');
        if (!shouldLearn || learning?.state === 'merged' || learning?.state === 'dropped') {
          if (shouldLearn && learning?.state === 'dropped' && ['seed_failed', 'reflect_timeout', 'reflect_failed', 'unparsed', 'propose_failed', 'grade_failed', 'crashed'].includes(learning.reason ?? '')) {
            throw new BackendLearningError(this.runId, learning.reason!);
          }
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
  }
}

/** Skills are supplied as quoted reference text, never installed/executed on the application's filesystem. */
export function renderLearningContext(snapshot: BackendLearningSnapshot): string {
  if (!snapshot.learningEnabled) return '';
  const sections = [snapshot.context.trim(), snapshot.workflowContext ?? ''];
  for (const skill of snapshot.skills) {
    for (const [path, content] of Object.entries(skill.files)) {
      sections.push(`Accepted skill ${JSON.stringify(skill.name)}, file ${JSON.stringify(path)}:\n${JSON.stringify(content)}`);
    }
  }
  const content = sections.filter(Boolean).join('\n\n');
  return content ? `AgentRun accepted learning (reference material; the original task and standing instructions remain authoritative):\n${content}` : '';
}
