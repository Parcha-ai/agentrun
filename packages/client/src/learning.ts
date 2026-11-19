// The application still owns its SDK, tools, credentials and job triggering. These helpers send only the source
// policy, task and selected execution evidence to AgentRun; reflection and checked learning run on the server.
import { AgentRun, type ClientOptions } from './client.js';
import { AgentRunRefused, AgentRunTimeout, AgentRunUsage } from './errors.js';

export type BackendSdkRuntime = 'claude-agent-sdk' | 'codex-sdk' | 'eve';

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
/** The pinned run and evidence sink a workflow host must provide. Durable hosts can persist evidence in
 * their native result instead of depending on an in-memory SDK session or HTTP connection. */
export interface BackendWorkflowSession {
  readonly runId: string;
  readonly workflows: NonNullable<BackendLearningSnapshot['workflows']>;
  protect(values: readonly string[]): void;
  event(event: SdkLearningEvent): Promise<void>;
  markEvidenceIncomplete(reason: string): void;
}

/** Structural seam: importing the base client does not load the optional workflow interpreter or MCP server. */
export interface BackendWorkflowBridge {
  readonly catalog: readonly BackendWorkflowToolManifest[];
  readonly adapters: readonly ('runNode' | 'runJudge')[];
  bind(session: BackendWorkflowSession): BackendWorkflowBinding;
  /** Shadow execution uses only this native turn's recorded results, never new side effects. */
  check?(check: BackendWorkflowCheck, turn: { runId: string; input: string; events: readonly BackendNativeEvent[]; outcome: SdkLearningOutcome; signal?: AbortSignal }): Promise<Extract<SdkLearningEvent, { type: 'workflow_check' }>>;
}

/** The learning loop's numbers an agent definition may set (`learning: {...}`); each one left out is the server's default. */
export interface BackendLearningLoop {
  compile_after?: number;
  agree_min?: number;
  alone_min?: number;
  agree_on?: readonly string[];
}

export interface BackendLearningConfig extends ClientOptions {
  /** A stable agent id, shared by fresh runs of the same backend agent. */
  agentId: string;
  name?: string;
  /** The backend's standing policy. Wrappers add their explicit SDK system instructions to the source snapshot. */
  instructions?: string;
  /** Opt in when this wrapper first registers a missing agent (default false). Never changes an existing agent. An object
   *  is on, with the learning loop's numbers set on the agent: `compile_after` (completed runs before its job compiles
   *  into a workflow, default 20), `agree_min` and `alone_min` (the draft's one check, default 0.8 and 0.7). */
  learning?: boolean | BackendLearningLoop;
  /** Explicit host workflow binding over the backend's existing allowed callbacks; MCP is optional. */
  workflows?: BackendWorkflowBridge;
  /** Poll interval while waiting for checked learning (default 250 ms). */
  pollIntervalMs?: number;
  /** Maximum wait after completion for checked learning (default 120000 ms). The server continues after a timeout. */
  learningTimeoutMs?: number;
}

export interface BackendWorkflowCheck {
  id: string;
  revision: string;
  digest: string;
  workflow: { name: string; workflow: string; description: string };
}

type SdkReceipt = Awaited<ReturnType<AgentRun['sdkRuns']['start']>>;
/** Private durable host state, including a scoped credential. Never put this in a model prompt, result or log. */
export interface BackendLearningCheckpoint {
  baseUrl: string;
  agentId: string;
  source: BackendLearningStart;
  receipt: SdkReceipt;
  /** A completed shadow result is replayed verbatim after transport ambiguity; it never reruns a host callback. */
  shadow?: { fingerprint: string; redacted?: true; state: 'started' } | { fingerprint: string; redacted?: true; state: 'complete'; event: Extract<SdkLearningEvent, { type: 'workflow_check' }> };
}
export interface BackendLearningBeginOptions { idempotencyKey?: string }
export interface BackendLearningSubmitOptions {
  evidenceComplete?: boolean;
  /** Native arguments and results stay local; only the separate events argument is uploaded. */
  nativeEvents?: readonly BackendNativeEvent[];
  /** Durable hooks can return after persistence; the server continues checking independently. */
  waitForLearning?: boolean;
  /** Persist the private updated receipt before the first shadow-result upload. */
  onCheckpoint?(checkpoint: BackendLearningCheckpoint): void | Promise<void>;
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
  | { type: 'workflow_check'; id: string; digest: string; outcome: 'answered' | 'handed_back' | 'failed' | 'skipped_write'; answer?: string; reason?: string; skipped?: { tool: string; unmarked?: true } }
  | { type: 'tool'; id: string; name: string; status: 'started' | 'completed' | 'failed'; input?: unknown; output?: unknown; parent_tool_use_id?: string };

/** Local shadow evidence only. A buffered result can pair a timeline but cannot prove effect order or concurrency. */
export type BackendNativeEvent = SdkLearningEvent & { orderUnknown?: true };

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
  workflows?: ReadonlyArray<{ name: string; workflow: string; description: string }>;
  workflowContext?: string;
  /** A private check candidate; never included in reusable workflows or model context. */
  check?: BackendWorkflowCheck;
}

export interface BackendLearningStatus {
  run_id: string;
  state: 'running' | 'processing' | 'completed' | 'failed' | 'cancelled';
  learning_run_id?: string;
  learning?: { state: string; reason?: string | null } | null;
}

/** A persistence or learning failure, separate from the application's original SDK result or error. */
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

/** Cancel one caller's wait, not shared registration or a request that may already have issued a receipt. */
function waitFor<T>(pending: Promise<T>, signal?: AbortSignal, abandoned?: () => void): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stop);
      abandoned?.();
      reject(signal.reason);
    };
    // Observe both late outcomes even after cancellation; a late refusal cannot replace the caller's reason.
    pending.then(value => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stop);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stop);
      reject(error);
    });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}

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

  async begin(source: BackendLearningStart, signal?: AbortSignal, options: BackendLearningBeginOptions = {}): Promise<BackendLearningSession> {
    if (options.idempotencyKey !== undefined && (!options.idempotencyKey.trim() || options.idempotencyKey.length > 256 || /[^\x21-\x7e]/.test(options.idempotencyKey)))
      throw new AgentRunUsage('idempotencyKey must be a nonempty printable ASCII string of at most 256 characters.');
    signal?.throwIfAborted();
    if (source.runtime !== 'claude-agent-sdk' && source.runtime !== 'codex-sdk' && source.runtime !== 'eve') throw new AgentRunUsage('Unsupported backend SDK runtime.');
    if (typeof source.input !== 'string' || typeof source.instructions !== 'string') throw new AgentRunUsage('SDK input and source instructions must be strings.');
    // Freeze the source before the registration request: caller mutation cannot change the policy after validation.
    const start = clone({ ...source, ...(this.#config.workflows ? { workflow_tools: [...this.#config.workflows.catalog], workflow_adapters: [...this.#config.workflows.adapters] } : {}) });
    if (this.#runtime !== undefined && this.#runtime !== start.runtime) throw new AgentRunUsage('A backend learning client belongs to one SDK runtime.');
    this.#runtime = start.runtime;
    this.#registration ??= this.#register(start).catch(error => { this.#registration = undefined; throw error; });
    await waitFor(this.#registration, signal);
    signal?.throwIfAborted();
    const pending = this.#start(start, options.idempotencyKey);
    return waitFor(pending, signal, () => {
      // The POST may already have committed. Keep its answer observed and close a late receipt; flushLearning()
      // waits for this cleanup and reports a failed write without delaying or replacing the caller's abort.
      this.track(pending.then(session => session.complete({ status: 'cancelled', answer: '',
        error: 'The backend task was cancelled before native SDK dispatch.' })));
    });
  }

  async #start(start: BackendLearningStart, idempotencyKey: string = uuid()): Promise<BackendLearningSession> {
    const receipt = await this.#owner.sdkRuns.start(this.#config.agentId, start, { 'Idempotency-Key': idempotencyKey });
    if (!receipt || typeof receipt.run_id !== 'string' || typeof receipt.token !== 'string' || receipt.agent_id !== this.#config.agentId || !receipt.learning) {
      throw new AgentRunUsage('The SDK start response is missing its scoped run receipt.');
    }
    const scoped = new AgentRun({
      baseUrl: this.#owner.baseUrl, apiKey: receipt.token,
      fetch: this.#config.fetch, timeoutMs: this.#config.timeoutMs, maxRetries: this.#config.maxRetries,
    });
    try {
      return this.resume({ baseUrl: this.#owner.baseUrl, agentId: this.#config.agentId, source: start, receipt });
    } catch (error) {
      // Registration happened, but no native task was dispatched. Close its receipt rather than leaving it live.
      await scoped.sdkRuns.complete(receipt.run_id, { status: 'failed', answer: '', evidence_complete: false,
        error: 'The backend workflow bridge could not bind this task.' }, { 'Idempotency-Key': `${receipt.run_id}:bind-failed` }).catch(() => undefined);
      throw error;
    }
  }

  /** Restore a persisted receipt without registering or admitting a second native turn. */
  resume(checkpoint: BackendLearningCheckpoint): BackendLearningSession {
    const saved = clone(checkpoint), { receipt, source } = saved;
    if (saved.baseUrl !== this.#owner.baseUrl || saved.agentId !== this.#config.agentId || receipt?.agent_id !== saved.agentId ||
      typeof receipt.run_id !== 'string' || !receipt.run_id || typeof receipt.token !== 'string' || !receipt.token || !receipt.learning ||
      !source || !['claude-agent-sdk', 'codex-sdk', 'eve'].includes(source.runtime) || typeof source.input !== 'string' || typeof source.instructions !== 'string')
      throw new AgentRunUsage('The SDK receipt belongs to another server or agent, or has no original source.');
    if (this.#runtime !== undefined && this.#runtime !== source.runtime) throw new AgentRunUsage('A backend learning client belongs to one SDK runtime.');
    this.#runtime = source.runtime;
    const scoped = new AgentRun({ baseUrl: saved.baseUrl, apiKey: receipt.token,
      fetch: this.#config.fetch, timeoutMs: this.#config.timeoutMs, maxRetries: this.#config.maxRetries });
    const session = new BackendLearningSession(scoped, {
      runId: receipt.run_id, consoleUrl: receipt.console_url,
      learningEnabled: receipt.learning.enabled, revision: receipt.learning.revision,
      context: receipt.learning.context, workflows: receipt.learning.workflows ?? [],
      ...('check' in receipt.learning && receipt.learning.check ? { check: receipt.learning.check as BackendWorkflowCheck } : {}),
      input: source.input,
    }, this.#config, saved);
    session.protect([this.#config.apiKey ?? '', receipt.token]);
    return session;
  }

  async #register(source: BackendLearningStart): Promise<void> {
    const { agentId } = this.#config;
    const read = () => this.#owner.agents.get(agentId);
    let agent;
    try { agent = (await read()).body; }
    catch (error) {
      if (!(error instanceof AgentRunRefused) || error.status !== 404) throw error;
      // On (true, or the loop's numbers): the owner's corrections, and workflows too with a bridge (the server compiles
      // none for a run that binds no workflow tools).
      const { learning } = this.#config;
      const on = learning === true || (typeof learning === 'object' && learning !== null);
      const definition = {
        id: agentId, name: this.#config.name ?? agentId, instructions: source.instructions,
        sdk: { runtime: source.runtime }, learning: on ? (learning === true ? true as const : { ...(learning as BackendLearningLoop), agree_on: (learning as BackendLearningLoop).agree_on ? [...(learning as BackendLearningLoop).agree_on!] : undefined }) : false as const,
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

  /** Observe completion immediately; the original SDK call can return without waiting for the run's learning. */
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

/** One immutable source snapshot and ordered evidence. Only checkpoint() exposes private durable receipt state. */
export class BackendLearningSession implements BackendLearningSnapshot {
  readonly runId: string;
  readonly consoleUrl: string;
  readonly learningEnabled: boolean;
  readonly revision: string | null;
  readonly context: string;
  readonly workflows: NonNullable<BackendLearningSnapshot['workflows']>;
  readonly workflowContext: string;
  #workflowBinding?: BackendWorkflowBinding;
  readonly #workflowEvidenceBinding?: BackendWorkflowBinding;
  readonly #nativeEnvelopes = new Map<string, { event: SdkLearningEvent; input: unknown; serialized: string }>();
  readonly #protected = new Set<string>();
  readonly #abortCleanups: (() => void)[] = [];
  readonly #checkController = new AbortController();
  readonly #scoped: AgentRun;
  readonly #pollIntervalMs: number;
  readonly #learningTimeoutMs: number;
  readonly #checkpoint?: BackendLearningCheckpoint;
  readonly #check?: BackendWorkflowCheck;
  readonly #workflowBridge?: BackendWorkflowBridge;
  readonly #input: string;
  readonly #nativeEvents: BackendNativeEvent[] = [];
  #nativeBytes = 0;
  #nativeComplete = true;
  #comparisonRedacted = false;
  #sourceIncomplete = false;
  #waitForLearning = true;
  #submission?: Promise<void>;
  #submissionBody?: string;
  #onCheckpoint?: BackendLearningSubmitOptions['onCheckpoint'];
  #queue: Promise<void> = Promise.resolve();
  #sequence = 0;
  #pending = 0;
  #evidenceBytes = 0;
  #evidenceError?: unknown;
  #completion?: Promise<void>;
  #outcome?: string;
  #status?: BackendLearningStatus;

  constructor(scoped: AgentRun, snapshot: BackendLearningSnapshot & { runId: string; consoleUrl: string; input?: string }, config: Pick<BackendLearningConfig, 'pollIntervalMs' | 'learningTimeoutMs' | 'workflows'>, checkpoint?: BackendLearningCheckpoint) {
    this.#scoped = scoped;
    this.#checkpoint = checkpoint && clone(checkpoint);
    this.#comparisonRedacted = checkpoint?.shadow?.redacted === true;
    this.#check = snapshot.learningEnabled && snapshot.check ? clone(snapshot.check) : undefined;
    this.#input = snapshot.input ?? '';
    this.#workflowBridge = config.workflows;
    this.runId = snapshot.runId;
    this.consoleUrl = snapshot.consoleUrl;
    this.learningEnabled = snapshot.learningEnabled;
    this.revision = snapshot.revision;
    this.context = snapshot.context;
    this.workflows = clone(snapshot.workflows ?? []);
    this.#pollIntervalMs = duration(config.pollIntervalMs, 250, 'pollIntervalMs');
    this.#learningTimeoutMs = duration(config.learningTimeoutMs, 120_000, 'learningTimeoutMs');
    if (this.learningEnabled && config.workflows) this.#workflowBinding = config.workflows.bind(this);
    this.#workflowEvidenceBinding = this.#workflowBinding;
    this.workflowContext = this.#workflowBinding?.context ?? '';
  }

  checkpoint(): BackendLearningCheckpoint {
    if (!this.#checkpoint) throw new AgentRunUsage('This session has no durable receipt checkpoint.');
    return clone(this.#checkpoint);
  }

  #captureNative(event: BackendNativeEvent, detail: { input?: unknown; output?: unknown; orderUnknown?: true } = {}): void {
    if (!this.#check || event.type !== 'tool' || !this.#nativeComplete) return;
    try {
      const captured = clone({ ...event, ...(detail.input !== undefined ? { input: detail.input } : {}),
        ...(detail.output !== undefined ? { output: detail.output } : {}), ...(detail.orderUnknown ? { orderUnknown: true as const } : {}) });
      const bytes = size(JSON.stringify(captured));
      if (bytes > 250_000 || this.#nativeBytes + bytes > 3_000_000 || this.#nativeEvents.length >= 10_000) throw new Error('native_evidence_limit');
      this.#safe(captured, true);
      this.#nativeBytes += bytes; this.#nativeEvents.push(captured);
    } catch { this.#nativeComplete = false; this.#nativeEvents.length = 0; }
  }

  /** Deliver one finite recorded turn. Retry through a restored checkpoint; identical batches retain their keys. */
  submit(events: readonly SdkLearningEvent[], outcome: SdkLearningOutcome, options: BackendLearningSubmitOptions = {}): Promise<void> {
    let body: string, savedEvents: SdkLearningEvent[], savedOutcome: SdkLearningOutcome, savedOptions: BackendLearningSubmitOptions;
    try {
      savedEvents = clone(events) as SdkLearningEvent[]; savedOutcome = clone(outcome); savedOptions = { ...clone(options), onCheckpoint: options.onCheckpoint };
      body = JSON.stringify([savedEvents, savedOutcome, savedOptions]);
    } catch (error) { return reject(error); }
    if (this.#submission) return body === this.#submissionBody ? this.#submission : reject(new AgentRunUsage('SDK submission is immutable.'));
    if (this.#sequence || this.#completion) return reject(new AgentRunUsage('Recorded submission cannot follow streamed evidence.'));
    this.#submissionBody = body;
    this.#submission = this.#submit(savedEvents, savedOutcome, savedOptions);
    void this.#submission.catch(() => undefined);
    return this.#submission;
  }

  async #submit(events: SdkLearningEvent[], outcome: SdkLearningOutcome, options: BackendLearningSubmitOptions): Promise<void> {
    this.#sourceIncomplete = options.evidenceComplete === false;
    this.#waitForLearning = options.waitForLearning !== false;
    this.#onCheckpoint = options.onCheckpoint;
    for (const event of options.nativeEvents ?? events) this.#captureNative(event);
    let batch: SdkLearningEvent[] = [];
    for (const event of events) {
      const bytes = size(JSON.stringify(event)) + 100;
      if (bytes > 220_000 || event.type === 'text' && event.text.length > 128_000 || this.#evidenceBytes + size(JSON.stringify(batch)) + bytes > 3_000_000) {
        this.#sourceIncomplete = true; continue;
      }
      if (batch.length >= 100 || size(JSON.stringify([...batch, event])) > 220_000) { await this.#enqueue(batch); batch = []; }
      batch.push(event);
    }
    if (batch.length) await this.#enqueue(batch);
    await this.complete(outcome);
  }

  /** Keep ephemeral bridge capabilities out of stored evidence without changing native SDK results. */
  protect(values: readonly string[]): void {
    for (const value of values) if (value) this.#protected.add(value);
    this.#safe({ source: this.#checkpoint?.source, input: this.#input, events: this.#nativeEvents }, true);
  }
  #safe<T>(value: T, comparisonEvidence = false): T {
    const visit = (item: unknown): unknown => {
      if (typeof item === 'string') {
        const safe = [...this.#protected].reduce((text, secret) => text.split(secret).join('[withheld]'), item);
        if (comparisonEvidence && safe !== item) this.#comparisonRedacted = true;
        return safe;
      }
      return Array.isArray(item) ? item.map(visit) : item && typeof item === 'object'
        ? Object.fromEntries(Object.entries(item).map(([key, v]) => [key, visit(v)])) : item;
    };
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
    if (!signal || !this.#workflowBinding && !this.#check) return;
    const stop = () => { this.closeWorkflows(); this.#checkController.abort(signal.reason); };
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
  nativeEvent(event: SdkLearningEvent, detail: { input?: unknown; output?: unknown; orderUnknown?: true } = {}): Promise<void> {
    if (this.#completion) return reject(new AgentRunUsage('Cannot add SDK evidence after completion.'));
    this.#captureNative(event, detail);
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
    return this.#enqueue([event]);
  }

  #enqueue(events: SdkLearningEvent[]): Promise<void> {
    if (this.#evidenceError !== undefined) return reject(this.#evidenceError);
    let body: { sequence: number; events: SdkLearningEvent[] };
    let bytes: number;
    try {
      const frozen = this.#safe(events, true);
      body = { sequence: this.#sequence + 1, events: frozen };
      bytes = size(JSON.stringify(body));
      // Count the complete persisted batch, reserving room for the final answer and inbox metadata.
      if (bytes > 250_000 || events.some(event => event.type === 'text' && event.text.length > 128_000) || this.#pending >= 256 || this.#evidenceBytes + bytes > 3_000_000) {
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
    let serialized: string;
    try {
      if (!this.#completion) {
        this.closeWorkflows();
        for (const pending of this.#nativeEnvelopes.values()) void this.event(pending.event).catch(() => undefined);
        this.#nativeEnvelopes.clear();
      }
      // Compare and identify the original native outcome before redaction: distinct secrets must never
      // become apparently agreeing answers or identical durable completion fingerprints.
      serialized = JSON.stringify(outcome);
      frozen = this.#safe(outcome, true);
    }
    catch (error) { return reject(error); }
    if (this.#completion) return serialized === this.#outcome ? this.#completion : reject(new AgentRunUsage('SDK completion is immutable.'));
    this.#outcome = serialized;
    this.#completion = this.#complete(frozen).finally(() => {
      this.#nativeEvents.length = 0;
      for (const cleanup of this.#abortCleanups.splice(0)) cleanup();
    });
    void this.#completion.catch(() => undefined);
    return this.#completion;
  }

  async #complete(outcome: SdkLearningOutcome): Promise<void> {
    await this.#queue.catch(() => undefined);
    if (outcome.answer.length > 128_000) {
      this.#evidenceError ??= new AgentRunUsage('The SDK answer exceeded the AgentRun storage limit; self-improvement was skipped.');
      outcome = { ...outcome, answer: '[The SDK answer exceeded the AgentRun storage limit and was not stored. The original result remains available in the backend.]' };
    }
    if (this.#check && this.#workflowBridge?.check && outcome.status === 'completed' && !this.#sourceIncomplete && this.#evidenceError === undefined) {
      const fingerprint = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(
        JSON.stringify([this.#check, this.#input, this.#nativeEvents, this.#outcome, this.#nativeComplete])))), byte => byte.toString(16).padStart(2, '0')).join('');
      let result: Extract<SdkLearningEvent, { type: 'workflow_check' }>;
      const saved = this.#checkpoint?.shadow;
      if (saved) {
        if (saved.fingerprint !== fingerprint || saved.state === 'complete' && (saved.event.id !== this.#check.id || saved.event.digest !== this.#check.digest))
          throw new AgentRunUsage('The recorded shadow result belongs to different native evidence. Inspect the original turn before retrying.');
        result = saved.state === 'complete' ? clone(saved.event)
          : { type: 'workflow_check', id: this.#check.id, digest: this.#check.digest, outcome: 'failed', reason: 'shadow_outcome_unknown' };
      } else {
        if (this.#checkpoint) this.#checkpoint.shadow = { fingerprint, state: 'started', ...(this.#comparisonRedacted ? { redacted: true } : {}) };
        if (this.#onCheckpoint) await this.#onCheckpoint(this.checkpoint());
        try {
          result = this.#comparisonRedacted
            ? { type: 'workflow_check', id: this.#check.id, digest: this.#check.digest, outcome: 'failed', reason: 'client_redacted_evidence' }
            : this.#nativeComplete
            ? await this.#workflowBridge.check(clone(this.#check), { runId: this.runId, input: this.#input, events: clone(this.#nativeEvents), outcome: clone(outcome), signal: this.#checkController.signal })
            : { type: 'workflow_check', id: this.#check.id, digest: this.#check.digest, outcome: 'failed', reason: 'native_evidence_unavailable' };
        } catch { result = { type: 'workflow_check', id: this.#check.id, digest: this.#check.digest, outcome: 'failed', reason: 'shadow_execution_failed' }; }
      }
      // The check result itself can introduce a protected value. Invalidate before checkpointing or
      // uploading; sending '[withheld]' as an answer could make two different secrets compare equal.
      result = this.#safe(result, true);
      if (this.#comparisonRedacted) result = { type: 'workflow_check', id: this.#check.id, digest: this.#check.digest,
        outcome: 'failed', reason: 'client_redacted_evidence' };
      if (this.#checkpoint) this.#checkpoint.shadow = { fingerprint, state: 'complete', event: clone(result), ...(this.#comparisonRedacted ? { redacted: true } : {}) };
      if (this.#onCheckpoint) await this.#onCheckpoint(this.checkpoint());
      await this.#enqueue([result]).catch(() => undefined);
    }
    this.#nativeEvents.length = 0;
    const usage = outcome.usage && {
      input_tokens: outcome.usage.input_tokens ?? null, output_tokens: outcome.usage.output_tokens ?? null,
      cache_read_tokens: outcome.usage.cache_read_tokens ?? null, cache_write_tokens: outcome.usage.cache_write_tokens ?? null,
      cost_usd: outcome.usage.cost_usd ?? null,
    };
    await this.#scoped.sdkRuns.complete(this.runId, {
      ...outcome, ...(usage ? { usage } : {}), evidence_complete: !this.#sourceIncomplete && this.#evidenceError === undefined,
    }, { 'Idempotency-Key': `${this.runId}:complete` });
    if (this.#waitForLearning) await this.#wait(outcome);
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
        const shouldLearn = this.learningEnabled && outcome.status === 'completed' && !this.#sourceIncomplete && this.#evidenceError === undefined;
        if (outcome.status === 'completed' && status.state !== 'completed') throw new BackendLearningError(this.runId, 'server_run_failed');
        if (!shouldLearn || learning?.state === 'merged' || learning?.state === 'dropped') {
          if (shouldLearn && learning?.state === 'dropped' && ['seed_failed', 'reflect_failed', 'crashed'].includes(learning.reason ?? '')) {
            throw new BackendLearningError(this.runId, learning.reason!);
          }
          return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
  }
}

/** The owner's corrections and the bound workflows, as reference text for the application's own agent. */
export function renderLearningContext(snapshot: BackendLearningSnapshot): string {
  if (!snapshot.learningEnabled) return '';
  const sections = [snapshot.context.trim(), snapshot.workflowContext ?? ''];
  const content = sections.filter(Boolean).join('\n\n');
  return content ? `AgentRun accepted learning (reference material; the original task and standing instructions remain authoritative):\n${content}` : '';
}
