// The run with no key: both environments are directories of this machine (local boxes), and a scripted classifier stands in for Jev at pi-ai's provider boundary, so the placer
// runs as it does live. The script sends a frame at 150 iterations per pixel or more to modal and the rest to daytona; every answer says it is scripted, and so does the recording.
// The tools are the live ones; no model is asked (the workflow names none).
import { dirname, join } from 'node:path';
import type { ClassifierAnswer, ClassifierContext, ClassifierResult } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { typesafeProvider } from '@earendil-works/pi-ai/providers/typesafe';
import type { Fakes } from '@parcha/agentrun-reference';
import { localBoxes } from '@parcha/pi-transport/box/local';
import { ENVIRONMENTS, frameTools } from './tools.ts';

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

/** The fakes the reference entry runs the job on. */
export const fakes: Fakes = {
  // The workflow has no agent node, so no turn is ever asked for, and no question either.
  model: () => fauxAssistantMessage('(scripted) this job asks no model'),
  judge: async () => { throw new Error('this job asks the judge nothing'); },
  tools: frameTools({
    // Each environment a directory of this machine; the box's PATH starts with this node's directory, so the tile program runs on the node running the demo.
    providers: (place) => Object.fromEntries(ENVIRONMENTS.map((environment) => [environment.id, localBoxes({ root: join(place.root, 'boxes', environment.id), path: `${dirname(process.execPath)}:/usr/bin:/bin` })])),
    models: scriptedModels(),
    placer: 'scripted',
  }),
  pages: {},
  start: 'about:blank',
  responses: 4,
};
