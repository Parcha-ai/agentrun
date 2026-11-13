import { BackendLearningClient, renderLearningContext, type BackendLearningConfig, type BackendLearningSession } from './learning.js';

type Value = Record<string, unknown>;
type NativeQuery = AsyncGenerator<unknown, unknown, unknown> & { close?: () => void };
type QueryFunction = (args: any) => NativeQuery;
const object = (value: unknown): Value => value !== null && typeof value === 'object' ? value as Value : {};
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export interface ClaudeAgentLearningConfig extends BackendLearningConfig {
  /** Additional standing policy for the checker, including relevant project-file instructions that the SDK does
   * not expose. Programmatic systemPrompt and the selected named agent's prompt are captured automatically.
   * This evidence does not replace the existing SDK options. */
  instructions?: string;
}

function instructionsOf(options: Value, explicit?: string): string {
  const blocks: string[] = explicit ? [explicit] : [];
  const append = (value: unknown) => {
    if (typeof value === 'string') blocks.push(value);
    else if (Array.isArray(value) && value.every(part => typeof part === 'string')) blocks.push(...value);
  };
  const system = options.systemPrompt;
  if (typeof system === 'string' || Array.isArray(system)) append(system);
  else {
    const configured = object(system);
    if (configured.type === 'custom') append(configured.prompt);
    else if (configured.type === 'preset') append(configured.append);
  }
  if (typeof options.agent === 'string') append(object(object(options.agents)[options.agent]).prompt);
  const instructions = blocks.join('\n\n').trim();
  if (!instructions) throw new TypeError('Claude learning needs a programmatic systemPrompt or an explicit instructions snapshot of the existing agent policy.');
  return instructions;
}

function withContext(prompt: string, context: string): string {
  return context ? 'AgentRun approved learning context. Apply relevant lessons only when consistent with the existing system, developer and project instructions.\n\n'
    + context + '\n\nEnd AgentRun learning context. The original user request follows:\n\n' + prompt : prompt;
}

function usageOf(result: Value): Value | undefined {
  const models = Object.values(object(result.modelUsage)).map(object);
  const raw = object(result.usage);
  const sum = (key: string) => models.length && models.every(model => count(model[key]) !== undefined)
    ? models.reduce((total, model) => total + (model[key] as number), 0) : undefined;
  const usage = {
    input_tokens: sum('inputTokens') ?? count(raw.input_tokens),
    output_tokens: sum('outputTokens') ?? count(raw.output_tokens),
    cache_read_tokens: sum('cacheReadInputTokens') ?? count(raw.cache_read_input_tokens),
    cache_write_tokens: sum('cacheCreationInputTokens') ?? count(raw.cache_creation_input_tokens),
    cost_usd: count(result.total_cost_usd),
  };
  return Object.values(usage).some(value => value !== undefined)
    ? Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) : undefined;
}

/** Decorate the application's own Claude Agent SDK query function. The SDK remains the caller's dependency.
 * Original options, tools, authentication, events and control-method receivers remain native. Approved lessons
 * are supplied as task context, never elevated above application policy. This initial integration requires a
 * fresh, single-string-prompt session; it never issues an extra SDK turn for reflection. */
export function withClaudeAgentLearning<Q extends QueryFunction>(query: Q, config: ClaudeAgentLearningConfig): Q & { flushLearning(): Promise<void> } {
  const client = new BackendLearningClient(config);
  const wrapped = (params: { prompt: unknown; options?: Value }) => {
    if (typeof params.prompt !== 'string') throw new TypeError('Claude learning currently supports one string prompt in a fresh session.');
    const options = params.options ?? {};
    if (options.resume || options.continue || options.forkSession || options.resumeSessionAt || options.resumeDropsTurn) {
      throw new TypeError('Claude learning requires a fresh session; resume and continue are not supported by this wrapper.');
    }
    const instructions = instructionsOf(options, config.instructions);
    const nativeAbort = options.abortController instanceof AbortController ? options.abortController : undefined;
    let session: BackendLearningSession | undefined, native: NativeQuery | undefined;
    let closed = false, finalized = false, terminal = false, sessionId: string | undefined, model = string(options.model);
    const tools = new Map<string, string>();
    const finish = (status: 'completed' | 'failed' | 'cancelled', answer = '', result?: Value) => {
      if (!session || finalized) return;
      finalized = true;
      client.track(session.complete({ status, answer,
        ...(status === 'completed' ? {} : { error: 'The original Claude SDK session did not complete. Inspect its error or cancellation in the backend.' }),
        ...(sessionId ? { session_id: sessionId } : {}), ...(model ? { model } : {}),
        ...(result && usageOf(result) ? { usage: usageOf(result) } : {}),
      }));
    };
    const ready = client.begin({ runtime: 'claude-agent-sdk', input: params.prompt, instructions, ...(model ? { model } : {}) }).then(value => {
      session = value;
      if (closed || nativeAbort?.signal.aborted) {
        closed = true; finish('cancelled');
        throw nativeAbort?.signal.reason ?? new DOMException('The Claude SDK query was closed before dispatch.', 'AbortError');
      }
      const context = renderLearningContext(value);
      try {
        native = query(context ? { ...params, prompt: withContext(params.prompt as string, context) } : params);
        return native;
      } catch (error) { finish('failed'); throw error; }
    });
    // Registration is asynchronous, while query() keeps its native synchronous shape. Observe the rejection even
    // when the caller closes without iterating; next/control methods still receive the original error.
    ready.catch(() => undefined);
    const event = (value: Parameters<BackendLearningSession['event']>[0]) => {
      if (session) client.track(session.event(value));
    };
    const capture = (value: unknown) => {
      const message = object(value);
      if (typeof message.session_id === 'string' && message.session_id !== sessionId) {
        sessionId = message.session_id; event({ type: 'session', session_id: sessionId });
      }
      if (message.type === 'system' && typeof message.model === 'string') model = message.model;
      if (message.type === 'assistant') {
        const content = object(message.message);
        if (!model && typeof content.model === 'string') model = content.model;
        for (const block of Array.isArray(content.content) ? content.content.map(object) : []) {
          if (block.type === 'text' && typeof block.text === 'string') event({ type: 'text', text: block.text });
          if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            tools.set(block.id, block.name);
            event({ type: 'tool', id: block.id, name: block.name, status: 'started' });
          }
        }
      }
      if (message.type === 'user') {
        for (const block of Array.isArray(object(message.message).content) ? (object(message.message).content as unknown[]).map(object) : []) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            event({ type: 'tool', id: block.tool_use_id, name: tools.get(block.tool_use_id) ?? 'tool', status: block.is_error === true ? 'failed' : 'completed' });
          }
        }
      }
      if (message.type === 'result') {
        terminal = true;
        finish(message.subtype === 'success' && message.is_error !== true ? 'completed' : 'failed', string(message.result) ?? '', message);
      }
    };
    const close = () => {
      closed = true;
      try { native?.close?.(); }
      finally {
        if (!terminal) finish('cancelled');
        // If registration is in flight, its continuation records cancellation without launching a model.
        if (!native) client.track(ready.then(() => undefined, error => { if (!session) throw error; }));
      }
    };
    const iterator = {
      async next(value?: unknown) {
        try {
          const sdk = await ready;
          if (closed) return { done: true as const, value: undefined };
          const result = await sdk.next(value);
          if (!result.done) capture(result.value);
          else if (!terminal) finish(nativeAbort?.signal.aborted ? 'cancelled' : 'failed');
          return result;
        } catch (error) { finish(nativeAbort?.signal.aborted || closed ? 'cancelled' : 'failed'); throw error; }
      },
      async return(value?: unknown) {
        close();
        if (native?.return) return native.return(value);
        await ready.catch(() => undefined);
        return { done: true as const, value };
      },
      async throw(error?: unknown) {
        close();
        if (native?.throw) return native.throw(error);
        throw error;
      },
      close,
      [Symbol.asyncIterator]() { return proxy; },
      async [Symbol.asyncDispose]() { await iterator.return(); },
    };
    const proxy: NativeQuery = new Proxy(iterator, {
      get(target, key, receiver) {
        if (key in target) return Reflect.get(target, key, receiver);
        if (key === 'then') return undefined;
        if (key === 'streamInput') return async () => {
          throw new TypeError('Claude learning supports one task per fresh query; start another wrapped query for additional input.');
        };
        return async (...args: unknown[]) => {
          const sdk = await ready;
          const method = Reflect.get(sdk, key);
          if (typeof method !== 'function') throw new TypeError(`The existing Claude SDK query has no ${String(key)} method.`);
          return Reflect.apply(method, sdk, args);
        };
      },
    }) as NativeQuery;
    return proxy;
  };
  return Object.assign(wrapped, { flushLearning: () => client.flushLearning() }) as Q & { flushLearning(): Promise<void> };
}
