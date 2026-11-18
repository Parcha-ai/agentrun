import { BackendLearningClient, renderLearningContext, type BackendLearningConfig, type SdkLearningEvent,
  type SdkLearningUsage } from './learning.js';

/** Structural public APIs: the application owns its LangGraph and LangChain dependencies. */
type GraphLike = {
  invoke: (...args: any[]) => Promise<any>;
  getState?: (...args: any[]) => Promise<any>;
  checkpointer?: unknown;
  config?: unknown;
  interruptBefore?: unknown;
  interruptAfter?: unknown;
};
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' ? value as RecordValue : {};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const nonempty = (value: unknown): boolean => value !== undefined && value !== null && value !== false && value !== '' && (!Array.isArray(value) || value.length > 0);
const activeCheckpoints = new WeakMap<object, Set<string>>();
const observationLimit = 256;

export interface LangGraphLearningConfig<Input, Output> extends BackendLearningConfig {
  /** Snapshot of the graph's standing policy for learning. Native policy stays in the graph. */
  instructions: string;
  /** Extract the original text task only. Do not include credentials, hidden reasoning, or private state. */
  inputText(input: Input): string;
  /** Add owner corrections and approved workflow reference material to the graph's input schema, retaining the original task, policy, and state.
   * Called only when approved context is nonempty. The wrapper never writes the graph's checkpointer or store. */
  withLearning(input: Input, context: string): Input | Promise<Input>;
  /** Extract the final public answer from the graph's output schema. */
  answerText(output: Output): string;
  model?: string;
}

function freshInput(input: unknown): void {
  if (input === null || input === undefined || object(input).lg_name === 'Command' ||
    (typeof input !== 'string' && (typeof input !== 'object' || Array.isArray(input)))) {
    throw new TypeError('LangGraph learning supports fresh text or state inputs, not Command or checkpoint resume.');
  }
}

function callbacksWith(existing: unknown, handler: object): unknown {
  if (existing === undefined) return [handler];
  if (Array.isArray(existing)) return [...existing, handler];
  const manager = object(existing);
  if (typeof manager.copy !== 'function' || typeof manager.addHandler !== 'function') {
    throw new TypeError('LangGraph learning needs a callback array or a native CallbackManager with copy/addHandler.');
  }
  const copy = manager.copy.call(existing);
  if (copy === existing || typeof object(copy).addHandler !== 'function') {
    throw new TypeError('LangGraph callback manager copy must produce an independent manager.');
  }
  const addHandler = object(copy).addHandler as (...args: unknown[]) => unknown;
  addHandler.call(copy, handler, true);
  return copy;
}

function messageUsage(value: unknown): SdkLearningUsage {
  const usage = object(value), details = object(usage.input_token_details);
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  const read = count(details.cache_read), write = count(details.cache_creation);
  // LangChain input includes all cache categories. Optional details are unknown, never implicit zero.
  return { input_tokens: input !== null && read !== null && write !== null && read + write <= input ? input - read - write : null,
    output_tokens: output, cache_read_tokens: read, cache_write_tokens: write, cost_usd: null };
}

function totalUsage(models: Map<string, SdkLearningUsage | undefined>): SdkLearningUsage | undefined {
  if (!models.size) return undefined;
  const total: SdkLearningUsage = {};
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd'] as const) {
    const values = [...models.values()].map(value => value?.[key]);
    const sum = values.every(value => typeof value === 'number') ? (values as number[]).reduce((a, b) => a + b, 0) : null;
    total[key] = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  }
  return total;
}

/** Add owner corrections and optional learned workflows to fresh LangGraph invoke() calls. Streaming,
 * Command/resume, existing checkpoints, and static breakpoints are not supported by this wrapper.
 * The original graph remains available for those native APIs. Each checkpointed task needs a new thread_id.
 * Callback instrumentation covers LangChain models and tools that propagate the invocation config.
 * For workflows, the host must explicitly add the existing workflow MCP bridge as a native graph tool.
 * This wrapper installs no tools and never widens their permissions. */
export function withLangGraphLearning<T extends GraphLike, Input extends NonNullable<Parameters<T['invoke']>[0]>>(graph: T,
  config: LangGraphLearningConfig<Input, Awaited<ReturnType<T['invoke']>>>,
): { invoke(input: Input, options?: Parameters<T['invoke']>[1]): Promise<Awaited<ReturnType<T['invoke']>>>; flushLearning(): Promise<void> } {
  if (typeof config.instructions !== 'string' || typeof config.inputText !== 'function' ||
    typeof config.withLearning !== 'function' || typeof config.answerText !== 'function') {
    throw new TypeError('LangGraph learning requires instructions, inputText, withLearning, and answerText.');
  }
  const client = new BackendLearningClient(config);
  const checkpointer = graph.checkpointer;
  const threads = checkpointer && typeof checkpointer === 'object'
    ? activeCheckpoints.get(checkpointer) ?? new Set<string>() : new Set<string>();
  if (checkpointer && typeof checkpointer === 'object') activeCheckpoints.set(checkpointer, threads);
  return {
    flushLearning: () => client.flushLearning(),
    invoke: async (input: Input, options?: Parameters<T['invoke']>[1]) => {
      freshInput(input);
      const nativeOptions = object(options), bound = object(graph.config);
      const configurable = { ...object(bound.configurable), ...object(nativeOptions.configurable) };
      // getState reads its supplied thread before merging a graph's bound config in LangGraph 1.x.
      const stateOptions = { ...bound, ...nativeOptions, configurable };
      if (Object.keys(configurable).some(key => key.startsWith('__pregel_') ||
        (key.startsWith('checkpoint_') && nonempty(configurable[key]))) ||
        nonempty(nativeOptions.interruptBefore ?? bound.interruptBefore ?? graph.interruptBefore) ||
        nonempty(nativeOptions.interruptAfter ?? bound.interruptAfter ?? graph.interruptAfter) ||
        (nativeOptions.streamMode !== undefined && nativeOptions.streamMode !== 'values')) {
        throw new TypeError('LangGraph learning requires a fresh invoke without checkpoint replay, static interrupts, or streaming modes.');
      }
      const signal = nativeOptions.signal ?? bound.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('LangGraph signal must be an AbortSignal.');
      signal?.throwIfAborted();
      const thread = configurable.thread_id;
      if (thread !== undefined && (typeof thread !== 'string' || !thread)) throw new TypeError('LangGraph thread_id must be a nonempty string.');
      if (typeof thread === 'string' && threads.has(thread)) throw new Error('LangGraph learning requires a fresh thread_id for each task.');
      if (graph.checkpointer && (typeof thread !== 'string' || typeof graph.getState !== 'function')) {
        throw new TypeError('A checkpointed LangGraph needs a fresh thread_id and getState() for learning.');
      }
      const task = config.inputText(input);
      if (typeof task !== 'string') throw new TypeError('LangGraph inputText must return the original text task.');
      // Validate callback composition before creating a server run or invoking the graph.
      let session: Awaited<ReturnType<BackendLearningClient['begin']>> | undefined;
      const models = new Map<string, SdkLearningUsage | undefined>(), tools = new Map<string, { name: string; input: unknown }>();
      const completedModels = new Map<string, string>();
      let fingerprintBytes = 0, usageIncomplete = false;
      const record = (event: SdkLearningEvent, detail?: { input?: unknown; output?: unknown }) => {
        if (session) void session.nativeEvent(event, detail).catch(() => undefined);
      };
      const incomplete = (reason: string) => session?.markEvidenceIncomplete(reason);
      const admitModel = (runId: string) => {
        if (!models.has(runId) && models.size >= observationLimit) {
          usageIncomplete = true;
          incomplete('LangGraph exceeded the bounded model observation limit.');
          return false;
        }
        if (!models.has(runId)) models.set(runId, undefined);
        return true;
      };
      const handler = {
        // A structural handler bypasses BaseCallbackHandler's constructor. The native manager reads this
        // public field directly; _awaitHandler alone would leave evidence on the global background queue.
        name: 'agentrun_learning', awaitHandlers: true,
        handleLLMStart(_model: unknown, _prompts: unknown, runId: string) { admitModel(runId); },
        handleChatModelStart(_model: unknown, _messages: unknown, runId: string) { admitModel(runId); },
        handleLLMEnd(output: unknown, runId: string) {
          if (!admitModel(runId)) return;
          try {
            const generations = object(output).generations;
            if (!Array.isArray(generations) || generations.length !== 1 || !Array.isArray(generations[0]) || generations[0].length !== 1) {
              models.set(runId, undefined);
              incomplete('LangGraph returned batched or unrecognized model evidence; this run cannot produce learning.');
              return;
            }
            const generation = object(generations[0][0]), message = object(generation.message);
            const content = generation.message === undefined ? generation.text : message.content;
            const usage = messageUsage(message.usage_metadata);
            const fingerprint = JSON.stringify({ content, usage });
            if (completedModels.has(runId)) {
              if (completedModels.get(runId) !== fingerprint) {
                models.set(runId, undefined);
                incomplete('LangGraph delivered conflicting completions for the same native model run.');
              }
              return;
            }
            if (fingerprint.length > 128_000 || fingerprintBytes + fingerprint.length > 1_000_000) {
              models.set(runId, undefined);
              incomplete('LangGraph model evidence exceeded the bounded observation size.');
              return;
            }
            fingerprintBytes += fingerprint.length;
            completedModels.set(runId, fingerprint);
            models.set(runId, usage);
            if (typeof content === 'string') { if (content) record({ type: 'text', text: content }); }
            else if (Array.isArray(content)) {
              for (const block of content) {
                const part = object(block);
                if (part.type === 'text' && typeof part.text === 'string') record({ type: 'text', text: part.text });
                else if (!['reasoning', 'thinking', 'redacted_thinking'].includes(String(part.type))) {
                  incomplete('LangGraph returned non-text model content unavailable to learning.');
                }
              }
            } else incomplete('LangGraph returned model content unavailable to learning.');
          } catch {
            models.set(runId, undefined);
            incomplete('LangGraph returned model evidence that could not be captured.');
          }
        },
        handleLLMError(_error: unknown, runId: string) { if (admitModel(runId)) models.set(runId, undefined); },
        handleToolStart(tool: unknown, input: unknown, runId: string, _parent?: string, _tags?: unknown, _metadata?: unknown, runName?: string) {
          if (tools.has(runId)) return;
          if (tools.size >= observationLimit) { incomplete('LangGraph exceeded the bounded tool observation limit.'); return; }
          const serialized = object(tool), id = serialized.id;
          const name = runName ?? (typeof serialized.name === 'string' ? serialized.name : Array.isArray(id) ? String(id.at(-1)) : 'langgraph-tool');
          let args: unknown;
          // Tool arguments are used only to correlate an explicitly configured workflow bridge. Never retain
          // arbitrary native arguments, and bound even this local correlation material before parsing it.
          if (config.workflows) {
            if (typeof input === 'string' && input.length <= 131_072) {
              try { args = JSON.parse(input); } catch { /* An unrecognized envelope cannot match a bridge receipt. */ }
            } else incomplete('LangGraph tool arguments exceeded the bounded native correlation format.');
          }
          tools.set(runId, { name, input: args });
          record({ type: 'tool', id: runId, name, status: 'started' }, { input: args });
        },
        handleToolEnd(output: unknown, runId: string) { endTool(runId, 'completed', output); },
        handleToolError(_error: unknown, runId: string) { endTool(runId, 'failed'); },
      };
      const endTool = (runId: string, status: 'completed' | 'failed', output?: unknown) => {
        const started = tools.get(runId);
        if (!started) { incomplete('LangGraph tool completion arrived without its start.'); return; }
        record({ type: 'tool', id: runId, name: started.name, status },
          { input: started.input, output: typeof output === 'string' ? output : object(output).content });
        tools.delete(runId);
      };
      const callbacks = callbacksWith(nativeOptions.callbacks, handler);
      if (threads.size >= observationLimit) throw new Error('Too many concurrent LangGraph learning invocations.');
      if (typeof thread === 'string') threads.add(thread); // Reserve before the asynchronous freshness check.
      try {
        if (graph.checkpointer) {
          const state = await graph.getState!(stateOptions);
          if (object(state).createdAt !== undefined || object(object(object(state).config).configurable).checkpoint_id !== undefined) {
            throw new Error('LangGraph learning cannot attach to an existing checkpoint; use a fresh thread_id.');
          }
        }
        session = await client.begin({ runtime: 'langgraph', input: task, instructions: config.instructions,
          ...(config.model ? { model: config.model } : {}) }, signal);
        session.followAbort(signal);
        if (typeof thread === 'string') record({ type: 'session', session_id: thread });
        try {
          const context = renderLearningContext(session);
          const nextInput = context ? await config.withLearning(input, context) : input;
          freshInput(nextInput);
          signal?.throwIfAborted();
          const result = await graph.invoke(nextInput, { ...nativeOptions, callbacks });
          let interrupted = nonempty(object(result).__interrupt__);
          if (graph.checkpointer) {
            try { interrupted ||= nonempty(object(await graph.getState!(stateOptions)).next); }
            catch { incomplete('LangGraph checkpoint completion could not be inspected.'); }
          }
          if (tools.size) incomplete('LangGraph finished with incomplete native tool evidence.');
          if (!models.size) incomplete('No LangChain model callbacks were observed; propagate the invocation config to models and tools.');
          let answer = '';
          if (!interrupted) {
            try {
              answer = config.answerText(result);
              if (typeof answer !== 'string') { answer = ''; incomplete('LangGraph answerText must return text.'); }
            } catch { incomplete('LangGraph answerText could not extract the public answer.'); }
          }
          client.track(session.complete({ status: interrupted || signal?.aborted ? 'cancelled' : 'completed', answer,
            ...(interrupted ? { error: 'The native graph paused; resume it through the original graph.' } : {}),
            ...(typeof thread === 'string' ? { session_id: thread } : {}),
            ...(config.model ? { model: config.model } : {}), usage: usageIncomplete ? undefined : totalUsage(models) }));
          return result;
        } catch (error) {
          client.track(session.complete({ status: signal?.aborted ? 'cancelled' : 'failed', answer: '',
            error: 'The existing LangGraph invocation did not complete. Inspect the original error in the application.',
            ...(typeof thread === 'string' ? { session_id: thread } : {}), usage: usageIncomplete ? undefined : totalUsage(models) }));
          throw error;
        }
      } finally { if (typeof thread === 'string') threads.delete(thread); }
    },
  };
}
