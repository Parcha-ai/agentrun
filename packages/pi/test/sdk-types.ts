import type { CreateAgentSessionOptions, ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createPiRunner, type PiRunnerOptions } from '../dist/index.js';

declare const model: NonNullable<CreateAgentSessionOptions['model']>;
declare const modelRuntime: ModelRuntime;
const parameters = Type.Object({ text: Type.String() });
const sdkTool: ToolDefinition<typeof parameters, { count: number }> = {
  name: 'count', label: 'Count', description: 'Count characters', parameters,
  async execute(_id, args, _signal, onUpdate, context) {
    const details = { count: args.text.length };
    const result = { content: [{ type: 'text' as const, text: String(details.count) }], details };
    onUpdate?.(result);
    context.getContextUsage();
    return result;
  },
};
const options: PiRunnerOptions = { model, modelRuntime, tools: [sdkTool] };
createPiRunner(options);
