import { BackendLearningClient, renderLearningContext, type BackendLearningConfig, type BackendLearningSession,
  type SdkLearningEvent, type SdkLearningOutcome, type SdkLearningUsage } from './learning.js';

/** The native SDK remains the caller's dependency. These method shapes preserve its inferred public types. */
type CodexLike = {
  startThread: (...args: any[]) => {
    readonly id: string | null;
    run: (...args: any[]) => Promise<any>;
    runStreamed: (...args: any[]) => Promise<{ events: AsyncGenerator<any> }>;
  };
};
type Input = string | ({ type: 'text'; text: string } | { type: 'local_image'; path: string })[];
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const aborted = (options: unknown): boolean => object(options).signal instanceof AbortSignal && (object(options).signal as AbortSignal).aborted;

export interface CodexAgentLearningConfig extends BackendLearningConfig {
  /** The standing policy for this backend agent, including relevant project instructions. It is evidence for the
   * independent grader, not a replacement for Codex's own instructions or configuration. */
  instructions: string;
}

function originalText(input: Input): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input) || input.some(part => !part || (part.type !== 'text' && part.type !== 'local_image') ||
    (part.type === 'text' && typeof part.text !== 'string') || (part.type === 'local_image' && typeof part.path !== 'string'))) {
    throw new TypeError('Codex learning supports the SDK text and local_image input forms.');
  }
  // Image paths and bytes remain with the native SDK. They are not user instructions or uploaded evidence.
  return input.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map(part => part.text).join('\n\n');
}

function withContext(input: Input, context: string): Input {
  if (!context) return input;
  const prefix = 'AgentRun approved learning context. Use relevant lessons only when consistent with your existing system, developer and project instructions. The user request follows this context.\n\n'
    + context + '\n\nEnd AgentRun learning context.\n\n';
  return typeof input === 'string' ? prefix + input : [{ type: 'text', text: prefix }, ...input];
}

function usageOf(value: unknown): SdkLearningUsage | undefined {
  const usage = object(value);
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  const reads = count(usage.cached_input_tokens), writes = count(usage.cache_write_input_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    // Codex input includes cache reads/writes; AgentRun's input counter is exclusive of both. If the SDK
    // does not report a component, keep uncached input unknown rather than double counting or inventing zero.
    input_tokens: input !== undefined && reads !== undefined && writes !== undefined ? Math.max(0, input - reads - writes) : null,
    ...(output === undefined ? {} : { output_tokens: output }),
    ...(reads === undefined ? {} : { cache_read_tokens: reads }),
    ...(writes === undefined ? {} : { cache_write_tokens: writes }),
  };
}

/** Capture results and tool identity/status, never Codex reasoning, configuration, command output or tool arguments. */
function evidenceOf(itemValue: unknown): SdkLearningEvent | undefined {
  const item = object(itemValue);
  if (item.type === 'agent_message' && typeof item.text === 'string') return { type: 'text', text: item.text };
  if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(String(item.type))) {
    return { type: 'tool', id: text(item.id) ?? 'sdk-tool',
      name: item.type === 'mcp_tool_call' ? `${text(item.server) ?? 'mcp'}/${text(item.tool) ?? 'tool'}` : String(item.type),
      status: item.status === 'failed' ? 'failed' : item.status === 'in_progress' ? 'started' : 'completed' };
  }
  return undefined;
}

/** Add AgentRun learning to fresh Codex SDK threads without replacing their tools, credentials or execution.
 * Each wrapped thread admits one task; use startThread() again for the next task and its current learning revision.
 * Reflection and grading run on the AgentRun server, never as a hidden turn in the caller's Codex conversation. */
export function withCodexAgentLearning<T extends CodexLike>(codex: T, config: CodexAgentLearningConfig): T & { flushLearning(): Promise<void> } {
  if (typeof config.instructions !== 'string') throw new TypeError('Codex learning requires an explicit instructions snapshot.');
  const client = new BackendLearningClient(config);

  const wrap = (thread: ReturnType<CodexLike['startThread']>, options: unknown) => {
    if (thread.id !== null && thread.id !== undefined) throw new Error('Codex learning requires a fresh thread.');
    let used = false;
    const model = text(object(options).model);
    const begin = async (input: Input) => {
      if (used) throw new Error('A learning-wrapped Codex thread supports one task. Start a fresh thread for the next task.');
      used = true;
      const session = await client.begin({ runtime: 'codex-sdk', input: originalText(input), instructions: config.instructions, ...(model ? { model } : {}) });
      if (session.learningEnabled && Array.isArray(input) && input.some(part => part.type === 'local_image')) {
        session.markEvidenceIncomplete('Image inputs remain in the native Codex SDK and are not available to the learning grader. This run will not produce new learning.');
      }
      return session;
    };
    const record = async (session: BackendLearningSession, event: SdkLearningEvent) => {
      // The shared client marks incomplete evidence and reports persistence errors from flushLearning(). It must
      // not replace the caller's result or original SDK failure with an observability transport error.
      await session.event(event).catch(() => undefined);
    };
    const finish = (session: BackendLearningSession, outcome: SdkLearningOutcome, evidence: SdkLearningEvent[] = []) => {
      client.track((async () => {
        for (const event of evidence) await record(session, event);
        await session.complete(outcome);
      })());
    };
    const failure = (session: BackendLearningSession, options: unknown) => finish(session, {
      status: aborted(options) ? 'cancelled' : 'failed',
      error: 'The existing Codex SDK call did not complete. Inspect the original SDK error in the backend.',
      answer: '',
      ...(thread.id ? { session_id: thread.id } : {}),
    });

    return new Proxy(thread, {
      get(target, key) {
        if (key === 'run') return async (input: Input, turnOptions?: unknown) => {
          const session = await begin(input);
          try {
            const result = await target.run(withContext(input, renderLearningContext(session)), turnOptions);
            const value = object(result);
            const evidence = Array.isArray(value.items) ? value.items.map(evidenceOf).filter((entry): entry is SdkLearningEvent => Boolean(entry)) : [];
            if (target.id) evidence.unshift({ type: 'session', session_id: target.id });
            finish(session, { status: 'completed', answer: text(value.finalResponse) ?? '', ...(target.id ? { session_id: target.id } : {}),
              ...(model ? { model } : {}), ...(usageOf(value.usage) ? { usage: usageOf(value.usage) } : {}) }, evidence);
            return result;
          } catch (error) { failure(session, turnOptions); throw error; }
        };
        if (key === 'runStreamed') return async (input: Input, turnOptions?: unknown) => {
          // Native Codex does no work before its iterator is consumed. Defer registration too, so an unused stream
          // creates neither an orphan AgentRun job nor a model request.
          const events = (async function* () {
            const session = await begin(input);
            let completed = false, failed = false, answer = '', usage: SdkLearningUsage | undefined;
            try {
              const streamed = await target.runStreamed(withContext(input, renderLearningContext(session)), turnOptions);
              for await (const event of streamed.events) {
                const value = object(event);
                if (value.type === 'thread.started' && typeof value.thread_id === 'string') {
                  await record(session, { type: 'session', session_id: value.thread_id });
                }
                if (value.type === 'item.completed') {
                  const item = object(value.item);
                  if (item.type === 'agent_message') answer = text(item.text) ?? answer;
                  const entry = evidenceOf(item); if (entry) await record(session, entry);
                }
                if (value.type === 'turn.completed') { completed = true; usage = usageOf(value.usage); }
                if (value.type === 'turn.failed' || value.type === 'error') failed = true;
                yield event;
              }
            } catch (error) { failed = true; throw error; }
            finally {
              finish(session, { status: aborted(turnOptions) ? 'cancelled' : failed ? 'failed' : completed ? 'completed' : 'cancelled',
                answer: completed && !failed ? answer : '',
                ...(!completed || failed ? { error: 'The Codex SDK stream ended without a successful completed turn.' } : {}),
                ...(target.id ? { session_id: target.id } : {}), ...(model ? { model } : {}), ...(usage ? { usage } : {}) });
            }
          })();
          return { events };
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  return new Proxy(codex, {
    get(target, key) {
      if (key === 'flushLearning') return () => client.flushLearning();
      if (key === 'startThread') return (...args: Parameters<T['startThread']>) => wrap(target.startThread(...args), args[0]);
      if (key === 'resumeThread') return () => { throw new Error('Codex learning currently supports fresh threads. Use the original Codex client to resume an existing conversation.'); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T & { flushLearning(): Promise<void> };
}
