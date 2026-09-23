import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { createPiRunner, type PiRunner } from './runner.js';
import type { PiHostContext, PiHostRunnerOptions, PiModel, PiSessionFactory } from './types.js';

export const PI_MODEL_SETUP_MESSAGE = 'AgentRun requires an active Pi model. Use /login to connect a provider, then /model to select it. Try /agentrun demo without model access.';

function selectedModel(context: PiHostContext): PiModel {
  const model = context.model;
  if (!model) throw new Error(PI_MODEL_SETUP_MESSAGE);
  if (!context.modelRegistry || typeof context.modelRegistry.streamSimple !== 'function' || typeof context.modelRegistry.getAll !== 'function') {
    throw new Error('AgentRun requires the host public model registry');
  }
  if (!context.modelRegistry.getAll().some(known => known.id === model.id && known.provider === model.provider && known.api === model.api)) {
    throw new Error(PI_MODEL_SETUP_MESSAGE);
  }
  return model;
}

export function createPiHostSessionFactory(context: PiHostContext): PiSessionFactory {
  const model = selectedModel(context);
  const stream = context.modelRegistry.streamSimple.bind(context.modelRegistry);
  return async options => {
    if (options.model !== model) throw new Error('The child session must use the captured active Pi model');
    let delivered = false, turns = 0;
    const allowed = new Set(options.tools);
    const tools = options.customTools.filter(tool => allowed.has(tool.name)).map(tool => ({
      name: tool.name, label: tool.label, description: tool.description,
      parameters: tool.parameters,
      async execute(id, args, signal, onUpdate) {
        const result = await tool.execute(id, args, signal, onUpdate, context);
        if (tool.name === 'submit' && (result.details as { accepted?: boolean })?.accepted === true) delivered = true;
        return result;
      },
    } satisfies AgentTool)) as AgentTool[];
    const agent = new Agent({
      initialState: { model, thinkingLevel: options.thinkingLevel, systemPrompt: options.resourceLoader.getSystemPrompt() ?? '', tools },

      streamFn: (_model, transcript, streamOptions) => stream(model, transcript, streamOptions) as ReturnType<StreamFn>,
      toolExecution: 'sequential',

      finishTurn: () => {
        turns++;
        if (delivered || (options.maxTurns !== undefined && turns >= options.maxTurns)) return { action: 'end' };
      },
    });
    let disposed = false;
    const unsubscribers = new Set<() => void>();
    return { session: {
      async prompt(text) {
        if (disposed) throw new Error('Pi host child session is disposed');
        await agent.prompt(text);
      },
      subscribe(listener) {
        if (disposed) throw new Error('Pi host child session is disposed');
        const unsubscribe = agent.subscribe(event => { listener(event); });
        unsubscribers.add(unsubscribe);
        return () => { unsubscribe(); unsubscribers.delete(unsubscribe); };
      },
      async abort() { agent.abort(); },
      dispose() {
        if (disposed) return;
        disposed = true;
        agent.abort();
        agent.clearAllQueues();
        for (const unsubscribe of unsubscribers) unsubscribe();
        unsubscribers.clear();
      },
    } };
  };
}

export function createPiHostRunner(context: PiHostContext, options: PiHostRunnerOptions = {}): PiRunner {
  const model = selectedModel(context);
  return createPiRunner({
    ...options, model, cwd: options.cwd ?? context.cwd,
    thinkingLevel: options.thinkingLevel ?? context.thinkingLevel,
    sessionFactory: createPiHostSessionFactory(context),
  });
}
