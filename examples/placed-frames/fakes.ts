// The run with no key: both environments are directories of this machine (local boxes), a scripted lead stands in for the model, and a scripted classifier stands in for Jev at pi-ai's
// provider boundary, so the placer runs as it does live. The lead asks for every frame in one turn, releases, and submits what the answers say; the classifier sends a frame at 150 iterations
// per pixel or more to modal and the rest to daytona. Every answer says it is scripted, and so does the recording. The tools are the live ones.
import { dirname, join } from 'node:path';
import type { AssistantMessage, ClassifierAnswer, ClassifierContext, ClassifierResult, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { typesafeProvider } from '@earendil-works/pi-ai/providers/typesafe';
import type { Fakes } from '@parcha/agentrun-reference';
import { localBoxes } from '@parcha/pi-transport/box/local';
import { ENVIRONMENTS, placedFrames } from './tools.ts';

/** The iterations at which the script calls a frame heavy. */
export const HEAVY_ITERATIONS = 150;

/** The scripted classifier's answers: from the step's iterations, a sure need and modal for a heavy frame, else daytona. */
export function scriptedAnswers(context: ClassifierContext): Record<string, ClassifierAnswer> {
  const iterations = Number(/at (\d+) iterations per pixel/.exec(String(context.state.step))?.[1] ?? 0);
  const heavy = iterations >= HEAVY_ITERATIONS;
  const where = heavy ? 'modal' : 'daytona';
  return {
    need: { type: 'bool', probability: heavy ? 0.9 : 0.1 },
    where: { type: 'choice', choice: where, probabilities: Object.fromEntries(ENVIRONMENTS.map((environment) => [environment.id, environment.id === where ? 0.9 : 0.1])), confidence: 0.9 },
  };
}

/** pi-ai's models with TypeSafe's classifier scripted: its real model ids, an auth that holds no key, and no usage, so no cost. */
export function scriptedModels() {
  const models = createModels();
  models.setProvider(createProvider({
    id: 'typesafe',
    name: 'TypeSafe, scripted',
    auth: { apiKey: { name: 'scripted (no key)', resolve: async () => ({ auth: {} }) } },
    models: typesafeProvider().getAllModels?.() ?? [],
    classifiers: {
      'typesafe-system-one': {
        async classify(model, context): Promise<ClassifierResult> {
          return { api: model.api, provider: model.provider, model: model.id, answers: scriptedAnswers(context), stopReason: 'stop', timestamp: Date.now() };
        },
      },
    },
  }));
  return models;
}

const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));
const turn = (calls: Array<{ name: string; args: Record<string, number> }>) => fauxAssistantMessage(calls.map((call) => fauxToolCall(call.name, call.args)), { stopReason: 'toolUse' });

/** The frames the agent's state names: the first JSON object in the prompt with a `frames`. */
function framesOf(prompt: string): number | undefined {
  for (let start = prompt.indexOf('{'); start >= 0; start = prompt.indexOf('{', start + 1)) {
    for (let end = prompt.lastIndexOf('}'); end > start; end = prompt.lastIndexOf('}', end - 1)) {
      try { const parsed = JSON.parse(prompt.slice(start, end + 1)); if (Number.isInteger(parsed?.frames)) return parsed.frames; } catch { /* not this slice */ }
    }
  }
  return undefined;
}

/** The scripted lead: every frame in one turn, then `release`, then the answer from what the results say. */
export function scriptedLead(messages: readonly Message[]): AssistantMessage {
  const frames = framesOf(textOf(messages.find((message) => message.role === 'user')!));
  if (!frames) throw new Error('the scripted lead found no frame count in its prompt');
  const results = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
  const answers = (name: string) => results.filter((result) => result.toolName === name).map((result) => { try { return JSON.parse(textOf(result as Message)); } catch { return undefined; } });
  const drawn = answers('frame').filter((answer) => typeof answer?.f === 'number');
  if (drawn.length < frames) {
    if (results.length === 0) return turn(Array.from({ length: frames }, (_, f) => ({ name: 'frame', args: { f, frames } })));
    throw new Error(`the scripted lead got ${drawn.length} of ${frames} frames`);
  }
  if (answers('release').length === 0) return turn([{ name: 'release', args: {} }]);
  const by = new Map<string, number>();
  for (const answer of drawn) by.set(answer.environment, (by.get(answer.environment) ?? 0) + 1);
  const spread = [...by].map(([environment, count]) => `${count} on ${environment}`).join(' and ');
  return fauxAssistantMessage([fauxToolCall('submit', { answer: `(scripted) Drew ${frames} frames: ${spread}.` })], { stopReason: 'toolUse' });
}

/** The fakes the reference entry runs the job on. */
export const fakes: Fakes = {
  model: scriptedLead,
  judge: async () => { throw new Error('this job asks the judge nothing'); },
  tools: {},
  // The agent's tools, over each environment a directory of this machine; the box's PATH starts with this node's directory, so the tile program runs on the node running the demo.
  extensions: [placedFrames({
    providers: (place) => Object.fromEntries(ENVIRONMENTS.map((environment) => [environment.id, localBoxes({ root: join(place.root, 'boxes', environment.id), path: `${dirname(process.execPath)}:/usr/bin:/bin` })])),
    models: scriptedModels(),
    placer: 'scripted',
  })],
  pages: {},
  start: 'about:blank',
  responses: 8,
};
