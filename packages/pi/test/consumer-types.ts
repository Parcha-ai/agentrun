import { authorWorkflow } from '@parcha/agentrun-dsl';
import { createPiRunner, type PiRunnerOptions, type PiEvent, type PiToolDefinition } from '../dist/index.js';

declare const options: PiRunnerOptions;
const runner = createPiRunner(options);
const event: PiEvent = { type: 'turn_end', message: { role: 'assistant', stopReason: 'stop' } };
const tool: PiToolDefinition<{ text: string }, { count: number }> = {
  name: 'count', label: 'Count', description: 'Count input characters',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  async execute(_id, args) { return { content: [{ type: 'text', text: String(args.text.length) }], details: { count: args.text.length } }; },
};
void runner;
void event;
void tool;
void authorWorkflow({ request: 'Extract a count', outputDir: './candidates', runNode: createPiRunner({ ...options, tools: [], maxSubmissions: 4 }) });
