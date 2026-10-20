// An app module for `pi-durable-disk run --app`, as the agent app's test uses it: one agent on the host the environment gives (`hostFromEnv`), its lead a scripted faux model. `AGENT_TOOLS` is the
// JSON list of tools the agent names; `AGENT_CALL` the one tool call the lead makes, as JSON `{ name, arguments }`. Then the lead answers `done: ` and the text of that call's result.
import type { Message } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { AppContext } from '@parcha/pi-durable-disk';
import { agentApp, hostFromEnv } from '@parcha/agentrun-harness';

const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''));

function lead(messages: readonly Message[]) {
  const results = messages.filter((message) => message.role === 'toolResult');
  if (!results.length) {
    const call = JSON.parse(process.env.AGENT_CALL!) as { name: string; arguments: Record<string, unknown> };
    return fauxAssistantMessage([fauxToolCall(call.name, call.arguments as never)], { stopReason: 'toolUse' });
  }
  return fauxAssistantMessage(`done: ${textOf(results.at(-1)!)}`);
}

export default async function app(ctx: AppContext) {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 8 }, () => (context) => lead(context.messages)));
  const models = createModels();
  models.setProvider(faux.provider);
  const place = { id: ctx.ref.id, root: ctx.root, work: ctx.work, store: ctx.store };
  const host = await hostFromEnv(place, { models, lead: { provider: faux.provider.id, modelId: faux.getModel().id }, env: process.env });
  return agentApp(place, host, { instructions: 'Do what the person asks.', tools: JSON.parse(process.env.AGENT_TOOLS!) as string[] });
}
